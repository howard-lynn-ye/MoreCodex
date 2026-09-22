import type { Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";

const accountError = (message: string) => new ChatGptWebAdapterError(message, {
  status: 409, errorType: "invalid_request_error", code: "web_account_verification_required", retryable: false,
});

/** Stable identity enrolled from the account's own authenticated browser. */
export interface ChatGptAccountIdentity {
  label: string;
  userId: string;
  accountId: string;
}

export interface ChatGptSessionIdentity {
  userId?: string;
  accountId?: string;
}

export function assertChatGptAccountIdentity(
  actual: ChatGptSessionIdentity,
  expected: ChatGptAccountIdentity,
): void {
  if (!actual.userId || !actual.accountId) {
    throw accountError(`ChatGPT Web ${expected.label}: login required in this account's dedicated browser`);
  }
  if (actual.userId !== expected.userId || actual.accountId !== expected.accountId) {
    throw accountError(`ChatGPT Web ${expected.label}: account or workspace changed; sign back into the enrolled account in its dedicated browser. No prompt was submitted`);
  }
}

export async function verifyChatGptAccount(page: Page, expected?: ChatGptAccountIdentity): Promise<void> {
  if (!expected) return;
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw accountError(`ChatGPT Web ${expected.label}: login required in this account's dedicated browser`);
  }
  let actual: ChatGptSessionIdentity;
  try {
    actual = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", {
        credentials: "include", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return {};
      const session = await response.json();
      // Never transfer the session token, cookies, or complete response out of the page.
      return { userId: session.user?.id, accountId: session.account?.id };
    });
  } catch {
    throw accountError(`ChatGPT Web ${expected.label}: could not verify the current account; retry when the dedicated browser is connected`);
  }
  assertChatGptAccountIdentity(actual, expected);
}
