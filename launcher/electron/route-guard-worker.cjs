// Runs in an independent Windows process. Keep this file dependency-free so it
// can be copied out of app.asar into the durable bridge home.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
function write(file, data, { rename = fs.renameSync, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data) + "\n", { mode: 0o600 });
  const delays = [25, 50, 100, 150, 250, 350, 500];
  for (let attempt = 0; ; attempt++) {
    try { rename(temporary, file); return; }
    catch (error) {
      if (process.platform !== "win32" || !["EBUSY", "EPERM", "EACCES"].includes(error.code) || delays[attempt] === undefined) throw error;
      wait(delays[attempt]);
    }
  }
}
function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function assertJournalTarget(spec) {
  for (const name of ["integration-journal.json", "integration-journal.recovery.json"]) {
    const file = path.join(spec.coreHome, "codex", name);
    if (fs.existsSync(file) && !samePath(read(file).configPath, path.join(spec.codexHome, "config.toml"))) {
      throw Error("Recovery journal targets a different Codex home; refusing restoration");
    }
  }
}
function disconnect(spec) {
  assertJournalTarget(spec);
  const result = spawnSync(spec.invocation.executable, [...spec.invocation.args, "--home", spec.coreHome, "route", "disconnect"], {
    cwd: spec.invocation.cwd, windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: spec.coreHome, CODEX_HOME: spec.codexHome },
  });
  // Do not copy arbitrary CLI output (which may contain private data) to logs.
  if (result.error || result.status !== 0) throw Error("Route restoration command failed; inspect the integration journal");
  if (JSON.parse(result.stdout).active !== false) throw Error("Route restoration was not verified");
}
async function healthy(spec) {
  try {
    // A current-desktop integration can reuse an already supervised bridge while
    // keeping a separate recovery journal for that desktop's real Codex home.
    const state = read(path.join(spec.runtimeHome || spec.coreHome, "runtime", "launcher-supervisor.json"));
    if (state.ownerPid !== spec.ownerPid || state.status !== "ready" || !running(state.daemonPid)) return false;
    const response = await fetch(spec.healthUrl, { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    return response.ok && health.service === "codex-chatgpt-web" && health.status === "ok"
      && health.accepting_turns === true && health.mode === spec.mode && health.version === spec.version;
  } catch { return false; }
}
async function run(specFile) {
  const spec = read(specFile);
  if (!path.isAbsolute(spec.coreHome) || !path.isAbsolute(spec.codexHome)
    || (spec.runtimeHome !== undefined && !path.isAbsolute(spec.runtimeHome))
    || !path.isAbsolute(spec.invocation.executable) || !Number.isInteger(spec.ownerPid) || spec.ownerPid < 1
    || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/healthz$/.test(spec.healthUrl)) {
    throw Error("Invalid recovery guard configuration");
  }
  assertJournalTarget(spec);
  const status = (state, extra = {}) => write(spec.statusFile, {
    nonce: spec.nonce, pid: process.pid, ownerPid: spec.ownerPid, state, at: new Date().toISOString(), ...extra,
  });
  let failures = 0;
  let reason;
  while (!reason) {
    let lease;
    try { lease = read(spec.leaseFile); } catch {}
    if (!running(spec.ownerPid)) reason = "launcher-exited";
    else if (lease?.nonce !== spec.nonce || Date.now() - Date.parse(lease.at) > 8000 || !Number.isFinite(Date.parse(lease?.at))) {
      reason = "launcher-heartbeat-expired";
    } else if (lease.stop === true) reason = "launcher-stopped";
    else if (await healthy(spec)) { failures = 0; status("ready"); }
    else if (++failures >= 3) reason = "runtime-unavailable";
    if (!reason) await delay(1000);
  }
  status("restoring", { reason });
  // Recovery can briefly race a launcher CLI transaction. Retry without ever
  // replacing user edits or restoring a whole config snapshot.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      disconnect(spec);
      status("restored", { reason });
      return;
    } catch (error) {
      status("recovery-failed", { reason, message: error.message });
      if (attempt < 4) await delay(1000);
    }
  }
  process.exitCode = 1;
}

function recoverAfterError(specFile, error) {
  try {
    const spec = read(specFile);
    // A status-file write error must not silently abandon a live Codex route.
    disconnect(spec);
    write(spec.statusFile, { nonce: spec.nonce, pid: process.pid, ownerPid: spec.ownerPid,
      state: "restored", reason: "guard-error", errorCode: error.code || error.name, at: new Date().toISOString() });
  } catch {
    try { fs.appendFileSync(`${specFile}.error.log`, `${new Date().toISOString()} recovery failed after ${error.code || error.name}\n`); } catch {}
    process.exitCode = 1;
  }
}
module.exports = { assertJournalTarget, disconnect, healthy, run, write, recoverAfterError };
if (require.main === module) run(process.argv[2]).catch(error => recoverAfterError(process.argv[2], error));
