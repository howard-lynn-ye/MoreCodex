const test = require("node:test");
const assert = require("node:assert/strict");
const { assertServiceOnlyCommand, disconnectBeforeShutdown } = require("../electron/integration-safety.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("inspection and service-only modes reject integration writes but allow diagnostics", () => {
  for (const mode of ["--inspect-only", "--service-only"]) {
    for (const args of [["setup"], ["uninstall"], ["route", "connect"], ["route", "disconnect"]]) {
      assert.throws(() => assertServiceOnlyCommand(args, [mode]), /cannot modify Codex/);
    }
    for (const args of [["doctor"], ["route", "status"], ["service", "cancel-turns"]]) {
      assert.doesNotThrow(() => assertServiceOnlyCommand(args, [mode]));
    }
  }
});

test("quit restores route before stopping the service and refuses to stop on restore failure", async () => {
  const calls = [];
  const supervisor = { shutdown: async () => { calls.push("shutdown"); } };
  await disconnectBeforeShutdown({ host: { restoreBridgeRoute: async () => calls.push("restore") }, supervisor });
  assert.deepEqual(calls, ["restore", "shutdown"]);
  calls.length = 0;
  await assert.rejects(disconnectBeforeShutdown({ host: { restoreBridgeRoute: async () => { throw Error("conflict"); } }, supervisor }), /conflict/);
  assert.deepEqual(calls, []);
  await disconnectBeforeShutdown({ isolated: true, host: { restoreBridgeRoute: () => { throw Error("must not run"); } }, supervisor });
  assert.deepEqual(calls, ["shutdown"]);
});

test("runtime loss restores the route once even if several failure notifications arrive together", async () => {
  let calls = 0;
  const supervisor = Object.create(RuntimeSupervisor.prototype);
  supervisor.writeState = () => {};
  supervisor.logger = { error() {} };
  supervisor.onUnavailable = async () => { calls++; };
  supervisor.tryWriteState("degraded", "daemon exit");
  supervisor.tryWriteState("failed", "restart limit");
  await supervisor.routeRecovery;
  assert.equal(calls, 1);
  supervisor.stopping = true;
  supervisor.tryWriteState("failed", "intentional stop");
  assert.equal(supervisor.routeRecovery, null);
});
