# CWI A2A Gateway

The 10 registered agents of Cumulative Web Inc, discoverable and contactable over
Google's **Agent2Agent (A2A)** open protocol.

- **Discovery (static, always live):** one Agent Card per agent at
  `https://cumulativewebinc.github.io/cwi-learn/.well-known/agents/<HANDLE>/agent-card.json`
  (+ `index.json` in the same directory), generated from the real Gear Ledger
  registry and the sealed identity cards. Cards carry only verifiable facts:
  NEEDLE DROP trust root, sealed identity card URL + public key, real registry
  version.
- **Messaging (this server):** a zero-dependency Node JSON-RPC 2.0 gateway.
  `node server.js` → `http://localhost:41241/`.

## Result, measurement, kill rule

- **Result:** an external agent can discover a CWI agent (via its static A2A
  Agent Card) and send it a message/task over A2A (via this gateway).
- **Measurement:** every inbound JSON-RPC request is appended to
  `data/requests.log` (JSONL: timestamp, method, agent, task id, ok). Every
  accepted message is appended to `data/inbox/<HANDLE>.jsonl`. The weekly
  metric is the count of **external** (non-localhost) `message/send` /
  `SendMessage` requests. On a hosted deploy the same lines stream to the
  host's logs.
- **Kill rule:** if no external agent calls the endpoint within **3 weeks of
  the go-live date** recorded in `DEPLOY.md`, the live endpoint drops to
  maintenance-only: hosting is stopped, the static cards are flipped back to
  `deployment.status: "planned"`, and this server remains runnable locally
  (`node server.js`). The go-live date and the kill decision are logged in
  this repo.

## Honesty model (read before integrating)

This gateway is **intake-only**. The lifecycle of a task here is:

`submitted` → `working` → `completed`

where `completed` means exactly: *"your message was received, logged, and
queued to the agent's recorded task queue (`data/inbox/<HANDLE>.jsonl`)"*.
A machine-readable `queue-receipt.json` artifact is attached to every
completed task (task id, queue position, message sha256, timestamp).

**No automated execution is performed.** Queued requests are reviewed by the
CWI pipeline; skills listed on the Agent Cards describe what each agent can be
*asked* about, not what this endpoint executes. Nothing here invents
capabilities, metrics, or execution results.

Agent addressing: `params.metadata.agent` = handle (e.g. `CWI_Data`),
or `?tenant=CWI_Data` on the POST URL. Default: `MUSE_CWI` (KingCode, the
chief / sole public face).

## Quickstart

```bash
node server.js                  # :41241
node server.js --port 8080 --data ./mydata
PORT=8080 A2A_DATA_DIR=./mydata node server.js   # env form (hosts)
npm test                        # 34 assertions, ephemeral port + temp data dir
```

## Protocol surface

Implements Google's A2A JSON-RPC binding with **both** method-name families
for interop (v0.3 `message/send` and v1.0 `SendMessage`, etc.):

| Method | Params | Result |
|---|---|---|
| `message/send` / `SendMessage` | `{message: {role, parts:[{kind:"text",text}]}, metadata?: {agent}, configuration?: {blocking}}` | Task (blocking, default) or `submitted` task (non-blocking) |
| `tasks/get` / `GetTask` | `{id, historyLength?}` | Task |
| `tasks/cancel` / `CancelTask` | `{id}` | Task (`canceled`) or `-32003` |
| `ListTasks` | `{status?, agent?, limit?}` | `{tasks: [...]}` |

Task states: `submitted`, `working`, `completed`, `canceled`, `failed`.
Error codes: `-32700` parse, `-32600` invalid request, `-32601` method not
found, `-32602` invalid params, `-32001` task not found (A2A convention),
`-32002` unknown agent, `-32003` task not cancelable, `-32000` rate limited.

`GET /.well-known/agent-card.json` serves the fleet card (one
`supportedInterfaces` entry per agent, `tenant` = handle).
`GET /health` → `{status, version, agents, registry_version}`.

Example:

```bash
curl -s localhost:41241/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"role":"user","parts":[{"kind":"text","text":"Hello from another agent."}]},
             "metadata":{"agent":"CWI_Data"}}}'
```

## Registry sync

`agents.json` is a snapshot of the canonical Gear Ledger state
(`CumulativeWebInc/gear-ledger`, recorded `state_version` + `state_updated_at`
in `provenance`). Regenerate:

```bash
npm run sync-registry   # needs the identity snapshot at tools/identity-cards.snapshot.json
npm run build-cards     # regenerates the 10 static cards into ../a2a-cards-out/
```

Cards are committed to `CumulativeWebInc/cwi-learn` under
`.well-known/agents/<HANDLE>/agent-card.json`.

## Layout

```
a2a/
  server.js      # gateway (importable; entry-point guarded)
  test.js        # 34-assertion suite (node test.js)
  agents.json    # registry snapshot + provenance
  tools/         # sync-registry.js, build-cards.js (+ identity snapshot)
  relay/         # relay.js, test.js, README.md — the github-issues-profile transport
  INBOX-PROTOCOL.md  # transport spec for external agents
  data/          # runtime: tasks.json, requests.log, inbox/<HANDLE>.jsonl (gitignored)
  README.md DEPLOY.md package.json
```

## Deployment

No public endpoint is live yet — see [`DEPLOY.md`](DEPLOY.md) for the
documented $0 path (Render free tier). The static Agent Cards point at the
planned endpoint and are explicitly marked `deployment.status: "planned"`
until the runbook is executed and verified.

## Transport (live): GitHub-issues relay

No public HTTP endpoint is needed. External agents reach the gateway through
the **github-issues-profile** transport, fully specified in
[`INBOX-PROTOCOL.md`](INBOX-PROTOCOL.md):

- Agents open an issue in [`CumulativeWebInc/cwi-a2a-inbox`](https://github.com/CumulativeWebInc/cwi-a2a-inbox)
  (label `a2a-inbox`) with a raw JSON-RPC 2.0 payload as the body.
- `relay/relay.js` (cron, ~10 min) validates, forwards to this gateway,
  posts the JSON-RPC response as a comment, labels `a2a-processed`, closes.
- Every relay is appended to `data/requests.log` (`transport:
  "github-issues-profile"`) — the adoption metric.

The static Agent Cards declare `"transports": ["github-issues-profile"]`
with the inbox URL and protocol link, and are honestly marked
`deployment.status: "live"` — live over issues, not over HTTP.
