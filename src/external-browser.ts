import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type ConnectOverCDPOptions, type ConnectOverCDPTransport, type Page } from "playwright-core";

/** A user-enabled, already running browser. This module never launches or imports a browser. */
export interface ExternalBrowserOptions {
  userDataDir: string;
  email: string;
  userId?: string;
  accountId?: string;
  connectTimeoutMs?: number;
  connectionTtlMs?: number;
}

export interface ExternalBrowserIdentity { userId: string; accountId: string }
export type ExternalBrowserErrorCode =
  | "external_browser_configuration_invalid" | "external_browser_debugging_unavailable"
  | "external_browser_connection_failed" | "external_browser_disconnected" | "external_browser_expired"
  | "external_browser_closed" | "external_browser_identity_unavailable" | "external_browser_identity_mismatch"
  | "external_browser_identity_ambiguous" | "external_browser_page_unavailable" | "external_browser_page_not_owned"
  | "external_browser_cleanup_failed";

/** Deliberately contains neither raw browser exceptions nor session/endpoint/identity data. */
export class ExternalBrowserError extends Error {
  readonly retryable = false;
  constructor(readonly code: ExternalBrowserErrorCode, message: string) { super(message); this.name = "ExternalBrowserError"; }
}

const failure = (code: ExternalBrowserErrorCode, message: string) => new ExternalBrowserError(code, message);
const ORIGIN = "https://chatgpt.com";
const OPERATION_TIMEOUT_MS = 10_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;

/** Only the browser's own two-line rendezvous file is read; no profile data is copied. */
export function readExternalBrowserEndpoint(userDataDir: string): string {
  if (typeof userDataDir !== "string" || !isAbsolute(userDataDir)) throw failure("external_browser_configuration_invalid", "External browser userDataDir must be absolute.");
  let text: string;
  try {
    const file = join(userDataDir, "DevToolsActivePort");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 3 || stat.size > 1024) throw Error();
    text = readFileSync(file, "utf8");
  } catch {
    throw failure("external_browser_debugging_unavailable", "The existing browser has no readable DevToolsActivePort. Enable its supported remote-debugging connection and approve the browser's own prompt. No browser was started.");
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== 2 || !/^[1-9][0-9]{0,4}$/.test(lines[0]!) || Number(lines[0]) > 65535
    || !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(lines[1]!)) {
    throw failure("external_browser_debugging_unavailable", "The existing browser's DevToolsActivePort is invalid. No alternate endpoint was used.");
  }
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

/** Public Playwright 1.62 transport API lets us disconnect without Browser.close(). */
export function createExternalCdpTransport(endpoint: string): ConnectOverCDPTransport {
  if (!/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(endpoint)
    || Number(new URL(endpoint).port) > 65535) throw failure("external_browser_configuration_invalid", "External CDP endpoint must be the browser's loopback WebSocket.");
  let socket: WebSocket | undefined;
  let closed = false;
  const pending: string[] = [];
  const finish = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    try { socket?.close(); } catch { /* The socket may already have failed. */ }
    transport.onclose?.("External browser transport disconnected");
  };
  const transport: ConnectOverCDPTransport = {
    open() {
      if (socket || closed) return;
      socket = new WebSocket(endpoint);
      socket.addEventListener("open", () => { for (const message of pending.splice(0)) socket!.send(message); });
      socket.addEventListener("message", event => {
        try {
          if (typeof event.data !== "string") throw Error();
          const message = JSON.parse(event.data);
          if (!message || typeof message !== "object" || Array.isArray(message)) throw Error();
          transport.onmessage?.(message);
        } catch { finish(); }
      });
      socket.addEventListener("close", finish);
      socket.addEventListener("error", finish);
    },
    send(message) {
      if (closed) throw failure("external_browser_disconnected", "External browser connection has ended; no automatic reconnect or fallback was attempted.");
      const command = message as { id?: number; method?: string; sessionId?: string };
      if (command.method === "Browser.close") {
        queueMicrotask(() => transport.onmessage?.({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), error: { code: -32000, message: "Closing the user's browser is prohibited" } }));
        return;
      }
      const serialized = JSON.stringify(message);
      if (socket?.readyState === WebSocket.OPEN) socket.send(serialized);
      else if (pending.length < 256) pending.push(serialized);
      else { finish(); throw failure("external_browser_disconnected", "External browser connection did not become ready."); }
    },
    close: finish,
  };
  return transport;
}

export interface ExternalBrowserDependencies {
  connect?: (transport: ConnectOverCDPTransport, options: ConnectOverCDPOptions) => Promise<Browser>;
  transport?: (endpoint: string) => ConnectOverCDPTransport;
  now?: () => number;
}

