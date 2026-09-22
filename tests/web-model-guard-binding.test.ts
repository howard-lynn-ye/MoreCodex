import { expect, test } from "bun:test";
import { installWebModelGuard } from "../src/web-model-guard";

async function outgoingRequest(workspace: string | undefined, model = "actual-model") {
  let intercept: any;
  const actions: string[] = [];
  const cdp = { async send(method: string) { actions.push(method); return {}; }, on() {}, async detach() {} };
  const page = { context: () => ({ async newCDPSession() { return cdp; } }),
    async route(_url: unknown, handler: any) { intercept = handler; }, async unroute() {} };
  const guard = await installWebModelGuard(page as any,
    { accountId: "enrolled", publicModelId: "chatgpt-web/enrolled/model", webModelSlug: "actual-model" },
    { label: "Test account", userId: "user-enrolled", accountId: "workspace-enrolled" }, "binding-test");
  const body = JSON.stringify({ model, messages: [] });
  await intercept({ request: () => ({ method: () => "POST", postDataJSON: () => JSON.parse(body), postData: () => body,
    async allHeaders() { return workspace ? { "chatgpt-account-id": workspace } : {}; } }),
    async continue() { actions.push("forwarded"); }, async abort() { actions.push("blocked"); } });
  return { guard, actions };
}

test("missing workspace proof is blocked before any Web request is forwarded", async () => {
  const { guard, actions } = await outgoingRequest(undefined);
  expect(actions).toContain("blocked"); expect(actions).not.toContain("forwarded");
  expect(() => guard.check()).toThrow("No fallback"); await guard.dispose();
});
test("a workspace switch between session verification and submission is blocked", async () => {
  const { guard, actions } = await outgoingRequest("workspace-other");
  expect(actions).toContain("blocked"); expect(actions).not.toContain("forwarded");
  expect(() => guard.check()).toThrow("selected account/model"); await guard.dispose();
});
test("the selected workspace and model are forwarded together", async () => {
  const { guard, actions } = await outgoingRequest("workspace-enrolled");
  expect(actions).toContain("forwarded"); expect(actions).not.toContain("blocked");
  expect(() => guard.check()).not.toThrow();
  // Outgoing identity alone still cannot establish a successful upstream model response.
  expect(() => guard.assertComplete()).toThrow("actual response model was not verified"); await guard.dispose();
});
test("a silent model switch is blocked even in the selected workspace", async () => {
  const { guard, actions } = await outgoingRequest("workspace-enrolled", "different-model");
  expect(actions).toContain("blocked"); expect(actions).not.toContain("forwarded");
  expect(() => guard.check()).toThrow("selected account/model"); await guard.dispose();
});
