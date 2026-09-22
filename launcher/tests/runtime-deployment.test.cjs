const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { explicitRuntimeBundle, runtimeInvocation, embeddedRuntimeInvocation } = require('../electron/runtime-command.cjs');
const { patchRuntime, maintenanceHealthReady } = require('../../scripts/deploy-current-runtime.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
test('maintenance can keep admission drained, while startup must accept and neither may have active turns', () => {
  const idle = { accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 };
  assert.equal(maintenanceHealthReady(idle, true), true);
  assert.equal(maintenanceHealthReady(idle), false);
  assert.equal(maintenanceHealthReady({ ...idle, accepting_turns: true }), true);
  for (const accepting_turns of [true, false]) {
    for (const field of ['active_http_turns', 'active_browser_turns']) {
      assert.equal(maintenanceHealthReady({ ...idle, accepting_turns, [field]: 1 }, true), false);
    }
  }
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-runtime-deployment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['app/browser-helper.cjs', 'app/cli.js', 'bin/' + (process.platform === 'win32' ? 'codex-chatgpt-web.cmd' : 'codex-chatgpt-web'), 'runtime/' + (process.platform === 'win32' ? 'bun.exe' : 'bun')]
    .sort().map(relative => {
      const absolute = path.join(root, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, relative); fs.chmodSync(absolute, 0o700);
      return { path: relative, size: Buffer.byteLength(relative), sha256: digest(relative) };
    });
  const bundleId = digest(files.map(file => `${file.path}\0${file.size}\0${file.sha256}\0`).join(''));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, appVersion: require('../../package.json').version,
    platform: process.platform, arch: process.arch, bunVersion: '1.4.0', playwright: '1.62.0', files, bundleId,
    launcher: 'bin/' + (process.platform === 'win32' ? 'codex-chatgpt-web.cmd' : 'codex-chatgpt-web'), entrypoint: 'app/cli.js' }));
  return { root, bundleId, env: { CODEX_CHATGPT_WEB_RUNTIME_BUNDLE: root, CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID: bundleId } };
}
test('runtime override is opt-in and incomplete identity never falls back', () => {
  assert.equal(explicitRuntimeBundle({ env: {} }), null);
  assert.throws(() => explicitRuntimeBundle({ env: { CODEX_CHATGPT_WEB_RUNTIME_BUNDLE: 'relative' } }), /absolute bundle path/);
  assert.throws(() => explicitRuntimeBundle({ env: { CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID: 'a'.repeat(64) } }), /absolute bundle path/);
});
test('runtime override verifies candidate content and exact expected manifest identity', t => {
  const f = fixture(t);
  assert.throws(() => explicitRuntimeBundle({ env: { ...f.env, CODEX_CHATGPT_WEB_RUNTIME_BUNDLE_ID: 'a'.repeat(64) } }), /identity mismatch/);
  fs.writeFileSync(path.join(f.root, 'app', 'cli.js'), 'changed');
  assert.throws(() => explicitRuntimeBundle({ env: f.env }), /size mismatch|checksum mismatch/);
});
test('runtime override rejects files outside the hash manifest', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'extra.js'), 'unexpected');
  assert.throws(() => explicitRuntimeBundle({ env: f.env }), /unmanifested file/);
});
test('runtime and embedded CLI select the same verified bundle as the helper', t => {
  const f = fixture(t);
  const keys = Object.keys(f.env); const before = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }));
  Object.assign(process.env, f.env);
  const expected = explicitRuntimeBundle();
  for (const invoke of [runtimeInvocation, embeddedRuntimeInvocation]) {
    const result = invoke({ app: { isPackaged: false }, sourceRoot: 'unused-source', args: ['serve'] });
    assert.equal(result.executable, expected.executable);
    assert.deepEqual(result.args, [expected.entrypoint, 'serve']);
    assert.equal(result.cwd, f.root);
  }
  assert.equal(expected.helperScript, path.join(f.root, 'app', 'browser-helper.cjs'));
});
test('deployment and rollback preserve unrelated configuration and remove newly introduced helper override', () => {
  const original = { runtimeCommand: ['old'], controlToken: 'test-only-secret', webAccountsFile: 'existing-registry', port: 17881 };
  const next = patchRuntime(original, { runtimeCommand: ['new'], browserHelperScriptPath: 'new-helper' });
  const restored = patchRuntime({ ...next, extraUserPreference: true }, { runtimeCommand: original.runtimeCommand });
  assert.deepEqual(restored, { ...original, extraUserPreference: true });
  assert.deepEqual(original.runtimeCommand, ['old']);
});
