#!/usr/bin/env node
/**
 * ledger.test.js — protocol tests for cli/ledger.js against a stubbed
 * GitHub Contents API (no network). Run:
 *   node --test cli/ledger.test.js
 * with LEDGER_STUB_DIR pointing at a scratch dir (the suite manages it).
 *
 * The stub emulates: contents GET (incl. the >1MB encoding:none quirk),
 * git/blob GET, contents PUT with SHA CAS (409 on mismatch), and a
 * one-shot forced 409 via $LEDGER_STUB_DIR/conflict-once.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXDIR = '/home/hatch/workspace/goals/cwi-agent-company/hidden_files/ledger-fix-2026-09-25';
const LEDGER = '/home/hatch/workspace/gear-ledger/cli/ledger.js';

const stubDir = mkdtempSync(join(tmpdir(), 'ledger-stub-'));
process.env.GEAR_LEDGER_GHAPI = join(FIXDIR, 'stub-ghapi.py');
process.env.GEAR_LEDGER_GHAPI_PUT_FILE = join(FIXDIR, 'stub-ghapi-put-file.py');
process.env.GEAR_LEDGER_REPO = 'TestOrg/test-repo';
process.env.GEAR_LEDGER_BRANCH = 'main';
process.env.LEDGER_STUB_DIR = stubDir;

const L = await import(LEDGER);

// --- helpers ---------------------------------------------------------------
import { execFileSync } from 'node:child_process';
function stubPut(path, text) {
  const body = JSON.stringify({ message: 'seed', content: Buffer.from(text, 'utf8').toString('base64'), branch: 'main' });
  if (Buffer.byteLength(body, 'utf8') > 100000) {
    // mirror ledger.js: large bodies go through the file-based helper
    const tmp = join(stubDir, 'seed-body.json');
    writeFileSync(tmp, body);
    execFileSync('python3', [process.env.GEAR_LEDGER_GHAPI_PUT_FILE,
      `/repos/TestOrg/test-repo/contents/${path}`, tmp], { encoding: 'utf8' });
  } else {
    execFileSync('python3', [process.env.GEAR_LEDGER_GHAPI, 'PUT',
      `/repos/TestOrg/test-repo/contents/${path}`, '--data', body], { encoding: 'utf8' });
  }
}
function stubStoreFiles() {
  return JSON.parse(readFileSync(join(stubDir, 'store.json'), 'utf8')).files;
}
function seedState(doc) { stubPut('state.json', JSON.stringify(doc)); }
function genesis(over = {}) {
  return {
    contract: 'v1.0', schema_version: 1, repo: 'TestOrg/test-repo', mode: 'LIVE',
    version: 1, updated_at: '2026-09-25T00:00:00.000Z',
    agents: [{ agent_id: 'agent:TEST_A', status: 'active', capabilities: ['build', 'verify'], note: 't' },
             { agent_id: 'agent:TEST_B', status: 'active', capabilities: ['build'], note: 't' }],
    tasks: [], presence: {}, handoffs: [], approvals: [], idempotency: {}, note: 'test',
    ...over,
  };
}
let tid = 0;
function task(state, createdAgoHrs, histAgoHrs = null) {
  tid++;
  const created = new Date(Date.now() - createdAgoHrs * 3600e3).toISOString();
  const changed = new Date(Date.now() - (histAgoHrs ?? createdAgoHrs) * 3600e3).toISOString();
  return {
    task_id: `tsk_TEST${String(tid).padStart(4, '0')}`, type: 'build', title: `t${tid}`,
    created_by: 'agent:TEST_A', created_at: created,
    assigned_to: state === 'created' ? null : 'agent:TEST_B',
    state, priority: 'normal', inputs: {}, acceptance: [], artifacts: [],
    deliverable_ref: null,
    state_history: [{ from: 'created', to: state, at: changed, by: 'agent:TEST_A' }],
    requires_black_approval: false, sample: false,
  };
}
const todayShard = () => `events/${new Date().toISOString().slice(0, 10)}.jsonl`;
function shardLines() {
  const f = stubStoreFiles()[todayShard()];
  if (!f) return [];
  return Buffer.from(f.content_b64, 'base64').toString('utf8').trim().split('\n').filter(Boolean);
}

beforeEach(() => {
  execFileSync('rm', ['-rf', stubDir]);
  execFileSync('mkdir', ['-p', stubDir]);
  tid = 0;
});

// --- tests -----------------------------------------------------------------
test('readRepoFile falls back to git blob when contents returns encoding:none (>1MB)', () => {
  const big = genesis();
  big.note = 'x'.repeat(1_100_000); // >1MB
  seedState(big);
  const { doc } = L.readState();
  assert.equal(doc.note.length, 1_100_000);
  assert.equal(doc.version, 1);
});

test('large write path routes through the put-file helper', () => {
  const big = genesis();
  big.note = 'y'.repeat(200_000); // >100KB LARGE_BODY_BYTES
  seedState(big);
  const doc = L.casMutateState('test bump', (d) => { d.note += 'z'; });
  assert.equal(doc.note.length, 200_001);
});

test('casMutateState retries once on 409 then succeeds', () => {
  seedState(genesis());
  writeFileSync(join(stubDir, 'conflict-once'), '1');
  const doc = L.casMutateState('retry test', (d) => { d.version_note = 'ok'; });
  assert.equal(doc.version_note, 'ok');
  assert.equal(doc.version, 2);
});

test('casMutateState survives consecutive 409s with backoff', () => {
  seedState(genesis());
  writeFileSync(join(stubDir, 'conflict-n'), '2');
  const t0 = Date.now();
  const doc = L.casMutateState('backoff test', (d) => { d.backoff_ok = true; });
  const dt = Date.now() - t0;
  assert.equal(doc.backoff_ok, true);
  assert.ok(dt >= 200, `expected backoff delay, took ${dt}ms`);
});

test('appendEvent shards into events/YYYY-MM-DD.jsonl', () => {
  seedState(genesis());
  const e = L.opEventAppend('test.ping', 'agent:TEST_A', { n: 1 });
  assert.ok(e.event_id.startsWith('evt_'));
  const files = stubStoreFiles();
  assert.ok(files[todayShard()], 'today shard exists');
  assert.ok(!files['events.jsonl'], 'legacy monolith untouched');
  assert.equal(shardLines().length, 1);
});

test('presence heartbeat appends event only on change', () => {
  seedState(genesis());
  const r1 = L.opPresenceHeartbeat('agent:TEST_A', 'online', 'TEST_A:tsk_1');
  assert.ok(r1.event_id, 'first pulse emits event');
  const r2 = L.opPresenceHeartbeat('agent:TEST_A', 'online', 'TEST_A:tsk_1');
  assert.equal(r2.event_id, null, 'identical pulse emits no event');
  const r3 = L.opPresenceHeartbeat('agent:TEST_A', 'online', 'TEST_A:tsk_2');
  assert.ok(r3.event_id, 'pointer change emits event');
  assert.equal(shardLines().length, 2);
  // state.presence still pulses every run
  const { doc } = L.readState();
  assert.equal(doc.presence['agent:TEST_A'].status, 'online');
});

test('compact dry-run lists eligible, writes nothing', () => {
  const g = genesis();
  g.tasks = [
    task('verified', 200),            // terminal, old -> eligible
    task('cancelled', 100),           // terminal -> eligible
    task('delivered', 100, 80),       // delivered 80h ago -> eligible (>72h)
    task('delivered', 100, 10),       // delivered 10h ago -> keep
    task('in_progress', 50),          // live -> keep
    task('assigned', 50),             // live -> keep
  ];
  const oldKey = 'idem_old';
  g.idempotency[oldKey] = { op: 'task.create', at: new Date(Date.now() - 10 * 86400e3).toISOString(), ref: 'tsk_x' };
  g.idempotency['idem_new'] = { op: 'task.create', at: new Date().toISOString(), ref: 'tsk_y' };
  seedState(g);
  const before = JSON.stringify(stubStoreFiles());
  const r = L.opCompact({ graceHours: 72, dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(r.task_count, 3);
  assert.deepEqual(r.eligible_idempotency, [oldKey]);
  assert.equal(JSON.stringify(stubStoreFiles()), before, 'dry-run wrote nothing');
});

test('compact archives terminal tasks with index and removes from state', () => {
  const g = genesis();
  const vt = task('verified', 200);
  const dt = task('delivered', 100, 80);
  const live = task('in_progress', 5);
  g.tasks = [vt, dt, live];
  seedState(g);
  const r = L.opCompact({ graceHours: 72 });
  assert.equal(r.archived_tasks, 2);
  assert.ok(r.bytes_after < r.bytes_before);
  const { doc } = L.readState();
  assert.deepEqual(doc.tasks.map((t) => t.task_id), [live.task_id]);
  const files = stubStoreFiles();
  const idx = JSON.parse(Buffer.from(files['state-archive/index.json'].content_b64, 'base64').toString('utf8')).tasks;
  assert.ok(idx[vt.task_id] && idx[dt.task_id], 'index has both');
  assert.ok(idx[vt.task_id].sha256, 'index carries integrity hash');
  const m = vt.created_at.slice(0, 7);
  const arch = JSON.parse(Buffer.from(files[`state-archive/tasks-${m}.json`].content_b64, 'base64').toString('utf8'));
  assert.ok(arch.tasks[vt.task_id], 'verified task in monthly archive');
});

test('compact is crash-safe: phase-1 done, phase-3 pending -> re-run completes without dupes', () => {
  const g = genesis();
  const vt = task('verified', 200);
  g.tasks = [vt];
  seedState(g);
  // simulate a crash: archive+index written, state.json untouched
  const m = vt.created_at.slice(0, 7);
  const archPath = `state-archive/tasks-${m}.json`;
  stubPut(archPath, JSON.stringify({ archive: 'tasks', month: m, tasks: { [vt.task_id]: vt }, idempotency: {}, updated_at: new Date().toISOString() }));
  stubPut('state-archive/index.json', JSON.stringify({ index: 'tasks', updated_at: new Date().toISOString(), tasks: { [vt.task_id]: { path: archPath, archived_at: new Date().toISOString(), sha256: L.sha256hex(JSON.stringify(vt)) } } }));
  const r = L.opCompact({ graceHours: 72 });
  assert.equal(r.archived_tasks, 1);
  const { doc } = L.readState();
  assert.equal(doc.tasks.length, 0, 'task removed from state on re-run');
  const files = stubStoreFiles();
  const arch = JSON.parse(Buffer.from(files[archPath].content_b64, 'base64').toString('utf8'));
  assert.equal(Object.keys(arch.tasks).length, 1, 'no duplication in archive');
});

test('task restore rehydrates an archived task', () => {
  const g = genesis();
  const dt = task('delivered', 100, 80);
  g.tasks = [dt];
  seedState(g);
  L.opCompact({ graceHours: 72 });
  assert.equal(L.readState().doc.tasks.length, 0);
  const r = L.opTaskRestore(dt.task_id);
  assert.equal(r.task_id, dt.task_id);
  assert.equal(r.state, 'delivered');
  assert.equal(L.readState().doc.tasks.length, 1);
});

test('transition on an archived task auto-rehydrates transparently', () => {
  const g = genesis();
  const dt = task('delivered', 100, 80);
  dt.assigned_to = 'agent:TEST_B';
  g.tasks = [dt];
  seedState(g);
  L.opCompact({ graceHours: 72 });
  assert.equal(L.readState().doc.tasks.length, 0, 'precondition: archived out of state');
  // TEST_A has verify capability and != assignee -> legal delivered->verified
  const out = L.opTaskTransition(dt.task_id, 'verified', 'agent:TEST_A', {});
  assert.equal(out.to, 'verified');
  const t = L.readState().doc.tasks.find((x) => x.task_id === dt.task_id);
  assert.ok(t && t.state === 'verified', 'rehydrated and transitioned');
});

test('compact archives idempotency keys older than 7 days', () => {
  const g = genesis();
  g.idempotency['old'] = { op: 'x', at: new Date(Date.now() - 8 * 86400e3).toISOString(), ref: 'a' };
  g.idempotency['new'] = { op: 'y', at: new Date().toISOString(), ref: 'b' };
  seedState(g);
  const r = L.opCompact({ graceHours: 72 });
  assert.equal(r.archived_idempotency, 1);
  const { doc } = L.readState();
  assert.deepEqual(Object.keys(doc.idempotency), ['new']);
});

test('presence heartbeat-batch updates N agents in ONE CAS, events only on change', () => {
  const g = genesis();
  g.agents.push({ agent_id: 'agent:TEST_C', status: 'active', capabilities: ['build'], note: 't' });
  seedState(g);
  // pre-set CWI_Data with pointer t-x so it is "unchanged" in the batch
  L.opPresenceHeartbeat('agent:TEST_A', 'online', 't-x', 'seed');
  const v0 = L.readState().doc.version;
  const res = L.opPresenceHeartbeatBatch([
    { agent: 'agent:TEST_B', status: 'online', task: 't-1' },
    { agent: 'agent:TEST_A', status: 'online', task: 't-x' }, // unchanged
    { agent: 'agent:TEST_C', status: 'online' },            // no task key -> changed (first pulse)
  ]);
  assert.equal(res.agents, 3);
  assert.equal(res.changed, 2, 'only 2 agents should count as changed');
  const d = L.readState().doc;
  assert.equal(d.version, v0 + 1, 'exactly one CAS cycle for 3 agents');
  assert.equal(d.presence['agent:TEST_B'].current_task_id, 't-1');
  assert.equal(d.presence['agent:TEST_C'].status, 'online');
  const lines = shardLines();
  const pres = lines.map((l) => JSON.parse(l)).filter((e) => e.event === 'agent.presence');
  assert.equal(pres.length, 3, 'seed pulse + 2 changed in batch, CWI_Data silent');
});

test('presence heartbeat-batch rejects duplicates and empty batches', () => {
  seedState(genesis());
  assert.throws(() => L.opPresenceHeartbeatBatch([]), /non-empty entries/);
  assert.throws(() => L.opPresenceHeartbeatBatch([
    { agent: 'agent:TEST_B', status: 'online' },
    { agent: 'agent:TEST_B', status: 'online' },
  ]), /duplicate agent/);
});

test('secret scan still blocks pushes', () => {
  seedState(genesis());
  assert.throws(
    () => L.writeRepoFileCAS('state.json', '{"api_key": "sk-abcdefghij1234567890"}', 'evil', 'anysha'),
    (e) => e.code === 'secret.scan_blocked'
  );
});

test('prune moves event shards older than 90 days, keeps recent', () => {
  seedState(genesis());
  const oldDay = new Date(Date.now() - 100 * 86400e3).toISOString().slice(0, 10);
  const newDay = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
  stubPut(`events/${oldDay}.jsonl`, '{"event_id":"evt_old"}\n');
  stubPut(`events/${newDay}.jsonl`, '{"event_id":"evt_new"}\n');
  const r = L.opPruneEvents({ days: 90 });
  assert.equal(r.pruned, 1);
  assert.equal(r.warnings.length, 0);
  const files = stubStoreFiles();
  assert.ok(!files[`events/${oldDay}.jsonl`], 'old shard removed from events/');
  assert.ok(files[`events-archive/${oldDay.slice(0, 7)}/${oldDay}.jsonl`], 'old shard moved to archive');
  assert.ok(files[`events/${newDay}.jsonl`], 'recent shard kept');
});

test('prune dry-run moves nothing', () => {
  seedState(genesis());
  const oldDay = new Date(Date.now() - 100 * 86400e3).toISOString().slice(0, 10);
  stubPut(`events/${oldDay}.jsonl`, '{"event_id":"evt_old"}\n');
  const r = L.opPruneEvents({ days: 90, dryRun: true });
  assert.equal(r.pruned, 1);
  assert.ok(r.moved[0].dry_run);
  assert.ok(stubStoreFiles()[`events/${oldDay}.jsonl`], 'shard untouched');
});
