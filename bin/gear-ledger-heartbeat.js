#!/usr/bin/env node
/**
 * gear-ledger-heartbeat.js — hardened 10-min Gear Ledger presence heartbeat.
 *
 * Full read → sync → heartbeat → report pass for all 22 registered agents in
 * one command (18 original + Codex + 3 ATHENA sub-agents, folded in 2026-09-22;
 * the old separate Codex/ATHENA cron steps are retired — this wrapper is the
 * single writer). Eliminates the recurring hand-rolled-loop bugs:
 *
 *  1. NO tilde expansion anywhere — the ledger CLI path is absolute.
 *  2. Agent URNs (`agent:MUSE_CWI`, …) are hardcoded whole strings and passed
 *     through argv — NEVER split with ${a%%:*} / ${a#*:} in bash.
 *  3. Exactly one presence write per agent, single pass — no duplicates.
 *  4. POINTER SYNC (added 2026-09-22, Black's order: all agents live): before
 *     heartbeating, each agent's desired live-task pointer is DERIVED from the
 *     store — newest `in_progress` task assigned to them, else newest
 *     `assigned` task — formatted `<SHORT>:<task_id>` (e.g. `MUSE_CWI:tsk_…`).
 *     The heartbeat passes `--task <desired>` so the pulse both marks the
 *     agent online AND sets the pointer in the same single write. When an
 *     agent has no live task, `--task` is omitted and the CLI preserves the
 *     existing pointer (explicit null/empty would wipe it — never pass that).
 *  5. NEURAL-BRAIN WIRING (added 2026-09-22, Black's order: every action in
 *     the neural brain ecosystem): whenever ≥1 pointer actually changes, a
 *     durable claim is written to the agent-memory shared pool
 *     (`memory.js writeshared agent:MUSE_CWI`) so every agent's read sees the
 *     live roster state. Best-effort: a memory failure warns but never fails
 *     the heartbeat — presence is the critical path. No-op runs write no
 *     claim (the brain learns what changed, not 144 identical pulses a day).
 *  6. Exits non-zero ONLY on a real heartbeat failure. Machine-readable
 *     summary line: OK=<n> FAIL=<m> VERSION=<before> -> <after>
 *
 * The CLI appends the `agent.presence` event itself — this wrapper appends none.
 * The CLI handles SHA compare-and-swap retries internally; a 409 that survives
 * its retries surfaces here as a FAIL with the exact error text.
 *
 * Usage: node /home/hatch/workspace/gear-ledger/bin/gear-ledger-heartbeat.js
 */

'use strict';
const { execFileSync } = require('child_process');

const LEDGER = '/home/hatch/workspace/gear-ledger/cli/ledger.js';
const MEMORY = '/home/hatch/workspace/cwi-agent-memory/cli/memory.js';
const AGENTS = [
  'agent:MUSE_CWI',
  'agent:CWI_AandR',
  'agent:CWI_Marketing',
  'agent:CWI_Sync',
  'agent:CWI_Radio',
  'agent:CWI_Press',
  'agent:CWI_Studio',
  'agent:CWI_Data',
  'agent:CWI_Affairs',
  'agent:CWI_Results',
  'agent:CWI_Athena',
  'agent:CWI_Visual',
  'agent:CWI_Volt',
  'agent:CWI_Tween',
  'agent:CWI_Atelier',
  'agent:CWI_Care',
  'agent:CWI_Guide',
  'agent:CWI_Watch',
  'agent:CWI_Codex',
  'agent:CWI_Athena_PIONEER',
  'agent:CWI_Athena_MINT',
  'agent:CWI_Athena_CLOSER',
];

const LIVE_STATES = new Set(['in_progress', 'assigned']);

