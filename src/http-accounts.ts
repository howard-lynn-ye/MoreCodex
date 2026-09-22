import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import { scrubBridgeArtifactsForNative, type NativeFetch } from "./native-passthrough";

export const HTTP_ACCOUNT_PREFIX = "account-http/";
type Json = Record<string, any>;
export interface HttpAccountModel { id: string; catalog: Json; }
export interface HttpAccount {
  id: string;
  label: string;
  provider: "codex" | "api";
  enabled: boolean;
  credentialFile: string;
  accountId?: string;
  email?: string;
  credentialSha256?: string;
  projectId?: string;
  organizationId?: string;
  tunnelId?: string;
  models: HttpAccountModel[];
}
export interface HttpAccountRegistry { version: 1; accounts: HttpAccount[]; }
export class HttpAccountError extends Error {
  constructor(message: string, readonly status = 409, readonly code = "http_account_not_ready") { super(message); }
}
export function readHttpAccounts(config: Pick<AppConfig, "httpAccountsFile">): HttpAccountRegistry | undefined {
  if (!config.httpAccountsFile) return;
  let registry: HttpAccountRegistry;
  try { registry = JSON.parse(readFileSync(config.httpAccountsFile, "utf8")); }
  catch { throw new HttpAccountError("HTTP account registry could not be read"); }
  if (registry?.version !== 1 || !Array.isArray(registry.accounts)) throw new HttpAccountError("Invalid HTTP account registry");
  const ids = new Set<string>();
  for (const account of registry.accounts) {
    if (!account || typeof account.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(account.id) || ids.has(account.id)
      || typeof account.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(account.label)
      || !["codex", "api"].includes(account.provider) || typeof account.enabled !== "boolean"
      || typeof account.credentialFile !== "string" || !isAbsolute(account.credentialFile)
      || (account.email !== undefined && (typeof account.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(account.email)))
      || !Array.isArray(account.models) || account.models.some(model => !model || typeof model.id !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model.id)
        || !model.catalog || typeof model.catalog !== "object" || model.catalog.slug !== model.id)
      || new Set(account.models.map(model => model.id)).size !== account.models.length
      || (account.accountId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(account.accountId))
      || (account.credentialSha256 !== undefined && !/^[a-f0-9]{64}$/.test(account.credentialSha256))
      || (account.projectId !== undefined && !/^proj_[A-Za-z0-9_-]+$/.test(account.projectId))
      || (account.organizationId !== undefined && !/^org-[A-Za-z0-9_-]+$/.test(account.organizationId))
      || (account.tunnelId !== undefined && !/^tunnel_[a-f0-9]{32}$/.test(account.tunnelId))) throw new HttpAccountError("Invalid HTTP account entry");
    ids.add(account.id);
  }
  return registry;
}
function claims(token: unknown): Json {
  if (typeof token !== "string") return {};
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")); } catch { return {}; }
}
export function httpAccountCredentials(account: HttpAccount): { headers: Headers; fingerprint: string } {
  if (!existsSync(account.credentialFile)) throw new HttpAccountError(`${account.label}: credential file is missing`, 401, "account_auth_required");
  if (!lstatSync(account.credentialFile).isFile()) throw new HttpAccountError(`${account.label}: credential must be a regular file`);
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  let text: string;
  try { text = readFileSync(account.credentialFile, "utf8").trim(); } catch { throw new HttpAccountError(`${account.label}: credential file is unavailable`, 401); }
  let fingerprint: string;
  if (account.provider === "codex") {
    let auth: Json;
    try { auth = JSON.parse(text); } catch { throw new HttpAccountError(`${account.label}: invalid Codex credential file`); }
    const tokens = auth.tokens ?? {};
    const identity = claims(tokens.id_token);
    const identityAccount = identity["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!account.accountId || !account.email || tokens.account_id !== account.accountId
      || (identityAccount && identityAccount !== account.accountId)
      || (account.email && (typeof identity.email !== "string" || identity.email.toLowerCase() !== account.email.toLowerCase()))) {
      throw new HttpAccountError(`${account.label}: credential account/workspace does not match its fixed binding`, 409, "account_identity_mismatch");
    }
    if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new HttpAccountError(`${account.label}: Codex authentication required`, 401, "account_auth_required");
    const access = claims(tokens.access_token);
    if (typeof access.exp === "number" && access.exp * 1000 <= Date.now()) throw new HttpAccountError(`${account.label}: saved Codex access token expired`, 401, "account_auth_expired");
    headers.set("authorization", `Bearer ${tokens.access_token}`);
    headers.set("chatgpt-account-id", account.accountId);
    // Two people can share a workspace. Route and user binding must also remain isolated.
    fingerprint = `codex:${account.id}:${account.accountId}:${createHash("sha256").update(account.email.toLowerCase()).digest("hex")}`;
  } else {
    const digest = createHash("sha256").update(text).digest("hex");
    if (!account.credentialSha256 || digest !== account.credentialSha256) throw new HttpAccountError(`${account.label}: API credential changed; verify its account binding first`, 409, "account_identity_mismatch");
    if (!/^sk-[A-Za-z0-9_-]+$/.test(text)) throw new HttpAccountError(`${account.label}: invalid API credential file`);
    headers.set("authorization", `Bearer ${text}`);
    if (account.projectId) headers.set("openai-project", account.projectId);
    if (account.organizationId) headers.set("openai-organization", account.organizationId);
    fingerprint = `api:${digest}`;
  }
  return { headers, fingerprint };
}
export function httpAccountModels(config: AppConfig): Json[] {
  return (readHttpAccounts(config)?.accounts ?? []).filter(account => account.enabled).flatMap(account => {
    try { httpAccountCredentials(account); } catch { return []; }
    return account.models.map(model => ({ ...structuredClone(model.catalog),
      slug: `${HTTP_ACCOUNT_PREFIX}${account.id}/${model.id}`,
      display_name: `${model.catalog.display_name ?? model.id} · ${account.label} · ${account.provider === "codex" ? "Codex" : "API"}`,
      description: `${model.catalog.description ?? ""} Fixed ${account.label} ${account.provider} account; HTTP transport.`,
      visibility: "list", supported_in_api: true, upgrade: null,
    }));
  });
}
export async function inspectHttpAccount(account: HttpAccount, fetchUpstream: NativeFetch = fetch): Promise<Json> {
  const { headers } = httpAccountCredentials(account);
  if (account.provider === "codex") {
    headers.set("originator", "codex_cli_rs"); headers.set("user-agent", "codex_cli_rs/0.154.0");
  }
  const endpoint = account.provider === "codex" ? "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0" : "https://api.openai.com/v1/models";
  const response = await fetchUpstream(new Request(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(20000) }));
  if (!response.ok) throw new HttpAccountError(`${account.label}: model catalogue returned HTTP ${response.status}`, response.status, "account_catalog_rejected");
  const value = await response.json() as Json;
  const models = account.provider === "codex" ? value.models : value.data;
  if (!Array.isArray(models)) throw new HttpAccountError(`${account.label}: invalid upstream model catalogue`, 502);
  return { account: account.id, provider: account.provider, models };
}

