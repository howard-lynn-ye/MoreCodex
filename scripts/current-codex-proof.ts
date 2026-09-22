// Uses the real Codex home; command-line route overrides do not edit its configuration.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const [home, executable, bridgeUrl, output, catalog, cwd, mode] = process.argv.slice(2);
if (!home || !executable || !bridgeUrl || !output) throw Error("Supply CODEX_HOME, codex.exe, bridge URL, output directory, and optional native catalogue");
const catalogOverride = catalog && catalog !== "-" ? catalog : undefined;
if (mode && mode !== "--official-only" && mode !== "--web-only") throw Error("Unknown proof mode");
const officialOnly = mode === "--official-only";
// Web-only: the official account has no remaining quota, so only the Web model is exercised.
const webOnly = mode === "--web-only";
if (officialOnly) {
  const config = Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8")) as any;
  if (bridgeUrl !== "installed" || catalogOverride || config.openai_base_url
    || (config.model_provider && config.model_provider !== "openai") || config.model?.startsWith("chatgpt-web/")) {
    throw Error("Official recovery proof requires the restored official provider with no route or catalogue override");
  }
}
mkdirSync(output, { recursive: true });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const before = sha(readFileSync(join(home, "config.toml")));
const started = Date.now();
// Separate evidence output from the already-authorized project used by the core.
// Starting a new project may cause the client to persist a project trust entry.
const executionCwd = resolve(cwd || output);
const evidence: any = { at: new Date().toISOString(), home, isolatedCodexHome: false, desktopUi: false,
  executionCwd, commandLineRouteOverride: bridgeUrl !== "installed", catalogueOverride: Boolean(catalogOverride),
  officialOnly, webOnlyProof: webOnly, turns: [] };
const args = [executable, "app-server", ...(bridgeUrl !== "installed" ? ["-c", `openai_base_url=${JSON.stringify(bridgeUrl)}`] : []),
  ...(catalogOverride ? ["-c", `model_catalog_json=${JSON.stringify(catalogOverride)}`] : [])];
const child = Bun.spawn(args, { env: { ...process.env, CODEX_HOME: home }, cwd: executionCwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
const errors = new Response(child.stderr).text();
const events: any[] = [], pending = new Map<number, any>(); let serial = 0, buffer = "";
const send = (v: any) => { child.stdin.write(JSON.stringify(v) + "\n"); child.stdin.flush(); };
const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 30_000);
  pending.set(id, { resolve, reject, timer }); send({ id, method, params });
});
const reader = (async () => { for await (const bytes of child.stdout) {
  buffer += new TextDecoder().decode(bytes); let n;
  while ((n = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (!line) continue;
    const event = JSON.parse(line), call = pending.get(event.id);
    if (call) { clearTimeout(call.timer); pending.delete(event.id); event.error ? call.reject(Error(event.error.message)) : call.resolve(event.result); }
    else if (event.id !== undefined) send({ id: event.id, error: { code: -32000, message: "This text-only validation does not grant additional permissions" } });
    else events.push(event);
  }
} })();
const watchdog = setTimeout(() => child.kill(), 210_000);
try {
  await rpc("initialize", { clientInfo: { name: "current_codex_integration_proof", version: "1" }, capabilities: { experimentalApi: true } }); send({ method: "initialized" });
  const listed = await rpc("model/list", { includeHidden: false, limit: 100 });
  const web = listed.data.filter((m: any) => String(m.model ?? m.id).startsWith("chatgpt-web/"));
  evidence.webModels = web.map((m: any) => ({ id: m.model ?? m.id, name: m.displayName }));
  if (!officialOnly && !web.length) throw Error("The real home's app-server model/list did not expose any Web models");
  // Prove the route with the most established Web model (GPT-6 Pro unless CODEX_WEB_PROOF_MODEL names another);
  // a newly added model must not decide whether every Web model gets connected.
  const wanted = (process.env.CODEX_WEB_PROOF_MODEL ?? "GPT-6 Pro").toLowerCase();
  const proofModel = web.find((m: any) => String(m.displayName ?? "").toLowerCase().includes(wanted)) ?? web[0];
  const proofId = proofModel ? (proofModel.model ?? proofModel.id) : undefined;
  for (const selection of officialOnly ? [undefined] : webOnly ? [proofId] : [undefined, proofId]) {
    const nonce = `CURRENT_CODEX_${Date.now()}`;
    const thread = await rpc("thread/start", { cwd: executionCwd, ...(selection ? { model: selection } : {}) });
    const offset = events.length;
    const turn = await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: `Route verification. Reply only with ${nonce}. Do not use tools.` }] });
    const deadline = Date.now() + 100_000; let terminal;
    while (Date.now() < deadline && child.exitCode === null) {
      terminal = events.slice(offset).find(e => e.method === "turn/completed" && e.params?.turn?.id === turn.turn.id);
      if (terminal) break; await Bun.sleep(200);
    }
    const answer = events.slice(offset).filter(e => e.method === "item/completed" && e.params?.item?.type === "agentMessage").at(-1)?.params.item.text ?? "";
    const result = { threadId: thread.thread.id, turnId: turn.turn.id, model: thread.model ?? selection, selection: selection ?? "existing default",
      marker: nonce, markerMatches: answer.replaceAll("\\_", "_").includes(nonce), answerHash: sha(answer), status: terminal?.params.turn.status,
      deltas: events.slice(offset).filter(e => e.method === "item/agentMessage/delta").length };
    evidence.turns.push(result);
    if (result.status !== "completed" || !result.markerMatches) throw Error("Real request did not complete correctly; keep the existing official configuration");
  }
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error); }
finally {
  clearTimeout(watchdog); child.kill(); await child.exited; await reader; await errors;
  for (const p of pending.values()) clearTimeout(p.timer);
  evidence.configSha256 = before;
  evidence.configUnchanged = sha(readFileSync(join(home, "config.toml"))) === before;
  if (!evidence.configUnchanged) {
    evidence.passed = false;
    evidence.error = "Main configuration changed during the proof; inspect the change and repeat before installing a route";
  }
  evidence.file = join(output, `current-core-proof-${started}.json`); writeFileSync(evidence.file, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2)); if (!evidence.passed) process.exitCode = 1;
}
