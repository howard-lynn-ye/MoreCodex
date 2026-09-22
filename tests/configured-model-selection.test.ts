import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { cloneWebModelDefinition, validateWebModelDefinition, type WebModelDefinition } from "../src/web-model-definition";
import { selectConfiguredWebModel } from "../src/adapters/chatgpt-web/configured-model-selection";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_WEB_CONFIGURED_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/browser-worker";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

function definition(): WebModelDefinition {
  return { version: 1, slug: "future-authorized-model", title: "Future Model",
    effort: { codex: "high", adapter: "high" }, capabilities: { tools: false, inputModalities: ["text"] },
    limits: { contextWindow: 32000, autoCompactTokenLimit: 24000, browserMessageTokenLimit: 28000,
      browserComposerCharLimit: 120000, platformReserveTokens: 1024, imageTokenReserveTokens: 0 },
    selection: { kind: "menu", trigger: { role: "button", name: "Choose model" }, scope: { role: "menu", name: "Models" },
      steps: [{ role: "menuitemradio", name: "Future Model" }], verify: { role: "menuitemradio", name: "Future Model", state: "checked" } },
  };
}
function semanticPage(options: { duplicateTrigger?: boolean; rangeMax?: number; owner?: string; unsupportedTrigger?: boolean } = {}) {
  const state = { open: false, selected: false, value: 0, actions: [] as string[] };
  const locator = (role: string, name: string, inside = false): any => ({
    filter: () => locator(role, name, inside),
    count: async () => {
      if (role === "button" && name === "Choose model") return options.duplicateTrigger ? 2 : 1;
      if (role === "menu" && name === "Models") return state.open ? 1 : 0;
      if (!inside || !state.open) return 0;
      return (role === "menuitemradio" && name === "Future Model") || (role === "slider" && name === "Effort") || (role === "menuitem" && name === "Set effort") ? 1 : 0;
    },
    getByRole: (child: string, spec: { name: string; exact: boolean }) => {
      expect(spec.exact).toBeTrue(); return locator(child, spec.name, true);
    },
    getAttribute: async (key: string) => {
      if (role === "button") return key === "aria-haspopup" ? options.unsupportedTrigger ? null : "menu" : key === "aria-controls" ? "model-menu" : null;
      if (role === "menu") return key === "id" ? options.owner ?? "model-menu" : null;
      if (role === "menuitemradio") return key === "aria-checked" ? String(state.selected) : null;
      if (role === "slider") return ({ "aria-valuemin": "0", "aria-valuemax": String(options.rangeMax ?? 8), "aria-valuenow": String(state.value) } as Record<string, string>)[key] ?? null;
      return null;
    },
    click: async () => { state.actions.push(`click:${role}:${name}`); if (role === "button") state.open = true;
      else if (role === "menuitemradio") { state.selected = true; state.open = false; } },
    waitFor: async () => { if (!state.open) throw Error("not open"); },
    press: async (key: string) => { state.actions.push(key); state.value += key === "ArrowRight" ? 1 : -1; },
  });
  const page = { getByRole: (role: string, spec: { name: string; exact: boolean }) => { expect(spec.exact).toBeTrue(); return locator(role, spec.name); },
    keyboard: { press: async (key: string) => { state.actions.push(key); state.open = false; } },
    evaluate: () => { throw Error("Arbitrary JavaScript is prohibited"); },
    reload: () => { throw Error("Reload is prohibited"); },
  } as unknown as Page;
  return { page, state };
}

test("definition is explicit and rejects executable instructions, unsupported capabilities and inconsistent limits", () => {
  const value = definition(); validateWebModelDefinition(value);
  const cloned = cloneWebModelDefinition(value);
  if (value.selection.kind !== "menu") throw new Error("Expected a menu selection fixture");
  value.selection.trigger.name = "Changed";
  expect(cloned.selection).toMatchObject({ kind: "menu", trigger: { name: "Choose model" } });
  expect(() => validateWebModelDefinition({ ...definition(), selection: { ...definition().selection, evaluate: "arbitrary()" } })).toThrow("explicit fields");
  expect(() => validateWebModelDefinition({ ...definition(), capabilities: { tools: true, inputModalities: ["audio"] } })).toThrow("capabilities");
  expect(() => validateWebModelDefinition({ ...definition(), limits: { ...definition().limits, platformReserveTokens: 32000 } })).toThrow("Inconsistent");
});

