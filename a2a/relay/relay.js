#!/usr/bin/env node
// relay.js — CWI A2A GitHub-issues relay.
//
// Transports A2A JSON-RPC requests from external agents to the local CWI A2A
// gateway without any public HTTP endpoint. External agents open an issue in
// the inbox repo (label `a2a-inbox`) with a raw JSON-RPC 2.0 payload as the
// body. This script (run every ~10 min by cron):
//   1. lists open `a2a-inbox` issues,
//   2. validates the JSON-RPC 2.0 envelope (rejects malformed/spam with an
//      explanatory comment + `a2a-rejected` label, then closes),
//   3. forwards valid payloads to the local A2A server (spawned on demand),
//   4. posts the JSON-RPC response as an issue comment, labels
//      `a2a-processed`, closes the issue,
//   5. appends every relay to data/requests.log (the adoption metric).
//
// Honest transport: this is the "github-issues-profile" of A2A, not vanilla
// HTTP JSON-RPC. Round-trip latency is bounded by the cron cadence (~10 min).
// Zero dependencies; GitHub API access goes through the ghapi skill CLI.
//
// Run:  node relay.js
// Env:  A2A_INBOX_REPO (default CumulativeWebInc/cwi-a2a-inbox)
//       A2A_SERVER_DIR (default <this-dir>/server), A2A_DATA_DIR (default <this-dir>/data)
//       A2A_PORT (default 41241), A2A_MAX_PER_RUN (default 20), GHAPI (path to ghapi CLI)
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  repo: process.env.A2A_INBOX_REPO || 'CumulativeWebInc/cwi-a2a-inbox',
  inboxLabel: 'a2a-inbox',
  processedLabel: 'a2a-processed',
  rejectedLabel: 'a2a-rejected',
  serverDir: process.env.A2A_SERVER_DIR || join(HERE, 'server'),
  dataDir: process.env.A2A_DATA_DIR || join(HERE, 'data'),
  port: parseInt(process.env.A2A_PORT, 10) || 41241,
  maxPerRun: parseInt(process.env.A2A_MAX_PER_RUN, 10) || 20,
  maxBodyBytes: 64 * 1024,
  ghapi: process.env.GHAPI || '/home/hatch/workspace/skills/github/bin/ghapi',
  protocolDoc: 'https://github.com/CumulativeWebInc/gear-ledger/blob/main/a2a/INBOX-PROTOCOL.md',
};

const RELAY_MARKER = '<!-- cwi-a2a-relay:v1 -->';

