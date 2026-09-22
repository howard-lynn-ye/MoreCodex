import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, ConnectOverCDPOptions, ConnectOverCDPTransport } from "playwright-core";
import { createExternalCdpTransport, ExternalBrowserConnection, ExternalBrowserError, readExternalBrowserEndpoint } from "../src/external-browser";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function profile(content = "9222\n/devtools/browser/a-valid-local-id\n") {
  const dir = mkdtempSync(join(tmpdir(), "external-browser-test-")); roots.push(dir);
  writeFileSync(join(dir, "DevToolsActivePort"), content); return dir;
}

test("real rendezvous files accept only a canonical local port and browser path", () => {
  expect(readExternalBrowserEndpoint(profile())).toBe("ws://127.0.0.1:9222/devtools/browser/a-valid-local-id");
  expect(readExternalBrowserEndpoint(profile("1\r\n/devtools/browser/x\r\n"))).toBe("ws://127.0.0.1:1/devtools/browser/x");
  for (const content of ["0\n/devtools/browser/x", "65536\n/devtools/browser/x", "09222\n/devtools/browser/x", "9222\nws://evil.test/x", "9222\n//evil.test", "9222\n/devtools/browser/../x", "9222\n/devtools/browser/x?secret=1", "9222\n/devtools/browser/x\nextra", "9222\n/devtools/browser/x\n\n"]) {
    expect(() => readExternalBrowserEndpoint(profile(content))).toThrow(ExternalBrowserError);
  }
  expect(() => readExternalBrowserEndpoint("relative")).toThrow("must be absolute");
  const missing = mkdtempSync(join(tmpdir(), "external-browser-test-")); roots.push(missing);
  expect(() => readExternalBrowserEndpoint(missing)).toThrow("No browser was started");
});

function fixture() {
  const commands: Array<{ method: string; params: any }> = [];
  const originalMutations: string[] = [];
  let connected = true; let disconnected: (() => void) | undefined; let transportClosed = 0;
  let observedOptions: ConnectOverCDPOptions | undefined;
  let closeBehavior: ((targetId: string, attempt: number) => { success: boolean }) | undefined;
  let closeAttempts = 0;
  let rejectFocus = false;
  const inputSessions: Array<{ targetId: string; focus: boolean; detached: boolean }> = [];
  const original: any = { id: "original", observation: { state: "match", userId: "user-test", accountId: "workspace-test" },
    url: () => "https://chatgpt.com/", isClosed: () => false,
    evaluate: async () => original.observation,
    goto: () => { originalMutations.push("goto"); throw Error("original page must not navigate"); },
    reload: () => { originalMutations.push("reload"); throw Error("original page must not refresh"); },
    close: () => { originalMutations.push("close"); throw Error("original page must not close"); },
  };
  const pages: any[] = [original];
  const context: any = { pages: () => pages,
    newCDPSession: async (page: any) => {
      const session = { targetId: page.id, focus: false, detached: false };
      inputSessions.push(session);
      return {
        send: async (method: string, params: any) => {
          if (method === "Target.getTargetInfo") return { targetInfo: { targetId: page.id, browserContextId: "original-context" } };
          if (method === "Emulation.setFocusEmulationEnabled") {
            if (page === original) { originalMutations.push(method); throw Error("Do not change user page focus"); }
            if (rejectFocus) throw Error("Focus unavailable");
            session.focus = params.enabled; return {};
          }
          throw Error("Unexpected page command");
        },
        detach: async () => { session.detached = true; },
      };
    },
    close: () => { throw Error("context must not close"); },
    storageState: () => { throw Error("session must not be exported"); },
  };
  const root: any = { send: async (method: string, params: any) => {
    commands.push({ method, params });
    if (method === "Target.createTarget") {
      const page: any = { id: `owned-${pages.length}`, currentUrl: "about:blank", url: () => page.currentUrl, isClosed: () => false,
        evaluate: async () => original.observation, goto: async (url: string) => { page.currentUrl = url; } };
      pages.push(page); return { targetId: page.id };
    }
    if (method === "Target.closeTarget") {
      closeAttempts++;
      if (closeBehavior) return closeBehavior(params.targetId, closeAttempts);
      const index = pages.findIndex(page => page.id === params.targetId); if (index >= 0) pages.splice(index, 1); return { success: true };
    }
    if (method === "Target.getTargets") return { targetInfos: pages.map(page => ({ targetId: page.id })) };
    throw Error("unexpected mutation");
  } };
  const browser: any = { contexts: () => [context], isConnected: () => connected, newBrowserCDPSession: async () => root,
    on: (_: string, handler: () => void) => { disconnected = handler; },
    close: () => { throw Error("Browser.close must never be called"); },
  };
  const transport: ConnectOverCDPTransport = { send() {}, close() { transportClosed++; connected = false; disconnected?.(); } };
  let now = 1000;
  return { original, context, pages, commands, originalMutations, browser, transport, inputSessions,
    rejectFocus() { rejectFocus = true; },
    closeWith(callback: (targetId: string, attempt: number) => { success: boolean }) { closeBehavior = callback; },
    drop() { connected = false; disconnected?.(); }, advance() { now += 1001; },
    closedCount: () => transportClosed, connectOptions: () => observedOptions,
    connect: (connectionTtlMs: number | undefined = 1000) => ExternalBrowserConnection.connect({ userDataDir: profile(), email: "enrolled@example.test", ...(connectionTtlMs ? { connectionTtlMs } : {}) }, {
      transport: () => transport, connect: async (_, options) => { observedOptions = options; return browser as Browser; }, now: () => now,
    }),
  };
}

