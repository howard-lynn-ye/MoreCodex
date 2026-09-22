import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL,
  availableChatGptWebModelRoutes, requireChatGptWebModelRoute, resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { configForWebModel, webModelId, type WebAccount } from "../src/web-accounts";
import type { WebModelDefinition } from "../src/web-model-definition";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "configured-model-catalog-")); roots.push(root);
  const config = { ...defaultConfig("full"), webAccountsFile: join(root, "accounts.json") };
  const definition: WebModelDefinition = {
    version: 1, slug: "arbitrary-next-generation-model", title: "Discovered model",
    effort: { codex: "high", adapter: "high" }, capabilities: { tools: false, inputModalities: ["text"] },
    limits: { contextWindow: 50000, autoCompactTokenLimit: 40000, browserMessageTokenLimit: 42000,
      browserComposerCharLimit: 155000, platformReserveTokens: 3000, imageTokenReserveTokens: 0 },
    selection: { kind: "menu", trigger: { role: "button", name: "Model" }, scope: { role: "menu", name: "Models" },
      steps: [{ role: "menuitemradio", name: "Discovered model" }],
      verify: { role: "menuitemradio", name: "Discovered model", state: "checked" } },
  };
  const account: WebAccount = { id: "arbitrary", label: "Arbitrary alias", email: "private@example.test", enabled: true,
    solAvailable: false, proAvailable: false, userId: "user-arbitrary", accountId: "workspace-arbitrary",
    browserHostDescriptorPath: join(root, "browser.json"), catalogVerifiedAt: new Date().toISOString(),
    catalogIdentity: { userId: "user-arbitrary", accountId: "workspace-arbitrary" },
    models: [{ slug: definition.slug, title: definition.title, available: true, definition }],
  };
  writeFileSync(config.webAccountsFile, JSON.stringify({ version: 2, accounts: [account] }));
  return { config, definition, account, selected: configForWebModel(config, account, account.models![0]!), root };
}
function nativeCatalog() {
  return { models: [{ slug: "native-model", display_name: "Native model", visibility: "list", supported_in_api: true,
    priority: 3, tool_mode: "code_mode_only", shell_type: "unified_exec", multi_agent_version: "v2",
    multi_agent_reasoning_effort: "xhigh", context_window: 1000000, max_context_window: 1000000,
    supported_reasoning_levels: [{ effort: "high", description: "High" }], default_reasoning_level: "high",
    supports_search_tool: true, supports_image_detail_original: true, supports_experimental_context: true,
    supports_reasoning_summaries: true, support_verbosity: true, supports_parallel_tool_calls: true,
    experimental_supported_tools: ["native-only"], input_modalities: ["text", "image"],
    model_messages: { some_native_specific_contract: "not for the configured model" }, comp_hash: "native-hash",
    node_repl_auto_review_required: true, node_repl_disabled: false, use_responses_lite: true }] };
}

test("an arbitrary discovered definition creates one route with the exact stable public ID", () => {
  const { selected, account } = fixture(); const id = webModelId(account, account.models![0]!);
  const route = requireChatGptWebModelRoute(id, selected);
  expect(route).toMatchObject({ slug: id, backendModel: CHATGPT_WEB_CONFIGURED_BACKEND_MODEL,
    codexEffort: "high", adapterEffort: "high", interactionMode: "automatic" });
  expect(availableChatGptWebModelRoutes(selected)).toEqual([route]);
  expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", selected)).toThrow("binding");
  expect(() => requireChatGptWebModelRoute(id.replace("arbitrary/", "other/"), selected)).toThrow("binding");
  expect(() => requireChatGptWebModelRoute(id, { ...selected, webModelBinding: { ...selected.webModelBinding!, webModelSlug: "other" } })).toThrow("binding");
});

test("configured limits and reserves cannot inherit larger preset or native windows", () => {
  const { selected } = fixture();
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "max", selected))
    .toEqual({ contextWindow: 50000, autoCompactTokenLimit: 40000, effectiveContextWindowPercent: 80 });
  expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "max", selected))
    .toEqual({ browserMessageTokenLimit: 42000, browserComposerCharLimit: 155000 });
  // Legacy usage helpers still pass the preset constant; explicit definitions must win there too.
  expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", selected).contextWindow).toBe(50000);
  expect(resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", selected, 10000)).toBe(36999);
  expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", defaultConfig("full"))).toThrow("explicit");
  expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", { ...selected, experimentalBiggerContext: true })).toThrow("Bigger Context");
});

test("the native catalogue publishes only declared capabilities and keeps safety checks", () => {
  const { config, account } = fixture(); config.subagentProtocol = "native";
  const source = nativeCatalog(); const before = structuredClone(source);
  const models = augmentNativeModelCatalog(source, config).models as Record<string, unknown>[];
  expect(source).toEqual(before); expect(models[0]).toEqual(before.models[0]);
  const row = models[1]!;
  expect(row).toMatchObject({ slug: webModelId(account, account.models![0]!), display_name: "Discovered model Arbitrary alias",
    input_modalities: ["text"], supports_tools: false, node_repl_disabled: true, node_repl_auto_review_required: true,
    context_window: 50000, max_context_window: 50000, auto_compact_token_limit: 40000,
    default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high", description: "Discovered model Arbitrary alias" }],
    multi_agent_version: "disabled", experimental_supported_tools: [], supports_search_tool: false,
    supports_image_detail_original: false, supports_experimental_context: false, supports_reasoning_summaries: false,
    supports_parallel_tool_calls: false, support_verbosity: false, use_responses_lite: false });
  expect(row).not.toHaveProperty("comp_hash"); expect(row).not.toHaveProperty("model_messages");
  expect(row).not.toHaveProperty("multi_agent_reasoning_effort"); expect(JSON.stringify(row)).not.toContain(account.email);
});

test("legacy account catalogue descriptions omit private email addresses", () => {
  const { config, account } = fixture(); account.models = undefined; account.solAvailable = true;
  writeFileSync(config.webAccountsFile, JSON.stringify({ version: 1, accounts: [account] }));
  const models = augmentNativeModelCatalog(nativeCatalog(), config).models as Record<string, unknown>[];
  expect(models.length).toBeGreaterThan(1);
  expect(JSON.stringify(models)).not.toContain(account.email);
});
