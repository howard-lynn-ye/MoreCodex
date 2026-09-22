function serviceOnly(argv = process.argv) {
  return argv.includes("--service-only") || argv.includes("--inspect-only");
}

function assertServiceOnlyCommand(args, argv = process.argv) {
  if (!serviceOnly(argv)) return;
  // Allow diagnostics and runtime control, but never modify a Codex installation.
  if (["setup", "uninstall"].includes(args[0])
    || (args[0] === "route" && args[1] !== "status")) {
    throw new Error("Service-only launcher cannot modify Codex integration; use the isolated validation workflow");
  }
}

async function disconnectBeforeShutdown({ host, supervisor, isolated = false }) {
  if (!isolated && host) await host.restoreBridgeRoute("launcher-quit-route-restore");
  if (!isolated) await host?.releaseRouteProtection?.();
  return await supervisor?.shutdown({ cancelActiveTurns: true, force: true });
}

module.exports = { serviceOnly, assertServiceOnlyCommand, disconnectBeforeShutdown };
