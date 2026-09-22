import type { Locator, Page } from "playwright-core";
import { cloneWebModelDefinition, type WebModelControl, type WebModelDefinition } from "../../web-model-definition";
import { ChatGptWebAdapterError } from "./adapter-error";

const failure = (message: string) => new ChatGptWebAdapterError(message, {
  status: 409, errorType: "invalid_request_error", code: "web_model_selection_unavailable", retryable: false,
});
type Role = Parameters<Page["getByRole"]>[0];
function byControl(parent: Page | Locator, control: WebModelControl, includeHidden = false): Locator {
  return parent.getByRole(control.role as Role, { name: control.name, exact: true, ...(includeHidden ? { includeHidden: true } : {}) });
}
async function exactOne(locator: Locator, hiddenSemanticInput = false): Promise<Locator> {
  const selected = hiddenSemanticInput ? locator : locator.filter({ visible: true });
  const count = await selected.count();
  if (count !== 1) throw failure(`Configured model control resolved to ${count} elements; exactly one is required. No alternate model was selected.`);
  return selected;
}
function integer(value: string | null): number {
  if (value === null || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure("Configured model slider did not expose integer ARIA state");
  return Number(value);
}

const COMPOSER = '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]';
const EFFORT_CONTROL = 'button[aria-haspopup="menu"][data-tone="neutral"], button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]';
const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Composer picker: one exact family radio, then one verified slider position. Never rewrites a request. */
async function selectEffortMenuModel(page: Page, selection: Extract<WebModelDefinition["selection"], { kind: "effort-menu" }>): Promise<void> {
  let opened = false;
  try {
    const composer = page.locator(COMPOSER).filter({ visible: true }).first();
    await composer.waitFor({ state: "visible", timeout: 70_000 });
    const control = composer.locator("xpath=ancestor::form[1]").locator(EFFORT_CONTROL).last();
    await control.waitFor({ state: "visible", timeout: 70_000 });
    const radios = () => page.locator('[role="menuitemradio"]').filter({ visible: true });
    const menuShown = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (await radios().count() === 0 && Date.now() < deadline) await pause(100);
      return await radios().count() > 0;
    };
    const open = async () => {
      if (await radios().count() > 0) return;
      // A transient page dialog can swallow the first click; retry click, then a primary pointerdown.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await control.getAttribute("aria-expanded") === "true" || await control.getAttribute("data-state") === "open") {
          await page.keyboard.press("Escape").catch(() => {}); await pause(200);
        }
        opened = true;
        await control.click({ force: true, timeout: 10_000 }).catch(() => {});
        if (await menuShown(4_000)) return;
        await control.dispatchEvent("pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true });
        if (await menuShown(4_000)) return;
        await page.keyboard.press("Escape").catch(() => {}); await pause(1_000);
      }
      throw failure("Model menu did not open; no prompt was submitted");
    };
    const find = async () => {
      const labels = await radios().evaluateAll(elements => elements.map(element =>
        [String(element.textContent ?? "").replace(/\s+/g, " ").trim(), element.getAttribute("aria-checked")] as const));
      const matches = labels.map((label, index) => label[0] === normalize(selection.option) ? index : -1).filter(index => index >= 0);
      if (matches.length !== 1) throw failure(`Model menu option "${selection.option}" resolved to ${matches.length} entries; no alternative was selected`);
      return { index: matches[0]!, checked: labels[matches[0]!]![1] === "true" };
    };
    await open();
    let option = await find();
    if (!option.checked) {
      await radios().nth(option.index).click({ force: true, timeout: 10_000 });
      await pause(600);
      const deadline = Date.now() + 5_000;
      for (;;) {
        await open(); option = await find();
        if (option.checked || Date.now() > deadline) break;
        await pause(200);
      }
      if (!option.checked) throw failure(`Model menu option "${selection.option}" did not become selected; no prompt was submitted`);
    }
    // The slider belongs to the same open picker as the family radios (it may be a zero-size semantic node).
    await open();
    const slider = radios().first().locator("xpath=ancestor::*[.//*[@data-model-reasoning-effort-slider]][1]")
      .locator('[data-model-reasoning-effort-slider] [role="slider"]').first();
    await slider.waitFor({ state: "attached", timeout: 10_000 });
    const state = async () => {
      const min = integer(await slider.getAttribute("aria-valuemin"));
      const max = integer(await slider.getAttribute("aria-valuemax"));
      const value = integer(await slider.getAttribute("aria-valuenow"));
      // Pro can be hidden temporarily (usage limit), which only removes the top position.
      if (min !== selection.min || max < selection.value || max > selection.max || value < min || value > max) {
        throw failure(`Model effort slider range changed (min=${min}; max=${max}); refusing to infer a replacement model`);
      }
      return value;
    };
    // The semantic slider owns keyboard events even when its visual box is hidden.
    const keys = slider;
    let current = await state();
    while (current !== selection.value) {
      const direction = selection.value > current ? 1 : -1;
      const previous = current;
      await keys.press(direction > 0 ? "ArrowRight" : "ArrowLeft", { timeout: 10_000 });
      const deadline = Date.now() + 5_000;
      do { current = await state(); if (current !== previous) break; await pause(50); } while (Date.now() < deadline);
      if (current !== previous + direction) throw failure(`Model effort slider did not move exactly one verified step (before=${previous}; after=${current})`);
    }
    option = await find();
    if (!option.checked) throw failure(`Model menu option "${selection.option}" lost its selected state; no prompt was submitted`);
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) throw error;
    throw failure(`Model menu/effort controls are unavailable or changed (${String((error as Error)?.message ?? error).slice(0, 160)}); no alternative selection was attempted`);
  } finally {
    if (opened) await page.keyboard.press("Escape").catch(() => {});
  }
}

