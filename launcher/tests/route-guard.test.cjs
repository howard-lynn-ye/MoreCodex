const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { disconnect, assertJournalTarget, write } = require("../electron/route-guard-worker.cjs");
const { healthy } = require("../electron/route-guard-worker.cjs");

test("a separate desktop journal monitors the real runtime and still requires its owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-route-owner-"));
  const priorFetch = global.fetch;
  try {
    const runtimeHome = path.join(root, "service"), coreHome = path.join(root, "desktop-route");
    fs.mkdirSync(path.join(runtimeHome, "runtime"), { recursive: true });
    const file = path.join(runtimeHome, "runtime", "launcher-supervisor.json");
    fs.writeFileSync(file, JSON.stringify({ ownerPid: process.pid, daemonPid: process.pid, status: "ready" }));
    global.fetch = async () => ({ ok: true, json: async () => ({ service: "codex-chatgpt-web", status: "ok", accepting_turns: true, mode: "full", version: "test" }) });
    const spec = { runtimeHome, coreHome, ownerPid: process.pid, healthUrl: "http://127.0.0.1:1/healthz", mode: "full", version: "test" };
    assert.equal(await healthy(spec), true);
    assert.equal(await healthy({ ...spec, ownerPid: process.pid + 1 }), false);
    assert.equal(await healthy({ ...spec, runtimeHome: coreHome }), false);
    fs.writeFileSync(file, JSON.stringify({ ownerPid: process.pid, daemonPid: process.pid, status: "stopped" }));
    assert.equal(await healthy(spec), false);
  } finally {
    global.fetch = priorFetch;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-route-owner-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("independent restoration pins both homes and refuses a journal for another config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-route-guard-"));
  try {
    const coreHome = path.join(root, "core");
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(path.join(coreHome, "codex"), { recursive: true });
    fs.mkdirSync(codexHome);
    const journal = path.join(coreHome, "codex", "integration-journal.json");
    fs.writeFileSync(journal, JSON.stringify({ configPath: path.join(root, "unrelated", "config.toml") }));
    assert.throws(() => assertJournalTarget({ coreHome, codexHome }), /different Codex home/);
    fs.writeFileSync(journal, JSON.stringify({ configPath: path.join(codexHome, "config.toml") }));
    const script = path.join(root, "cli.cjs");
    if (process.platform === "win32") {
      let attempts = 0;
      const waits = [];
      const statusFile = path.join(root, "status.json");
      write(statusFile, { state: "ready" }, { rename: (from, to) => {
        if (++attempts < 3) throw Object.assign(Error("reader temporarily holds file"), { code: "EPERM" });
        fs.renameSync(from, to);
      }, wait: ms => waits.push(ms) });
      assert.equal(JSON.parse(fs.readFileSync(statusFile)).state, "ready");
      assert.deepEqual(waits, [25, 50]);
    }
    fs.writeFileSync(script, `const fs=require('node:fs');const path=require('node:path');
      fs.writeFileSync(path.join(process.env.CODEX_HOME,'observed.json'), JSON.stringify({core:process.env.CODEX_CHATGPT_WEB_HOME,args:process.argv.slice(2)}));
      console.log(JSON.stringify({active:false}));`);
    disconnect({ coreHome, codexHome, invocation: { executable: process.execPath, args: [script], cwd: root } });
    const observed = JSON.parse(fs.readFileSync(path.join(codexHome, "observed.json")));
    assert.equal(observed.core, coreHome);
    assert.deepEqual(observed.args, ["--home", coreHome, "route", "disconnect"]);
    fs.writeFileSync(script, "console.log(JSON.stringify({active:true}));");
    assert.throws(() => disconnect({ coreHome, codexHome,
      invocation: { executable: process.execPath, args: [script], cwd: root } }), /not verified/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-route-guard-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
