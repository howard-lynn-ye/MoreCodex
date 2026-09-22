// Current-user Windows startup. Recovery precedes readiness; no model request is
// made unless --verify-and-connect was explicitly selected at install/run time.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writePrivateFileAtomic } = require('../launcher/electron/atomic-file.cjs');
const source = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quotePS = value => "'" + String(value).replaceAll("'", "''") + "'";
const alive = pid => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
const write = (file, value) => writePrivateFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { protectDirectory: false });
const beforeBoot = (at, boot = Date.now() - os.uptime() * 1000) => Number.isFinite(Date.parse(at)) && Date.parse(at) < boot - 5000;
const currentBootTimestamp = (at, now = Date.now(), boot = now - os.uptime() * 1000) => Number.isFinite(Date.parse(at))
  && Date.parse(at) >= boot - 5000 && Date.parse(at) <= now + 5000;
function run(executable, args, { timeout = 30000, env = process.env, cwd = source, log } = {}) {
  const r = spawnSync(executable, args, { env, cwd, windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (log) fs.writeFileSync(log, (r.stdout || '') + (r.stderr || ''), { mode: 0o600 });
  if (r.error || r.status !== 0) throw Error('A startup stage failed; inspect its private log. No automatic retry was scheduled');
  return r.stdout.trim();
}
function powershell(code) {
  return run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')]);
}
function protect(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const user = run('whoami.exe', []);
  run('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F']);
}
function load(connectionFile) {
  if (!connectionFile || !path.isAbsolute(connectionFile)) throw Error('Supply an absolute connection.json path');
  const m = read(connectionFile);
  for (const k of ['runtimeHome', 'integrationHome', 'codexHome', 'bunExecutable']) {
    if (!path.isAbsolute(m[k] || '') || !fs.existsSync(m[k])) throw Error(`Invalid or missing connection field: ${k}`);
  }
  if (same(m.runtimeHome, m.integrationHome)) throw Error('Runtime and main integration journal homes must remain separate');
  const root = path.join(path.dirname(connectionFile), 'windows-startup');
  return { ...m, connectionFile, root, installFile: path.join(root, 'installation.json'), statusFile: path.join(root, 'status.json'),
    runName: 'CodexChatGPTWeb.CurrentIntegration.' + crypto.createHash('sha256').update(path.resolve(connectionFile).toLowerCase()).digest('hex').slice(0, 12),
    officialConfig: path.join(m.codexHome, 'config.toml'), supervisorFile: path.join(m.runtimeHome, 'runtime', 'launcher-supervisor.json') };
}
function registryValue(ctx) {
  const result = powershell(`$v=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name ${quotePS(ctx.runName)} -ErrorAction SilentlyContinue; if($null -eq $v){'null'}else{[string]$v.${quotePS(ctx.runName)}|ConvertTo-Json -Compress}`);
  return JSON.parse(result);
}
function route(ctx, action) {
  const status = JSON.parse(run(ctx.bunExecutable, [path.join(source, 'src', 'cli.ts'), '--home', ctx.integrationHome, 'route', action],
    { env: { ...process.env, CODEX_HOME: ctx.codexHome } }));
  return validateRouteStatus(status);
}
function validateRouteStatus(status) {
  if (typeof status?.active !== 'boolean' || !Array.isArray(status.errors)) throw Error('Main route state is unknown; startup was stopped');
  // active records journal intent, not a successful comparison with the user's
  // current configuration. A mismatch must never trigger automatic restoration.
  if (status.errors.length) throw Error('Main configuration or model catalogue differs from its ownership journal; startup stopped and external changes were preserved');
  return status;
}
function disconnect(ctx, directory) {
  run(process.execPath, [path.join(source, 'scripts', 'current-codex-integration.cjs'), 'disconnect', ctx.connectionFile],
    { timeout: 100000, log: path.join(directory, 'route-recovery.private.log') });
  if (route(ctx, 'status').active !== false) throw Error('Owned route recovery was not verified; service startup was stopped');
}
async function observedRuntime(ctx) {
  try {
    const config = read(path.join(ctx.runtimeHome, 'config.json'));
    const supervisor = read(ctx.supervisorFile);
    if (config.host !== '127.0.0.1' || !Number.isInteger(config.port)) return { healthy: false };
    const r = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: AbortSignal.timeout(2500) });
    const h = await r.json();
    const healthy = r.ok && h.service === 'codex-chatgpt-web' && h.status === 'ok' && h.accepting_turns === true
      && h.version === config.releaseVersion && h.mode === config.mode && supervisor.status === 'ready'
      && supervisor.version === 1 && supervisor.daemonPid === h.pid && alive(h.pid) && alive(supervisor.ownerPid)
      && currentBootTimestamp(supervisor.updatedAt);
    return { healthy, ownerPid: supervisor.ownerPid, daemonPid: h.pid, port: config.port,
      mode: h.mode, version: h.version,
      idle: h.active_http_turns === 0 && h.active_browser_turns === 0 };
  } catch { return { healthy: false }; }
}
function startupDecision({ active, healthy, protectedRoute = false }) {
  if (active && healthy && protectedRoute) return 'already-connected';
  if (active) return 'recover-first';
  return healthy ? 'already-serving' : 'start-service';
}
function hasFreshGuard(ctx, runtime) {
  try {
    const manager = read(path.join(ctx.integrationHome, 'manager-status.json'));
    if (!same(path.dirname(manager.guardStatus), path.join(ctx.integrationHome, 'runtime'))
      || !/^route-guard-[0-9a-f-]+\.status\.json$/i.test(path.basename(manager.guardStatus))) return false;
    const guard = read(manager.guardStatus);
    const spec = read(manager.guardStatus.replace(/\.status\.json$/, '.json'));
    const expectedLease = manager.guardStatus.replace(/\.status\.json$/, '.lease.json');
    if (!same(spec.leaseFile, expectedLease)) return false;
    return guardEvidenceMatches(ctx, runtime, manager, guard, spec, read(expectedLease));
  } catch { return false; }
}
function guardEvidenceMatches(ctx, runtime, manager, guard, spec, lease,
  { now = Date.now(), boot = now - os.uptime() * 1000, isAlive = alive } = {}) {
  const url = `http://127.0.0.1:${runtime.port}`;
  return runtime.healthy === true && manager.state === 'connected' && same(manager.codexHome, ctx.codexHome)
    && manager.routeUrl === `${url}/v1` && isAlive(manager.pid) && currentBootTimestamp(manager.at, now, boot)
    && same(path.dirname(manager.guardStatus), path.join(ctx.integrationHome, 'runtime'))
    && typeof spec.nonce === 'string' && /^[0-9a-f-]+$/i.test(spec.nonce)
    && same(manager.guardStatus, path.join(ctx.integrationHome, 'runtime', `route-guard-${spec.nonce}.status.json`))
    && same(spec.coreHome, ctx.integrationHome) && same(spec.codexHome, ctx.codexHome) && same(spec.runtimeHome, ctx.runtimeHome)
    && same(spec.statusFile, manager.guardStatus) && same(spec.leaseFile, manager.guardStatus.replace(/\.status\.json$/, '.lease.json'))
    && spec.healthUrl === `${url}/healthz` && spec.mode === runtime.mode && spec.version === runtime.version
    && spec.ownerPid === runtime.ownerPid && guard.ownerPid === runtime.ownerPid && guard.nonce === spec.nonce
    && isAlive(guard.pid) && guard.state === 'ready' && currentBootTimestamp(guard.at, now, boot) && now - Date.parse(guard.at) < 4000
    && lease.nonce === spec.nonce && lease.stop !== true && currentBootTimestamp(lease.at, now, boot) && now - Date.parse(lease.at) < 8000;
}
function validateProof(proof, binding, ctx, expectedHash, startedAt, webOnly = false) {
  const web = proof.turns?.filter(t => t.selection?.startsWith('chatgpt-web/')) || [];
  if (!proof.passed || !proof.configUnchanged || !same(proof.home, ctx.codexHome) || proof.configSha256 !== expectedHash
    || !Number.isFinite(Date.parse(proof.at)) || Date.parse(proof.at) < startedAt || Date.now() - Date.parse(proof.at) > 15 * 60000
    || (proof.webOnlyProof !== true && !proof.turns?.some(t => t.selection === 'existing default' && t.status === 'completed' && t.markerMatches))
    || (proof.webOnlyProof === true && !webOnly)
    || !web.length || !binding.passed || !binding.configUnchanged || !same(binding.codexHome, ctx.codexHome)
    || web.some(t => t.status !== 'completed' || !t.markerMatches || !binding.checks?.some(c => c.passed
      && c.threadId === t.threadId && c.turnId === t.turnId && c.modelId === t.selection
      && c.checks?.installed && c.checks?.submitted && c.checks?.observed && c.checks?.completed && !c.checks?.rejected))) {
    throw Error('Fresh main-home official/Web proof and actual account/model binding did not pass; official route remains selected');
  }
}
function trustedCwd(ctx) {
  const cwd = path.dirname(source);
  const code = `const fs=require('node:fs'); const c=Bun.TOML.parse(fs.readFileSync(process.argv[1],'utf8')); const normalize=p=>require('node:path').resolve(p).toLowerCase(); console.log(JSON.stringify(Object.entries(c.projects||{}).some(([p,v])=>normalize(p)===normalize(process.argv[2])&&v.trust_level==='trusted')));`;
  if (run(ctx.bunExecutable, ['-e', code, ctx.officialConfig, cwd]) !== 'true') throw Error('The existing project directory is not trusted; startup will not change project trust');
  return cwd;
}
function retireStale(ctx, file, directory, name) {
  if (!fs.existsSync(file)) return;
  const bytes = fs.readFileSync(file);
  const state = JSON.parse(bytes);
  if (!beforeBoot(state.updatedAt || state.at)) return;
  // Old-boot numeric PIDs may now belong to unrelated processes. Preserve the
  // marker without signalling any PID, after the old route has been recovered.
  if (!fs.readFileSync(file).equals(bytes)) throw Error('Ownership marker changed while recovering startup');
  fs.renameSync(file, path.join(directory, name));
}
function installationPlan(ctx, verify, codexExecutable, nodeExecutable = process.execPath) {
  const args = [__filename, 'run', path.resolve(ctx.connectionFile), ...(verify ? ['--verify-and-connect', '--codex-executable', codexExecutable] : [])];
  const launcher = path.join(ctx.root, 'launch.cjs');
  const launcherSource = '// Owned Windows startup bootstrap; no credentials.\n'
    + `const r = require('node:child_process').spawnSync(process.execPath, ${JSON.stringify(args)}, {windowsHide:true, stdio:'ignore'});\n`
    + 'process.exitCode = r.status === 0 ? 0 : 1;\n';
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `"${shell}" -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ${quotePS(nodeExecutable)} ${quotePS(launcher)}"`;
  if (command.length > 260) throw Error('Startup command exceeds the Windows Run limit; no registration was changed');
  return { command, launcher, launcherSource, launcherSha256: crypto.createHash('sha256').update(launcherSource).digest('hex') };
}
async function launch(ctx, verify, codexExecutable, webOnly = false) {
  protect(ctx.root);
  const lockFile = path.join(ctx.root, 'startup.lock.json');
  if (fs.existsSync(lockFile)) {
    const old = read(lockFile);
    if (!beforeBoot(old.at) && alive(old.pid)) throw Error('A startup attempt is already running');
    fs.renameSync(lockFile, path.join(ctx.root, `expired-lock-${Date.now()}.json`));
  }
  const token = crypto.randomUUID();
  fs.writeFileSync(lockFile, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  const directory = path.join(ctx.root, `run-${Date.now()}`); protect(directory);
  const status = (state, extra = {}) => {
    const result = { at: new Date().toISOString(), state, mode: verify ? 'verify-and-connect' : 'service-only',
      runtimeHome: ctx.runtimeHome, codexHome: ctx.codexHome, evidenceDirectory: directory,
      windowsRebootVerified: false, desktopUiVerified: false, ...extra };
    write(ctx.statusFile, result); write(path.join(directory, 'result.json'), result); return result;
  };
  let connectedByThisRun = false;
  try {
    status('checking');
    let runtime = await observedRuntime(ctx);
    const active = route(ctx, 'status').active === true;
    const decision = startupDecision({ active, healthy: runtime.healthy, protectedRoute: hasFreshGuard(ctx, runtime) });
    if (decision === 'already-connected') return status('already-connected', { runtime, changed: false });
    if (active) disconnect(ctx, directory);
    if (!runtime.healthy) {
      retireStale(ctx, ctx.supervisorFile, directory, 'previous-boot-supervisor.json');
      run(process.execPath, [path.join(source, 'scripts', 'deploy-current-runtime.cjs'), 'start', ctx.connectionFile],
        { timeout: 240000, log: path.join(directory, 'service-start.private.log') }); // cold start after a Windows restart measured 81 s
      runtime = await observedRuntime(ctx);
      if (!runtime.healthy) throw Error('Started bridge has no valid health evidence');
    }
    if (!verify) return status('awaiting-end-to-end-proof', { runtime, officialRouteActive: false });
    if (!runtime.idle) throw Error('Startup proof requires an idle bridge; no requests were cancelled');
    if (!codexExecutable || !path.isAbsolute(codexExecutable) || !fs.statSync(codexExecutable).isFile()) throw Error('Explicit verification requires the installed official codex.exe path');
    const cwd = trustedCwd(ctx);
    const configBefore = hash(ctx.officialConfig), startedAt = Date.now();
    const catalog = path.join(ctx.integrationHome, 'codex', 'account-models.json');
    if (!fs.statSync(catalog).isFile()) throw Error('The configured native model catalogue is unavailable');
    status('verifying-main-home-requests', { runtime, officialRouteActive: false });
    const proofText = run(ctx.bunExecutable, [path.join(source, 'scripts', 'current-codex-proof.ts'), ctx.codexHome,
      codexExecutable, `http://127.0.0.1:${runtime.port}/v1`, directory, catalog, cwd, ...(webOnly ? ['--web-only'] : [])],
      { timeout: 240000, log: path.join(directory, 'core-proof.private.log') });
    const proof = JSON.parse(proofText);
    if (!same(path.dirname(proof.file), directory)) throw Error('Proof artifact escaped its run directory');
    const bindingFile = path.join(directory, 'routing-evidence.json');
    run(process.execPath, [path.join(source, 'scripts', 'current-runtime-routing-evidence.cjs'), proof.file, ctx.connectionFile, bindingFile],
      { log: path.join(directory, 'routing-check.private.log') });
    validateProof(proof, read(bindingFile), ctx, configBefore, startedAt, webOnly);
    if (hash(ctx.officialConfig) !== configBefore) throw Error('Main configuration changed during proof; startup will not overwrite it');
    // The old manager cannot acknowledge a stop after reboot. Preserve its
    // stale status before reusing the journal; never rewrite a live manager.
    retireStale(ctx, path.join(ctx.integrationHome, 'manager-status.json'), directory, 'previous-boot-manager.json');
    run(process.execPath, [path.join(source, 'scripts', 'current-codex-integration.cjs'), 'connect', ctx.connectionFile, proof.file],
      { timeout: 150000, log: path.join(directory, 'route-connect.private.log') });
    connectedByThisRun = true;
    if (route(ctx, 'status').active !== true || !hasFreshGuard(ctx, runtime)) throw Error('Connection did not establish independent recovery protection');
    return status('connected-after-request-proof', { runtime, officialRouteActive: true, proof: proof.file, bindingEvidence: bindingFile,
      scope: webOnly ? 'One eligible Web model only (--web-only: official default was not exercised); other account/model combinations remain separate acceptance items'
        : 'One current official default and one eligible Web model; other account/model combinations remain separate acceptance items' });
  } catch (error) {
    let officialRouteRestored = false;
    try {
      if (route(ctx, 'status').active) disconnect(ctx, directory);
      officialRouteRestored = route(ctx, 'status').active === false;
    } catch { /* Keep failure explicit; never restore a full config snapshot. */ }
    const failed = status('failed', { officialRouteRestored, connectedByThisRun,
      reason: error.message, retriesScheduled: 0 });
    console.error(JSON.stringify(failed)); process.exitCode = 1; return failed;
  } finally {
    if (fs.existsSync(lockFile) && read(lockFile).token === token) fs.unlinkSync(lockFile);
  }
}
async function main() {
  if (process.platform !== 'win32') throw Error('This startup helper is Windows-only');
  const [action, connectionFile, ...flags] = process.argv.slice(2);
  let verify = false, codexExecutable, webOnly = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--verify-and-connect') verify = true;
    else if (flags[i] === '--web-only') webOnly = true;
    else if (flags[i] === '--codex-executable' && flags[i + 1]) codexExecutable = flags[++i];
    else throw Error('Unknown or incomplete startup option');
  }
  const ctx = load(connectionFile);
  if (action === 'status') return { runName: ctx.runName, registered: registryValue(ctx) !== null,
    registrationMatches: fs.existsSync(ctx.installFile) && registryValue(ctx) === read(ctx.installFile).command,
    lastRun: fs.existsSync(ctx.statusFile) ? read(ctx.statusFile) : null, windowsRebootVerified: false };
  if (action === 'run') return launch(ctx, verify, codexExecutable, webOnly);
  if (action === 'install') {
    if (verify && (!codexExecutable || !path.isAbsolute(codexExecutable) || !fs.statSync(codexExecutable).isFile())) throw Error('Verification startup requires an absolute installed codex.exe path');
    if (verify) trustedCwd(ctx);
    const plan = installationPlan(ctx, verify, codexExecutable);
    const { command } = plan;
    const existing = registryValue(ctx);
    if (existing !== null && existing !== command) throw Error('The project startup value already contains another command; it was not overwritten');
    protect(ctx.root);
    if (existing === command) {
      if (!fs.existsSync(ctx.installFile) || read(ctx.installFile).command !== command) throw Error('An identical startup value has no ownership journal; refusing to adopt it');
      if (read(ctx.installFile).launcherSha256 !== plan.launcherSha256 || hash(plan.launcher) !== plan.launcherSha256) {
        throw Error('Startup mode or bootstrap changed; uninstall the owned registration before selecting another mode');
      }
      return { installed: true, changed: false, runName: ctx.runName, mode: verify ? 'verify-and-connect' : 'service-only' };
    }
    if (fs.existsSync(plan.launcher)) {
      if (!fs.existsSync(ctx.installFile) || read(ctx.installFile).launcherSha256 !== hash(plan.launcher)) throw Error('Startup bootstrap was changed independently; refusing overwrite');
      fs.copyFileSync(plan.launcher, path.join(ctx.root, `launch-before-${Date.now()}.cjs`), fs.constants.COPYFILE_EXCL);
    }
    const record = { at: new Date().toISOString(), runName: ctx.runName, command, connectionFile: ctx.connectionFile,
      previousValue: null, mode: verify ? 'verify-and-connect' : 'service-only', nodeExecutable: process.execPath,
      launcher: plan.launcher, launcherSha256: plan.launcherSha256, windowsRebootVerified: false };
    const backup = path.join(ctx.root, `install-before-${Date.now()}.json`); write(backup, record); write(ctx.installFile, record);
    writePrivateFileAtomic(plan.launcher, plan.launcherSource, { protectDirectory: false });
    powershell(`$ErrorActionPreference='Stop'; $p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if(-not(Test-Path -LiteralPath $p)){New-Item -Path $p -Force|Out-Null}; $v=Get-ItemProperty -LiteralPath $p -Name ${quotePS(ctx.runName)} -ErrorAction SilentlyContinue; if($null -ne $v){throw 'Startup value appeared during installation'}; New-ItemProperty -LiteralPath $p -Name ${quotePS(ctx.runName)} -Value ${quotePS(command)} -PropertyType String|Out-Null`);
    if (registryValue(ctx) !== command) throw Error('Startup registration read-back did not match');
    return { installed: true, changed: true, runName: ctx.runName, mode: record.mode, rollbackRecord: backup, windowsRebootVerified: false };
  }
  if (action === 'uninstall') {
    if (!fs.existsSync(ctx.installFile)) throw Error('No owned startup installation journal exists');
    const record = read(ctx.installFile), existing = registryValue(ctx);
    if (record.runName !== ctx.runName || !same(record.connectionFile, ctx.connectionFile)) throw Error('Startup installation journal belongs to another connection');
    if (existing !== null && existing !== record.command) throw Error('Startup value was changed by another actor; it was not removed');
    if (existing !== null) powershell(`$ErrorActionPreference='Stop'; $p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $v=Get-ItemProperty -LiteralPath $p -Name ${quotePS(ctx.runName)}; if([string]$v.${quotePS(ctx.runName)} -ne ${quotePS(record.command)}){throw 'Startup value changed'}; Remove-ItemProperty -LiteralPath $p -Name ${quotePS(ctx.runName)}`);
    if (registryValue(ctx) !== null) throw Error('Startup removal was not verified');
    write(path.join(ctx.root, `uninstall-${Date.now()}.json`), { at: new Date().toISOString(), runName: ctx.runName, removedOnlyOwnedValue: true });
    return { removed: true, runName: ctx.runName, bridgeAndRouteUnchanged: true, dataAndEvidencePreserved: true };
  }
  throw Error('Use status, install, uninstall, or run');
}
module.exports = { startupDecision, validateProof, beforeBoot, currentBootTimestamp, validateRouteStatus, guardEvidenceMatches, installationPlan };
if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(`Windows startup: ${error.message}`); process.exitCode = 1;
});
