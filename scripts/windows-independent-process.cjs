// Start a service outside the invoking desktop's Windows job/process tree.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { writePrivateFileAtomic } = require('../launcher/electron/atomic-file.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";
function quotePath(value) {
  if (!path.isAbsolute(value) || /["\r\n]/.test(value) || value.endsWith('\\')) throw Error('Invalid independent process path');
  return `"${value}"`;
}
async function launchIndependentProcess(spec) {
  if (process.platform !== 'win32') throw Error('Windows process broker required');
  const specFile = spec.receiptFile + '.request.json';
  const commandLine = [spec.bootstrapExecutable, __filename, specFile].map(quotePath).join(' ');
  writePrivateFileAtomic(specFile, JSON.stringify(spec), { protectDirectory: false });
  const command = `$s=New-CimInstance -CimClass (Get-CimClass Win32_ProcessStartup) -ClientOnly -Property @{ShowWindow=[uint16]0};`
    + `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quotePS(commandLine)};CurrentDirectory=${quotePS(spec.cwd)};ProcessStartupInformation=$s};if($r.ReturnValue -ne 0){exit 1}`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw Error('Independent Windows process launch failed');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(spec.receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(spec.receiptFile, 'utf8'));
      if (receipt.error || !Number.isInteger(receipt.pid)) throw Error('Independent service startup failed');
      return receipt.pid;
    }
    await pause(100);
  }
  throw Error('Independent service did not acknowledge startup');
}
async function worker(specFile) {
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const env = { ...process.env, ...spec.env };
  for (const name of spec.unsetEnv || []) delete env[name];
  const output = fs.openSync(spec.stdoutFile, 'a');
  const errors = fs.openSync(spec.stderrFile, 'a');
  try {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env, windowsHide: true, detached: true, stdio: ['ignore', output, errors] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    writePrivateFileAtomic(spec.receiptFile, JSON.stringify({ pid: child.pid, brokerPid: process.pid }), { protectDirectory: false });
  } catch {
    writePrivateFileAtomic(spec.receiptFile, JSON.stringify({ error: true }), { protectDirectory: false });
    process.exitCode = 1;
  } finally { fs.closeSync(output); fs.closeSync(errors); }
}
module.exports = { launchIndependentProcess };
if (require.main === module) worker(process.argv[2]).catch(() => { process.exitCode = 1; });