interface IdentityObservation {
  state: "match" | "different" | "unavailable";
  userId?: string;
  accountId?: string;
}

function isChatGptPage(page: Page): boolean {
  try { return !page.isClosed() && new URL(page.url()).origin === ORIGIN; } catch { return false; }
}

async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Timed out")), ms); })]); }
  finally { clearTimeout(timer!); }
}

async function observeIdentity(page: Page, options: ExternalBrowserOptions): Promise<IdentityObservation> {
  if (!isChatGptPage(page)) return { state: "unavailable" };
  try {
    return await deadline(page.evaluate(async expected => {
      // Compare email in the existing page. Neither it nor tokens/cookies leave the page.
      if (location.origin !== "https://chatgpt.com") return { state: "unavailable" as const };
      const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return { state: "unavailable" as const };
      const session = await response.json();
      if (session.error || typeof session.user?.id !== "string" || typeof session.account?.id !== "string"
        || typeof session.user?.email !== "string" || !session.user.id || !session.account.id
        || (session.expires !== undefined && (!Number.isFinite(Date.parse(session.expires)) || Date.parse(session.expires) <= Date.now()))) return { state: "unavailable" as const };
      if (session.user.email.trim().toLowerCase() !== expected.email
        || (expected.userId && session.user.id !== expected.userId)
        || (expected.accountId && session.account.id !== expected.accountId)) return { state: "different" as const };
      return { state: "match" as const, userId: session.user.id, accountId: session.account.id };
    }, { email: options.email.trim().toLowerCase(), userId: options.userId, accountId: options.accountId }), OPERATION_TIMEOUT_MS);
  } catch { return { state: "unavailable" }; }
}

export interface ExternalBrowserPageLease {
  page: Page;
  targetId: string;
  identity: Readonly<ExternalBrowserIdentity>;
  /** Call after navigating this owned page and immediately before each submission. */
  verifyIdentity(): Promise<void>;
  release(): Promise<void>;
}

/** One long-lived connection per configured account; it never reconnects implicitly. */
export class ExternalBrowserConnection {
  readonly identity: Readonly<ExternalBrowserIdentity>;
  private readonly owned = new Map<string, Page | undefined>();
  private readonly ownedInputSessions = new Map<string, CDPSession>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly originalPages: Set<Page>;
  private stopCode?: "external_browser_disconnected" | "external_browser_expired" | "external_browser_closed" | "external_browser_cleanup_failed";
  private cleanupFailure?: ExternalBrowserError;
  private transportClosed = false;
  private closing?: Promise<void>;
  private readonly expiresAt?: number;
  private readonly expiryTimer?: ReturnType<typeof setTimeout>;
  private constructor(
    private readonly options: ExternalBrowserOptions,
    private readonly browser: Browser,
    private readonly transport: ConnectOverCDPTransport,
    private readonly context: BrowserContext,
    private originalPage: Page,
    identity: ExternalBrowserIdentity,
    private readonly rootSession: CDPSession,
    private readonly now: () => number,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.originalPages = new Set(browser.contexts().flatMap(context => context.pages()));
    // A normal persistent session has no artificial expiry or daily authorization prompt.
    if (options.connectionTtlMs !== undefined) {
      this.expiresAt = now() + options.connectionTtlMs;
      this.expiryTimer = setTimeout(() => { void this.stop("external_browser_expired").catch(() => {}); }, options.connectionTtlMs);
      this.expiryTimer.unref?.();
    }
    browser.on("disconnected", () => {
      if (!this.stopCode) this.stopCode = "external_browser_disconnected";
      clearTimeout(this.expiryTimer);
    });
  }

