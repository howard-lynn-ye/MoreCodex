import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web/index";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function request(thread: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol", stream: true,
    context: { messages: [{ role: "user", content: "Test task", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Completed task" }], timestamp: 2 },
      { role: "user", content: "Continue this exact task", timestamp: 3 }] },
    options: { reasoning: "high" },
    _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue this exact task" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_source" } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn_source" }) } },
  };
}

test("external adapter completes structured compaction through its exact account broker without a launcher descriptor", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-external-compact-"));
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "https://chatgpt.com",
    chatgptWeb: { browserHost: "external-cdp", externalBrowser: { userDataDir: root, email: "enrolled@example.test", userId: "user-one", accountId: "workspace-one" },
      accountIdentity: { label: "One", userId: "user-one", accountId: "workspace-one" },
      brokerSocketPath: defaultBrokerEndpoint(root), appName: "External compaction test", localToolsEnabled: true, solAvailable: true, proAvailable: true } };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const source = request(root);
  const namespace = chatGptWebExecutionNamespace(provider);
  const conversationKey = chatGptConversationKey(source, namespace)!;
  const executionKey = `${namespace}:${chatGptTurnExecutionKey(source)}`;
  let releases = 0;
  let submissions = 0;
  chatGptTurnSessions.getOrCreate(executionKey, () => ({
    mode: "read-only", browser: Promise.resolve("source complete"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), usageInput: source, conversationKey,
    releaseRetainedConversation: async () => { releases += 1; }, cancel() {},
  }));
  await chatGptTurnSessions.find(executionKey)!.browserOutcome;
  worker.run = async (turn: BrowserTurn) => {
    submissions += 1;
    expect(turn.conversationKey).toBe(conversationKey);
    expect(turn.requireRetainedConversation).toBeTrue();
    expect(turn.nativeConnector).toBeTrue();
    const instruction = await turn.prepareResume!();
    const token = instruction.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
    const handoffId = instruction.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
    expect(token).toBeDefined(); expect(handoffId).toBeDefined();
    await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary: "Exact external structured checkpoint" });
    return "submitted via broker";
  };
  const compact = structuredClone(source);
  compact._compactionRequest = true;
  (compact._rawBody as any).client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: root, turn_id: "turn_compact" });
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    expect(events.some(event => event.type === "text_delta" && event.text.includes("Exact external structured checkpoint"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect({ submissions, releases }).toEqual({ submissions: 1, releases: 1 });

    // A different enrolled account has no ownership of that retained source and must not open
    // a new browser page or replace the structured protocol with a read-only summary.
    const other = structuredClone(provider);
    other.chatgptWeb!.accountIdentity = { label: "Two", userId: "user-two", accountId: "workspace-two" };
    other.chatgptWeb!.externalBrowser = { ...other.chatgptWeb!.externalBrowser!, userId: "user-two", accountId: "workspace-two", email: "other@example.test" };
    const otherWorker = ChatGptBrowserWorker.forProvider(other);
    const originalOtherRun = otherWorker.run;
    let unexpected = 0;
    otherWorker.run = async () => { unexpected += 1; throw Error("must not open a replacement"); };
    try {
      const failure: AdapterEvent[] = [];
      await createChatGptWebAdapter(other).runTurn!(compact, { headers: new Headers() }, event => failure.push(event));
      expect(unexpected).toBe(0);
      expect(failure.at(-1)).toMatchObject({ type: "error", code: "compaction_source_unavailable", retryable: false });
    } finally { otherWorker.run = originalOtherRun; }
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected test cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