// ---------------------------------------------------------------------------
// GitHub API via the ghapi skill CLI
// ---------------------------------------------------------------------------
function gh(method, path, data) {
  const args = [method, path];
  if (data !== undefined) args.push('--data', JSON.stringify(data));
  try {
    const out = execFileSync(CONFIG.ghapi, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    const detail = (e.stderr || e.message || String(e)).slice(0, 500);
    throw new Error(`ghapi ${method} ${path} failed: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Envelope validation (relay-level: well-formedness only; protocol semantics
// like unknown methods are the A2A server's job — its error is posted back).
// ---------------------------------------------------------------------------
function unwrapFences(body) {
  const t = body.trim();
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n');
    const lastFence = t.lastIndexOf('```');
    if (firstNl !== -1 && lastFence > firstNl) return t.slice(firstNl + 1, lastFence).trim();
  }
  return t;
}

function validateEnvelope(body) {
  if (!body || !body.trim()) return { ok: false, reason: 'empty issue body' };
  if (Buffer.byteLength(body, 'utf8') > CONFIG.maxBodyBytes)
    return { ok: false, reason: `body exceeds ${CONFIG.maxBodyBytes / 1024}KB` };
  const unwrapped = unwrapFences(body);
  let rpc;
  try { rpc = JSON.parse(unwrapped); }
  catch { return { ok: false, reason: 'body is not valid JSON (raw JSON-RPC 2.0 object required)' }; }
  if (Array.isArray(rpc)) return { ok: false, reason: 'batch requests are not supported' };
  if (!rpc || rpc.jsonrpc !== '2.0')
    return { ok: false, reason: 'not a JSON-RPC 2.0 request (jsonrpc must be "2.0")' };
  if (typeof rpc.method !== 'string' || !rpc.method)
    return { ok: false, reason: 'missing or invalid "method"' };
  if (rpc.id === undefined)
    return { ok: false, reason: 'missing "id" (notifications are not supported)' };
  return { ok: true, rpc, raw: unwrapped };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
function safeFence(s) {
  return String(s).replace(/```/g, "'''");
}

const EXAMPLE = `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": { "role": "user", "parts": [{ "kind": "text", "text": "Hello, KingCode." }] },
    "metadata": { "agent": "MUSE_CWI" }
  }
}`;

function rejectionComment(reason) {
  return `${RELAY_MARKER}
**CWI A2A relay — request rejected.**

Reason: ${reason}.

To reach a CWI agent, open an issue with the \`a2a-inbox\` label whose body is a raw JSON-RPC 2.0 request object (a single \`\`\`json fence is tolerated). Full protocol: ${CONFIG.protocolDoc}

Example body:
\`\`\`json
${EXAMPLE}
\`\`\`

This is the CWI **github-issues-profile** transport — honest, async, and relayed every ~10 minutes. It is not a live HTTP endpoint.`;
}

function responseComment(response) {
  return `${RELAY_MARKER}
**CWI A2A relay — response** (transport: \`github-issues-profile\`; round trip relayed every ~10 min — this is not a live HTTP endpoint).

\`\`\`json
${safeFence(JSON.stringify(response, null, 2))}
\`\`\`

Protocol: ${CONFIG.protocolDoc}`;
}

// ---------------------------------------------------------------------------
// Local A2A server lifecycle (spawned on demand, only when needed)
// ---------------------------------------------------------------------------
function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function probe() {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() > deadline) return reject(new Error('health check failed'));
        setTimeout(probe, 300);
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
        setTimeout(probe, 300);
      });
      req.end();
    })();
  });
}

async function withServer(fn) {
  let port = CONFIG.port;
  let child = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    child = spawn('node', [join(CONFIG.serverDir, 'server.js'), '--port', String(port), '--data', CONFIG.dataDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = false;
    child.on('exit', () => { exited = true; });
    await new Promise((r) => setTimeout(r, 400));
    if (exited) { port += 1; continue; } // port busy or crash — try next
    try { await waitForHealth(port, 12000); break; }
    catch { try { child.kill('SIGKILL'); } catch {} port += 1; child = null; }
  }
  if (!child) throw new Error('could not start the A2A server on any candidate port');
  try {
    return await fn(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    try { child.kill('SIGKILL'); } catch {}
  }
}

function postToServer(port, rawBody) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('server returned non-JSON')); }
        });
      });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('server request timed out')));
    req.end(rawBody);
  });
}

// ---------------------------------------------------------------------------
// Request log (the adoption metric)
// ---------------------------------------------------------------------------
function logRelay(rec) {
  mkdirSync(CONFIG.dataDir, { recursive: true });
  appendFileSync(join(CONFIG.dataDir, 'requests.log'),
    JSON.stringify({ ts: new Date().toISOString(), transport: 'github-issues-profile', ...rec }) + '\n');
}

