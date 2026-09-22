// Correlate an actual official-core smoke run with redacted bridge binding events.
// This is supporting evidence, never a native desktop screenshot or UI acceptance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [proofFile, connectionFile, outputFile] = process.argv.slice(2);
if (![proofFile, connectionFile, outputFile].every(file => file && path.isAbsolute(file))) {
  throw Error('Supply absolute proof, connection, and output paths');
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const proof = read(proofFile), connection = read(connectionFile);
const config = read(path.join(connection.runtimeHome, 'config.json'));
const registry = read(config.webAccountsFile);
const log = path.resolve(connection.runtimeHome, '../launcher-data/logs/launcher.jsonl');
const strings = value => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const allowed = ['at', 'event', 'traceId', 'accountId', 'publicModelId', 'webModelSlug', 'threadId', 'turnId',
  'compaction', 'userHash', 'workspaceHash', 'actualModel', 'requestWorkspaceHash', 'workspaceVerified',
  'bodyHash', 'submitted', 'actualModels'];
const events = [];
for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
  let record; try { record = JSON.parse(line); } catch { continue; }
  for (const text of strings(record)) for (const segment of text.split(/\r?\n/)) {
    const offset = segment.indexOf('[web-routing] '); if (offset < 0) continue;
    try {
      const value = JSON.parse(segment.slice(offset + 14));
      if (Date.parse(value.at) >= Date.parse(proof.at)) events.push(
        Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
    } catch { /* Other launcher text is never exported. */ }
  }
}
const fingerprint = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
const webTurns = proof.turns.filter(turn => turn.selection?.startsWith('chatgpt-web/'));
const checks = webTurns.map(turn => {
  const bound = events.filter(event => event.event === 'native_request_bound'
    && event.threadId === turn.threadId && event.turnId === turn.turnId && event.publicModelId === turn.selection);
  const traces = [...new Set(bound.map(event => event.traceId))];
  const trace = events.filter(event => traces.includes(event.traceId));
  const account = registry.accounts.find(account => account.id === bound[0]?.accountId);
  const userHash = account?.userId && fingerprint(account.userId);
  const workspaceHash = account?.accountId && fingerprint(account.accountId);
  const actualSlug = bound[0]?.webModelSlug;
  const installed = trace.some(event => event.event === 'binding_installed'
    && event.userHash === userHash && event.workspaceHash === workspaceHash);
  const submitted = trace.some(event => event.event === 'web_request_bound'
    && event.actualModel === actualSlug && event.workspaceVerified === true
    && event.requestWorkspaceHash === workspaceHash);
  const observed = trace.some(event => event.event === 'web_model_observed' && event.actualModel === actualSlug);
  const completed = trace.some(event => event.event === 'binding_complete'
    && event.submitted > 0 && event.actualModels?.length > 0 && event.actualModels.every(slug => slug === actualSlug));
  const rejected = trace.some(event => event.event === 'binding_rejected');
  return { threadId: turn.threadId, turnId: turn.turnId, modelId: turn.selection, account: account?.id,
    expectedWebModel: actualSlug, userHash, workspaceHash, traceIds: traces,
    passed: Boolean(turn.status === 'completed' && turn.markerMatches && traces.length === 1
      && userHash && workspaceHash && installed && submitted && observed && completed && !rejected),
    checks: { installed, submitted, observed, completed, rejected }, routing: trace };
});
const evidence = { at: new Date().toISOString(), proofFile, codexHome: proof.home,
  scope: 'actual official core using main home; not a native desktop UI test', desktopUi: false,
  proofPassed: proof.passed, configUnchanged: proof.configUnchanged, checks,
  passed: Boolean(proof.passed && proof.configUnchanged && checks.length > 0 && checks.every(check => check.passed)) };
fs.writeFileSync(outputFile, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ evidence: outputFile, passed: evidence.passed,
  webTurns: checks.length, desktopUi: false }, null, 2));
if (!evidence.passed) process.exitCode = 1;
