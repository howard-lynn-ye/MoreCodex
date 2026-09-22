import { mkdirSync, existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { atomicWriteFile, getConfigDir, type AppConfig } from "./config";
import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import type { WebAccount, WebAccountRegistry } from "./web-accounts";

export interface AccountHostStatus {
  running: boolean;
  authenticated?: boolean;
  status?: string;
  activeTurns?: number;
  operation?: string | null;
}

export async function accountHostStatus(account: WebAccount): Promise<AccountHostStatus> {
  try {
    const descriptor = readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath);
    if (descriptor.profile !== "production") return { running: false };
    const response = await fetch(`${descriptor.control.endpoint}/v1/account-host/status`, {
      headers: { authorization: `Bearer ${descriptor.control.token}` }, signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { running: false };
    const status = await response.json() as { pid: number; profile: string; partition: string; authenticated?: boolean; status?: string; activeTurns: number; operation?: string | null };
    if (status.pid !== descriptor.pid || status.profile !== "production" || status.partition !== descriptor.partition) return { running: false };
    return { running: true, activeTurns: status.activeTurns, operation: status.operation,
      authenticated: typeof status.authenticated === "boolean" ? status.authenticated : undefined,
      status: typeof status.status === "string" ? status.status : undefined };
  } catch { return { running: false }; }
}

export async function accountHostControl(account: WebAccount, action: "login" | "stop") {
  const descriptor = readLauncherBrowserHostDescriptor(account.browserHostDescriptorPath);
  if (descriptor.profile !== "production") throw Error("Account host must use the production profile");
  const response = await fetch(`${descriptor.control.endpoint}/v1/account-host/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Error(`${account.label}: account host ${action} failed (HTTP ${response.status}); update the isolated host or finish its active turn`);
  return { action, account: account.id, accepted: true };
}

export async function runAccountHost(config: AppConfig, registry: WebAccountRegistry, account: WebAccount, visible = false) {
  if (!registry.host?.executable || !existsSync(registry.host.executable)) throw Error("Configure an account host executable with web-accounts start --executable PATH [--entry PATH]");
  if (!account.sessionHome) throw Error("Account has no independent sessionHome");
  const core = join(account.sessionHome, "bridge-home");
  const descriptor = join(core, "runtime", "launcher-browser.json");
  if (resolve(descriptor).toLowerCase() !== resolve(account.browserHostDescriptorPath).toLowerCase()) throw Error("Account descriptor must belong to sessionHome/bridge-home/runtime");
  if (resolve(core).toLowerCase() === resolve(getConfigDir()).toLowerCase()) throw Error("Dedicated account hosts must have a separate home from the Responses service");
  if ((await accountHostStatus(account)).running) throw Error("Account host is already running");
  const fresh = !existsSync(account.sessionHome);
  mkdirSync(account.sessionHome, { recursive: true, mode: 0o700 });
  if (fresh && process.platform === "win32") {
    const owner = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).stdout.trim();
    if (!owner || spawnSync("icacls.exe", [account.sessionHome, "/inheritance:r", "/grant:r", `${owner}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"], { windowsHide: true }).status !== 0) throw Error("Could not protect the independent account session directory");
  }
  const data = join(account.sessionHome, "launcher-data"); const codex = join(account.sessionHome, "codex-home");
  for (const directory of [core, data, codex, join(account.sessionHome, "logs")]) mkdirSync(directory, { recursive: true });
  const configFile = join(core, "config.json");
  if (!existsSync(configFile)) {
    const standalone = { ...config, browserHostDescriptorPath: descriptor, controlToken: randomBytes(32).toString("base64url"),
      storageStatePath: join(core, "browser", "storage-state.json"), webAccountsFile: undefined, webAccountIdentity: undefined,
      webModelBinding: undefined, httpAccountsFile: undefined, httpOnly: false, modelAccountLabels: undefined };
    atomicWriteFile(configFile, JSON.stringify(standalone, null, 2));
  }
  if (!existsSync(join(codex, "config.toml"))) atomicWriteFile(join(codex, "config.toml"), "# Dedicated Web account host; no Codex route installed.\n");
  if (!existsSync(join(data, "launcher-state.json"))) atomicWriteFile(join(data, "launcher-state.json"), JSON.stringify({
    version: 1, onboardingComplete: true, autoStart: false, keepRunningOnClose: true, showBrowserDuringTurns: false,
    browserInteractionMode: "automatic", coreSetupComplete: false, browserSmokePassed: false,
  }));
  const out = openSync(join(account.sessionHome, "logs", "host-stdout.log"), "a");
  const err = openSync(join(account.sessionHome, "logs", "host-stderr.log"), "a");
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codex, CODEX_CHATGPT_WEB_HOME: core, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
  const child = spawn(registry.host.executable, [...(registry.host.entry ? [registry.host.entry] : []), "--inspect-only",
    ...(visible ? [] : ["--hidden"]), "--account-label", account.id, "--core-home", core, "--codex-home", codex, "--launcher-data", data],
    { env, windowsHide: !visible, detached: true, stdio: ["ignore", out, err] });
  closeSync(out); closeSync(err);
  child.once("error", () => { process.exitCode = 1; });
  child.once("spawn", () => { atomicWriteFile(join(account.sessionHome!, "host-process.json"), JSON.stringify({ pid: child.pid, at: new Date().toISOString(), account: account.id })); child.unref(); });
}

export function launchAccountHost(account: WebAccount, visible = false) {
  // Windows account hosts survive the invoking terminal's job object. Arguments contain paths/IDs only.
  const args = [resolve(process.argv[1]!), "--home", getConfigDir(), "web-accounts", "host-run", account.id, ...(visible ? ["--visible"] : [])];
  if (process.platform === "win32") {
    const command = [process.execPath, ...args].map(value => `"${value}"`).join(" ");
    const script = `$ErrorActionPreference='Stop'; $s=New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ShowWindow=[uint16]0}; $r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'; ProcessStartupInformation=$s}; if($r.ReturnValue -ne 0){exit 1}`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000, stdio: "ignore" });
    if (result.status !== 0) throw Error("Could not launch the independent account host");
  } else {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" }); child.unref();
  }
}
