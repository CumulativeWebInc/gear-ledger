// server.js — CWI A2A (Agent2Agent) JSON-RPC gateway.
// Zero dependencies: pure node:http. Serves the 10 CWI agents as A2A endpoints.
//
// What it does (honestly): receives A2A messages, validates them, logs them,
// queues them to the addressed agent's recorded inbound queue
// (data/inbox/<HANDLE>.jsonl), and completes the intake task with a
// machine-readable queue receipt. It does NOT execute agent work —
// queued requests are reviewed by the CWI pipeline (see README.md).
//
// Spec coverage (Google A2A):
//   JSON-RPC methods: message/send + SendMessage (v0.3 + v1.0 names),
//                     tasks/get + GetTask, tasks/cancel + CancelTask,
//                     ListTasks
//   Task states: submitted -> working -> completed | canceled | failed
//   Discovery: GET /.well-known/agent-card.json (fleet card, one interface
//              per agent via tenant), GET /health
//
// Run: node server.js [--port 41241] [--data ./data]
// Env: PORT, A2A_DATA_DIR
import { createServer as createHttpServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

// A2A error codes (JSON-RPC server-error range; -32001 follows A2A convention).
const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, TASK_NOT_FOUND: -32001, AGENT_NOT_FOUND: -32002,
  TASK_NOT_CANCELABLE: -32003, RATE_LIMITED: -32000,
};
const TASK_ERROR_NAMES = { [-32001]: 'TASK_NOT_FOUND', [-32002]: 'AGENT_NOT_FOUND', [-32003]: 'TASK_NOT_CANCELABLE' };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
function loadRegistry() {
  const snap = JSON.parse(readFileSync(join(HERE, 'agents.json'), 'utf8'));
  const byHandle = new Map(snap.agents.map((a) => [a.handle, a]));
  return { snapshot: snap, byHandle };
}

// ---------------------------------------------------------------------------
// Store (JSON write-through so restarts keep task state)
// ---------------------------------------------------------------------------
function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, 'inbox'), { recursive: true });
  const tasksFile = join(dataDir, 'tasks.json');
  const requestsLog = join(dataDir, 'requests.log');
  let tasks = new Map();
  try {
    if (existsSync(tasksFile)) {
      for (const t of JSON.parse(readFileSync(tasksFile, 'utf8'))) tasks.set(t.id, t);
    }
  } catch { /* corrupt file -> start empty, never crash */ }

  function persist() {
    const tmp = tasksFile + '.tmp';
    writeFileSync(tmp, JSON.stringify([...tasks.values()], null, 1));
    // atomic replace via rename would be nicer; writeFileSync is fine for this scale
    writeFileSync(tasksFile, readFileSync(tmp));
  }
  function logRequest(rec) {
    appendFileSync(requestsLog, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
  }
  function inboxAppend(handle, rec) {
    appendFileSync(join(dataDir, 'inbox', `${handle}.jsonl`), JSON.stringify(rec) + '\n');
  }
  function inboxCount(handle) {
    const f = join(dataDir, 'inbox', `${handle}.jsonl`);
    if (!existsSync(f)) return 0;
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  }
  return { tasks, persist, logRequest, inboxAppend, inboxCount, tasksFile, requestsLog };
}

