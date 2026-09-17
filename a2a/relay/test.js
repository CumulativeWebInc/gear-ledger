// test.js — tests for the A2A GitHub-issues relay. Zero deps.
// Run: node test.js   (prints "N/N assertions passed")
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createNetServer } from 'node:net';

// Env must be set BEFORE importing relay (CONFIG reads at module load).
const tmp = mkdtempSync(join(tmpdir(), 'a2a-relay-test-'));
const dataDir = join(tmp, 'data');
const port = await freePort();
process.env.A2A_DATA_DIR = dataDir;
process.env.A2A_PORT = String(port);
process.env.A2A_SERVER_DIR = '/home/hatch/workspace/a2a-build/server';
process.env.A2A_INBOX_REPO = 'TestOrg/test-inbox';
process.env.A2A_MAX_PER_RUN = '20';

const relay = await import('./relay.js');
const { validateEnvelope, unwrapFences, rejectionComment, responseComment, runRelay, RELAY_MARKER, CONFIG } = relay;

function freePort() {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const VALID = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'message/send',
  params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hello from test' }] }, metadata: { agent: 'MUSE_CWI' } } });

let passed = 0, total = 0;
let chain = Promise.resolve();
function check(name, fn) {
  total++;
  chain = chain.then(async () => {
    try { await fn(); passed++; }
    catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); }
  });
}

// --- envelope validation ----------------------------------------------------
check('valid envelope', () => {
  const v = validateEnvelope(VALID);
  assert.equal(v.ok, true); assert.equal(v.rpc.method, 'message/send');
});
check('fenced envelope tolerated', () => {
  const v = validateEnvelope('```json\n' + VALID + '\n```');
  assert.equal(v.ok, true);
});
check('invalid JSON rejected', () => assert.equal(validateEnvelope('{nope').ok, false));
check('empty body rejected', () => assert.equal(validateEnvelope('   ').ok, false));
check('batch rejected', () => assert.equal(validateEnvelope('[{}]').ok, false));
check('wrong jsonrpc rejected', () => {
  assert.equal(validateEnvelope(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'm' })).ok, false);
});
check('missing method rejected', () => {
  assert.equal(validateEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1 })).ok, false);
});
check('missing id rejected (no notifications)', () => {
  assert.equal(validateEnvelope(JSON.stringify({ jsonrpc: '2.0', method: 'message/send' })).ok, false);
});
check('oversize body rejected', () => {
  assert.equal(validateEnvelope('x'.repeat(70 * 1024)).ok, false);
});
check('unwrapFences passthrough', () => assert.equal(unwrapFences(VALID), VALID));

// --- comments ----------------------------------------------------------------
check('rejection comment has marker + doc link + reason', () => {
  const c = rejectionComment('bad json');
  assert.ok(c.includes(RELAY_MARKER));
  assert.ok(c.includes('github-issues-profile'));
  assert.ok(c.includes(CONFIG.protocolDoc));
  assert.ok(c.includes('bad json'));
});
check('response comment sanitizes backticks', () => {
  const c = responseComment({ jsonrpc: '2.0', id: 1, result: { text: 'a```b' } });
  assert.ok(c.includes(RELAY_MARKER));
  assert.ok(!c.includes('a```b'));
  assert.ok(c.includes("a'''b"));
});

// --- fake GitHub -------------------------------------------------------------
function makeGh(issues, commentsByIssue = {}) {
  const calls = [];
  const gh = (method, path, data) => {
    calls.push({ method, path, data });
    if (method === 'GET' && path.includes('/issues?')) return issues;
    if (method === 'GET' && path.includes('/comments')) {
      const n = parseInt(path.split('/issues/')[1]);
      return commentsByIssue[n] || [];
    }
    return {};
  };
  return { gh, calls };
}

function postedComment(calls, n) {
  const c = calls.find((x) => x.method === 'POST' && x.path.endsWith(`/issues/${n}/comments`));
  return c && c.data.body;
}
function hasLabel(calls, n, label) {
  return calls.some((x) => x.method === 'POST' && x.path.endsWith(`/issues/${n}/labels`) &&
    JSON.stringify(x.data).includes(label));
}
function isClosed(calls, n) {
  return calls.some((x) => x.method === 'PATCH' && x.path.endsWith(`/issues/${n}`) && x.data.state === 'closed');
}

// --- full relay flow: one valid + one malformed + one PR ---------------------
check('full relay flow', async () => {
  const issues = [
    { number: 11, user: { login: 'external-agent' }, labels: [{ name: 'a2a-inbox' }], body: VALID },
    { number: 12, user: { login: 'spammer' }, labels: [{ name: 'a2a-inbox' }], body: '{not json' },
    { number: 13, user: { login: 'bot' }, labels: [{ name: 'a2a-inbox' }], pull_request: {}, body: VALID },
  ];
  const { gh, calls } = makeGh(issues);
  const summary = await runRelay({ ghImpl: gh });
  assert.equal(summary.processed, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.errors, 0);
  // valid issue: response comment contains the queued task id
  const body11 = postedComment(calls, 11);
  assert.ok(body11 && body11.includes('"jsonrpc": "2.0"'), 'response comment is JSON-RPC');
  assert.ok(body11.includes('queue-receipt.json') || body11.includes('"result"'), 'response has result');
  assert.ok(hasLabel(calls, 11, 'a2a-processed'));
  assert.ok(isClosed(calls, 11));
  // malformed: rejection path
  const body12 = postedComment(calls, 12);
  assert.ok(body12 && body12.includes('rejected'));
  assert.ok(hasLabel(calls, 12, 'a2a-rejected'));
  assert.ok(isClosed(calls, 12));
  // PR untouched
  assert.ok(!calls.some((x) => x.path.includes('/issues/13/comments')));
  // requests.log: both the relay and the server log here
  const log = readFileSync(join(dataDir, 'requests.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const relayLines = log.filter((l) => l.transport === 'github-issues-profile');
  assert.equal(relayLines.length, 2);
  const good = relayLines.find((l) => l.issue === 11);
  assert.equal(good.ok, true);
  assert.equal(good.sender, 'external-agent');
  assert.equal(good.method, 'message/send');
  assert.ok(good.task_id && good.task_id.startsWith('a2a_'));
  const bad = relayLines.find((l) => l.issue === 12);
  assert.equal(bad.ok, false);
});

// --- idempotency: marker already present --------------------------------------
check('dedupe when relay marker already posted', async () => {
  const issues = [{ number: 21, user: { login: 'x' }, labels: [{ name: 'a2a-inbox' }], body: VALID }];
  const { gh, calls } = makeGh(issues, { 21: [{ body: RELAY_MARKER + '\nresponse stuff' }] });
  const summary = await runRelay({ ghImpl: gh });
  assert.equal(summary.processed, 1);
  assert.ok(!postedComment(calls, 21), 'no duplicate response comment');
  assert.ok(isClosed(calls, 21));
});

// --- server error surfaced as JSON-RPC error response, still processed -------
check('unknown method gets server error response, not rejection', async () => {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope/nothing', params: {} });
  const issues = [{ number: 31, user: { login: 'y' }, labels: [{ name: 'a2a-inbox' }], body: payload }];
  const { gh, calls } = makeGh(issues);
  const summary = await runRelay({ ghImpl: gh });
  assert.equal(summary.processed, 1);
  const body = postedComment(calls, 31);
  assert.ok(body.includes('-32601'), 'method-not-found error posted back');
  assert.ok(hasLabel(calls, 31, 'a2a-processed'));
});

await chain;
console.log(`${passed}/${total} assertions passed`);
if (passed !== total) process.exit(1);
