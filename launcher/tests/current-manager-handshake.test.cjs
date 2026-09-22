const test = require('node:test');
const assert = require('node:assert/strict');
const { ownReply, assertAttempt, waitForAttempt, attemptPaths } = require('../../scripts/current-codex-integration.cjs');

const attempt = { attemptId: 'a8e9c2a2-78af-4cdd-866e-42e76389a7db', parentPid: 101, deadline: 1000 };
test('connection ignores old failure and old success, accepting only its spawned manager', async () => {
  const replies = [
    { attemptId: 'old', pid: 102, state: 'failed', message: 'old failure' },
    { attemptId: 'old', pid: 102, state: 'connected' },
    { attemptId: attempt.attemptId, pid: 999, state: 'connected' },
    { attemptId: attempt.attemptId, pid: 102, state: 'starting' },
    { attemptId: attempt.attemptId, pid: 102, state: 'connected' },
  ];
  let now = 0, index = 0;
  const result = await waitForAttempt(attempt, 102, { readStatus: () => replies[index++], now: () => now, sleep: async () => { now += 100; } });
  assert.equal(result, replies[4]); assert.equal(index, 5);
  assert.equal(ownReply({ attemptId: attempt.attemptId, pid: 999 }, attempt, 102), null);
});
test('only this attempt failure terminates its handshake', async () => {
  await assert.rejects(waitForAttempt(attempt, 102, { now: () => 0,
    readStatus: () => ({ attemptId: attempt.attemptId, pid: 102, state: 'failed', message: 'owned failure' }) }), /owned failure/);
});
test('expired handshake cannot be rescued by a late connected status from another attempt', async () => {
  let now = 0;
  await assert.rejects(waitForAttempt(attempt, 102, { readStatus: () => ({ attemptId: 'old', pid: 102, state: 'connected' }),
    now: () => now, sleep: async () => { now += 250; } }), /deadline/);
  assert.equal(now, 1000);
  assert.throws(() => assertAttempt(attempt, { lock: attempt, cancelled: false, parentAlive: true, now }), /expired/);
});
test('a delayed or in-flight watcher is rejected after cancellation, supersession or caller exit', () => {
  const valid = { lock: attempt, cancelled: false, parentAlive: true, now: 500 };
  assert.doesNotThrow(() => assertAttempt(attempt, valid));
  for (const changes of [{ cancelled: true }, { lock: { attemptId: 'newer-attempt' } }, { lock: null }, { parentAlive: false }, { now: 1000 }]) {
    assert.throws(() => assertAttempt(attempt, { ...valid, ...changes }), /no new route may be installed/);
  }
});
test('attempt artifacts cannot escape the integration runtime directory', () => {
  assert.throws(() => attemptPaths(process.cwd(), '../another-status'), /Invalid/);
  const files = attemptPaths(process.cwd(), attempt.attemptId);
  assert.ok(files.status.endsWith(`manager-attempt-${attempt.attemptId}.status.json`));
  assert.ok(files.cancel.endsWith(`manager-attempt-${attempt.attemptId}.cancel.json`));
});