test("one verified connection creates only owned background targets in the verified context; release preserves originals", async () => {
  const f = fixture(); const connection = await f.connect();
  expect(f.connectOptions()?.noDefaults).toBe(true);
  const first = await connection.createPage(); const second = await connection.createPage();
  expect(f.commands.filter(row => row.method === "Target.createTarget").every(row => row.params.background === true && row.params.newWindow === false && row.params.browserContextId === "original-context")).toBe(true);
  await first.page.goto("https://chatgpt.com/?temporary-chat=true"); await first.verifyIdentity();
  await first.release(); await first.release();
  await expect(first.verifyIdentity()).rejects.toThrow("no longer owned");
  await connection.close(); await connection.close();
  expect(f.pages).toEqual([f.original]); expect(f.originalMutations).toEqual([]);
  expect(f.commands.filter(row => row.method === "Target.closeTarget").map(row => row.params.targetId)).toEqual([first.targetId, second.targetId]);
  expect(f.closedCount()).toBe(1);
});

test("background input focus stays enabled only for owned targets until release", async () => {
  const f = fixture(); const connection = await f.connect(0);
  const first = await connection.createPage(); const second = await connection.createPage();
  const focused = f.inputSessions.filter(session => session.focus);
  expect(focused.map(session => session.targetId)).toEqual([first.targetId, second.targetId]);
  expect(focused.every(session => !session.detached)).toBe(true);
  await first.release();
  expect(focused.map(session => session.detached)).toEqual([true, false]);
  expect(f.originalMutations).toEqual([]);
  await connection.close();
  expect(focused.every(session => session.detached)).toBe(true);
});

test("failed input focus setup cleans up its owned page without returning a lease", async () => {
  const f = fixture(); const connection = await f.connect(0);
  f.rejectFocus();
  await expect(connection.createPage()).rejects.toMatchObject({ code: "external_browser_page_unavailable" });
  expect(f.pages).toEqual([f.original]);
  expect(f.inputSessions.every(session => session.detached)).toBe(true);
  expect(f.originalMutations).toEqual([]);
  expect(() => connection.assertReady()).not.toThrow();
  await connection.close();
});

test("release retries only its exact owned target and waits for physical disappearance", async () => {
  const f = fixture(); const connection = await f.connect(0); const lease = await connection.createPage();
  f.closeWith((targetId, attempt) => {
    if (attempt === 1) return { success: false };
    f.pages.splice(f.pages.findIndex(page => page.id === targetId), 1);
    return { success: true };
  });
  await Promise.all([lease.release(), lease.release()]);
  expect(f.commands.filter(row => row.method === "Target.closeTarget").map(row => row.params.targetId)).toEqual([lease.targetId, lease.targetId]);
  expect(f.commands.filter(row => row.method === "Target.getTargets")).toHaveLength(2);
  expect(f.pages).toEqual([f.original]); expect(() => connection.assertReady()).not.toThrow();
  await connection.close();
});

