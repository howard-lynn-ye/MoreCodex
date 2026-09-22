export interface WebModelControl<R extends string = string> { role: R; name: string }
type Trigger = WebModelControl<"button">;
type Scope = WebModelControl<"menu" | "listbox" | "dialog">;
export type WebModelSelection = {
  kind: "menu"; trigger: Trigger; scope: Scope;
  steps: Array<WebModelControl<"menuitem" | "menuitemradio" | "option" | "tab">>;
  verify: WebModelControl<"menuitemradio" | "option" | "tab"> & { state: "checked" | "selected" };
} | {
  kind: "slider"; trigger: Trigger; scope: Scope;
  slider: WebModelControl<"slider">;
  control: WebModelControl<"menuitem" | "slider">;
  min: number; max: number; value: number;
} | {
  /** ChatGPT composer picker: choose one exact model-family radio, then one effort-slider position. */
  kind: "effort-menu"; option: string;
  min: number; max: number; value: number;
};

/** Explicit behavior and capabilities, enrolled for this account's real catalogue entry. */
export interface WebModelDefinition {
  version: 1;
  slug: string;
  title: string;
  effort: { codex: "low" | "medium" | "high" | "xhigh" | "ultra"; adapter: "low" | "medium" | "high" | "xhigh" | "max" };
  capabilities: { tools: boolean; inputModalities: Array<"text" | "image"> };
  limits: {
    contextWindow: number; autoCompactTokenLimit: number;
    browserMessageTokenLimit: number; browserComposerCharLimit: number;
    platformReserveTokens: number; imageTokenReserveTokens: number;
  };
  selection: WebModelSelection;
}

function object(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
    throw new Error(`Invalid Web model definition ${label}; exact explicit fields are required`);
  }
}
function name(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= 160 && (allowEmpty || Boolean(value.trim())) && !/[\x00-\x1f\x7f]/.test(value);
}
function control(value: unknown, roles: string[], allowEmpty = false): void {
  object(value, ["role", "name"], "semantic control");
  if (!roles.includes(String(value.role)) || !name(value.name, allowEmpty)) throw new Error("Invalid Web model semantic control");
}
export function validateWebModelDefinition(value: unknown): asserts value is WebModelDefinition {
  object(value, ["version", "slug", "title", "effort", "capabilities", "limits", "selection"], "root");
  if (value.version !== 1 || typeof value.slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.slug) || !name(value.title)) {
    throw new Error("Invalid Web model identity");
  }
  object(value.effort, ["codex", "adapter"], "effort");
  if (!["low", "medium", "high", "xhigh", "ultra"].includes(String(value.effort.codex))
    || !["low", "medium", "high", "xhigh", "max"].includes(String(value.effort.adapter))) throw new Error("Invalid Web model effort");
  object(value.capabilities, ["tools", "inputModalities"], "capabilities");
  const modalities = value.capabilities.inputModalities;
  if (typeof value.capabilities.tools !== "boolean" || !Array.isArray(modalities)
    || !modalities.includes("text") || modalities.some(mode => mode !== "text" && mode !== "image")
    || new Set(modalities).size !== modalities.length) throw new Error("Invalid Web model input or tool capabilities");
  object(value.limits, ["contextWindow", "autoCompactTokenLimit", "browserMessageTokenLimit", "browserComposerCharLimit", "platformReserveTokens", "imageTokenReserveTokens"], "limits");
  const limits = value.limits;
  for (const [key, number] of Object.entries(limits)) {
    const reserve = key === "platformReserveTokens" || key === "imageTokenReserveTokens";
    if (!Number.isSafeInteger(number) || (number as number) < (reserve ? 0 : 1) || (number as number) > 100_000_000) throw new Error("Invalid Web model explicit limits");
  }
  if ((limits.autoCompactTokenLimit as number) >= (limits.contextWindow as number)
    || (limits.autoCompactTokenLimit as number) <= (limits.platformReserveTokens as number)
    || (limits.platformReserveTokens as number) >= (limits.contextWindow as number)
    || (limits.browserMessageTokenLimit as number) > (limits.contextWindow as number) - (limits.platformReserveTokens as number)
    || (modalities.includes("image") ? (limits.imageTokenReserveTokens as number) < 1 : limits.imageTokenReserveTokens !== 0)) {
    throw new Error("Inconsistent Web model context, transport, or image limits");
  }
  const selection = value.selection as Record<string, unknown>;
  if (selection?.kind === "menu") {
    object(selection, ["kind", "trigger", "scope", "steps", "verify"], "menu selection");
    if (!Array.isArray(selection.steps) || selection.steps.length < 1 || selection.steps.length > 8) throw new Error("Invalid Web model selection steps");
    for (const step of selection.steps) control(step, ["menuitem", "menuitemradio", "option", "tab"]);
    object(selection.verify, ["role", "name", "state"], "selected-state proof");
    const verification = selection.verify;
    if (!["menuitemradio", "option", "tab"].includes(String(verification.role)) || !name(verification.name)
      || (verification.role === "menuitemradio" ? verification.state !== "checked" : verification.state !== "selected")) {
      throw new Error("Web model selection requires an explicit compatible selected-state proof");
    }
  } else if (selection?.kind === "slider") {
    object(selection, ["kind", "trigger", "scope", "slider", "control", "min", "max", "value"], "slider selection");
    control(selection.slider, ["slider"], true);
    control(selection.control, ["menuitem", "slider"], true);
    if (![selection.min, selection.max, selection.value].every(Number.isSafeInteger)
      || (selection.min as number) < 0 || (selection.max as number) < (selection.min as number)
      || (selection.max as number) - (selection.min as number) > 100
      || (selection.value as number) < (selection.min as number) || (selection.value as number) > (selection.max as number)) {
      throw new Error("Invalid Web model slider range");
    }
  } else if (selection?.kind === "effort-menu") {
    object(selection, ["kind", "option", "min", "max", "value"], "effort-menu selection");
    if (!name(selection.option) || ![selection.min, selection.max, selection.value].every(Number.isSafeInteger)
      || (selection.min as number) < 0 || (selection.max as number) < (selection.min as number)
      || (selection.max as number) - (selection.min as number) > 100
      || (selection.value as number) < (selection.min as number) || (selection.value as number) > (selection.max as number)) {
      throw new Error("Invalid Web model effort-menu selection");
    }
    return;
  } else throw new Error("Unsupported Web model selection kind");
  control(selection.trigger, ["button"]);
  control(selection.scope, ["menu", "listbox", "dialog"], true);
}

export function cloneWebModelDefinition(value: unknown): WebModelDefinition {
  validateWebModelDefinition(value);
  return structuredClone(value);
}
