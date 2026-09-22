import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { ExternalRetainedPages } from "../src/adapters/chatgpt-web/external-retained";

const page = () => ({ isClosed: () => false }) as Page;
function deferred() { let done!: () => void; return { promise: new Promise<void>(resolve => { done = resolve; }), done: () => done() }; }

test("only the same account/model store can resume its exact connector-bound page", async () => {
  let created = 0;
  const closed: Page[] = [];
  const store = new ExternalRetainedPages(async () => { created += 1; return page(); }, async item => { closed.push(item); });
  const other = new ExternalRetainedPages(async () => { throw Error("must not allocate a fallback"); }, async () => {});
  const first = await store.acquire("thread-model-epoch", false);
  await first.finish(true, true);
  const resumed = await store.acquire("thread-model-epoch", true);
  expect(resumed.page).toBe(first.page);
  expect(resumed.reused).toBeTrue();
  await expect(other.acquire("thread-model-epoch", true)).rejects.toHaveProperty("code", "compaction_source_unavailable");
  expect(created).toBe(1);
  await resumed.finish(false, true);
  expect(closed).toEqual([first.page]);
  await expect(store.acquire("thread-model-epoch", true)).rejects.toHaveProperty("code", "compaction_source_unavailable");
});

test("interruption cleanup prevents a replacement owner until physical closure completes", async () => {
  const closing = deferred();
  let created = 0;
  const store = new ExternalRetainedPages(async () => { created += 1; return page(); }, () => closing.promise);
  const active = await store.acquire("one", false);
  const finish = active.finish(false, false);
  await expect(store.acquire("one", false)).rejects.toHaveProperty("code", "external_retained_owner_busy");
  expect(created).toBe(1);
  closing.done();
  await finish;
  const next = await store.acquire("one", false);
  expect(next.reused).toBeFalse();
  expect(created).toBe(2);
  await next.finish(false, false);
});

test("failed physical cleanup quarantines the key instead of silently replacing its page", async () => {
  let created = 0;
  const store = new ExternalRetainedPages(async () => { created += 1; return page(); }, async () => { throw Error("closure unconfirmed"); });
  const active = await store.acquire("one", false);
  await expect(active.finish(false, false)).rejects.toThrow("closure unconfirmed");
  await expect(store.acquire("one", false)).rejects.toHaveProperty("code", "external_retained_owner_busy");
  expect(created).toBe(1);
  await expect(store.retire("one")).rejects.toThrow("closure unconfirmed");
});

test("retirement during an active turn waits and prevents its successful outcome from retaining the page", async () => {
  let closed = 0;
  const store = new ExternalRetainedPages(async () => page(), async () => { closed += 1; });
  const active = await store.acquire("one", false);
  let retired = false;
  const retirement = store.retire("one").then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBeFalse();
  await active.finish(true, true);
  await retirement;
  expect(closed).toBe(1);
  await expect(store.acquire("one", true)).rejects.toHaveProperty("code", "compaction_source_unavailable");
});

test("unbound pages are never retained and capacity does not evict an existing checkpoint", async () => {
  let closed = 0;
  const store = new ExternalRetainedPages(async () => page(), async () => { closed += 1; }, 1);
  const unbound = await store.acquire("unbound", false);
  await unbound.finish(true, false);
  const bound = await store.acquire("bound", false);
  await bound.finish(true, true);
  await expect(store.acquire("new", false)).rejects.toHaveProperty("code", "external_retained_capacity");
  const resumed = await store.acquire("bound", true);
  expect(resumed.page).toBe(bound.page);
  await resumed.finish(true, true);
  await store.close();
  expect(closed).toBe(2);
  await expect(store.acquire("after-close", false)).rejects.toHaveProperty("code", "external_browser_closed");
});