// ---------------------------------------------------------------------------
// Main relay
// ---------------------------------------------------------------------------
async function runRelay({ ghImpl = gh } = {}) {
  const summary = { processed: 0, rejected: 0, skipped: 0, errors: 0, issues: [] };
  let issues;
  try {
    issues = ghImpl('GET', `/repos/${CONFIG.repo}/issues?state=open&labels=${CONFIG.inboxLabel}&per_page=50`);
  } catch (e) {
    summary.errors += 1;
    summary.fatal = String(e.message || e).slice(0, 300);
    return summary;
  }
  const candidates = (Array.isArray(issues) ? issues : []).slice(0, CONFIG.maxPerRun);

  // Pass 1: classify (no server needed for rejects/skips).
  const valid = [];
  for (const issue of candidates) {
    const n = issue.number;
    const labels = (issue.labels || []).map((l) => l.name || l);
    if (issue.pull_request) { summary.skipped += 1; summary.issues.push({ n, action: 'skipped:pr' }); continue; }
    if (labels.includes(CONFIG.processedLabel) || labels.includes(CONFIG.rejectedLabel)) {
      summary.skipped += 1; summary.issues.push({ n, action: 'skipped:already-labeled' }); continue;
    }
    const sender = (issue.user && issue.user.login) || 'unknown';
    const v = validateEnvelope(issue.body || '');
    if (!v.ok) {
      try {
        ghImpl('POST', `/repos/${CONFIG.repo}/issues/${n}/comments`, { body: rejectionComment(v.reason) });
        ghImpl('POST', `/repos/${CONFIG.repo}/issues/${n}/labels`, { labels: [CONFIG.rejectedLabel] });
        ghImpl('PATCH', `/repos/${CONFIG.repo}/issues/${n}`, { state: 'closed' });
        logRelay({ issue: n, sender, ok: false, reason: v.reason });
        summary.rejected += 1; summary.issues.push({ n, action: 'rejected', reason: v.reason });
      } catch (e) {
        summary.errors += 1; summary.issues.push({ n, action: 'error', error: String(e.message || e).slice(0, 200) });
      }
      continue;
    }
    valid.push({ issue, sender, rpc: v.rpc, raw: v.raw });
  }

  // Pass 2: forward valid payloads through the on-demand A2A server.
  if (valid.length > 0) {
    try {
      await withServer(async (port) => {
        for (const { issue, sender, rpc, raw } of valid) {
          const n = issue.number;
          try {
            // Idempotency: if a previous run already posted our response, just close+label.
            const comments = ghImpl('GET', `/repos/${CONFIG.repo}/issues/${n}/comments?per_page=50`);
            const already = (Array.isArray(comments) ? comments : [])
              .some((c) => typeof c.body === 'string' && c.body.includes(RELAY_MARKER) && c.body.includes('response'));
            if (already) {
              ghImpl('POST', `/repos/${CONFIG.repo}/issues/${n}/labels`, { labels: [CONFIG.processedLabel] });
              ghImpl('PATCH', `/repos/${CONFIG.repo}/issues/${n}`, { state: 'closed' });
              summary.processed += 1; summary.issues.push({ n, action: 'processed:dedupe' });
              continue;
            }
            const response = await postToServer(port, raw);
            ghImpl('POST', `/repos/${CONFIG.repo}/issues/${n}/comments`, { body: responseComment(response) });
            ghImpl('POST', `/repos/${CONFIG.repo}/issues/${n}/labels`, { labels: [CONFIG.processedLabel] });
            ghImpl('PATCH', `/repos/${CONFIG.repo}/issues/${n}`, { state: 'closed' });
            const ok = !response || !response.error;
            logRelay({
              issue: n, sender, method: rpc.method, id: rpc.id,
              agent: response && response.result && response.result.agent,
              task_id: response && response.result && response.result.id,
              ok,
            });
            summary.processed += 1; summary.issues.push({ n, action: 'processed', ok });
          } catch (e) {
            summary.errors += 1; summary.issues.push({ n, action: 'error', error: String(e.message || e).slice(0, 200) });
          }
        }
      });
    } catch (e) {
      summary.errors += 1; summary.fatal = `server: ${String(e.message || e).slice(0, 200)}`;
    }
  }
  return summary;
}

async function main() {
  const summary = await runRelay();
  console.log(JSON.stringify(summary));
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
export { runRelay, validateEnvelope, unwrapFences, rejectionComment, responseComment, RELAY_MARKER, CONFIG };
