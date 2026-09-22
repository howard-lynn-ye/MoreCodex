import type { Page } from "playwright-core";
import { ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "./adapter-error";

interface RetainedEntry {
  page?: Page;
  active: boolean;
  connectorBound: boolean;
  retiring: boolean;
  failedCleanup?: unknown;
  settled: Promise<void>;
  settle(): void;
}

export interface ExternalRetainedLease {
  readonly page: Page;
  readonly reused: boolean;
  finish(retain: boolean, connectorBound: boolean): Promise<void>;
}

const ownershipError = (code: string, message: string) => new ChatGptWebAdapterError(message, {
  status: 409, errorType: "invalid_request_error", code, retryable: false,
});

/** Only bridge-owned pages enter this store. Each worker is fixed to one account/model binding. */
export class ExternalRetainedPages {
  private readonly entries = new Map<string, RetainedEntry>();
  private closed = false;
  constructor(
    private readonly createPage: () => Promise<Page>,
    private readonly releasePage: (page: Page) => Promise<void>,
    private readonly limit = 32,
  ) {}

  async acquire(key: string, requireRetained: boolean): Promise<ExternalRetainedLease> {
    if (this.closed) throw ownershipError("external_browser_closed", "External retained pages have been closed");
    if (!key) throw ownershipError("external_retained_identity_missing", "A retained page requires a conversation identity");
    let entry = this.entries.get(key);
    if (entry?.active || entry?.retiring || entry?.failedCleanup) {
      throw ownershipError("external_retained_owner_busy", "The previous owner of this Web conversation has not physically released its page");
    }
    if (entry?.page?.isClosed()) {
      await this.remove(key, entry);
      entry = undefined;
    }
    const reused = entry !== undefined;
    if (requireRetained && (!entry || !entry.connectorBound)) throw chatGptRetainedConversationUnavailableError();
    if (!entry) {
      if (this.entries.size >= this.limit) {
        throw ownershipError("external_retained_capacity", "The external browser retained-conversation limit was reached; release an earlier task before opening another");
      }
      entry = { active: false, connectorBound: false, retiring: false, settled: Promise.resolve(), settle() {} };
      this.entries.set(key, entry);
    }
    const owned = entry;
    owned.active = true;
    owned.settled = new Promise(resolve => { owned.settle = resolve; });
    try {
      owned.page ??= await this.createPage();
      if (this.closed || owned.retiring) throw ownershipError("external_browser_closed", "This Web conversation was retired during page acquisition");
    } catch (error) {
      try { await this.remove(key, owned); }
      finally { owned.active = false; owned.settle(); }
      throw error;
    }
    let completion: Promise<void> | undefined;
    return {
      page: owned.page,
      reused,
      finish: (retain, connectorBound) => completion ??= (async () => {
        try {
          if (retain && connectorBound && !owned.retiring && !this.closed && !owned.page!.isClosed()) {
            owned.connectorBound = true;
          } else {
            await this.remove(key, owned);
          }
        } finally {
          owned.active = false;
          owned.settle();
        }
      })(),
    };
  }

  private async remove(key: string, entry: RetainedEntry): Promise<void> {
    entry.retiring = true;
    try {
      if (entry.page) await this.releasePage(entry.page);
      if (this.entries.get(key) === entry) this.entries.delete(key);
    } catch (error) {
      // Keep the exact owner quarantined. A later request cannot acquire a replacement page.
      entry.failedCleanup = error;
      throw error;
    }
  }

  async retire(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.retiring = true;
    if (entry.active) await entry.settled;
    if (entry.failedCleanup) throw entry.failedCleanup;
    if (this.entries.get(key) === entry) await this.remove(key, entry);
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.entries.keys()].map(key => this.retire(key)));
    const errors = results.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(item => item.reason), "Some external retained pages did not confirm physical closure");
  }
}
