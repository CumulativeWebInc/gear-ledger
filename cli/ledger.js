#!/usr/bin/env node
/**
 * Gear Ledger CLI — protocol + CLI implementation of the frozen REST contract
 * (backend-architecture.md design v1.0, contracts/*.schema.json).
 *
 * The canonical store is versioned JSON in the CumulativeWebInc/gear-ledger
 * repo. Every mutation is a SHA-based atomic compare-and-swap through the
 * GitHub Contents API: read (sha S) → transform → PUT with sha S. A concurrent
 * writer's PUT lands first → our PUT gets a true 409, we re-read and retry
 * (x3), then surface the 409 with the winner named. Commit order is truth.
 *
 * Mapping to the REST contract (docs/API.md):
 *   POST /tasks                  → task create
 *   POST /tasks/{id}/assign      → task assign | task claim
 *   POST /tasks/{id}/start       → task start
 *   POST /tasks/{id}/deliver     → task deliver
 *   POST /tasks/{id}/verify      → task verify
 *   POST /tasks/{id}/cancel      → task cancel
 *   POST /tasks/{id}/fail        → task fail
 *   POST /approvals              → approval seal
 *   GET  /world/state            → state get
 *   event log                    → event append
 *   agent.presence heartbeats     → presence heartbeat
 *
 * HTTP server later: same protocol, same IDs, same CAS — no client changes.
 *
 * Env:
 *   GEAR_LEDGER_REPO   default CumulativeWebInc/gear-ledger
 *   GEAR_LEDGER_BRANCH default main
 *   GEAR_LEDGER_GHAPI  path to the ghapi CLI
 *   GEAR_LEDGER_KEY    path to the Ed25519 private key (approval seal only)
 *
 * Dependencies: none (node stdlib only).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes, createPrivateKey, sign } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.env.GEAR_LEDGER_REPO || 'CumulativeWebInc/gear-ledger';
const BRANCH = process.env.GEAR_LEDGER_BRANCH || 'main';
const GHAPI = process.env.GEAR_LEDGER_GHAPI || (homedir() + '/workspace/skills/github/bin/ghapi');
const GHAPI_PUT_FILE = process.env.GEAR_LEDGER_GHAPI_PUT_FILE || (homedir() + '/workspace/skills/github/bin/ghapi_put_file');
// ghapi takes --data as a CLI arg; payloads near/above the OS arg limit die
// before any HTTP request (surfaces as HTTP 0). Route large PUT bodies
// through the file-based helper on the same auth path.
const LARGE_BODY_BYTES = 100000;
const KEY_PATH = process.env.GEAR_LEDGER_KEY || (homedir() + '/.config/gear-ledger/ed25519.key');
const CONTRACT = 'v1.0';
const KID = 'cwi-ledger-2026';
const MAX_CAS_RETRIES = 3;

// ---------------------------------------------------------------- ULID
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function ulid() {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const r = randomBytes(10);
  let rand = '', acc = 0, bits = 0;
  for (const b of r) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; rand += CROCKFORD[(acc >>> bits) & 31]; }
  }
  return time + rand;
}
export const now = () => new Date().toISOString();
export const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------- errors
export class LedgerError extends Error {
  constructor(code, message, detail = null, status = 409) {
    super(message);
    this.code = code; this.detail = detail; this.status = status;
  }
  toJSON() { return { error: { code: this.code, message: this.message, detail: this.detail } }; }
}

// ---------------------------------------------------------------- GitHub layer
function gh(method, path, data) {
  const body = data !== undefined ? JSON.stringify(data) : undefined;
  try {
    let out;
    if (body !== undefined && method === 'PUT' && Buffer.byteLength(body, 'utf8') > LARGE_BODY_BYTES) {
      const tmp = join(tmpdir(), `ghapi-body-${randomBytes(8).toString('hex')}.json`);
      writeFileSync(tmp, body, 'utf8');
      try {
        out = execFileSync('python3', [GHAPI_PUT_FILE, path, tmp], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      } finally {
        rmSync(tmp, { force: true });
      }
    } else {
      const args = [method, path];
      if (body !== undefined) args.push('--data', body);
      out = execFileSync('python3', [GHAPI, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    }
    return JSON.parse(out);
  } catch (e) {
    const stderr = (e.stderr || '').toString();
    const m = stderr.match(/^HTTP (\d+):\s*([\s\S]*)$/m);
    const status = m ? parseInt(m[1], 10) : 0;
    let body = null;
    try { body = JSON.parse(m ? m[2] : 'null'); } catch { /* keep null */ }
    const err = new LedgerError('github.request_failed', `GitHub ${method} ${path} → HTTP ${status}`, body, status);
    err.status = status; err.body = body;
    throw err;
  }
}

