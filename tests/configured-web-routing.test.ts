import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { mergeDiscoveredModels } from "../src/web-account-cli";
import { configForWebModel, resolveWebAccountModel, validateWebAccountRegistry, verifiedAccountModels, webModelId, type WebAccount } from "../src/web-accounts";
import { type WebModelDefinition } from "../src/web-model-definition";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "configured-web-route-")); roots.push(root);
  const config = { ...defaultConfig("browser-only"), webAccountsFile: join(root, "accounts.json") };
  const definition: WebModelDefinition = {
    version: 1, slug: "future-web-model", title: "Future Web Model",
    effort: { codex: "high", adapter: "high" },
    capabilities: { tools: false, inputModalities: ["text"] },
    limits: { contextWindow: 32000, autoCompactTokenLimit: 24000, browserMessageTokenLimit: 28000,
      browserComposerCharLimit: 120000, platformReserveTokens: 1024, imageTokenReserveTokens: 0 },
    selection: { kind: "menu", trigger: { role: "button", name: "Choose model" },
      scope: { role: "menu", name: "Models" }, steps: [{ role: "menuitemradio", name: "Future Web Model" }],
      verify: { role: "menuitemradio", name: "Future Web Model", state: "checked" } },
  };
  const account: WebAccount = { id: "research", label: "Research", email: "enrolled@example.test", enabled: true,
    browserHostDescriptorPath: join(root, "browser.json"), solAvailable: false, proAvailable: false,
    userId: "user-research", accountId: "workspace-research",
    catalogIdentity: { userId: "user-research", accountId: "workspace-research" }, catalogVerifiedAt: new Date().toISOString(),
    models: [{ slug: definition.slug, title: definition.title, available: true, definition }],
  };
  const registry = { version: 2, accounts: [account] };
  const save = () => writeFileSync(config.webAccountsFile, JSON.stringify(registry)); save();
  return { root, config, definition, account, registry, save };
}

test("a configured discovered model routes without any built-in Sol or Pro preset", async () => {
  const { config, account } = fixture();
  const id = webModelId(account, account.models![0]!); let captured: any, parsedModel: string | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer unrelated-official-login" },
    body: JSON.stringify({ model: id, input: "marker", stream: false }),
  }), config, provider => {
    captured = provider;
    return { name: "routing-contract-test", async runTurn(parsed, _request, emit) {
      parsedModel = parsed.modelId;
      emit({ type: "text_delta", text: "marker" }); emit({ type: "done", stopReason: "stop", endTurn: true });
    } };
  });
  expect(response.status).toBe(200);
  expect(parsedModel).toBe("chatgpt-web-configured");
  expect(captured.chatgptWeb.webModelDefinition.slug).toBe("future-web-model");
  expect(captured.chatgptWeb.modelBinding).toEqual({ accountId: account.id, publicModelId: id, webModelSlug: "future-web-model" });
  expect(captured.chatgptWeb.accountIdentity.accountId).toBe(account.accountId);
});

test("an in-flight configuration is a deep snapshot of model selection", () => {
  const { config, account, definition } = fixture();
  const selected = configForWebModel(config, account, account.models![0]!);
  if (definition.selection.kind !== "menu") throw new Error("Expected a menu selection fixture");
  definition.selection.trigger.name = "Changed later";
  definition.limits.contextWindow = 64000;
  expect(selected.webModelDefinition!.selection).toMatchObject({ kind: "menu", trigger: { name: "Choose model" } });
  expect(selected.webModelDefinition!.limits.contextWindow).toBe(32000);
});

test("configured model identity cannot disagree with authenticated discovery or also select a preset", () => {
  const { config, account, registry } = fixture();
  account.models![0]!.definition!.slug = "different-model";
  expect(() => validateWebAccountRegistry(registry, config)).toThrow("discovered");
  account.models![0]!.definition!.slug = account.models![0]!.slug;
  account.models![0]!.adapterRoute = "chatgpt-web/pro";
  expect(() => validateWebAccountRegistry(registry, config)).toThrow("preset");
});

test("revoked availability hides the definition and rejects the old public ID", () => {
  const { config, account, save } = fixture(); const id = webModelId(account, account.models![0]!);
  account.models![0]!.available = false; save();
  expect(verifiedAccountModels(account)).toHaveLength(0);
  expect(() => resolveWebAccountModel(id, config)).toThrow("No fallback");
});

test("rediscovery retains selection for the same slug and updates only the observed title", () => {
  const { account } = fixture(); const oldId = webModelId(account, account.models![0]!);
  const updated = mergeDiscoveredModels(account, [{ slug: "future-web-model", title: "Renamed Web Model", available: true }]);
  expect(updated[0]!.definition!.title).toBe("Renamed Web Model");
  expect(updated[0]!.definition!.selection).toMatchObject({ kind: "menu", trigger: { name: "Choose model" } });
  expect(webModelId(account, updated[0]!)).toBe(oldId);
  expect(mergeDiscoveredModels(account, [{ slug: "new-model", title: "New", available: true }])[0]!.definition).toBeUndefined();
});

test("declared text-only execution does not inherit a different account's full-mode Tunnel", () => {
  const { config, account } = fixture(); config.mode = "full";
  const selected = resolveWebAccountModel(webModelId(account, account.models![0]!), config);
  expect(selected.config.mode).toBe("browser-only");
  expect(selected.config.webModelDefinition!.capabilities.tools).toBe(false);
});

test("CLI installs a configured model without changing source and preserves configuration on a mismatched slug", async () => {
  const { root, config, definition, account, save } = fixture();
  delete account.models![0]!.definition; save();
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  const definitionFile = join(root, "definition.json");
  writeFileSync(definitionFile, JSON.stringify(definition));
  const command = () => Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--home", root,
    "web-accounts", "model", account.id, definition.slug, "--definition", definitionFile], {
    env: { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CHATGPT_WEB_HOME: root },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const first = command();
  const [firstOutput, firstErrors, firstExit] = await Promise.all([new Response(first.stdout).text(), new Response(first.stderr).text(), first.exited]);
  expect({ exit: firstExit, stderr: firstErrors }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(firstOutput).accounts[0].selectableModels[0].name).toBe("Future Web Model Research");
  const installed = readFileSync(config.webAccountsFile, "utf8");
  expect(JSON.parse(installed).accounts[0].models[0].definition).toEqual(definition);
  writeFileSync(definitionFile, JSON.stringify({ ...definition, slug: "different-upstream" }));
  const rejected = command();
  const [, rejection, secondExit] = await Promise.all([new Response(rejected.stdout).text(), new Response(rejected.stderr).text(), rejected.exited]);
  expect(secondExit).not.toBe(0);
  expect(rejection).toContain("exact slug and title");
  expect(readFileSync(config.webAccountsFile, "utf8")).toBe(installed);
}, 30000);
