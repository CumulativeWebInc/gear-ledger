// test.js — test suite for the CWI A2A gateway. Zero dependencies.
// Runs an ephemeral server (random port, temp data dir) and exercises the
// JSON-RPC surface end to end. Usage: node test.js
import { createServer } from './server.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
async function rpc(base, method, params, query = '') {
  const r = await fetch(`${base}/${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 't1', method, params }),
  });
  return r.json();
}
const msg = (text, role = 'user') => ({ role, parts: [{ kind: 'text', text }] });

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'a2a-test-'));
  const { server, registry } = createServer({ port: 0, dataDir });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`test server: ${base} (data: ${dataDir})`);
  console.log(`registry: ${registry.snapshot.agent_count} agents, v${registry.snapshot.provenance.state_version}`);

  try {
    // 1. health
    {
      const r = await fetch(`${base}/health`); const j = await r.json();
      ok(r.status === 200 && j.status === 'ok', 'GET /health 200 + ok');
      ok(j.agents === 10, 'health reports 10 agents', JSON.stringify(j));
    }
    // 2. fleet card
    {
      const r = await fetch(`${base}/.well-known/agent-card.json`); const j = await r.json();
      ok(r.status === 200 && j.protocolVersion === '1.0.0', 'fleet card 200 + protocolVersion 1.0.0');
      ok(Array.isArray(j.supportedInterfaces) && j.supportedInterfaces.length === 10, 'fleet card has 10 tenant interfaces');
      ok(j.supportedInterfaces.some((i) => i.tenant === 'MUSE_CWI' && i.protocolBinding === 'JSONRPC'), 'MUSE_CWI tenant interface present');
      ok(j.securitySchemes && Array.isArray(j.securityRequirements), 'security fields present (open, no auth)');
    }
    // 3. message/send (v0.3 name), blocking default -> completed with receipt
    let taskId;
    {
      const j = await rpc(base, 'message/send', { message: msg('Hello KingCode, this is an A2A interop test.') });
      ok(!j.error, 'message/send returns no error', JSON.stringify(j.error));
      ok(j.result && j.result.id.startsWith('a2a_'), 'task id assigned', j.result?.id);
      ok(j.result.agent === 'MUSE_CWI', 'default agent is MUSE_CWI (chief)');
      ok(j.result.status.state === 'completed', 'blocking send completes intake', j.result.status?.state);
      ok(j.result.artifacts?.[0]?.name === 'queue-receipt.json', 'queue receipt artifact present');
      ok(j.result.artifacts[0].parts[0].kind === 'data', 'receipt is a data part');
      taskId = j.result.id;
    }
    // 4. inbox queue file written (the real recorded task queue)
    {
      const f = join(dataDir, 'inbox', 'MUSE_CWI.jsonl');
      ok(existsSync(f), 'inbox/MUSE_CWI.jsonl created');
      const lines = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      ok(lines.length === 1 && lines[0].task_id === taskId, 'inbox line carries task_id');
      ok(lines[0].text.includes('interop test'), 'inbox line carries message text');
      ok(typeof lines[0].message_sha256 === 'string' && lines[0].queue_position === 1, 'receipt has sha256 + queue position');
    }
    // 5. SendMessage (v1.0 name), non-blocking, addressed via metadata
    let nbId;
    {
      const j = await rpc(base, 'SendMessage', { message: msg('Data check please.'), metadata: { agent: 'CWI_Data' }, configuration: { blocking: false } });
      ok(!j.error && j.result.status.state === 'submitted', 'non-blocking SendMessage -> submitted', JSON.stringify(j.error || j.result.status));
      ok(j.result.agent === 'CWI_Data', 'metadata.agent routes to CWI_Data');
      nbId = j.result.id;
    }
    // 6. tasks/get + GetTask alias
    {
      const j = await rpc(base, 'tasks/get', { id: taskId, historyLength: 1 });
      ok(!j.error && j.result.status.state === 'completed', 'tasks/get returns completed task');
      ok(Array.isArray(j.result.history) && j.result.history.length === 1, 'historyLength honored');
      const j2 = await rpc(base, 'GetTask', { id: taskId });
      ok(!j2.error && j2.result.id === taskId, 'GetTask alias works');
    }
    // 7. cancel the non-blocking task before the worker runs
    {
      const j = await rpc(base, 'tasks/cancel', { id: nbId });
      ok(!j.error && j.result.status.state === 'canceled', 'tasks/cancel cancels submitted task', JSON.stringify(j.error || j.result.status));
      const j2 = await rpc(base, 'CancelTask', { id: nbId });
      ok(j2.error && j2.error.code === -32003, 'CancelTask on canceled task -> -32003', JSON.stringify(j2.error));
    }
    // 8. cancel on completed -> -32003
    {
      const j = await rpc(base, 'tasks/cancel', { id: taskId });
      ok(j.error && j.error.code === -32003, 'cancel on completed task -> TASK_NOT_CANCELABLE');
    }
    // 9. unknown task -> -32001
    {
      const j = await rpc(base, 'tasks/get', { id: 'a2a_nope' });
      ok(j.error && j.error.code === -32001, 'unknown task -> TASK_NOT_FOUND (-32001)');
    }
    // 10. unknown agent -> -32002
    {
      const j = await rpc(base, 'message/send', { message: msg('hi'), metadata: { agent: 'CWI_Nope' } });
      ok(j.error && j.error.code === -32002, 'unknown agent -> AGENT_NOT_FOUND (-32002)');
    }
    // 11. missing/empty text -> -32602
    {
      const j = await rpc(base, 'message/send', { message: { role: 'user', parts: [] } });
      ok(j.error && j.error.code === -32602, 'empty parts -> INVALID_PARAMS (-32602)');
    }
    // 12. unknown method -> -32601
    {
      const j = await rpc(base, 'nope/method', {});
      ok(j.error && j.error.code === -32601, 'unknown method -> METHOD_NOT_FOUND (-32601)');
    }
    // 13. malformed JSON -> -32700
    {
      const r = await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
      const j = await r.json();
      ok(j.error && j.error.code === -32700, 'malformed JSON -> PARSE_ERROR (-32700)');
    }
    // 14. tenant via query param + v0.3-style parts
    {
      const j = await rpc(base, 'message/send', { message: { role: 'user', parts: [{ type: 'text', text: 'Radio request via tenant.' }] } }, '?tenant=CWI_Radio');
      ok(!j.error && j.result.agent === 'CWI_Radio' && j.result.status.state === 'completed', 'query tenant + v0.3 parts route to CWI_Radio');
    }
    // 15. ListTasks
    {
      const j = await rpc(base, 'ListTasks', { limit: 10 });
      ok(!j.error && Array.isArray(j.result.tasks) && j.result.tasks.length >= 3, 'ListTasks returns tasks', `n=${j.result.tasks?.length}`);
    }
    // 16. requests.log is the measurement source
    {
      const f = join(dataDir, 'requests.log');
      ok(existsSync(f), 'data/requests.log exists');
      const n = readFileSync(f, 'utf8').trim().split('\n').length;
      ok(n >= 10, `requests.log has ${n} inbound entries (>=10)`);
    }
    // 17. rate limit trips (last: consumes remaining quota)
    {
      let tripped = false;
      for (let i = 0; i < 70 && !tripped; i++) {
        const j = await rpc(base, 'tasks/get', { id: 'a2a_nope' });
        if (j.error && j.error.code === -32000) tripped = true;
      }
      ok(tripped, 'rate limit (60/min/IP) trips with 429-class error');
    }
  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failures:', failures.join(', ')); process.exit(1); }
}

if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
export { main };