export function readRepoFile(path) {
  try {
    const r = gh('GET', `/repos/${REPO}/contents/${path}?ref=${BRANCH}`);
    return { sha: r.sha, text: Buffer.from(r.content || '', 'base64').toString('utf8') };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export function writeRepoFileCAS(path, text, message, baseSha) {
  const payload = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (baseSha) payload.sha = baseSha;
  const r = gh('PUT', `/repos/${REPO}/contents/${path}`, payload);
  return r.content.sha;
}

// ---------------------------------------------------------------- state
export function readState() {
  const f = readRepoFile('state.json');
  if (!f) throw new LedgerError('state.missing', 'state.json missing — genesis not seeded', null, 500);
  return { doc: JSON.parse(f.text), sha: f.sha };
}

function bump(doc) {
  doc.version = (doc.version || 0) + 1;
  doc.updated_at = now();
}

/**
 * Atomic compare-and-swap mutation of state.json.
 * mutate(doc) performs the transform (may throw LedgerError for illegal ops).
 * On SHA conflict: re-read and retry up to MAX_CAS_RETRIES, then throw the
 * caller's onConflict() result (lets claim name the winner).
 */
export function casMutateState(label, mutate, onConflict) {
  let lastErr = null;
  for (let i = 0; i < MAX_CAS_RETRIES; i++) {
    const { doc, sha } = readState();
    mutate(doc);
    bump(doc);
    try {
      writeRepoFileCAS('state.json', JSON.stringify(doc, null, 2) + '\n', label, sha);
      return doc;
    } catch (e) {
      if (e.status === 409) { lastErr = e; continue; }
      throw e;
    }
  }
  if (onConflict) throw onConflict(readState().doc);
  throw new LedgerError('state.write_conflict', `CAS conflict on state.json after ${MAX_CAS_RETRIES} retries`, { label }, 409);
}

export function appendEvent(event, actor, data) {
  const full = { event_id: 'evt_' + ulid(), event, at: now(), actor, sample: false, data };
  for (let i = 0; i < MAX_CAS_RETRIES; i++) {
    const f = readRepoFile('events.jsonl');
    const base = f ? f.text : '';
    try {
      writeRepoFileCAS('events.jsonl', base + JSON.stringify(full) + '\n', `event: ${event} ${full.event_id}`, f ? f.sha : null);
      return full;
    } catch (e) {
      if (e.status === 409) continue;
      throw e;
    }
  }
  throw new LedgerError('events.write_conflict', 'CAS conflict appending to events.jsonl', null, 409);
}

// ---------------------------------------------------------------- transition engine (frozen §4.2)
export const TRANSITIONS = {
  created: ['assigned', 'cancelled', 'failed'],
  assigned: ['in_progress', 'cancelled', 'failed'],
  in_progress: ['delivered', 'cancelled', 'failed'],
  delivered: ['verified', 'in_progress', 'cancelled'], // delivered→in_progress = verifier rollback
  verified: [], cancelled: [], failed: [],
};

const ACTOR_RE = /^(agent:[A-Za-z0-9_]+|human:black|adapter:[a-z0-9-]+|system)$/;
function agentOf(doc, urn) { return doc.agents.find((a) => a.agent_id === urn) || null; }
function isVerifierAgent(doc, urn) {
  if (urn === 'human:black') return true;
  const a = agentOf(doc, urn);
  return !!(a && a.status === 'active' && a.capabilities.includes('verify'));
}
function assertRegistered(doc, urn) {
  const a = agentOf(doc, urn);
  if (!a || a.status !== 'active') throw new LedgerError('agent.unknown', `unknown or inactive agent: ${urn}`, null, 422);
  return a;
}

export function checkTransition(doc, task, to, actor, opts = {}) {
  // Open-board claim arbitration FIRST: a raced claim must surface
  // task.already_claimed (with the winner) rather than transition.illegal —
  // commit order is truth, and the loser is told exactly who won.
  if (opts.claim) {
    if (task.state !== 'created' || task.assigned_to !== null) {
      throw new LedgerError('task.already_claimed', 'task already claimed', { claimed_by: task.assigned_to }, 409);
    }
    const a = assertRegistered(doc, actor);
    if (!a.capabilities.includes(task.type)) {
      throw new LedgerError('claim.ineligible', `${actor} lacks capability ${task.type}`, null, 422);
    }
    return;
  }
  if (!TRANSITIONS[task.state].includes(to)) {
    throw new LedgerError('transition.illegal', `${task.state} → ${to} is not a legal transition`, { task_id: task.task_id }, 409);
  }
  if ((to === 'cancelled' || to === 'failed') && !(opts.reason && opts.reason.trim())) {
    throw new LedgerError('transition.reason_required', `${to} requires a non-empty reason`, { task_id: task.task_id }, 400);
  }
  const rollback = task.state === 'delivered' && to === 'in_progress';
  switch (to) {
    case 'assigned': {
      // direct assign: creator or Black only (open-board claims handled above)
      if (actor !== task.created_by && actor !== 'human:black') {
        throw new LedgerError('assign.forbidden', 'only the creator or Black may direct-assign', null, 403);
      }
      assertRegistered(doc, opts.assignee);
      break;
    }
    case 'in_progress':
      if (rollback) {
        if (!actor || actor === task.assigned_to || !isVerifierAgent(doc, actor)) {
          throw new LedgerError('rollback.verifier_required', 'rollback requires a verifier different from the assignee', null, 422);
        }
        if (!(opts.notes && opts.notes.trim())) {
          throw new LedgerError('rollback.notes_required', 'rollback requires non-empty notes', null, 400);
        }
      } else if (actor !== task.assigned_to) {
        throw new LedgerError('start.forbidden', 'only the assignee may start the task', null, 403);
      }
      break;
    case 'delivered':
      if (actor !== task.assigned_to) throw new LedgerError('deliver.forbidden', 'only the assignee may deliver', null, 403);
      if (!opts.artifacts || opts.artifacts.length === 0) throw new LedgerError('deliver.artifacts_required', 'delivery must attach ≥1 artifact', null, 400);
      if (!(opts.report && opts.report.trim())) throw new LedgerError('deliver.report_required', 'delivery requires a self-report', null, 400);
      break;
    case 'verified':
      if (actor === task.assigned_to) throw new LedgerError('verify.self_rejected', 'verifier must differ from the assignee', null, 422);
      if (!isVerifierAgent(doc, actor)) throw new LedgerError('verify.forbidden', `${actor} lacks the verifier capability`, null, 403);
      break;
    case 'cancelled':
      if (actor !== task.created_by && actor !== 'human:black') throw new LedgerError('cancel.forbidden', 'only the creator or Black may cancel', null, 403);
      break;
    case 'failed':
      if (actor !== task.assigned_to && actor !== 'system' && actor !== 'human:black') {
        throw new LedgerError('fail.forbidden', 'only the assignee, the watchdog, or Black may fail a task', null, 403);
      }
      break;
  }
}

function findTask(doc, id) {
  const t = doc.tasks.find((x) => x.task_id === id);
  if (!t) throw new LedgerError('task.not_found', `no such task: ${id}`, null, 404);
  return t;
}

const EVENT_FOR = {
  assigned: 'task.assigned', in_progress: 'task.started', delivered: 'task.delivered',
  verified: 'task.verified', cancelled: 'task.cancelled', failed: 'task.failed',
};

export function applyTransition(doc, taskId, to, actor, opts = {}) {
  const task = findTask(doc, taskId);
  checkTransition(doc, task, to, actor, opts);
  const from = task.state;
  if (to === 'assigned') task.assigned_to = opts.claim ? actor : opts.assignee;
  if (to === 'delivered') {
    task.artifacts.push(...opts.artifacts);
    task.deliverable_ref = opts.artifacts[0].uri;
  }
  task.state = to;
  task.state_history.push({ from, to, at: now(), by: actor, ...(opts.note || opts.notes || opts.reason ? { note: opts.note || opts.notes || opts.reason } : {}) });
  return { task, from };
}

// ---------------------------------------------------------------- task ops
function getTaskCreateArgs(a) {
  const inputs = JSON.parse(a['inputs-json'] || '{}');
  if (a.sample === 'true') throw new LedgerError('task.sample_rejected', 'sample:true is rejected in LIVE mode', null, 400);
  return {
    type: need(a, 'type'), title: need(a, 'title'), created_by: need(a, 'created-by'),
    inputs,
    acceptance: (a.acceptance || '').split(';').map((s) => s.trim()).filter(Boolean),
    priority: a.priority || 'normal',
    assigned_to: a['assigned-to'] || null,
    deadline_at: a.deadline || null,
    requires_black_approval: a['requires-black-approval'] === 'false' ? false : true,
    deliverable_ref: a['deliverable-ref'] || null,
    note: a.note || null,
    idempotency_key: a['idempotency-key'] || null,
  };
}

export function opTaskCreate(p) {
  if (!ACTOR_RE.test(p.created_by)) throw new LedgerError('task.bad_actor', `bad created_by: ${p.created_by}`, null, 400);
  if (p.assigned_to && !/^agent:[A-Za-z0-9_]+$/.test(p.assigned_to)) throw new LedgerError('task.bad_assignee', `bad assigned_to: ${p.assigned_to}`, null, 400);
  let created = null; // built inside the CAS closure so retries never duplicate
  const doc = casMutateState(`task create "${p.title.slice(0, 60)}"`, (d) => {
    if (p.idempotency_key && d.idempotency[p.idempotency_key]) {
      throw new LedgerError('idempotent.replay', 'duplicate idempotency key', { replay: d.idempotency[p.idempotency_key] }, 200);
    }
    const task = {
      task_id: 'tsk_' + ulid(), type: p.type, title: p.title, created_by: p.created_by,
      created_at: now(), assigned_to: null, state: 'created', priority: p.priority,
      inputs: p.inputs, acceptance: p.acceptance, artifacts: [], deliverable_ref: p.deliverable_ref,
      state_history: [], requires_black_approval: p.requires_black_approval, sample: false,
    };
    if (p.deadline_at) task.deadline_at = p.deadline_at;
    if (p.assigned_to) {
      assertRegistered(d, p.assigned_to);
      task.assigned_to = p.assigned_to; task.state = 'assigned';
      task.state_history.push({ from: 'created', to: 'assigned', at: now(), by: p.created_by, ...(p.note ? { note: p.note } : {}) });
    }
    d.tasks.push(task);
    if (p.idempotency_key) d.idempotency[p.idempotency_key] = { op: 'task.create', at: now(), ref: task.task_id };
    created = task;
  });
  const task = created;
  const evt = appendEvent('task.created', p.created_by, { task_id: task.task_id, state: task.state, title: task.title, type: task.type, assignee: task.assigned_to });
  if (task.state === 'assigned') appendEvent('task.assigned', p.created_by, { task_id: task.task_id, state: 'assigned', title: task.title, assignee: task.assigned_to });
  return { task_id: task.task_id, state: task.state, event_id: evt.event_id, version: doc.version };
}

export function opTaskTransition(taskId, to, actor, opts = {}) {
  if (!ACTOR_RE.test(actor)) throw new LedgerError('task.bad_actor', `bad actor: ${actor}`, null, 400);
  let applied = null;
  const doc = casMutateState(`task ${to} ${taskId} by ${actor}`, (d) => {
    if (opts.idempotency_key && d.idempotency[opts.idempotency_key]) {
      throw new LedgerError('idempotent.replay', 'duplicate idempotency key', { replay: d.idempotency[opts.idempotency_key] }, 200);
    }
    applied = applyTransition(d, taskId, to, actor, opts);
    if (opts.idempotency_key) d.idempotency[opts.idempotency_key] = { op: `task.${to}`, at: now(), ref: taskId };
  }, (fresh) => {
    // conflict path: name the winner when a claim raced us
    const t = fresh.tasks.find((x) => x.task_id === taskId);
    if (to === 'assigned' && t && t.assigned_to) {
      return new LedgerError('task.already_claimed', 'task already claimed', { claimed_by: t.assigned_to }, 409);
    }
    return new LedgerError('state.write_conflict', 'CAS conflict on state.json', { task_id: taskId }, 409);
  });
  const { task, from } = applied;
  const evtName = EVENT_FOR[to];
  const evt = appendEvent(evtName, actor, { task_id: taskId, state: to, title: task.title, assignee: task.assigned_to });
  let attention = null;
  if (from === 'delivered' && to === 'in_progress') {
    const cycles = task.state_history.filter((h) => h.from === 'delivered' && h.to === 'in_progress').length;
    attention = appendEvent('task.attention', actor, {
      task_id: taskId, reason: 'rollback', cycles,
      note: cycles >= 3 ? 'watchdog escalation: 3 rollback cycles → human:black' : 'verifier returned work with notes',
    });
  }
  return { task_id: taskId, from, to, event_id: evt.event_id, attention_event_id: attention ? attention.event_id : null, version: doc.version };
}

// Open-board claim: first-write-wins via atomic CAS on
// (state == 'created' AND assigned_to IS NULL). Loser gets 409 task.already_claimed + winner.
export function opClaim(taskId, claimant, opts = {}) {
  return opTaskTransition(taskId, 'assigned', claimant, { claim: true, note: opts.note, idempotency_key: opts.idempotency_key });
}

export function opEventAppend(event, actor, data) {
  if (!ACTOR_RE.test(actor)) throw new LedgerError('event.bad_actor', `bad actor: ${actor}`, null, 400);
  return appendEvent(event, actor, data);
}

export function opPresenceHeartbeat(agent, status = 'online', taskId = null, note = null) {
  if (!/^agent:[A-Za-z0-9_]+$/.test(agent)) throw new LedgerError('presence.bad_agent', `bad agent: ${agent}`, null, 400);
  const doc = casMutateState(`presence heartbeat ${agent} ${status}`, (d) => {
    assertRegistered(d, agent);
    // null taskId = "no change": preserve the existing live-task pointer.
    // The pointer is cleared only by an explicit empty-string --task "".
    const prev = d.presence[agent] || {};
    const keep = (taskId === null || taskId === undefined) ? (prev.current_task_id || null) : (taskId === '' ? null : taskId);
    d.presence[agent] = { status, at: now(), current_task_id: keep, note: note || prev.note || 'ops heartbeat (10-min cron)' };
  });
  const cur = doc.presence[agent].current_task_id;
  const evt = appendEvent('agent.presence', agent, { agent_id: agent, status, current_task_id: cur, note: note || 'ops heartbeat (10-min cron)' });
  return { agent_id: agent, status, event_id: evt.event_id, version: doc.version };
}

export function opApprovalSeal({ exactCopyPath, scopes, taskId, surface = 'owner-console', expiresAt = null }) {
  const exact = readFileSync(exactCopyPath, 'utf8');
  const copy_sha256 = sha256hex(exact);
  const receipt_id = 'apr_' + ulid();
  const scope = scopes.split(',').map((s) => s.trim()).filter(Boolean);
  if (scope.length === 0) throw new LedgerError('approval.scope_required', 'at least one scope is required', null, 400);
  // Seal per §4.5/§5: Ed25519 over receipt_id ‖ copy_sha256 ‖ scope (never the
  // key — Black holds sole signing authority; this CLI is the owner-console
  // surrogate and runs only on his explicit exact-copy approval).
  const key = createPrivateKey(readFileSync(KEY_PATH, 'utf8'));
  const sig = sign(null, Buffer.from(`${receipt_id}|${copy_sha256}|${scope.join(',')}`, 'utf8'), key).toString('base64');
  const receipt = {
    receipt_id, approved_by: 'human:black', approved_at: now(), surface,
    exact_copy: exact, copy_sha256, task_id: taskId, scope,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    seal: { alg: 'Ed25519', kid: KID, sig },
  };
  if (!/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(taskId)) throw new LedgerError('approval.bad_task', `bad task_id: ${taskId}`, null, 400);
  const doc = casMutateState(`approval seal ${receipt_id} scope=${scope.join(',')}`, (d) => {
    d.approvals.push({ receipt_id, approved_by: 'human:black', approved_at: receipt.approved_at, surface, copy_sha256, task_id: taskId, scope, seal: receipt.seal });
  });
  const fileSha = writeRepoFileCAS(`approvals/${receipt_id}.json`, JSON.stringify(receipt, null, 2) + '\n', `approval receipt ${receipt_id}`);
  return { receipt_id, copy_sha256, file_sha: fileSha, version: doc.version };
}

// ---------------------------------------------------------------- CLI
function need(a, k) {
  if (!a[k]) throw new LedgerError('cli.missing_arg', `missing required --${k}`, null, 400);
  return a[k];
}
function parseArgs(argv) {
  const a = {}; let positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      if (k in a) a[k] = Array.isArray(a[k]) ? [...a[k], v] : [a[k], v];
      else a[k] = v;
    } else positional.push(t);
  }
  return { args: a, positional };
}
function parseArtifacts(list) {
  return (Array.isArray(list) ? list : [list]).map((s) => {
    const [kind, uri] = s.split('|');
    if (!kind || !uri) throw new LedgerError('cli.bad_artifact', `--artifact expects "kind|uri", got: ${s}`, null, 400);
    if (!['report', 'draft', 'scan', 'image'].includes(kind)) throw new LedgerError('cli.bad_artifact', `bad artifact kind: ${kind}`, null, 400);
    return { artifact_id: 'art_' + ulid(), kind, uri, sha256: sha256hex(uri) };
  });
}