function responseOwnerStore(config: AppConfig): { owners: Map<string, string>; save: () => void } {
  const file = `${config.httpAccountsFile}.response-owners.json`;
  let entries: [string, string][] = [];
  if (existsSync(file)) {
    try { entries = JSON.parse(readFileSync(file, "utf8")).entries; }
    catch { throw new HttpAccountError("HTTP continuation ownership file is unreadable"); }
    if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || entry.some(value => typeof value !== "string"))) throw new HttpAccountError("Invalid HTTP continuation ownership file");
  }
  const owners = new Map<string, string>(entries);
  return { owners, save: () => {
    // Merge concurrent completed turns. This file contains hashes/IDs, never credentials or text.
    if (existsSync(file)) {
      const previous = JSON.parse(readFileSync(file, "utf8"));
      for (const [key, owner] of previous.entries ?? []) if (!owners.has(key)) owners.set(key, owner);
    }
    while (owners.size > 4096) owners.delete(owners.keys().next().value!);
    atomicWriteFile(file, JSON.stringify({version:1,entries:[...owners]}));
  } };
}
function rememberResponse(value: Json, fingerprint: string, state: ReturnType<typeof responseOwnerStore>): void {
  const responseOwners = state.owners;
  if (typeof value.id === "string") responseOwners.set(`id:${value.id}`, fingerprint);
  for (const item of value.output ?? []) if (typeof item?.encrypted_content === "string") responseOwners.set(`opaque:${createHash("sha256").update(item.encrypted_content).digest("hex")}`, fingerprint);
  while (responseOwners.size > 4096) responseOwners.delete(responseOwners.keys().next().value!);
  state.save();
}
function assertContinuation(body: Json, fingerprint: string, responseOwners: Map<string, string>): void {
  const keys = [
    ...(typeof body.previous_response_id === "string" ? [`id:${body.previous_response_id}`] : []),
    ...(Array.isArray(body.input) ? body.input.filter(item => typeof item?.encrypted_content === "string")
      .map(item => `opaque:${createHash("sha256").update(item.encrypted_content).digest("hex")}`) : []),
  ];
  if (keys.some(key => responseOwners.get(key) !== fingerprint)) throw new HttpAccountError("This continuation belongs to another or unverified account. Start a new task or provide full plaintext context", 409, "account_continuation_mismatch");
}
function publicModel(value: Json, model: string, alias: string, fingerprint: string, state: ReturnType<typeof responseOwnerStore>): Json {
  const response = value.response && typeof value.response === "object" ? value.response : value;
  if (response.model === model) response.model = alias;
  if (response.object === "response.compaction" || response.status === "completed" || value.type === "response.completed") rememberResponse(response, fingerprint, state);
  return value;
}
const apiFields = new Set(["model", "input", "instructions", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "include", "previous_response_id", "max_output_tokens", "metadata", "store", "truncation", "temperature", "top_p", "service_tier", "prompt_cache_key", "prompt_cache_retention", "safety_identifier"]);
export async function forwardHttpAccountRequest(request: Request, config: AppConfig, raw: Json,
  endpoint: "responses" | "responses/compact", fetchUpstream: NativeFetch = fetch): Promise<Response> {
  const parts = String(raw.model).slice(HTTP_ACCOUNT_PREFIX.length).split("/");
  const account = readHttpAccounts(config)?.accounts.find(candidate => candidate.id === parts[0]);
  const model = parts.length === 2 && account?.models.find(candidate => candidate.id === parts[1]);
  if (!account?.enabled || !model) throw new HttpAccountError("HTTP account model is unknown, disabled, or unverified", 400, "account_model_unavailable");
  if (account.provider === "codex" && endpoint === "responses/compact") {
    if (!Array.isArray(raw.input)) throw new HttpAccountError("Codex compaction requires an input array", 400);
    // Current Codex compaction uses Responses with a terminal compaction_trigger item.
    // The legacy Codex /responses/compact endpoint returns 404 on current deployments.
    const compacted = await forwardHttpAccountRequest(request, config, { ...raw, stream: false, store: false,
      input: [...raw.input, { type: "compaction_trigger" }] }, "responses", fetchUpstream);
    const value = await compacted.json() as Json;
    const output = (value.output ?? []).filter((item: Json) => item.type === "compaction" && typeof item.encrypted_content === "string");
    if (output.length !== 1) throw new HttpAccountError(`${account.label}: upstream did not return a valid compaction checkpoint`, 502, "account_compaction_incomplete");
    return Response.json({ id: value.id, object: "response.compaction", model: raw.model, output, usage: value.usage });
  }
  const { headers, fingerprint } = httpAccountCredentials(account);
  const body = scrubBridgeArtifactsForNative({ ...raw, model: model.id }).value as Json;
  const state = responseOwnerStore(config);
  assertContinuation(body, fingerprint, state.owners);
  // Authentication and account headers always come from the fixed private credential.
  let outgoing: Json = body;
  if (account.provider === "api") {
    const fields = endpoint === "responses/compact" ? new Set(["model", "input", "instructions", "previous_response_id"]) : apiFields;
    outgoing = Object.fromEntries(Object.entries(body).filter(([key]) => fields.has(key)));
    if (account.tunnelId && endpoint === "responses") outgoing.tools = [...(outgoing.tools ?? []), { type: "mcp", server_label: account.id.replace(/-/g, "_"), tunnel_id: account.tunnelId }];
  } else {
    // The Codex backend emits SSE, including on deployments that omit Content-Type.
    // Aggregate it locally when the caller requests a normal JSON response.
    if (endpoint === "responses") outgoing = { ...body, stream: true };
    headers.set("originator", request.headers.get("originator") ?? "codex_cli_rs");
    headers.set("user-agent", request.headers.get("user-agent") ?? "codex_cli_rs/0.154.0");
  }
  const base = account.provider === "codex" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1";
  const upstream = await fetchUpstream(new Request(`${base}/${endpoint}`, {
    method: "POST", headers, body: JSON.stringify(outgoing), signal: request.signal, redirect: "error",
  }));
  if (!upstream.ok) {
    await upstream.body?.cancel();
    throw new HttpAccountError(`${account.label} ${account.provider}: upstream returned HTTP ${upstream.status}; no fallback account was used`, upstream.status, "account_upstream_rejected");
  }
  const contentType = upstream.headers.get("content-type");
  const isStream = contentType?.toLowerCase().includes("text/event-stream")
    || (!contentType && account.provider === "codex" && endpoint === "responses");
  if (!isStream) return Response.json(publicModel(await upstream.json() as Json, model.id, raw.model, fingerprint, state), { status: upstream.status });
  const decoder = new TextDecoder(); let pending = "";
  const completedItems = new Map<number, Json>();
  const rewriteLine = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    let value: Json;
    try { value = JSON.parse(line.slice(5).trim()); } catch { return line; }
    if (value.type === "response.output_item.done" && Number.isInteger(value.output_index) && value.item) {
      completedItems.set(value.output_index, value.item);
    }
    if (value.type === "response.completed" && value.response && !value.response.output?.length && completedItems.size) {
      value.response.output = [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item);
    }
    return "data: " + JSON.stringify(publicModel(value, model.id, raw.model, fingerprint, state));
  };
  const stream = upstream.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true }); let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        controller.enqueue(new TextEncoder().encode(rewriteLine(pending.slice(0, newline)) + "\n")); pending = pending.slice(newline + 1);
      }
    },
    flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(new TextEncoder().encode(rewriteLine(pending))); },
  }));
  if (raw.stream !== false) return new Response(stream, { status: upstream.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  const reader = stream.getReader();
  const jsonDecoder = new TextDecoder();
  let jsonPending = "";
  let completed: Json | undefined;
  const readLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    let event: Json;
    try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.failed" || event.type === "error") throw new HttpAccountError(`${account.label}: upstream response failed`, 502, "account_response_failed");
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      jsonPending += jsonDecoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = jsonPending.indexOf("\n")) >= 0) {
        readLine(jsonPending.slice(0, newline));
        jsonPending = jsonPending.slice(newline + 1);
      }
    }
    jsonPending += jsonDecoder.decode();
    if (jsonPending) readLine(jsonPending);
  } finally { await reader.cancel().catch(() => {}); }
  if (!completed || completed.status !== "completed") throw new HttpAccountError(`${account.label}: upstream stream ended before completion`, 502, "account_response_incomplete");
  return Response.json(completed);
}