/** Operates only exact semantic controls on a bridge-owned page; never rewrites a model request. */
export async function selectConfiguredWebModel(page: Page, configured: WebModelDefinition): Promise<void> {
  const definition = cloneWebModelDefinition(configured);
  if (definition.selection.kind === "effort-menu") return selectEffortMenuModel(page, definition.selection);
  const selection = definition.selection;
  let opened = false;
  const trigger = await exactOne(byControl(page, selection.trigger));
  const popup = await trigger.getAttribute("aria-haspopup");
  if (popup !== selection.scope.role && !(popup === "true" && selection.scope.role === "menu")) {
    throw failure("Configured model trigger does not own the declared popup type; no click was performed");
  }
  const scopeLocator = byControl(page, selection.scope).filter({ visible: true });
  const openScope = async (): Promise<Locator> => {
    if (await scopeLocator.count() === 0) {
      opened = true;
      await trigger.click({ timeout: 10_000 });
      await scopeLocator.waitFor({ state: "visible", timeout: 10_000 });
    }
    const scope = await exactOne(scopeLocator);
    const ownedIds = await trigger.getAttribute("aria-controls");
    if (ownedIds && !ownedIds.split(/\s+/).includes(await scope.getAttribute("id") ?? "")) {
      throw failure("Configured model popup does not belong to its declared trigger");
    }
    return scope;
  };
  try {
    let scope = await openScope();
    if (selection.kind === "menu") {
      for (const step of selection.steps) {
        const choice = await exactOne(byControl(scope, step));
        opened = true;
        await choice.click({ timeout: 10_000 });
      }
      scope = await openScope();
      const proof = await exactOne(byControl(scope, selection.verify));
      const proofDeadline = Date.now() + 3_000;
      let selected = await proof.getAttribute(`aria-${selection.verify.state}`) === "true";
      while (!selected && Date.now() < proofDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        selected = await proof.getAttribute(`aria-${selection.verify.state}`) === "true";
      }
      if (!selected) {
        throw failure("Configured model's exact option did not report its selected state; no prompt was submitted");
      }
    } else {
      const slider = await exactOne(byControl(scope, selection.slider, true), true);
      const keyboard = await exactOne(byControl(scope, selection.control));
      const state = async () => {
        const min = integer(await slider.getAttribute("aria-valuemin"));
        const max = integer(await slider.getAttribute("aria-valuemax"));
        const value = integer(await slider.getAttribute("aria-valuenow"));
        if (min !== selection.min || max !== selection.max || value < min || value > max) {
          throw failure("Configured model slider range changed; refusing to infer a replacement model");
        }
        return value;
      };
      let current = await state();
      while (current !== selection.value) {
        const direction = selection.value > current ? 1 : -1;
        const previous = current;
        await keyboard.press(direction > 0 ? "ArrowRight" : "ArrowLeft", { timeout: 10_000 });
        const deadline = Date.now() + 3_000;
        do {
          current = await state();
          if (current !== previous) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (current !== previous + direction) throw failure("Configured model slider did not move exactly one verified step");
      }
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) throw error;
    throw failure("Configured model controls are unavailable or changed; no alternative selection or request rewrite was attempted");
  } finally {
    if (opened) await page.keyboard.press("Escape").catch(() => {});
  }
}
