const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const execFileAsync = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quotePS = value => "'" + value.replace(/'/g, "''") + "'";

function write(file, data) {
  writePrivateFileAtomic(file, JSON.stringify(data) + "\n", { protectDirectory: false });
}

class WindowsRouteGuard {
  constructor({ coreHome, codexHome, runtimeHome = coreHome, invocation, ownerPid = process.pid, onRestored }) {
    Object.assign(this, { coreHome, codexHome, runtimeHome, invocation, ownerPid, onRestored });
  }

  readStatus() {
    try {
      const status = JSON.parse(fs.readFileSync(this.statusFile, "utf8"));
      return status.nonce === this.nonce ? status : null;
    } catch { return null; }
  }

  assertReady() {
    const status = this.readStatus();
    if (status?.state !== "ready" || Date.now() - Date.parse(status.at) > 4000) {
      throw Error("Independent Windows recovery protection is no longer ready");
    }
    try { process.kill(status.pid, 0); } catch { throw Error("Independent Windows recovery process exited"); }
  }

  async arm(config) {
    if (process.platform !== "win32") return;
    const current = this.readStatus();
    if (this.timer && current?.state === "ready" && Date.now() - Date.parse(current.at) < 4000) return;
    // A guard must finish its previous recovery before another route is written.
    if (this.timer) await this.stop();
    if (!path.isAbsolute(this.invocation.executable)) throw Error("Windows route protection requires an absolute Bun executable path");
    const runtime = path.join(this.coreHome, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    this.nonce = randomUUID();
    const prefix = path.join(runtime, `route-guard-${this.nonce}`);
    this.leaseFile = `${prefix}.lease.json`;
    this.statusFile = `${prefix}.status.json`;
    const specFile = `${prefix}.json`;
    const workerFile = `${prefix}.cjs`;
    fs.copyFileSync(path.join(__dirname, "route-guard-worker.cjs"), workerFile);
    write(specFile, { nonce: this.nonce, ownerPid: this.ownerPid, coreHome: this.coreHome, codexHome: this.codexHome, runtimeHome: this.runtimeHome,
      invocation: this.invocation, leaseFile: this.leaseFile, statusFile: this.statusFile,
      healthUrl: `http://${config.host}:${config.port}/healthz`, mode: config.mode, version: config.releaseVersion });
    const heartbeat = () => write(this.leaseFile, { nonce: this.nonce, at: new Date().toISOString() });
    heartbeat();
    this.timer = setInterval(() => {
      try {
        heartbeat();
        const state = this.readStatus();
        if (state?.state === "ready" && Date.now() - Date.parse(state.at) > 6000 && this.notified !== "unavailable") {
          this.notified = "unavailable";
          Promise.resolve(this.onUnavailable?.()).catch(() => { this.notified = null; });
        }
        if (["restored", "recovery-failed"].includes(state?.state) && this.notified !== state.state) {
          this.notified = state.state;
          this.onRestored?.(state);
        }
      } catch {
        clearInterval(this.timer); this.timer = null;
        Promise.resolve(this.onUnavailable?.()).catch(() => {});
      }
    }, 1000);
    this.timer.unref?.();
    this.notified = null;
    // WMI creates a process outside Electron's tree and any caller job object.
    // Run PowerShell hidden; JSON quoting is never used as shell escaping.
    const commandLine = [this.invocation.executable, workerFile, specFile].map(value => {
      if (/["\r\n]/.test(value)) throw Error("Invalid Windows executable path");
      return `"${value}"`;
    }).join(" ");
    const command = `$s=New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ShowWindow=[uint16]0}; `
      + `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quotePS(commandLine)};`
      + `CurrentDirectory=${quotePS(this.invocation.cwd)};ProcessStartupInformation=$s}; if($r.ReturnValue -ne 0){exit 1}`;
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 15000,
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const state = this.readStatus();
        if (state?.state === "ready") return;
        if (state && state.state !== "ready") throw Error(`Windows recovery guard is ${state.state}`);
        await delay(100);
      }
      throw Error("Windows recovery guard did not become ready; Codex route was not changed");
    } catch (error) {
      clearInterval(this.timer); this.timer = null;
      write(this.leaseFile, { nonce: this.nonce, at: new Date().toISOString(), stop: true });
      throw error;
    }
  }

  async stop() {
    if (!this.leaseFile) return;
    clearInterval(this.timer); this.timer = null;
    write(this.leaseFile, { nonce: this.nonce, at: new Date().toISOString(), stop: true });
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const status = this.readStatus();
      if (status?.state === "restored") return;
      await delay(100);
    }
    throw Error("Windows recovery guard could not verify restoration; inspect its status file");
  }
}

module.exports = { WindowsRouteGuard };
