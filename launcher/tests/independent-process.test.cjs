const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchIndependentProcess } = require('../../scripts/windows-independent-process.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
test('Windows service survives its independent bootstrap process exiting', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-launch-'));
  let pid;
  t.after(async () => {
    if (pid && alive(pid)) process.kill(pid);
    // Windows can keep a terminating process's working directory locked briefly.
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const child = path.join(root, 'child.cjs');
  fs.writeFileSync(child, 'setInterval(() => {}, 1000);');
  const receiptFile = path.join(root, 'receipt.json');
  pid = await launchIndependentProcess({ executable: process.execPath, args: [child], cwd: root,
    bootstrapExecutable: process.execPath, env: {}, receiptFile,
    stdoutFile: path.join(root, 'out.log'), stderrFile: path.join(root, 'err.log') });
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.notEqual(receipt.brokerPid, process.pid);
  const deadline = Date.now() + 5000;
  while (alive(receipt.brokerPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(receipt.brokerPid), false);
  assert.equal(alive(pid), true);
});