test("an arbitrary model uses declared effort and capabilities without inheriting Sol or Pro", () => {
  const capabilities = { solAvailable: false, proAvailable: false, localToolsEnabled: true, webModelDefinition: definition() };
  const mode = resolveChatGptWebModelMode(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", capabilities);
  expect(mode.displayLabel).toBe("Future Model"); expect(mode.localTools).toBeFalse();
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "max", capabilities)).toThrow("immutable");
  expect(() => assertChatGptWebInputWithinLimits(10000, 10000, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", capabilities, 1000)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(29000, 28001, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, "high", capabilities, 1000)).toThrow("configured 28,000-token");
});

test("exact menu selection reopens its own popup and verifies the selected option", async () => {
  const { page, state } = semanticPage();
  await selectConfiguredWebModel(page, definition());
  expect(state.actions).toEqual(["click:button:Choose model", "click:menuitemradio:Future Model", "click:button:Choose model", "Escape"]);
});

test("ambiguous and non-popup controls fail before a model-selection click", async () => {
  for (const options of [{ duplicateTrigger: true }, { unsupportedTrigger: true }]) {
    const { page, state } = semanticPage(options);
    await expect(selectConfiguredWebModel(page, definition())).rejects.toHaveProperty("retryable", false);
    expect(state.actions).toEqual([]);
  }
  const { page, state } = semanticPage({ owner: "unrelated-menu" });
  await expect(selectConfiguredWebModel(page, definition())).rejects.toThrow("does not belong");
  expect(state.actions).not.toContain("click:menuitemradio:Future Model");
});

test("configured slider supports observed ranges beyond five presets and refuses a changed range", async () => {
  const model = definition();
  model.selection = { kind: "slider", trigger: { role: "button", name: "Choose model" }, scope: { role: "menu", name: "Models" },
    slider: { role: "slider", name: "Effort" }, control: { role: "menuitem", name: "Set effort" }, min: 0, max: 8, value: 7 };
  const good = semanticPage(); await selectConfiguredWebModel(good.page, model);
  expect(good.state.value).toBe(7); expect(good.state.actions.filter(action => action === "ArrowRight")).toHaveLength(7);
  const changed = semanticPage({ rangeMax: 7 });
  await expect(selectConfiguredWebModel(changed.page, model)).rejects.toThrow("range changed");
  expect(changed.state.actions).not.toContain("ArrowRight");
});

test("explicit image and platform reserves apply and text-only prompts are rejected before transport", () => {
  const model = definition();
  expect(estimateCompiledChatGptWebInputTokens({ text: "", images: [] }, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, model)).toBe(1024);
  const image = { ref: "test", imageUrl: "data:image/jpeg;base64,AAAA" };
  expect(() => estimateCompiledChatGptWebInputTokens({ text: "", images: [image] }, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, model)).toThrow("text only");
  model.capabilities.inputModalities.push("image"); model.limits.imageTokenReserveTokens = 321;
  expect(estimateCompiledChatGptWebInputTokens({ text: "", images: [image, image] }, CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, model)).toBe(1024 + 642);
  const parsed: CodexParsedRequest = { modelId: CHATGPT_WEB_CONFIGURED_BACKEND_MODEL, stream: true, options: { reasoning: "high" },
    context: { messages: [{ role: "user", content: [{ type: "image", imageUrl: image.imageUrl }], timestamp: 1 }] } };
  expect(() => compileChatGptWebPrompt(parsed, { localToolsEnabled: false, proAvailable: false, solAvailable: false, webModelDefinition: definition() })).toThrow("text only");
});