  static async connect(raw: ExternalBrowserOptions, dependencies: ExternalBrowserDependencies = {}): Promise<ExternalBrowserConnection> {
    const options = { ...raw, connectTimeoutMs: raw.connectTimeoutMs ?? 30_000 };
    if (typeof options.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(options.email.trim())
      || !Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1_000 || options.connectTimeoutMs > 120_000
      || (options.connectionTtlMs !== undefined && (!Number.isSafeInteger(options.connectionTtlMs) || options.connectionTtlMs < 1_000 || options.connectionTtlMs > MAX_TTL_MS))
      || [options.userId, options.accountId].some(value => value !== undefined && (typeof value !== "string" || !value || value.length > 256))) {
      throw failure("external_browser_configuration_invalid", "External browser enrollment requires an email and valid bounded connection settings.");
    }
    const transport = (dependencies.transport ?? createExternalCdpTransport)(readExternalBrowserEndpoint(options.userDataDir));
    try {
      // Playwright 1.62 only calls transport.open() for WebKit; Chromium would queue commands forever.
      // open() is idempotent, so opening here stays correct if a later Playwright also calls it.
      transport.open?.();
      const browser = await (dependencies.connect ?? ((transport, options) => chromium.connectOverCDP(transport, options)))(transport, { timeout: options.connectTimeoutMs, noDefaults: true });
      const matches: Array<{ context: BrowserContext; page: Page; identity: ExternalBrowserIdentity }> = [];
      let different = false;
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          if (!isChatGptPage(page)) continue;
          const identity = await observeIdentity(page, options);
          different ||= identity.state === "different";
          if (identity.state === "match" && identity.userId && identity.accountId) matches.push({ context, page, identity: { userId: identity.userId, accountId: identity.accountId } });
        }
      }
      if (!matches.length) throw failure(different ? "external_browser_identity_mismatch" : "external_browser_identity_unavailable", "No existing ChatGPT page matches this enrolled account and workspace. No page was navigated and no prompt was submitted.");
      const match = matches[0]!;
      if (matches.some(candidate => candidate.context !== match.context || candidate.identity.userId !== match.identity.userId || candidate.identity.accountId !== match.identity.accountId)) {
        throw failure("external_browser_identity_ambiguous", "More than one browser context or workspace matches enrollment; select an unambiguous browser connection before using it.");
      }
      const root = await browser.newBrowserCDPSession();
      if (!browser.isConnected()) throw failure("external_browser_disconnected", "External browser disconnected during verification.");
      return new ExternalBrowserConnection(options, browser, transport, match.context, match.page, match.identity, root, dependencies.now ?? Date.now);
    } catch (error) {
      transport.close();
      if (error instanceof ExternalBrowserError) throw error;
      // Opt-in diagnostics: the underlying cause helps distinguish refusal, timeout and protocol errors.
      const cause = process.env.CODEX_WEB_DEBUG_EXTERNAL === "1"
        ? ` Cause: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 400)}`
        : "";
      throw failure("external_browser_connection_failed", `Could not connect to the existing browser. Approve its connection prompt if offered; no browser was launched and no alternate account was used.${cause}`);
    }
  }

  assertReady(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (!this.stopCode && this.expiresAt !== undefined && this.now() >= this.expiresAt) { void this.stop("external_browser_expired").catch(() => {}); }
    if (!this.stopCode && !this.browser.isConnected()) this.stopCode = "external_browser_disconnected";
    if (this.stopCode) throw failure(this.stopCode, "External browser connection is no longer usable. Reconnect explicitly; no automatic reconnect or fallback was attempted.");
  }

  private async verify(page: Page): Promise<void> {
    this.assertReady();
    const observed = await observeIdentity(page, { ...this.options, ...this.identity });
    this.assertReady();
    if (observed.state !== "match" || observed.userId !== this.identity.userId || observed.accountId !== this.identity.accountId) {
      throw failure(observed.state === "different" ? "external_browser_identity_mismatch" : "external_browser_identity_unavailable", "The enrolled browser account or workspace could not be verified. No prompt was submitted and no fallback was attempted.");
    }
  }

  private async verifySourceContext(): Promise<void> {
    if (isChatGptPage(this.originalPage)) return this.verify(this.originalPage);
    // The user may close their original tab. Rebind only within the previously proved context,
    // using fresh account metadata, never a profile name or a different browser context.
    for (const candidate of this.context.pages()) {
      if (!isChatGptPage(candidate)) continue;
      const observed = await observeIdentity(candidate, { ...this.options, ...this.identity });
      this.assertReady();
      if (observed.state === "match" && observed.userId === this.identity.userId && observed.accountId === this.identity.accountId) {
        this.originalPage = candidate;
        return;
      }
    }
    throw failure("external_browser_identity_unavailable", "No authenticated ChatGPT page remains in the verified browser context. No user page was navigated and no alternate profile was used.");
  }

  async createPage(): Promise<ExternalBrowserPageLease> {
    this.assertReady();
    await this.verifySourceContext();
    let targetId: string | undefined;
    try {
      const originalSession = await this.context.newCDPSession(this.originalPage);
      let browserContextId: string | undefined;
      try { browserContextId = (await originalSession.send("Target.getTargetInfo")).targetInfo.browserContextId; }
      finally { await originalSession.detach(); }
      this.assertReady();
      ({ targetId } = await deadline(this.rootSession.send("Target.createTarget", {
        url: "about:blank", ...(browserContextId ? { browserContextId } : {}), background: true, newWindow: false,
      }), OPERATION_TIMEOUT_MS));
      this.owned.set(targetId, undefined);
      const until = Date.now() + OPERATION_TIMEOUT_MS;
      while (Date.now() < until) {
        this.assertReady();
        for (const context of this.browser.contexts()) {
          for (const page of context.pages()) {
            if (page.isClosed() || this.originalPages.has(page)) continue;
            const probe = await context.newCDPSession(page);
            let id: string;
            try { id = (await probe.send("Target.getTargetInfo")).targetInfo.targetId; }
            finally { await probe.detach(); }
            if (id !== targetId) continue;
            if (context !== this.context) throw failure("external_browser_identity_mismatch", "The new browser page belongs to a different context; it was not used.");
            this.owned.set(targetId, page);
            // noDefaults preserves the user's existing tabs, but also skips Playwright's
            // default focus emulation. Restore it only for this verified, bridge-owned
            // background target so keyboard input works without activating the user's window.
            const inputSession = await context.newCDPSession(page);
            this.ownedInputSessions.set(targetId, inputSession);
            await deadline(inputSession.send("Emulation.setFocusEmulationEnabled", { enabled: true }), OPERATION_TIMEOUT_MS);
            this.assertReady();
            const ownedId = targetId;
            return {
              page, targetId: ownedId, identity: this.identity,
              verifyIdentity: async () => {
                if (this.owned.get(ownedId) !== page) throw failure("external_browser_page_not_owned", "This browser page is no longer owned by the bridge.");
                await this.verify(page);
              },
              release: () => this.release(ownedId),
            };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw failure("external_browser_page_unavailable", "The bridge-owned background page did not become available.");
    } catch (error) {
      if (targetId) await this.release(targetId);
      if (error instanceof ExternalBrowserError) throw error;
      throw failure("external_browser_page_unavailable", "Could not create a verified background page. No existing tab was navigated.");
    }
  }

  private disconnectTransport(): void {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.transport.close();
  }

  private quarantineCleanup(): ExternalBrowserError {
    this.cleanupFailure ??= failure("external_browser_cleanup_failed", "Closure of a bridge-owned browser page could not be confirmed. This account connection is quarantined; no further request, reconnect, or fallback will run.");
    this.stopCode = "external_browser_cleanup_failed";
    clearTimeout(this.expiryTimer);
    this.disconnectTransport();
    return this.cleanupFailure;
  }

  private async targetGone(targetId: string, waitMs: number): Promise<boolean> {
    const until = Date.now() + waitMs;
    for (;;) {
      if (!this.browser.isConnected()) return false;
      try {
        // Inspect IDs only. A successful close request alone does not prove physical cleanup.
        const result = await deadline(this.rootSession.send("Target.getTargets"), 2_000);
        if (!result.targetInfos.some(target => target.targetId === targetId)) return true;
      } catch { return false; }
      if (Date.now() >= until) return false;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private release(targetId: string): Promise<void> {
    if (!this.owned.has(targetId)) return Promise.resolve();
    const existing = this.releases.get(targetId);
    if (existing) return existing;
    const releasing = (async () => {
      if (this.cleanupFailure) throw this.cleanupFailure;
      // Exact owned-target cleanup is idempotent. Never retry creation/submission or user tabs.
      for (let attempt = 0; attempt < 2 && this.browser.isConnected(); attempt++) {
        let accepted = false;
        try { accepted = (await deadline(this.rootSession.send("Target.closeTarget", { targetId }), 2_000)).success === true; }
        catch { /* Confirm whether the target disappeared despite an ambiguous response. */ }
        if (await this.targetGone(targetId, accepted ? 1_000 : 0)) {
          this.owned.delete(targetId);
          const inputSession = this.ownedInputSessions.get(targetId);
          this.ownedInputSessions.delete(targetId);
          // Closing the owned target normally detaches this session already.
          await inputSession?.detach().catch(() => {});
          return;
        }
      }
      // Keep the ownership entry on failure. Disconnection is not evidence that the tab closed.
      throw this.quarantineCleanup();
    })();
    this.releases.set(targetId, releasing);
    void releasing.finally(() => { if (this.releases.get(targetId) === releasing) this.releases.delete(targetId); }).catch(() => {});
    return releasing;
  }

  private stop(code: "external_browser_closed" | "external_browser_expired"): Promise<void> {
    if (this.closing) return this.closing;
    this.stopCode ??= code;
    clearTimeout(this.expiryTimer);
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.owned.keys()].map(id => this.release(id)));
      // Closing our transport releases Playwright/CDP. Never call Browser.close or context.close.
      this.disconnectTransport();
      const rejected = results.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (this.cleanupFailure) throw this.cleanupFailure;
    })();
    return this.closing;
  }

  close(): Promise<void> { return this.stop("external_browser_closed"); }
}