// ---------------------------------------------------------------------------
// A2A shapes
// ---------------------------------------------------------------------------
function textOf(message) {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.kind === 'text' || p.type === 'text') && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function makeTask({ agentHandle, message }) {
  const now = new Date().toISOString();
  const contextId = message?.contextId || randomUUID();
  return {
    id: `a2a_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    contextId,
    sessionId: contextId, // v0.3-compatible alias
    agent: agentHandle,
    status: { state: 'submitted', timestamp: now },
    history: [
      { kind: 'message', messageId: message?.messageId || randomUUID(), role: message?.role || 'user',
        parts: message?.parts || [], contextId },
    ],
    artifacts: [],
    metadata: { intake: 'cwi-a2a-gateway', version: VERSION },
  };
}

function taskView(t, historyLength) {
  const v = { id: t.id, contextId: t.contextId, sessionId: t.sessionId, agent: t.agent,
              status: t.status, artifacts: t.artifacts, metadata: t.metadata };
  if (historyLength && historyLength > 0) v.history = t.history.slice(-historyLength);
  return v;
}

// ---------------------------------------------------------------------------
// Intake pipeline (the honest core: receive -> log -> queue -> receipt)
// ---------------------------------------------------------------------------
function processIntake(store, task, text) {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const position = store.inboxCount(task.agent) + 1;
  task.status = { state: 'working', timestamp: new Date().toISOString() };
  store.persist();

  const receipt = {
    receipt: 'cwi-a2a-intake',
    task_id: task.id,
    context_id: task.contextId,
    agent: task.agent,
    queued_at: new Date().toISOString(),
    queue_file: `data/inbox/${task.agent}.jsonl`,
    queue_position: position,
    message_sha256: digest,
    text_preview: text.slice(0, 280),
    honesty: 'Message received, logged, and queued to the agent\u2019s recorded task queue. No automated execution was performed; queued requests are reviewed by the CWI pipeline (see README.md).',
  };
  store.inboxAppend(task.agent, { ...receipt, text });

  task.status = { state: 'completed', timestamp: new Date().toISOString(),
    message: { kind: 'message', messageId: randomUUID(), role: 'agent',
      parts: [{ kind: 'text', text: `Queued for ${task.agent} (position ${position}). No automated execution.` }],
      contextId: task.contextId } };
  task.artifacts = [{ artifactId: randomUUID(), name: 'queue-receipt.json',
    description: 'Machine-readable receipt for the queued message.',
    parts: [{ kind: 'data', data: receipt }] }];
  store.persist();
  return task;
}

// ---------------------------------------------------------------------------
// JSON-RPC handlers
// ---------------------------------------------------------------------------
function rpcError(id, code, message, data) {
  const e = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (data !== undefined) e.error.data = data;
  if (TASK_ERROR_NAMES[code]) e.error.data = { name: TASK_ERROR_NAMES[code], ...(data || {}) };
  return e;
}
function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }

function resolveAgent(byHandle, params, query) {
  const raw = params?.metadata?.agent || params?.agent || query.tenant || query.agent || 'MUSE_CWI';
  const handle = String(raw).toUpperCase() === raw ? raw : raw; // handles are UPPER_SNAKE
  const norm = [...byHandle.keys()].find((h) => h.toLowerCase() === String(raw).toLowerCase());
  return norm || null;
}

function handleRpc(store, registry, body, query) {
  const { byHandle } = registry;
  if (Array.isArray(body)) return rpcError(null, ERR.INVALID_REQUEST, 'Batch requests are not supported.');
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
    return rpcError(body?.id, ERR.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request.');
  const { id, method, params = {} } = body;
  const isNotification = id === undefined;

  let result;
  try {
    switch (method) {
      case 'message/send':
      case 'SendMessage': {
        const message = params.message;
        if (!message || typeof message !== 'object')
          return rpcError(id, ERR.INVALID_PARAMS, 'params.message is required.');
        const text = textOf(message);
        if (!text.trim())
          return rpcError(id, ERR.INVALID_PARAMS, 'params.message must contain at least one text part.');
        const agent = resolveAgent(byHandle, params, query);
        if (!agent)
          return rpcError(id, ERR.AGENT_NOT_FOUND,
            `Unknown agent '${params?.metadata?.agent || params?.agent || query.tenant || ''}'. Known: ${[...byHandle.keys()].join(', ')}.`);
        const blocking = params.configuration?.blocking !== false;
        const task = makeTask({ agentHandle: agent, message });
        store.tasks.set(task.id, task);
        store.persist();
        if (blocking) processIntake(store, task, text);
        else setTimeout(() => {
          const t = store.tasks.get(task.id);
          if (t && (t.status.state === 'submitted' || t.status.state === 'working')) processIntake(store, t, text);
        }, 75);
        result = taskView(task, params.historyLength);
        break;
      }
      case 'tasks/get':
      case 'GetTask': {
        const tid = params.id;
        if (!tid) return rpcError(id, ERR.INVALID_PARAMS, 'params.id is required.');
        const t = store.tasks.get(tid);
        if (!t) return rpcError(id, ERR.TASK_NOT_FOUND, `Task '${tid}' not found.`);
        result = taskView(t, params.historyLength);
        break;
      }
      case 'tasks/cancel':
      case 'CancelTask': {
        const tid = params.id;
        if (!tid) return rpcError(id, ERR.INVALID_PARAMS, 'params.id is required.');
        const t = store.tasks.get(tid);
        if (!t) return rpcError(id, ERR.TASK_NOT_FOUND, `Task '${tid}' not found.`);
        if (!['submitted', 'working'].includes(t.status.state))
          return rpcError(id, ERR.TASK_NOT_CANCELABLE,
            `Task '${tid}' is ${t.status.state}; only submitted/working tasks can be canceled.`);
        t.status = { state: 'canceled', timestamp: new Date().toISOString() };
        store.persist();
        result = taskView(t, params.historyLength);
        break;
      }
      case 'ListTasks': {
        let list = [...store.tasks.values()];
        if (params.status) list = list.filter((t) => t.status.state === params.status);
        if (params.agent) list = list.filter((t) => t.agent === params.agent);
        const limit = Math.min(Math.max(parseInt(params.limit) || 50, 1), 200);
        result = { tasks: list.slice(-limit).reverse().map((t) => taskView(t, 0)) };
        // note: history omitted by default
        break;
      }
      default:
        return rpcError(id, ERR.METHOD_NOT_FOUND, `Method '${method}' not found. Supported: message/send, SendMessage, tasks/get, GetTask, tasks/cancel, CancelTask, ListTasks.`);
    }
  } catch (e) {
    return rpcError(id, ERR.RATE_LIMITED, 'Internal error.', { detail: String(e?.message || e) });
  }
  if (isNotification) return null;
  return rpcOk(id, result);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function fleetCard(registry, baseUrl) {
  const snap = registry.snapshot;
  return {
    name: 'CWI Agent Fleet',
    description: `All ${snap.agent_count} registered agents of Cumulative Web Inc, contactable over A2A. One supportedInterface per agent (tenant = handle). Per-agent cards: https://cumulativewebinc.github.io/cwi-learn/.well-known/agents/<HANDLE>/agent-card.json. Messages are received, logged, and queued; no automated execution.`,
    protocolVersion: '1.0.0',
    version: VERSION,
    provider: { organization: 'Cumulative Web Inc', url: 'https://github.com/CumulativeWebInc' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'agent_contact', name: 'Contact a CWI agent', tags: ['contact', 'queue'],
      description: 'Send a message to any registered CWI agent; it is queued to that agent\u2019s recorded task queue.', examples: [] }],
    supportedInterfaces: snap.agents.map((a) => ({
      url: baseUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0.0', tenant: a.handle })),
    trust: { root: 'cwi-needledrop/v1', issuer: 'Cumulative Web Inc',
      seal_url: snap.provenance.trust_root.seal_url,
      registry: { repo: snap.provenance.registry_repo, state_version: snap.provenance.state_version,
                  state_updated_at: snap.provenance.state_updated_at } },
  };
}

function createServer({ port = 41241, dataDir = join(HERE, 'data') } = {}) {
  const registry = loadRegistry();
  const store = openStore(dataDir);

  // light rate limit: 60 req/min per IP
  const rl = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const e = rl.get(ip) || { n: 0, reset: now + 60000 };
    if (now > e.reset) { e.n = 0; e.reset = now + 60000; }
    e.n++; rl.set(ip, e);
    return e.n > 60;
  }

  const server = createHttpServer((req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: VERSION, agents: registry.snapshot.agent_count,
        registry_version: registry.snapshot.provenance.state_version, time: new Date().toISOString() }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      const base = `http://${req.headers.host || `localhost:${port}`}/`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fleetCard(registry, base), null, 2));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/a2a/v1')) {
      if (rateLimited(ip)) {
        store.logRequest({ method: 'RATE_LIMITED', ip, ok: false });
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rpcError(null, ERR.RATE_LIMITED, 'Rate limited: 60 requests/minute per IP.')));
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); }
        catch { res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(rpcError(null, ERR.PARSE, 'Parse error: body is not valid JSON.'))); return; }
        const startedMethod = body && !Array.isArray(body) ? body.method : null;
        const resp = handleRpc(store, registry, body, query);
        const rid = body && !Array.isArray(body) ? body.id : null;
        const ok = !resp || !resp.error;
        store.logRequest({ method: startedMethod || '(invalid)', ip, agent: resp?.result?.agent, task_id: resp?.result?.id, ok });
        if (resp === null) { res.writeHead(204); res.end(); return; } // notification
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resp));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. POST JSON-RPC to / ; GET /health ; GET /.well-known/agent-card.json' }));
  });

  return { server, registry, store, port };
}

function main() {
  let port = parseInt(process.env.PORT) || 41241;
  let dataDir = process.env.A2A_DATA_DIR || join(HERE, 'data');
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--port') port = parseInt(process.argv[++i]);
    else if (process.argv[i] === '--data') dataDir = process.argv[++i];
  }
  const { server, registry } = createServer({ port, dataDir });
  server.listen(port, () => {
    console.log(`CWI A2A gateway listening on :${port} — ${registry.snapshot.agent_count} agents (registry v${registry.snapshot.provenance.state_version})`);
    console.log(`Card: http://localhost:${port}/.well-known/agent-card.json`);
  });
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
export { createServer, handleRpc, textOf, fleetCard, VERSION };