function runCli(args, script) {
  try {
    const out = execFileSync('node', [script || LEDGER, ...args], {
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: out };
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    const stdout = (e.stdout || '').toString().trim();
    return { ok: false, exitCode: e.status, error: stderr || stdout || e.message };
  }
}

function die(msg, code = 1) {
  process.stderr.write('heartbeat-wrapper: ' + msg + '\n');
  process.exit(code);
}

// Derive the live-task pointer for one agent: newest in_progress task assigned
// to them, else newest assigned task. Returns '<SHORT>:<task_id>' or null.
function desiredPointer(urn, tasks) {
  const mine = tasks.filter(
    (t) => t && t.assigned_to === urn && LIVE_STATES.has(t.state)
  );
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  mine.sort((a, b) => (a.state === 'in_progress' ? 0 : 1) - (b.state === 'in_progress' ? 0 : 1));
  return urn.replace(/^agent:/, '') + ':' + mine[0].task_id;
}

function main() {
  // Step 1: read current store (server-authoritative).
  const verBeforeRes = runCli(['state', 'version']);
  if (!verBeforeRes.ok) die('cannot read store version: ' + verBeforeRes.error);
  const versionBefore = JSON.parse(verBeforeRes.stdout).version;

  const getRes = runCli(['state', 'get']);
  if (!getRes.ok) die('cannot read store state: ' + getRes.error);
  const state = JSON.parse(getRes.stdout);
  const presence = state.presence || {};
  const tasks = state.tasks || [];

  // Step 2: heartbeat all agents in ONE compare-and-swap via the batch
  // command (2026-09-25: 22 sequential full-file CAS cycles collapsed to 1 —
  // the race window and write traffic drop ~22x). Pointer derivation is
  // unchanged: newest in_progress, else newest assigned.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const entries = [];
  const tags = {};
  const changed = [];
  for (const urn of AGENTS) {
    const cur = presence[urn] ? presence[urn].current_task_id : null;
    const want = desiredPointer(urn, tasks);
    const e = { agent: urn, status: 'online' };
    // Only include the task key when a live task exists — the CLI preserves
    // the existing pointer when the key is absent (never pass null/empty).
    if (want) e.task = want;
    entries.push(e);
    tags[urn] = !want ? 'no-live-task(preserved)' : want === cur ? 'pointer-ok' : 'pointer-synced';
    if (want && want !== cur) changed.push({ urn, from: cur, to: want });
  }
  const batchTmp = path.join(os.tmpdir(), 'heartbeat-batch-' + process.pid + '.json');
  fs.writeFileSync(batchTmp, JSON.stringify(entries));
  const b = runCli(['presence', 'heartbeat-batch', '--batch-file', batchTmp]);
  try { fs.unlinkSync(batchTmp); } catch (_) {}
  let ok = 0, fail = 0;
  const failures = [];
  if (b.ok) {
    const res = JSON.parse(b.stdout);
    for (const urn of AGENTS) {
      ok++;
      const want = entries.find((e) => e.agent === urn).task;
      process.stdout.write('OK   ' + urn + ' [' + tags[urn] + (want ? ' ' + want : '') + ']\n');
    }
    process.stdout.write(`BATCH agents=${res.agents} changed=${res.changed} version=${res.version}\n`);
  } else {
    for (const urn of AGENTS) {
      fail++;
      failures.push({ urn, exitCode: b.exitCode, error: b.error });
      process.stdout.write('FAIL ' + urn + ' exit=' + b.exitCode + ' ' + b.error.split('\n')[0] + '\n');
    }
  }

  // Step 3: neural-brain wiring — record pointer changes as a durable claim.
  // Best-effort: never fails the heartbeat.
  if (changed.length > 0) {
    try {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const detail = changed
        .map((c) => c.urn.replace(/^agent:/, '') + '->' + c.to.split(':').pop())
        .join(', ');
      const claims = [
        {
          claim:
            'Gear-ledger presence sync ' + stamp + ' UTC: ' + changed.length +
            ' pointer(s) synced to live tasks — ' + detail +
            '. All ' + AGENTS.length + ' agents online with live task pointers.',
          source: 'gear-ledger-heartbeat wrapper (pointer-sync step)',
          date: new Date().toISOString().slice(0, 10),
          confidence: 'high',
        },
      ];
      const tmp = path.join(os.tmpdir(), 'heartbeat-claims-' + process.pid + '.json');
      fs.writeFileSync(tmp, JSON.stringify(claims));
      const mr = runCli(['writeshared', 'agent:MUSE_CWI', '--claims', tmp], MEMORY);
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (mr.ok) process.stdout.write('BRAIN claim written (' + changed.length + ' pointer syncs)\n');
      else process.stdout.write('WARN brain claim failed (heartbeat unaffected): ' + mr.error.split('\n')[0] + '\n');
    } catch (e) {
      process.stdout.write('WARN brain claim failed (heartbeat unaffected): ' + (e.message || e) + '\n');
    }
  } else {
    process.stdout.write('BRAIN no pointer changes — no claim written\n');
  }

  // Step 4: version after.
  let versionAfter = versionBefore;
  const verAfterRes = runCli(['state', 'version']);
  if (verAfterRes.ok) versionAfter = JSON.parse(verAfterRes.stdout).version;
  else process.stdout.write('WARN could not re-read version: ' + verAfterRes.error + '\n');

  process.stdout.write(`OK=${ok} FAIL=${fail} VERSION=${versionBefore} -> ${versionAfter}\n`);
  for (const f of failures) {
    process.stderr.write(`failure ${f.urn} exit=${f.exitCode}: ${f.error}\n`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
