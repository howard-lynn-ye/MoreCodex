// Reversible deployment of the existing production bridge. No route installation,
// browser interaction, process termination, or credential migration occurs here.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { validateRuntimeBundle } = require('../launcher/electron/runtime-install.cjs');
const { writePrivateFileAtomic } = require('../launcher/electron/atomic-file.cjs');
const { launchIndependentProcess } = require('./windows-independent-process.cjs');

const source = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, value) => writePrivateFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { protectDirectory: false });
function requireFile(file) { if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw Error('Required absolute file is unavailable'); return file; }
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 30000, ...options });
  if (result.error || result.status !== 0) throw Error('Required command failed; private command output was not copied into deployment logs');
  return result.stdout.trim();
}
function load(connectionFile) {
  requireFile(connectionFile);
  const connection = read(connectionFile);
  for (const key of ['runtimeHome', 'integrationHome', 'codexHome', 'bunExecutable']) {
    if (typeof connection[key] !== 'string' || !path.isAbsolute(connection[key])) throw Error(`Invalid connection ${key}`);
  }
  const base = path.dirname(connection.runtimeHome);
  const baseline = read(path.join(base, 'baseline.json'));
  if (!same(baseline.core, connection.runtimeHome) || baseline.profile !== 'production' || baseline.dev !== false) {
    throw Error('The existing production launch baseline does not match this runtime home');
  }
  for (const dir of [baseline.browser, baseline.codex]) {
    if (!path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) throw Error('The original launcher data or launcher Codex home is missing');
  }
  const result = { ...connection, connectionFile, launcherData: baseline.browser,
    launcherCodexHome: connection.codexHome, previousLauncherCodexHome: baseline.codex,
    root: path.dirname(connectionFile), configFile: path.join(connection.runtimeHome, 'config.json'),
    supervisorFile: path.join(connection.runtimeHome, 'runtime', 'launcher-supervisor.json'),
    descriptorFile: path.join(connection.runtimeHome, 'runtime', 'launcher-browser.json'),
    stateFile: path.join(baseline.browser, 'launcher-state.json'),
    pointerFile: path.join(path.dirname(connectionFile), 'runtime-deployment.json'),
    officialConfig: path.join(connection.codexHome, 'config.toml'),
  };
  result.config = read(result.configFile);
  if (result.config.host !== '127.0.0.1' || !Number.isInteger(result.config.port) || result.config.mode !== 'full') {
    throw Error('Deployment requires the existing loopback full-mode bridge configuration');
  }
  if (!same(result.config.browserHostDescriptorPath, result.descriptorFile)) throw Error('Configured browser descriptor differs from the existing launcher');
  if (read(result.stateFile).onboardingComplete !== true) throw Error('Hidden restart is not ready: existing launcher onboarding is incomplete');
  result.registryFile = requireFile(result.config.webAccountsFile);
  return result;
}
function routeStatus(ctx) {
  const text = run(ctx.bunExecutable, ['run', path.join(source, 'src', 'cli.ts'), '--home', ctx.integrationHome, 'route', 'status'], {
    cwd: source, env: { ...process.env, CODEX_HOME: ctx.codexHome, CODEX_CHATGPT_WEB_HOME: ctx.integrationHome },
  });
  const status = JSON.parse(text);
  if (typeof status.active !== 'boolean') throw Error('Official route state could not be established');
  return status.active;
}
function requireOfficialRouteInactive(ctx) {
  if (routeStatus(ctx)) throw Error('First disconnect the owned main Codex route using current-codex-integration.cjs disconnect; deployment never changes it');
}
function supervisor(ctx) { return fs.existsSync(ctx.supervisorFile) ? read(ctx.supervisorFile) : {}; }
function maintenanceHealthReady(h, allowDrained = false) {
  return (h.accepting_turns === true || (allowDrained && h.accepting_turns === false))
    && h.active_http_turns === 0 && h.active_browser_turns === 0;
}
async function health(ctx, allowDrained = false) {
  const response = await fetch(`http://${ctx.config.host}:${ctx.config.port}/healthz`, { signal: AbortSignal.timeout(3000) });
  const h = await response.json();
  if (!response.ok || h.service !== 'codex-chatgpt-web' || h.status !== 'ok' || h.mode !== ctx.config.mode
    || h.version !== ctx.config.releaseVersion || typeof h.accepting_turns !== 'boolean'
    || !Number.isInteger(h.pid) || !alive(h.pid)) throw Error('Bridge has not supplied valid accepting health evidence');
  if (!maintenanceHealthReady(h, allowDrained)) throw Error('Bridge is busy or not accepting; finish or explicitly interrupt its active turns before maintenance');
  return { service: h.service, status: h.status, mode: h.mode, version: h.version, pid: h.pid,
    accepting_turns: h.accepting_turns, active_http_turns: 0, active_browser_turns: 0 };
}
function candidate(root, version) {
  if (!root || !path.isAbsolute(root)) throw Error('Candidate runtime path must be absolute');
  const manifest = read(path.join(root, 'manifest.json'));
  validateRuntimeBundle(root, { version, platform: process.platform, arch: process.arch, bundleId: manifest.bundleId });
  if (manifest.bunVersion !== '1.4.0') throw Error('Candidate does not contain the pinned Bun 1.4.0 runtime');
  const executable = path.join(root, 'runtime', 'bun.exe');
  const entrypoint = path.join(root, 'app', 'cli.js');
  if (run(executable, ['--version']) !== '1.4.0' || run(executable, [entrypoint, '--version']) !== version) {
    throw Error('Candidate executable version does not match its manifest');
  }
  return { root, bundleId: manifest.bundleId, version, executable, entrypoint,
    helper: path.join(root, 'app', 'browser-helper.cjs'), fileCount: manifest.files.length };
}
function protect(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const identity = run('whoami.exe', []);
  run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F']);
}
async function portFree(ctx) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(Error('The configured bridge port is still occupied; no process was terminated')));
    server.listen({ host: ctx.config.host, port: ctx.config.port, exclusive: true }, () => server.close(resolve));
  });
}
async function requireStopped(ctx) {
  requireOfficialRouteInactive(ctx);
  const state = supervisor(ctx);
  if (alive(state.ownerPid) || alive(state.daemonPid) || alive(state.tunnelPid)) {
    throw Error('The existing launcher or an owned child is still alive. Close the bridge normally first; this script does not terminate processes');
  }
  await portFree(ctx);
}
function readBackup(ctx, backupDir) {
  if (!backupDir || !path.isAbsolute(backupDir)) throw Error('An absolute deployment backup directory is required');
  const state = read(path.join(backupDir, 'deployment.json'));
  if (!same(state.connectionFile, ctx.connectionFile) || !same(state.runtimeHome, ctx.runtimeHome)
    || !same(state.launcherData, ctx.launcherData)) throw Error('Backup belongs to a different integration or browser profile');
  return state;
}
function preservePreference(ctx, state, backupDir) {
  const original = read(path.join(backupDir, 'launcher-state.json'));
  const current = read(ctx.stateFile);
  // The legacy graceful-close command changes this preference. Restore only
  // this one field; never replace session/profile storage or other preferences.
  if (current.keepRunningOnClose !== original.keepRunningOnClose) {
    if (current.keepRunningOnClose !== false) throw Error('Launcher close preference changed independently; refusing to overwrite it');
    current.keepRunningOnClose = original.keepRunningOnClose;
    write(ctx.stateFile, current);
  }
}
function patchRuntime(config, values) {
  const result = { ...config };
  for (const key of ['runtimeCommand', 'browserHelperScriptPath']) {
    if (values[key] === undefined) delete result[key]; else result[key] = values[key];
  }
  return result;
}
async function start(ctx) {
  await requireStopped(ctx);
  const pointer = fs.existsSync(ctx.pointerFile) ? read(ctx.pointerFile) : null;
  let selected;
  if (pointer) {
    if (pointer.schemaVersion !== 1 || !same(pointer.runtimeHome, ctx.runtimeHome)
      || !same(pointer.launcherData, ctx.launcherData) || !same(pointer.launcherCodexHome, ctx.launcherCodexHome)) {
      throw Error('Deployment pointer does not match the existing homes');
    }
    selected = candidate(pointer.bundleRoot, ctx.config.releaseVersion);
    if (selected.bundleId !== pointer.bundleId) throw Error('Candidate changed after deployment');
    if (JSON.stringify(ctx.config.runtimeCommand) !== JSON.stringify([selected.executable, selected.entrypoint])
      || !same(ctx.config.browserHelperScriptPath, selected.helper)) throw Error('Runtime config and deployment pointer disagree');
  }
  const officialBefore = hash(ctx.officialConfig);
  const registryBefore = hash(ctx.registryFile);
  const logDir = path.join(ctx.root, 'runtime-deployment-logs');
  protect(logDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const env = { CODEX_HOME: ctx.launcherCodexHome, CODEX_CHATGPT_WEB_HOME: ctx.runtimeHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: ctx.launcherData, CODEX_CHATGPT_WEB_BUN: ctx.bunExecutable };
  for (const name of ['VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE', 'CODEX_CHATGPT_WEB_RUNTIME_BUNDLE', 'CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID']) delete env[name];
  if (selected) { env.CODEX_CHATGPT_WEB_RUNTIME_BUNDLE = selected.root; env.CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID = selected.bundleId; }
  const executable = require(path.join(source, 'launcher', 'node_modules', 'electron'));
  const ownerPid = await launchIndependentProcess({ executable,
    args: [path.join(source, 'launcher'), '--service-only', '--hidden',
      '--core-home', ctx.runtimeHome, '--codex-home', ctx.launcherCodexHome, '--launcher-data', ctx.launcherData],
    cwd: source, env, bootstrapExecutable: ctx.bunExecutable,
    unsetEnv: ['VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE'],
    stdoutFile: path.join(logDir, `${stamp}.stdout.log`), stderrFile: path.join(logDir, `${stamp}.stderr.log`),
    receiptFile: path.join(logDir, `${stamp}.process.json`),
  });
  const processFile = path.join(logDir, `${stamp}.start.json`);
  const evidence = { at: new Date().toISOString(), ownerPid, independentWindowsProcess: true, runtimeHome: ctx.runtimeHome,
    launcherData: ctx.launcherData, launcherCodexHome: ctx.launcherCodexHome, port: ctx.config.port,
    bundleId: selected?.bundleId || null, cli: selected?.entrypoint || path.join(source, 'src', 'cli.ts'),
    serviceOnly: true, dev: false, officialRouteInstalled: false, endpointAcceptance: 'not tested' };
  write(processFile, { ...evidence, status: 'starting' });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!alive(ownerPid)) break;
    try {
      const h = await health(ctx);
      const state = supervisor(ctx);
      const descriptor = read(ctx.descriptorFile);
      if (state.ownerPid !== ownerPid || state.daemonPid !== h.pid || state.status !== 'ready') throw Error('Ownership still starting');
      if (selected && !same(descriptor.helper.script, selected.helper)) throw Error('Helper did not use the deployed bundle');
      if (hash(ctx.officialConfig) !== officialBefore || hash(ctx.registryFile) !== registryBefore) {
        throw Error('Official config or account registry changed during startup; inspect before proceeding');
      }
      const result = { ...evidence, status: 'ready', daemonPid: h.pid, health: h, registrySha256: registryBefore,
        officialConfigUnchanged: true, helper: descriptor.helper.script, evidence: processFile };
      write(processFile, result);
      return result;
    } catch { /* Bounded startup polling; never sends a model request. */ }
    await pause(500);
  }
  write(processFile, { ...evidence, status: 'startup-failed', officialConfigUnchanged: hash(ctx.officialConfig) === officialBefore,
    recovery: 'Keep official route disconnected. Close the bridge normally, then rollback with the saved backup directory.' });
  throw Error(`Bridge did not meet readiness within 60 seconds; route remains disconnected. Evidence: ${processFile}`);
}
async function main() {
  if (process.platform !== 'win32') throw Error('This deployment helper is for Windows');
  const [action, connectionFile, argument] = process.argv.slice(2);
  const ctx = load(connectionFile);
  if (action === 'preflight' || action === 'prepare') {
    const selected = candidate(argument, ctx.config.releaseVersion);
    // A drained, idle bridge is the stable maintenance state: do not reopen
    // admission and race clients retrying interrupted requests just to back up.
    const h = await health(ctx, true); const ownership = supervisor(ctx);
    if (ownership.status !== 'ready' || ownership.daemonPid !== h.pid || !alive(ownership.ownerPid)) throw Error('Live supervisor ownership is inconsistent');
    const descriptor = read(ctx.descriptorFile);
    const summary = { at: new Date().toISOString(), connectionFile: ctx.connectionFile, runtimeHome: ctx.runtimeHome,
      launcherData: ctx.launcherData, launcherCodexHome: ctx.launcherCodexHome, candidate: selected,
      current: { ownerPid: ownership.ownerPid, daemonPid: h.pid, helper: descriptor.helper.script, health: h,
        previousLauncherCodexHome: ctx.previousLauncherCodexHome },
      mainRouteActive: routeStatus(ctx), configSha256: hash(ctx.configFile), registrySha256: hash(ctx.registryFile),
      existingHelperSha256: hash(descriptor.helper.script), nativeUiAndWebAcceptance: 'not tested',
      mutationGate: 'Main route must be disconnected and old launcher normally stopped before deploy' };
    if (action === 'prepare') {
      const backupDir = path.join(ctx.root, 'runtime-deployment-backups', new Date().toISOString().replace(/[:.]/g, '-'));
      protect(backupDir);
      for (const [from, name] of [[ctx.configFile, 'config.json'], [ctx.stateFile, 'launcher-state.json'], [descriptor.helper.script, 'browser-helper.cjs']]) fs.copyFileSync(from, path.join(backupDir, name));
      if (fs.existsSync(ctx.pointerFile)) fs.copyFileSync(ctx.pointerFile, path.join(backupDir, 'runtime-deployment.json'));
      write(path.join(backupDir, 'deployment.json'), { ...summary, backupDir,
        originalRuntime: { runtimeCommand: ctx.config.runtimeCommand, browserHelperScriptPath: ctx.config.browserHelperScriptPath } });
      summary.backupDir = backupDir;
    }
    return summary;
  }
  if (action === 'start') return start(ctx);
  if (action !== 'deploy' && action !== 'rollback') throw Error('Use preflight, prepare, deploy, start, or rollback');
  const state = readBackup(ctx, argument);
  await requireStopped(ctx);
  if (hash(ctx.registryFile) !== state.registrySha256) throw Error('Account registry changed since the backup; create a fresh maintenance backup');
  if (hash(state.current.helper) !== state.existingHelperSha256) throw Error('Original helper changed independently; refusing to replace it');
  if (action === 'deploy') {
    if (Date.now() - Date.parse(state.at) > 15 * 60000) throw Error('Idle maintenance backup is older than 15 minutes; repeat prepare while the old bridge is healthy');
    if (hash(ctx.configFile) !== state.configSha256) throw Error('Runtime config changed after backup; refuse deployment');
    const selected = candidate(state.candidate.root, ctx.config.releaseVersion);
    if (selected.bundleId !== state.candidate.bundleId) throw Error('Candidate changed since preparation');
    const changes = { runtimeCommand: [selected.executable, selected.entrypoint], browserHelperScriptPath: selected.helper };
    const nextConfig = patchRuntime(ctx.config, changes);
    const pointer = { schemaVersion: 1, bundleRoot: selected.root, bundleId: selected.bundleId,
      runtimeHome: ctx.runtimeHome, launcherData: ctx.launcherData, launcherCodexHome: ctx.launcherCodexHome };
    preservePreference(ctx, state, argument);
    // Persist rollback intent before either write. An interrupted two-file
    // transaction remains explicitly recoverable without replacing user data.
    const intent = { at: new Date().toISOString(), changes, pointer };
    write(path.join(argument, 'deployment-intent.json'), intent);
    try {
      write(ctx.configFile, nextConfig); write(ctx.pointerFile, pointer);
      write(path.join(argument, 'deployed.json'), { ...intent, configSha256: hash(ctx.configFile) });
    } catch (error) {
      throw Error(`Deployment write did not complete. Keep the route disconnected and run rollback with ${argument}; its intent journal preserves the previous launch fields`);
    }
    return { deployed: true, started: false, backupDir: argument, pointer: ctx.pointerFile, bundleId: selected.bundleId,
      next: 'Run start; keep the main route disconnected until real official and Web request proofs are collected' };
  }
  const deployedFile = path.join(argument, 'deployed.json');
  const intentFile = path.join(argument, 'deployment-intent.json');
  if (!fs.existsSync(deployedFile) && !fs.existsSync(intentFile)) throw Error('Backup has no deployment intent record');
  const deployed = read(fs.existsSync(deployedFile) ? deployedFile : intentFile);
  for (const key of ['runtimeCommand', 'browserHelperScriptPath']) {
    if (![deployed.changes[key], state.originalRuntime[key]].some(value => JSON.stringify(ctx.config[key]) === JSON.stringify(value))) {
      throw Error('Runtime launch fields changed independently; refusing rollback overwrite');
    }
  }
  const oldPointer = path.join(argument, 'runtime-deployment.json');
  const originalPointer = fs.existsSync(oldPointer) ? read(oldPointer) : null;
  const currentPointer = fs.existsSync(ctx.pointerFile) ? read(ctx.pointerFile) : null;
  if (![deployed.pointer, originalPointer].some(value => JSON.stringify(currentPointer) === JSON.stringify(value))) throw Error('Deployment pointer changed independently');
  write(ctx.configFile, patchRuntime(ctx.config, state.originalRuntime));
  if (fs.existsSync(oldPointer)) write(ctx.pointerFile, read(oldPointer));
  else if (fs.existsSync(ctx.pointerFile)) fs.unlinkSync(ctx.pointerFile);
  preservePreference(ctx, state, argument);
  write(path.join(argument, 'rolled-back.json'), { at: new Date().toISOString(), restoredLaunchFields: true, oldHelperUnchanged: true, registryUnchanged: true });
  return { rolledBack: true, started: false, backupDir: argument, next: 'Run start to use the previous runtime with the same homes; the main Codex route remains disconnected' };
}
module.exports = { patchRuntime, maintenanceHealthReady };
if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(`Runtime deployment: ${error.message}`); process.exitCode = 1;
});
