const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startupDecision, validateProof, beforeBoot, currentBootTimestamp, validateRouteStatus,
  guardEvidenceMatches, installationPlan } = require('../../scripts/current-integration-startup.cjs');
test('startup command stays within the Windows Run limit and keeps long verification arguments in its owned bootstrap', () => {
  const ctx = { connectionFile: 'D:\\Projects\\current-integration\\connection.json', root: 'D:\\Projects\\current-integration\\windows-startup' };
  const codePath = 'C:\\Users\\example-user\\AppData\\Local\\OpenAI\\Codex\\bin\\some-long-version\\codex.exe';
  const plan = installationPlan(ctx, true, codePath, 'C:\\nvm4w\\nodejs\\node.exe');
  assert.ok(plan.command.length <= 260);
  assert.match(plan.command, /-WindowStyle Hidden/);
  assert.doesNotMatch(plan.command, /Bypass|EncodedCommand|codex\.exe/);
  assert.ok(plan.launcherSource.includes('--verify-and-connect'));
  assert.ok(plan.launcherSource.includes(JSON.stringify(codePath)));
});
test('only a healthy independently guarded current integration is left connected', () => {
  assert.equal(startupDecision({ active: true, healthy: true, protectedRoute: true }), 'already-connected');
  assert.equal(startupDecision({ active: true, healthy: true }), 'recover-first');
  assert.equal(startupDecision({ active: true, healthy: false, protectedRoute: true }), 'recover-first');
  assert.equal(startupDecision({ active: false, healthy: true }), 'already-serving');
  assert.equal(startupDecision({ active: false, healthy: false }), 'start-service');
});
test('old-boot ownership can be archived without signalling recycled PIDs', () => {
  const boot = Date.parse('2026-09-16T08:00:00Z');
  assert.equal(beforeBoot('2026-09-15T08:00:00Z', boot), true);
  assert.equal(beforeBoot('2026-09-16T08:00:01Z', boot), false);
  assert.equal(beforeBoot('invalid', boot), false);
});
test('a journal active bit cannot hide configuration or catalogue ownership errors', () => {
  assert.equal(validateRouteStatus({ active: true, errors: [] }).active, true);
  assert.equal(validateRouteStatus({ active: false, errors: [] }).active, false);
  for (const active of [true, false]) {
    assert.throws(() => validateRouteStatus({ active, errors: ['external modification'] }), /external changes were preserved/);
    assert.throws(() => validateRouteStatus({ active }), /unknown/);
  }
});
test('ownership must have a valid current-boot timestamp, not an invalid or future date', () => {
  const now = Date.parse('2026-09-16T09:00:00Z'), boot = now - 3600000;
  assert.equal(currentBootTimestamp(new Date(now - 1000).toISOString(), now, boot), true);
  for (const at of ['invalid', new Date(boot - 10000).toISOString(), new Date(now + 60000).toISOString()]) {
    assert.equal(currentBootTimestamp(at, now, boot), false);
  }
});
test('ready guard evidence must protect this exact home, runtime, route and current lease', () => {
  const now = Date.now(), at = new Date(now - 1000).toISOString(), nonce = '8d99796e-fd53-4aa4-a56a-caa2369aeeea';
  const ctx = { integrationHome: path.resolve('fixture-integration'), runtimeHome: path.resolve('fixture-runtime'), codexHome: path.resolve('fixture-codex') };
  const statusFile = path.join(ctx.integrationHome, 'runtime', `route-guard-${nonce}.status.json`);
  const make = () => ({
    runtime: { healthy: true, ownerPid: 101, port: 17881, mode: 'full', version: '5.0.6' },
    manager: { state: 'connected', pid: 102, codexHome: ctx.codexHome, routeUrl: 'http://127.0.0.1:17881/v1', guardStatus: statusFile, at },
    guard: { state: 'ready', pid: 103, ownerPid: 101, nonce, at },
    spec: { nonce, ownerPid: 101, coreHome: ctx.integrationHome, runtimeHome: ctx.runtimeHome, codexHome: ctx.codexHome,
      statusFile, leaseFile: statusFile.replace('.status.json', '.lease.json'), healthUrl: 'http://127.0.0.1:17881/healthz', mode: 'full', version: '5.0.6' },
    lease: { nonce, at },
  });
  const valid = f => guardEvidenceMatches(ctx, f.runtime, f.manager, f.guard, f.spec, f.lease,
    { now, boot: now - 3600000, isAlive: pid => [101, 102, 103].includes(pid) });
  assert.equal(valid(make()), true);
  for (const mutate of [
    f => { f.manager.codexHome = path.resolve('another-home'); },
    f => { f.manager.routeUrl = 'http://127.0.0.1:17841/v1'; },
    f => { f.spec.coreHome = path.resolve('another-integration'); },
    f => { f.spec.runtimeHome = path.resolve('another-runtime'); },
    f => { f.spec.codexHome = path.resolve('another-home'); },
    f => { f.guard.nonce = 'different'; },
    f => { f.guard.ownerPid = 999; },
    f => { f.spec.mode = 'browser-only'; },
    f => { f.guard.at = 'invalid'; },
    f => { f.manager.at = new Date(now + 60000).toISOString(); },
    f => { f.lease.stop = true; },
    f => { f.lease.at = new Date(now - 9000).toISOString(); },
  ]) {
    const f = make(); mutate(f); assert.equal(valid(f), false);
  }
});
function fixture() {
  const time = Date.now(); const home = process.cwd();
  const proof = { passed: true, configUnchanged: true, home, configSha256: 'expected', at: new Date(time).toISOString(), turns: [
    { selection: 'existing default', status: 'completed', markerMatches: true },
    { selection: 'chatgpt-web/account/model', status: 'completed', markerMatches: true, threadId: 'thread', turnId: 'turn' },
  ] };
  const binding = { passed: true, configUnchanged: true, codexHome: home, checks: [{ passed: true,
    threadId: 'thread', turnId: 'turn', modelId: 'chatgpt-web/account/model',
    checks: { installed: true, submitted: true, observed: true, completed: true, rejected: false } }] };
  return { proof, binding, ctx: { codexHome: home }, time };
}
test('startup connection requires actual correlated model binding, not just successful HTTP/core output', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateProof(f.proof, f.binding, f.ctx, 'expected', f.time));
  f.binding.checks[0].checks.observed = false;
  assert.throws(() => validateProof(f.proof, f.binding, f.ctx, 'expected', f.time), /actual account\/model binding/);
});
test('stale proof, changed config and unrelated turn evidence cannot arm a route', () => {
  for (const mutate of [
    f => { f.proof.configUnchanged = false; },
    f => { f.proof.configSha256 = 'changed'; },
    f => { f.proof.at = new Date(f.time - 1).toISOString(); },
    f => { f.proof.at = 'invalid'; },
    f => { f.binding.checks[0].turnId = 'other-turn'; },
    f => { f.binding.checks[0].checks.rejected = true; },
    f => { f.proof.turns = f.proof.turns.slice(1); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateProof(f.proof, f.binding, f.ctx, 'expected', f.time));
  }
});
