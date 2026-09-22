import { createHash } from "node:crypto";
import type { Page, Route } from "playwright-core";
import type { WebModelBinding } from "./web-accounts";
import type { ChatGptAccountIdentity } from "./chatgpt-account";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";

const bindingError = (message: string) => new ChatGptWebAdapterError(message, {
  status: 409, errorType: "invalid_request_error", code: "web_model_binding_mismatch", retryable: false,
});

const conversationUrl = /^https:\/\/chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:\?.*)?$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Read only model metadata from Web SSE; never persist content, cookies, or authorization. */
export function responseModelSlugs(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (entry: any) => {
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.model_slug === "string") result.add(entry.model_slug);
    if (typeof entry.p === "string" && entry.p.endsWith("/model_slug") && typeof entry.v === "string") result.add(entry.v);
    for (const child of Object.values(entry)) if (child && typeof child === "object") visit(child);
  };
  visit(value); return [...result];
}

export async function installWebModelGuard(page: Page, binding: WebModelBinding, identity: ChatGptAccountIdentity, traceId: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let failure: Error | undefined;
  let submitted = 0;
  const observed = new Set<string>();
  type StreamState = { pending: string; decoder: TextDecoder; buffering: boolean; queued: string[]; fallback?: boolean; finished?: boolean; done?: boolean };
  const streams = new Map<string, StreamState>();
  const evidence = (event: string, extra: Record<string, unknown> = {}) => console.info("[web-routing] " + JSON.stringify({
    at: new Date().toISOString(), event, traceId, ...binding,
    userHash: hash(identity.userId), workspaceHash: hash(identity.accountId), ...extra,
  }));
  const fail = (message: string) => {
    failure ??= bindingError(`ChatGPT Web ${identity.label}: ${message}. No fallback is permitted.`);
    evidence("binding_rejected", { reason: message });
    void cdp.send("Page.stopLoading").catch(() => {});
  };
  const consume = (id: string, base64: string) => {
    const stream = streams.get(id); if (!stream) return;
    stream.pending += stream.decoder.decode(Buffer.from(base64, "base64"), { stream: true });
    let newline: number;
    while ((newline = stream.pending.indexOf("\n")) >= 0) {
      const line = stream.pending.slice(0, newline); stream.pending = stream.pending.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      let payload: unknown; try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
      for (const slug of responseModelSlugs(payload)) {
        if (slug !== binding.webModelSlug) { fail(`upstream returned a different model (${slug})`); return; }
        if (!observed.has(slug)) { observed.add(slug); evidence("web_model_observed", { actualModel: slug }); }
      }
    }
    if (stream.pending.length > 4_000_000) fail("Web response metadata exceeds the observation limit");
  };
  // A response can finish before live streaming is enabled (short or continuation responses).
  // Then read the complete body once loading finishes; the model check itself is unchanged.
  const readFinishedBody = (id: string) => {
    const stream = streams.get(id); if (!stream || stream.done) return;
    stream.done = true;
    void cdp.send("Network.getResponseBody", { requestId: id }).then(result => {
      const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : String(result.body);
      consume(id, Buffer.from(text + "\n", "utf8").toString("base64"));
      let whole: unknown; try { whole = JSON.parse(text); } catch { /* SSE body */ }
      if (whole !== undefined) for (const slug of responseModelSlugs(whole)) {
        if (slug !== binding.webModelSlug) { fail(`upstream returned a different model (${slug})`); return; }
        if (!observed.has(slug)) { observed.add(slug); evidence("web_model_observed", { actualModel: slug, via: "body" }); }
      }
      evidence("web_stream_fallback_read", { bytes: text.length });
    }).catch(error => fail(`could not observe the actual Web response model (${String(error?.message ?? error).slice(0, 120)})`));
  };
  cdp.on("Network.responseReceived", event => {
    if (!conversationUrl.test(event.response.url)) return;
    if (event.response.status !== 200) { evidence("web_http_error", { status: event.response.status }); return; }
    (globalThis as { __cwWebActivityAt?: number }).__cwWebActivityAt = Date.now();
    evidence("web_response_seen", { mimeType: event.response.mimeType, path: new URL(event.response.url).pathname });
    const stream: StreamState = { pending: "", decoder: new TextDecoder(), buffering: true, queued: [] };
    streams.set(event.requestId, stream);
    void cdp.send("Network.streamResourceContent", { requestId: event.requestId }).then(result => {
      consume(event.requestId, result.bufferedData); stream.buffering = false;
      for (const data of stream.queued.splice(0)) consume(event.requestId, data);
    })
      .catch(error => {
        stream.fallback = true;
        evidence("web_stream_fallback", { reason: String(error?.message ?? error).slice(0, 160), mimeType: event.response.mimeType });
        if (stream.finished) readFinishedBody(event.requestId);
      });
  });
  cdp.on("Network.loadingFinished", event => {
    const stream = streams.get(event.requestId); if (!stream) return;
    (globalThis as { __cwWebActivityAt?: number }).__cwWebActivityAt = Date.now();
    stream.finished = true;
    if (stream.fallback) readFinishedBody(event.requestId);
  });
  cdp.on("Network.loadingFailed", event => {
    const stream = streams.get(event.requestId);
    if (stream?.fallback && !stream.done) { stream.done = true; fail(`could not observe the actual Web response model (loading failed: ${String(event.errorText).slice(0, 80)})`); }
  });
  cdp.on("Network.dataReceived", event => {
    const stream = streams.get(event.requestId);
    if (stream) (globalThis as { __cwWebActivityAt?: number }).__cwWebActivityAt = Date.now();
    if (!event.data || !stream) return;
    if (stream.buffering) stream.queued.push(event.data); else consume(event.requestId, event.data);
  });
  const intercept = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    let body: any; try { body = route.request().postDataJSON(); } catch { /* rejected below */ }
    const headers = await route.request().allHeaders();
    // Session verification before composing is insufficient if the workspace changes before
    // submission. Require the actual outgoing request to name the pinned workspace too.
    if (body?.model !== binding.webModelSlug || headers["chatgpt-account-id"] !== identity.accountId) {
      fail("browser request does not match the selected account/model"); await route.abort("blockedbyclient"); return;
    }
    submitted += 1;
    (globalThis as { __cwWebActivityAt?: number }).__cwWebActivityAt = Date.now();
    evidence("web_request_bound", { actualModel: body.model, bodyHash: hash(route.request().postData() ?? ""),
      requestWorkspaceHash: hash(headers["chatgpt-account-id"]!), workspaceVerified: true });
    await route.continue();
  };
  await page.route(conversationUrl, intercept);
  evidence("binding_installed");
  return {
    check() { if (failure) throw failure; },
    assertComplete() {
      if (failure) throw failure;
      if (!submitted || !observed.has(binding.webModelSlug)) throw bindingError(`ChatGPT Web ${identity.label}: actual response model was not verified; completion refused`);
      evidence("binding_complete", { submitted, actualModels: [...observed] });
    },
    async dispose() { await page.unroute(conversationUrl, intercept).catch(() => {}); await cdp.detach().catch(() => {}); },
  };
}
