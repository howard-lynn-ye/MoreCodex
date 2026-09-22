import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, providerConfig } from "../src/config";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { resolveBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { compactRequest, responseRequest } from "../src/server";
import { resolveWebAccountModel, type WebAccount } from "../src/web-accounts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "web-account-test-"));
  roots.push(root);
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  config.webAccountsFile = join(root, "accounts.json");
  const accounts: WebAccount[] = ["alpha", "beta", "gamma"].map(id => ({
    id, label: id.toUpperCase(), email: `${id}@example.test`, enabled: id !== "gamma",
    browserHostDescriptorPath: join(root, id, "launcher-browser.json"), solAvailable: true, proAvailable: true,
    userId: `user-${id}`, accountId: `workspace-${id}`,
  }));
  const save = () => writeFileSync(config.webAccountsFile!, JSON.stringify({ version: 1, accounts }));
  save();
  return { config, accounts, save };
}
const template = { slug: "native", visibility: "list", tool_mode: "function", supported_reasoning_levels: [] };
const request = (model: string) => new Request("http://127.0.0.1/v1/responses", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, stream: false, input: [{ role: "user", content: "Account routing test" }] }),
});

test("publishes distinct account routes and reloads enablement without changing native models", () => {
  const { config, accounts, save } = fixture();
  let models = augmentNativeModelCatalog({ models: [template] }, config).models as any[];
  expect(models[0]).toEqual(template);
  expect(models).toHaveLength(11);
  expect(models.find(m => m.slug === "chatgpt-web/beta/high").display_name).toBe("ChatGPT Web High BETA");
  expect(models.some(m => m.slug.includes("gamma"))).toBe(false);
  accounts[2]!.enabled = true;
  save();
  models = augmentNativeModelCatalog({ models: [template] }, config).models as any[];
  expect(models).toHaveLength(16);
  expect(models.find(m => m.slug === "chatgpt-web/gamma/high").display_name).toBe("ChatGPT Web High GAMMA");
});

test("account selection isolates browser workers and execution state while retaining the tool broker", () => {
  const { config, accounts } = fixture();
  const selected = accounts.slice(0, 2).map(account => resolveWebAccountModel(`chatgpt-web/${account.id}/high`, config));
  const providers = selected.map(value => providerConfig(value.config));
  expect(selected.map(value => value.model)).toEqual(["chatgpt-web/high", "chatgpt-web/high"]);
  expect(providers.map(p => p.chatgptWeb?.browserHostDescriptorPath)).toEqual(accounts.slice(0, 2).map(a => a.browserHostDescriptorPath));
  expect(providers[0]!.chatgptWeb?.brokerSocketPath).toBe(config.brokerSocketPath);
  expect(providers[1]!.chatgptWeb?.brokerSocketPath).toBe(config.brokerSocketPath);
  expect(providers[1]!.chatgptWeb?.accountIdentity).toEqual({label:"BETA",userId:"user-beta",accountId:"workspace-beta"});
  expect(chatGptWebExecutionNamespace(providers[0]!)).not.toBe(chatGptWebExecutionNamespace(providers[1]!));
  expect(resolveBrowserConfig(providers[0]!)).not.toEqual(resolveBrowserConfig(providers[1]!));
});

test("legacy labels alone cannot publish or route an unverified account", async () => {
  const {config, accounts, save} = fixture();
  delete accounts[1]!.userId;
  save();
  const models = augmentNativeModelCatalog({models:[template]},config).models as any[];
  expect(models.some(model => model.slug.includes('/beta/'))).toBe(false);
  const response = await responseRequest(request('chatgpt-web/beta/high'),config,()=>{throw Error('inference must not run');});
  expect(response.status).toBe(400);
});

test("responses and compaction use the selected account and preserve the public response model", async () => {
  const { config, accounts } = fixture();
  let calls = 0;
  const factory = (provider: ReturnType<typeof providerConfig>) => ({
    name: "account-test",
    async runTurn(parsed: any, _incoming: any, emit: any) {
      calls++;
      expect(provider.chatgptWeb?.browserHostDescriptorPath).toBe(accounts[1]!.browserHostDescriptorPath);
      expect(provider.baseUrl).toBe("https://chatgpt.com");
      expect(parsed.modelId).toBe("gpt-5.6-sol");
      expect(parsed.options.reasoning).toBe("high");
      emit({ type: "text_delta", text: "Verified account routing", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const response = await responseRequest(request("chatgpt-web/beta/high"), config, factory, { rememberState: false });
  expect(response.status).toBe(200);
  expect((await response.json() as any).model).toBe("chatgpt-web/beta/high");
  const compact = await compactRequest(request("chatgpt-web/beta/high"), config, factory);
  expect(compact.status).toBe(200);
  expect(calls).toBe(2);
});

test("unknown, disabled, malformed and duplicate account routes fail before inference", async () => {
  const { config, accounts, save } = fixture();
  for (const model of ["chatgpt-web/missing/high", "chatgpt-web/gamma/high", "chatgpt-web/beta/bad", "chatgpt-web/beta/high/extra"]) {
    for (const handler of [responseRequest, compactRequest]) {
      const response = await handler(request(model), config, () => { throw new Error("inference must not run"); });
      expect(response.status).toBe(400);
    }
  }
  accounts[1]!.browserHostDescriptorPath = accounts[0]!.browserHostDescriptorPath;
  save();
  expect(() => resolveWebAccountModel("chatgpt-web/beta/high", config)).toThrow("independent browser descriptors");
});