test("an ambiguous close can succeed only when the exact target is already physically absent", async () => {
  const f = fixture(); const connection = await f.connect(0); const lease = await connection.createPage();
  f.closeWith(targetId => {
    f.pages.splice(f.pages.findIndex(page => page.id === targetId), 1);
    throw Error("private CDP detail must not leak");
  });
  await lease.release();
  expect(f.commands.filter(row => row.method === "Target.closeTarget")).toHaveLength(1);
  expect(() => connection.assertReady()).not.toThrow(); await connection.close();
});

test("failed physical cleanup keeps ownership and quarantines without another target or reconnect", async () => {
  const f = fixture(); const connection = await f.connect(0); const lease = await connection.createPage();
  f.closeWith(() => ({ success: false }));
  await expect(lease.release()).rejects.toMatchObject({ code: "external_browser_cleanup_failed", retryable: false });
  await expect(lease.verifyIdentity()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  await expect(lease.release()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  await expect(connection.createPage()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  await expect(connection.close()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  expect(f.closedCount()).toBe(1);
  expect(f.commands.filter(row => row.method === "Target.createTarget")).toHaveLength(1);
  expect(f.commands.filter(row => row.method === "Target.closeTarget").map(row => row.params.targetId)).toEqual([lease.targetId, lease.targetId]);
  expect(f.pages).toContain(f.original); expect(f.pages).toContain(lease.page);
  expect(f.originalMutations).toEqual([]);
});

test("success acknowledgement with a still-present owned target is not accepted as cleanup", async () => {
  const f = fixture(); const connection = await f.connect(0); const lease = await connection.createPage();
  f.closeWith(() => ({ success: true }));
  await expect(lease.release()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  expect(f.pages).toContain(lease.page);
  await expect(connection.close()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
});

test("disconnection is not proof that an owned target physically closed", async () => {
  const f = fixture(); const connection = await f.connect(0); const lease = await connection.createPage(); f.drop();
  await expect(lease.release()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  await expect(connection.close()).rejects.toMatchObject({ code: "external_browser_cleanup_failed" });
  expect(f.commands.filter(row => row.method === "Target.closeTarget")).toHaveLength(0);
  expect(f.pages).toContain(lease.page); expect(f.pages).toContain(f.original);
});

test("initial wrong account fails closed before allocating any target and does not disclose metadata", async () => {
  const f = fixture(); f.original.observation = { state: "different" };
  try { await f.connect(); throw Error("must fail"); }
  catch (error) {
    expect(error).toBeInstanceOf(ExternalBrowserError);
    expect((error as ExternalBrowserError).code).toBe("external_browser_identity_mismatch");
    expect(String(error)).not.toContain("enrolled@example.test");
  }
  expect(f.commands).toEqual([]); expect(f.originalMutations).toEqual([]); expect(f.closedCount()).toBe(1);
});

test("duplicate matching contexts are rejected instead of selecting the first account", async () => {
  const f = fixture(); const second = { ...f.context };
  f.browser.contexts = () => [f.context, second];
  await expect(f.connect()).rejects.toMatchObject({ code: "external_browser_identity_ambiguous" });
  expect(f.commands).toEqual([]);
});

test("account/workspace changes stop the next request and recheck of an in-flight owned page", async () => {
  const f = fixture(); const connection = await f.connect(); const page = await connection.createPage();
  await page.page.goto("https://chatgpt.com/");
  f.original.observation = { state: "different" };
  await expect(page.verifyIdentity()).rejects.toMatchObject({ code: "external_browser_identity_mismatch" });
  await expect(connection.createPage()).rejects.toMatchObject({ code: "external_browser_identity_mismatch" });
  expect(f.commands.filter(row => row.method === "Target.createTarget")).toHaveLength(1);
  await connection.close();
});

test("connection drop and TTL expiry never silently reconnect or launch another browser", async () => {
  const dropped = fixture(); const a = await dropped.connect(); dropped.drop();
  await expect(a.createPage()).rejects.toMatchObject({ code: "external_browser_disconnected" }); await a.close();
  const expired = fixture(); const b = await expired.connect(); await b.createPage(); expired.advance();
  await expect(b.createPage()).rejects.toMatchObject({ code: "external_browser_expired" }); await b.close();
  expect(expired.pages).toEqual([expired.original]); expect(expired.closedCount()).toBe(1);
  expect(dropped.commands).toEqual([]);
});

test("default persistent connections have no artificial TTL", async () => {
  const f = fixture(); const connection = await f.connect(0);
  for (let day = 0; day < 100_000; day++) f.advance();
  expect(() => connection.assertReady()).not.toThrow();
  await connection.createPage(); await connection.close();
});

test("closing the source tab can rebind to an existing authenticated page only in its verified context", async () => {
  const f = fixture(); const connection = await f.connect();
  f.original.isClosed = () => true;
  const replacement = { ...f.original, id: "replacement-original", isClosed: () => false };
  f.pages.push(replacement);
  const lease = await connection.createPage(); await lease.release(); await connection.close();
  expect(f.pages).toContain(replacement);
  expect(f.commands.filter(row => row.method === "Target.closeTarget").every(row => row.params.targetId === lease.targetId)).toBe(true);
  expect(f.originalMutations).toEqual([]);
});

test("raw connection and page inspection errors never leak session details", async () => {
  const f = fixture(); f.original.evaluate = async () => { throw Error("private-token-do-not-log"); };
  await expect(f.connect()).rejects.toMatchObject({ code: "external_browser_identity_unavailable" });
  try {
    await ExternalBrowserConnection.connect({ userDataDir: profile(), email: "enrolled@example.test" }, {
      transport: () => f.transport, connect: async () => { throw Error("ws endpoint private-token-do-not-log"); },
    });
  } catch (error) { expect(String(error)).not.toContain("private-token"); expect((error as ExternalBrowserError).retryable).toBe(false); }
});

test("the actual page-side probe matches real enrollment and returns metadata without email or session tokens", async () => {
  const f = fixture();
  const fetchBefore = globalThis.fetch;
  const locationBefore = Object.getOwnPropertyDescriptor(globalThis, "location");
  const observations: unknown[] = [];
  Object.defineProperty(globalThis, "location", { value: { origin: "https://chatgpt.com" }, configurable: true });
  let accountId = "workspace-real";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/auth/session"); expect(init.credentials).toBe("include");
    return Response.json({ user: { id: "user-real", email: "Enrolled@Example.Test" }, account: { id: accountId },
      accessToken: "private-token-never-return", expires: new Date(Date.now() + 60_000).toISOString() });
  }) as typeof fetch;
  f.original.evaluate = async (callback: (expected: unknown) => unknown, expected: unknown) => {
    const observed = await callback(expected); observations.push(observed); return observed;
  };
  let connection: ExternalBrowserConnection | undefined;
  try {
    connection = await f.connect();
    expect(connection.identity).toEqual({ userId: "user-real", accountId: "workspace-real" });
    accountId = "workspace-changed";
    await expect(connection.createPage()).rejects.toMatchObject({ code: "external_browser_identity_mismatch" });
    expect(JSON.stringify(observations)).not.toContain("@example");
    expect(JSON.stringify(observations)).not.toContain("@Example");
    expect(JSON.stringify(observations)).not.toContain("private-token");
    expect(f.commands).toEqual([]);
  } finally {
    await connection?.close(); globalThis.fetch = fetchBefore;
    if (locationBefore) Object.defineProperty(globalThis, "location", locationBefore);
    else delete (globalThis as any).location;
  }
});

test("the public CDP transport disconnects its socket and prevents Browser.close from reaching an existing browser", async () => {
  const received: any[] = [];
  let peerClosed!: () => void;
  const closed = new Promise<void>(resolve => { peerClosed = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("Not found", { status: 404 }); },
    websocket: {
      message(socket, message) {
        const parsed = JSON.parse(String(message)); received.push(parsed);
        socket.send(JSON.stringify({ id: parsed.id, result: {} }));
      }, close() { peerClosed(); },
    },
  });
  const transport = createExternalCdpTransport(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
  const responses: any[] = [];
  let gotVersion!: () => void;
  const version = new Promise<void>(resolve => { gotVersion = resolve; });
  transport.onmessage = message => { responses.push(message); if ((message as any).id === 1) gotVersion(); };
  try {
    transport.open!(); transport.send({ id: 1, method: "Browser.getVersion" });
    await version;
    transport.send({ id: 2, method: "Browser.close" });
    await new Promise(resolve => queueMicrotask(resolve));
    expect(responses.find(row => row.id === 2)?.error.message).toContain("prohibited");
    transport.close(); await closed;
    expect(received.map(row => row.method)).toEqual(["Browser.getVersion"]);
  } finally { transport.close(); server.stop(true); }
});
