// Attach an existing supervised production bridge to an existing Codex home.
// No new Codex user-data/profile, copied authentication, or launcher UI is used.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { WindowsRouteGuard } = require('../launcher/electron/route-guard.cjs');
const { writePrivateFileAtomic } = require('../launcher/electron/atomic-file.cjs');
const [action, manifestFile, proofFile, attemptId] = process.argv.slice(2);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => writePrivateFileAtomic(f, JSON.stringify(v, null, 2) + '\n', { protectDirectory: false });
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const delay = ms => new Promise(r => setTimeout(r, ms));
const source = path.resolve(__dirname, '..');
const alive = pid => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
const beforeBoot = at => Number.isFinite(Date.parse(at)) && Date.parse(at) < Date.now() - require('node:os').uptime() * 1000 - 5000;
function attemptPaths(home, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw Error('Invalid manager connection attempt');
  const prefix = path.join(home, 'runtime', `manager-attempt-${id}`);
  return { request: `${prefix}.json`, status: `${prefix}.status.json`, cancel: `${prefix}.cancel.json`, lock: path.join(home, 'runtime', 'manager-connect.lock.json') };
}
function ownReply(status, attempt, managerPid) {
  return status?.attemptId === attempt.attemptId && status.pid === managerPid ? status : null;
}
function assertAttempt(attempt, { lock, cancelled, parentAlive = alive(attempt.parentPid), now = Date.now() }) {
  if (lock?.attemptId !== attempt.attemptId || cancelled || !parentAlive || !Number.isFinite(attempt.deadline) || now >= attempt.deadline) {
    throw Error('This manager connection attempt was cancelled, expired or superseded; no new route may be installed');
  }
}
async function waitForAttempt(attempt, managerPid, { readStatus, now = Date.now, sleep = delay } = {}) {
  while (now() < attempt.deadline) {
    const state = ownReply(readStatus(), attempt, managerPid);
    if (state?.state === 'connected') return state;
    if (state?.state === 'failed' || state?.state === 'disconnected') throw Error(state.message || 'This manager did not connect');
    await sleep(250);
  }
  throw Error('This connection manager did not report completion before its deadline');
}
function readOptional(file) { try { return read(file); } catch { return null; } }
function ownsAttempt(files, id) { return readOptional(files.lock)?.attemptId === id; }
function releaseAttempt(files, id) { if (ownsAttempt(files, id)) fs.unlinkSync(files.lock); }
async function main() {
  if (!manifestFile) throw Error('Supply a manifest with runtimeHome, integrationHome, codexHome, and bunExecutable');
  const m = read(manifestFile);
  for (const key of ['runtimeHome', 'integrationHome', 'codexHome', 'bunExecutable']) if (!path.isAbsolute(m[key] || '')) throw Error(`${key} must be absolute`);
  if (path.resolve(m.runtimeHome).toLowerCase() === path.resolve(m.integrationHome).toLowerCase()) throw Error('Keep the existing runtime journal separate from the current desktop journal');
  const configFile = path.join(m.codexHome, 'config.toml');
  const managerStatus = path.join(m.integrationHome, 'manager-status.json');
  const stopFile = path.join(m.integrationHome, 'disconnect-request.json');
  const cli = (command) => {
    const r = cp.spawnSync(m.bunExecutable, [path.join(source, 'src/cli.ts'), '--home', m.integrationHome, 'route', command], {
      env: { ...process.env, CODEX_HOME: m.codexHome }, windowsHide: true, encoding: 'utf8', timeout: 30_000,
    });
    if (r.error || r.status !== 0) throw Error(`Route ${command} failed; no CLI output containing private configuration is copied to logs`);
    return JSON.parse(r.stdout);
  };
  if (action === 'prepare') {
    if (fs.existsSync(path.join(m.integrationHome, 'config.json'))) throw Error('Prepared integration already exists; preserve it');
    fs.mkdirSync(m.integrationHome, { recursive: true });
    if (process.platform === 'win32') {
      const owner = cp.execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
      cp.execFileSync('icacls.exe', [m.integrationHome, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    }
    const runtime = read(path.join(m.runtimeHome, 'config.json'));
    if (runtime.purpose === 'dev-harness') throw Error('A DEV runtime cannot attach to the current Codex desktop');
    write(path.join(m.integrationHome, 'config.json'), { ...runtime, subagentProtocol: 'native', runtimeCommand: [m.bunExecutable, path.join(source, 'src/cli.ts')] });
    const backups = path.join(m.integrationHome, 'backups'); fs.mkdirSync(backups);
    for (const name of ['config.toml', 'models_cache.json']) if (fs.existsSync(path.join(m.codexHome, name))) fs.copyFileSync(path.join(m.codexHome, name), path.join(backups, name));
    write(path.join(m.integrationHome, 'baseline.json'), { at: new Date().toISOString(), configFile, configSha256: hash(configFile), runtimeHome: m.runtimeHome });
    console.log(JSON.stringify({ prepared: m.integrationHome, codexHome: m.codexHome, currentConfigChanged: false })); return;
  }
  if (action === 'status') { console.log(JSON.stringify({ route: cli('status'), manager: fs.existsSync(managerStatus) ? read(managerStatus) : null })); return; }
  if (action === 'disconnect') {
    // Cancel a pending install before restoring the route. A delayed watcher
    // must acknowledge cancellation (or exit) before a caller claims recovery.
    const lockFile = path.join(m.integrationHome, 'runtime', 'manager-connect.lock.json');
    const pending = readOptional(lockFile);
    if (pending) {
      const files = attemptPaths(m.integrationHome, pending.attemptId);
      write(files.cancel, { attemptId: pending.attemptId, at: new Date().toISOString(), reason: 'explicit-disconnect' });
      write(stopFile, { at: new Date().toISOString() });
      const deadline = Date.now() + 65000;
      while (ownsAttempt(files, pending.attemptId) && Date.now() < deadline) {
        const status = readOptional(files.status);
        if (beforeBoot(pending.at) || (!alive(pending.parentPid) && !alive(status?.pid))) break;
        await delay(250);
      }
      if (ownsAttempt(files, pending.attemptId) && !beforeBoot(pending.at)
        && (alive(pending.parentPid) || alive(readOptional(files.status)?.pid))) {
        throw Error('Pending manager cancellation has not settled; route recovery is not yet confirmed');
      }
    }
    // The existing journal restores only owned changes and preserves later user edits.
    const route = cli('disconnect'); write(stopFile, { at: new Date().toISOString() });
    console.log(JSON.stringify({ route, sessionsPreserved: true })); return;
  }
  if (action === 'connect') {
    const proof = proofFile && read(proofFile);
    if (!proof?.passed || !proof.configUnchanged || proof.home.toLowerCase() !== m.codexHome.toLowerCase()
      || (proof.webOnlyProof !== true && !proof.turns?.some(t => t.selection === 'existing default' && t.status === 'completed' && t.markerMatches))
      || !proof.turns?.some(t => t.selection?.startsWith('chatgpt-web/') && t.status === 'completed' && t.markerMatches)
      || proof.configSha256 !== hash(configFile)
      || Date.now() - Date.parse(proof.at) > 15 * 60_000) throw Error('A fresh real official-and-Web request proof and unchanged configuration are required');
    const initialRoute = cli('status');
    if (!Array.isArray(initialRoute.errors) || initialRoute.errors.length) throw Error('Main configuration differs from the owned route journal; no connection was started');
    if (initialRoute.active) throw Error('Already connected; inspect status before reconnecting');
    // A prior manager must acknowledge its stop before the same journal is reused.
    if (fs.existsSync(stopFile)) {
      const deadline = Date.now() + 10_000;
      while (fs.existsSync(managerStatus) && alive(read(managerStatus).pid) && Date.now() < deadline) await delay(250);
      if (fs.existsSync(managerStatus) && alive(read(managerStatus).pid)) throw Error('Previous manager is still running; it was not replaced');
      fs.renameSync(stopFile, `${stopFile}.${Date.now()}.completed`);
    }
    const prior = readOptional(managerStatus);
    if (prior && !beforeBoot(prior.at) && alive(prior.pid)) throw Error('An existing manager is still running; it was not replaced');
    const attempt = { attemptId: crypto.randomUUID(), parentPid: process.pid, at: new Date().toISOString(), deadline: Date.now() + 45000,
      manifestFile: path.resolve(manifestFile), proofFile: path.resolve(proofFile), configSha256: proof.configSha256 };
    const files = attemptPaths(m.integrationHome, attempt.attemptId);
    fs.mkdirSync(path.dirname(files.lock), { recursive: true });
    const previous = readOptional(files.lock);
    if (fs.existsSync(files.lock)) {
      if (!previous) throw Error('The existing manager attempt lock is invalid; it was preserved');
      const previousStatus = readOptional(attemptPaths(m.integrationHome, previous.attemptId).status);
      if (!beforeBoot(previous.at) && (alive(previous.parentPid) || alive(previousStatus?.pid))) throw Error('Another manager connection attempt is still running');
      fs.renameSync(files.lock, `${files.lock}.${Date.now()}.retired`);
    }
    fs.writeFileSync(files.lock, JSON.stringify(attempt) + '\n', { flag: 'wx', mode: 0o600 });
    write(files.request, attempt);
    fs.copyFileSync(configFile, path.join(m.integrationHome, 'backups', `config-before-connect-${Date.now()}.toml`), fs.constants.COPYFILE_EXCL);
    const args = [m.bunExecutable, __filename, 'watch', path.resolve(manifestFile), path.resolve(proofFile), attempt.attemptId];
    if (args.some(v => /["\r\n]/.test(v))) throw Error('Invalid process argument');
    const command = args.map(v => `"${v}"`).join(' ');
    const ps = `$s=New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ShowWindow=[uint16]0}; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'; ProcessStartupInformation=$s}; if($r.ReturnValue -ne 0){exit 1}; [int]$r.ProcessId`;
    let managerPid;
    try {
      managerPid = Number(cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 20_000 }).trim());
      if (!Number.isInteger(managerPid) || managerPid < 1) throw Error('Manager process creation returned no valid PID');
      const connected = await waitForAttempt(attempt, managerPid, { readStatus: () => readOptional(files.status) });
      if (fs.existsSync(files.cancel)) throw Error('Connection was cancelled before acknowledgement');
      console.log(JSON.stringify(connected)); return;
    } catch (error) {
      write(files.cancel, { attemptId: attempt.attemptId, at: new Date().toISOString(), reason: 'connection-failed' });
      const deadline = Date.now() + 65000;
      while (Date.now() < deadline) {
        const state = readOptional(files.status);
        const pid = managerPid || state?.pid;
        if (!ownsAttempt(files, attempt.attemptId) || (pid && !alive(pid))) break;
        // If process creation failed before the watcher ran, its durable cancel
        // marker also rejects any later watcher before guard/route operations.
        if (!pid && Date.now() >= attempt.deadline) break;
        await delay(250);
      }
      const state = readOptional(files.status), pid = managerPid || state?.pid;
      if (ownsAttempt(files, attempt.attemptId) && pid && alive(pid)) {
        throw Error('Manager attempt was cancelled but is still settling; recovery has not been confirmed');
      }
      releaseAttempt(files, attempt.attemptId);
      throw Error(`${error.message}; this attempt was cancelled and cannot install a late route`);
    }
  }
  if (action !== 'watch') throw Error('Use prepare, connect, status, or disconnect');
  const files = attemptPaths(m.integrationHome, attemptId);
  const attempt = read(files.request);
  if (attempt.attemptId !== attemptId || attempt.manifestFile !== path.resolve(manifestFile) || attempt.proofFile !== path.resolve(proofFile)) throw Error('Manager attempt belongs to a different invocation');
  const assertCurrentAttempt = () => assertAttempt(attempt, { lock: readOptional(files.lock), cancelled: fs.existsSync(files.cancel) || fs.existsSync(stopFile) });
  // A watcher arriving after its caller failed may not arm a guard, mutate the
  // route, or replace the status of a newer/live manager.
  assertCurrentAttempt();
  const supervisor = read(path.join(m.runtimeHome, 'runtime/launcher-supervisor.json'));
  const config = read(path.join(m.integrationHome, 'config.json'));
  const guard = new WindowsRouteGuard({ coreHome: m.integrationHome, runtimeHome: m.runtimeHome, codexHome: m.codexHome, ownerPid: supervisor.ownerPid,
    invocation: { executable: m.bunExecutable, args: [path.join(source, 'src/cli.ts')], cwd: source } });
  const state = (status, extra = {}) => {
    const value = { at: new Date().toISOString(), state: status, pid: process.pid, attemptId, codexHome: m.codexHome, ...extra };
    if (ownsAttempt(files, attemptId)) write(managerStatus, value);
    // The attempt-specific file is the caller's acknowledgement. Publish it
    // last so a failed shared-status write cannot acknowledge a connection.
    write(files.status, value);
  };
  let installed = false;
  try {
    const proof = read(proofFile);
    assertCurrentAttempt(); state('starting');
    if (hash(configFile) !== proof.configSha256) throw Error('Current configuration changed before connection');
    await guard.arm(config); guard.assertReady();
    assertCurrentAttempt(); state('installing');
    const route = cli('install'); installed = true; guard.assertReady();
    assertCurrentAttempt();
    if (!route.active) throw Error('Route installation did not activate');
    state('connected', { routeUrl: `http://${config.host}:${config.port}/v1`, guardStatus: guard.statusFile, configSha256: hash(configFile), restartCodexRequired: true });
    while (!fs.existsSync(stopFile) && !fs.existsSync(files.cancel)) { await delay(1000); guard.assertReady(); }
    await guard.stop(); state('disconnected', { routeRestored: cli('status').active === false });
  } catch (error) {
    // Keep the guard alive until an owned route has been restored.
    let restored = false;
    try { restored = cli('disconnect').active === false; } catch {}
    if (restored) { try { await guard.stop(); } catch {} }
    state('failed', { message: error.message, routeRestored: restored, installed });
    if (!restored) process.exitCode = 1;
  } finally {
    releaseAttempt(files, attemptId);
  }
}
module.exports = { ownReply, assertAttempt, waitForAttempt, attemptPaths };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
