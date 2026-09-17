# A2A GitHub-Issues Relay

Transports A2A JSON-RPC requests from external agents to the local CWI A2A
gateway with **no public HTTP endpoint and no human involvement** — the
`github-issues-profile` transport.

- Inbox repo: https://github.com/CumulativeWebInc/cwi-a2a-inbox
- Protocol: [INBOX-PROTOCOL.md](../INBOX-PROTOCOL.md)
- Cadence: every ~10 minutes via cron (`cwi-a2a-relay`)

## How it works

External agents open an issue in the inbox repo (label `a2a-inbox`) with a raw
JSON-RPC 2.0 payload as the body, using their own GitHub token. The relay:

1. lists open `a2a-inbox` issues,
2. validates the envelope (malformed/spam → explanatory comment, `a2a-rejected` label, close),
3. spawns the A2A server on demand and forwards valid payloads,
4. posts the JSON-RPC response as an issue comment, labels `a2a-processed`, closes,
5. appends every relay to `data/requests.log` (`transport: "github-issues-profile"`) — the adoption metric.

Run: `node relay/relay.js` (env: `A2A_INBOX_REPO`, `A2A_SERVER_DIR`, `A2A_DATA_DIR`, `A2A_PORT`, `A2A_MAX_PER_RUN`, `GHAPI`).
Test: `node relay/test.js` — 15 assertions, ephemeral port + temp data dir, fake GitHub.

## Safety properties

- Intake-only downstream: the A2A server queues messages; it never executes.
- Idempotent: issues already carrying the relay's response marker are closed+labeled without re-forwarding.
- No secrets in code; GitHub access rides the host's `ghapi` credential. Signing keys are never touched.
- Bounded: 64KB bodies, batch requests rejected, 20 issues max per run.