function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const { args: a, positional } = parseArgs(rest);
  try {
    let out;
    if (cmd === 'task' && sub === 'create') out = opTaskCreate(getTaskCreateArgs(a));
    else if (cmd === 'task' && sub === 'assign') out = opTaskTransition(positional[0], 'assigned', need(a, 'by'), { assignee: need(a, 'to'), note: a.note, idempotency_key: a['idempotency-key'] });
    else if (cmd === 'task' && sub === 'claim') out = opClaim(positional[0], need(a, 'as'), { note: a.note, idempotency_key: a['idempotency-key'] });
    else if (cmd === 'task' && sub === 'start') out = opTaskTransition(positional[0], 'in_progress', need(a, 'by'), { note: a.note });
    else if (cmd === 'task' && sub === 'deliver') out = opTaskTransition(positional[0], 'delivered', need(a, 'by'), { artifacts: parseArtifacts(a.artifact || []), report: need(a, 'report'), note: a.note });
    else if (cmd === 'task' && sub === 'verify') {
      if (a.verdict === 'needs_work') out = opTaskTransition(positional[0], 'in_progress', need(a, 'by'), { notes: need(a, 'notes') });
      else out = opTaskTransition(positional[0], 'verified', need(a, 'by'), { note: a.note });
    } else if (cmd === 'task' && sub === 'cancel') out = opTaskTransition(positional[0], 'cancelled', need(a, 'by'), { reason: need(a, 'reason') });
    else if (cmd === 'task' && sub === 'fail') out = opTaskTransition(positional[0], 'failed', need(a, 'by'), { reason: need(a, 'reason') });
    else if (cmd === 'event' && sub === 'append') out = opEventAppend(need(a, 'event'), need(a, 'actor'), JSON.parse(a['data-json'] || '{}'));
    else if (cmd === 'presence' && sub === 'heartbeat') out = opPresenceHeartbeat(need(a, 'agent'), a.status || 'online', ('task' in a ? a.task : null), a.note || null);
    else if (cmd === 'approval' && sub === 'seal') out = opApprovalSeal({ exactCopyPath: need(a, 'exact-copy'), scopes: need(a, 'scope'), taskId: need(a, 'task'), surface: a.surface || 'owner-console', expiresAt: a['expires-at'] || null });
    else if (cmd === 'state' && sub === 'get') out = readState().doc;
    else if (cmd === 'state' && sub === 'version') { const { doc, sha } = readState(); out = { version: doc.version, updated_at: doc.updated_at, sha, tasks: doc.tasks.length }; }
    else throw new LedgerError('cli.unknown_command', `unknown command: ${[cmd, sub].filter(Boolean).join(' ')}`, null, 400);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    if (e instanceof LedgerError && e.code === 'idempotent.replay') {
      console.log(JSON.stringify({ idempotent_replay: true, replay: e.detail.replay }, null, 2));
      return;
    }
    const body = e instanceof LedgerError ? e.toJSON() : { error: { code: 'cli.internal', message: e.message, detail: null } };
    console.error(JSON.stringify(body, null, 2));
    process.exit(e instanceof LedgerError && e.status === 409 ? 2 : e instanceof LedgerError && e.status >= 400 && e.status < 500 ? 3 : 1);
  }
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const invokedAsScript = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedAsScript) main();
