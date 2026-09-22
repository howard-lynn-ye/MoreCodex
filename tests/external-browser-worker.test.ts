import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker, ExternalBrowserWorkerPool, resolveBrowserConfig, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ExternalBrowserError, type ExternalBrowserConnection, type ExternalBrowserOptions } from "../src/external-browser";
import { ChatGptWebAdapterError, ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import type { CodexProviderConfig } from "../src/types";

const options: ExternalBrowserOptions = {
  userDataDir: resolve("test-existing-browser"), email: "account@example.test",
  userId: "user-enrolled", accountId: "workspace-enrolled",
};
const provider = (): CodexProviderConfig => ({
  adapter: "chatgpt-web", baseUrl: "https://chatgpt.com",
  chatgptWeb: { browserHost: "external-cdp", externalBrowser: { ...options },
    accountIdentity: { label: "Research", userId: options.userId!, accountId: options.accountId! } },
});

test("external requests fail closed without a matching enrolled account and workspace", () => {
  const valid = provider();
  expect(resolveBrowserConfig(valid).browserHost).toBe("external-cdp");
  delete valid.chatgptWeb!.accountIdentity;
  expect(() => resolveBrowserConfig(valid)).toThrow("run account discovery first");
  const mismatched = provider();
  mismatched.chatgptWeb!.externalBrowser!.accountId = "other-workspace";
  expect(() => resolveBrowserConfig(mismatched)).toThrow("run account discovery first");
  const mixed = provider();
  mixed.chatgptWeb!.browserHostDescriptorPath = resolve("other-launcher.json");
  expect(() => resolveBrowserConfig(mixed)).toThrow("cannot also use a launcher descriptor");
});

test("model workers share account connection while other accounts remain independent", async () => {
  let connects = 0;
  const closed: number[] = [];
  const pool = new ExternalBrowserWorkerPool(async () => {
    const id = ++connects;
    return { close: async () => { closed.push(id); } } as unknown as ExternalBrowserConnection;
  });
  const firstModel = pool.acquire(options);
  const secondModel = pool.acquire({ ...options });
  const otherAccount = pool.acquire({ ...options, email: "other@example.test", userId: "user-other" });
  expect(await firstModel.ready).toBe(await secondModel.ready);
  expect(await firstModel.ready).not.toBe(await otherAccount.ready);
  expect(connects).toBe(2);
  await firstModel.release();
  expect(closed).toEqual([]);
  await otherAccount.release();
  expect(closed).toEqual([2]);
  await secondModel.release();
  await secondModel.release();
  expect(closed).toEqual([2, 1]);
});

test("a later selection cannot mutate an existing worker's account or model binding", () => {
  const configured = provider();
  configured.chatgptWeb!.modelBinding = {
    accountId: "research", publicModelId: "chatgpt-web/research/model-1",
    webModelSlug: "actual-model-1",
  };
  const resolved = resolveBrowserConfig(configured);
  configured.chatgptWeb!.accountIdentity!.userId = "user-other";
  configured.chatgptWeb!.externalBrowser!.accountId = "workspace-other";
  configured.chatgptWeb!.modelBinding!.webModelSlug = "actual-model-2";
  expect(resolved.accountIdentity!.userId).toBe("user-enrolled");
  expect(resolved.externalBrowser!.accountId).toBe("workspace-enrolled");
  expect(resolved.modelBinding!.webModelSlug).toBe("actual-model-1");
});

test("external worker refuses required retained compaction before preparing or opening a page", async () => {
  const configured = provider();
  configured.chatgptWeb!.appName = "External review";
  const worker = ChatGptBrowserWorker.forProvider(configured);
  let opened = 0;
  let prepared = 0;
  const internals = worker as unknown as {
    runExclusive(turn: BrowserTurn): Promise<string>;
    runBrowserTurn(turn: BrowserTurn): Promise<string>;
  };
  internals.runBrowserTurn = async () => { opened += 1; return "should not run"; };
  const turn = { traceId: "retained-review", requireRetainedConversation: true,
    prepare: async () => { prepared += 1; throw Error("must not prepare"); } } as unknown as BrowserTurn;
  await expect(internals.runExclusive(turn)).rejects.toHaveProperty("code", "compaction_source_unavailable");
  expect({ opened, prepared }).toEqual({ opened: 0, prepared: 0 });
  const abort = new AbortController();
  abort.abort();
  await expect(internals.runExclusive({ ...turn, requireRetainedConversation: false, abortSignal: abort.signal })).rejects.toHaveProperty("name", "AbortError");
  expect(opened).toBe(0);
});

test("external worker hands compaction the same owned page and waits for its release", async () => {
  const configured = provider();
  configured.chatgptWeb!.appName = "External retained worker review";
  const worker = ChatGptBrowserWorker.forProvider(configured);
  let created = 0;
  let released = 0;
  const ownedPage = { isClosed: () => false } as Page;
  const internals = worker as unknown as {
    externalConnection: { ready: Promise<ExternalBrowserConnection>; release(): Promise<void> };
    runExclusive(turn: BrowserTurn): Promise<string>;
    runBrowserTurn(turn: BrowserTurn, surface?: string, page?: Page, reused?: boolean): Promise<string>;
  };
  internals.externalConnection = { ready: Promise.resolve({ assertReady() {}, createPage: async () => {
    created += 1;
    return { page: ownedPage, verifyIdentity: async () => {}, release: async () => { released += 1; } };
  } } as unknown as ExternalBrowserConnection), release: async () => {} };
  const observations: Array<{ page?: Page; reused?: boolean }> = [];
  internals.runBrowserTurn = async (turn, _surface, owned, reused) => {
    observations.push({ page: owned, reused });
    if (turn.requireRetainedConversation) throw new ChatGptCompactionHandoffAccepted();
    return "completed";
  };
  const turn = { traceId: "retained-source", conversationKey: "thread-model-epoch", retainConversation: true,
    capabilities: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    prepare: async () => ({ text: "source", images: [], release() {} }) } as unknown as BrowserTurn;
  await internals.runExclusive(turn);
  expect(released).toBe(0);
  await expect(internals.runExclusive({ ...turn, traceId: "retained-compact", retainConversation: false,
    requireRetainedConversation: true, prepareResume: turn.prepare })).rejects.toBeInstanceOf(ChatGptCompactionHandoffAccepted);
  expect(observations).toEqual([{ page: ownedPage, reused: false }, { page: ownedPage, reused: true }]);
  expect({ created, released }).toEqual({ created: 1, released: 1 });
  await expect(internals.runExclusive({ ...turn, requireRetainedConversation: true })).rejects.toHaveProperty("code", "compaction_source_unavailable");
  await worker.close();
});

test("a declined or failed external connection does not prompt again on later model requests", async () => {
  let connects = 0;
  const pool = new ExternalBrowserWorkerPool(async () => {
    connects += 1;
    throw new ExternalBrowserError("external_browser_connection_failed", "Browser did not authorize connection");
  });
  const first = pool.acquire(options);
  await expect(first.ready).rejects.toHaveProperty("retryable", false);
  const second = pool.acquire({ ...options });
  await expect(second.ready).rejects.toHaveProperty("code", "external_browser_connection_failed");
  expect(connects).toBe(1);
  await first.release();
  await second.release();
});

test("worker only verifies and releases leased external pages and preserves terminal errors", async () => {
  const worker = ChatGptBrowserWorker.forProvider(provider());
  let verified = 0;
  let released = 0;
  let poolReleased = 0;
  let pageClose = 0;
  const ownedPage = { isClosed: () => false, close: async () => { pageClose += 1; } } as unknown as Page;
  const foreignPage = { isClosed: () => false, close: async () => { throw Error("User tab was closed"); } } as unknown as Page;
  const connection = {
    assertReady: () => {},
    createPage: async () => ({ page: ownedPage, targetId: "owned", identity: { userId: options.userId!, accountId: options.accountId! },
      verifyIdentity: async () => { verified += 1; }, release: async () => { released += 1; } }),
  } as unknown as ExternalBrowserConnection;
  const internals = worker as unknown as {
    externalConnection: { ready: Promise<ExternalBrowserConnection>; release(): Promise<void> };
    pageForNewTurn(): Promise<Page>;
    verifyPageAccount(page: Page): Promise<void>;
    releaseTurnPage(page: Page): Promise<void>;
    externalAdapterError(error: unknown): unknown;
  };
  internals.externalConnection = { ready: Promise.resolve(connection), release: async () => { poolReleased += 1; } };
  expect(await internals.pageForNewTurn()).toBe(ownedPage);
  await internals.verifyPageAccount(ownedPage);
  await expect(internals.verifyPageAccount(foreignPage)).rejects.toThrow("not owned");
  await expect(internals.releaseTurnPage(foreignPage)).rejects.toThrow("not owned");
  await internals.releaseTurnPage(ownedPage);
  expect({ verified, released, pageClose }).toEqual({ verified: 1, released: 1, pageClose: 0 });
  const error = internals.externalAdapterError(new ExternalBrowserError("external_browser_disconnected", "Connection ended"));
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error).toHaveProperty("code", "external_browser_disconnected");
  expect(error).toHaveProperty("retryable", false);
  await worker.close();
  expect(poolReleased).toBe(1);
});

test("shutdown releases the account connection even when retained physical cleanup fails", async () => {
  const configured = provider();
  configured.chatgptWeb!.appName = "External shutdown review";
  const worker = ChatGptBrowserWorker.forProvider(configured);
  let disconnected = 0;
  const internals = worker as unknown as {
    externalRetainedPages: { close(): Promise<void> };
    externalConnection: { ready: Promise<ExternalBrowserConnection>; release(): Promise<void> };
  };
  internals.externalRetainedPages = { close: async () => { throw Error("physical cleanup unconfirmed"); } };
  internals.externalConnection = { ready: Promise.resolve({} as ExternalBrowserConnection), release: async () => { disconnected += 1; } };
  await expect(worker.close()).rejects.toBeInstanceOf(AggregateError);
  expect(disconnected).toBe(1);
});
