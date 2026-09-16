# Gear Ledger — server-authoritative task/event ledger for the CWI agent company

**Live store:** [`state.json`](https://raw.githubusercontent.com/CumulativeWebInc/gear-ledger/main/state.json) · [`events.jsonl`](https://raw.githubusercontent.com/CumulativeWebInc/gear-ledger/main/events.jsonl) · [API docs](docs/API.md)

This repo **is** the server. The canonical store is versioned JSON committed
here; every write is an atomic compare-and-swap through the GitHub Contents
API (read sha → transform → PUT with sha). A concurrent writer's commit lands
first → the loser's PUT gets a true 409, the CLI re-reads and retries (×3),
then surfaces the 409 naming the winner. Commit order is truth. The git
history is the audit log.

## Layout

| Path | What |
|---|---|
| `state.json` | Canonical store: `{contract, schema_version, version, updated_at, agents[9], tasks[], presence{}, handoffs[], approvals[], idempotency{}}`. `version` increments on every mutation. |
| `events.jsonl` | Append-only event log (frozen event enum, §2.2 of the architecture doc). |
| `approvals/` | Black's approval receipts (`apr_<ULID>.json`) — exact copy + SHA-256 + Ed25519 seal. Minted only on his explicit exact-copy approval. Empty until one exists. |
| `keys/ed25519.pub` | Ledger public key (`kid: cwi-ledger-2026`). The private key lives only on the ops VM (`~/.config/gear-ledger/ed25519.key`, 0600) — never in this repo. |
| `cli/ledger.js` | Protocol + CLI implementation (Node, zero deps). Every mutation command does the CAS write and appends the matching event. |
| `docs/API.md` | REST contract → CLI mapping (protocol first, HTTP server later, no client changes). |
| `index.html` | Human landing page for GitHub Pages. |

## Truth rules (hard)

- `sample:false` is mandatory on every live record. The CLI rejects `sample:true`.
- Only the 9 registered agents exist (`state.json → agents`). No invented agents, no invented tasks, no invented metrics.
- `verified` is terminal truth only via an independent verifier (never the assignee).
- Nothing is sent, posted, published, signed, or paid from a ledger record without Black's exact-copy approval receipt. The ledger records what happened; it never triggers outbound action.

## Sync semantics (honest)

- **Server-authoritative:** the repo is the single source of truth. Two independent fetches provably see identical state (compare the `sha` from the Contents API or the content SHA-256 of `state.json`).
- **Poll-synced LIVE, not push:** there is no WebSocket yet. Clients poll `state.json` with `ETag` / `If-None-Match` every ~10s and apply `events.jsonl` deltas. Presence heartbeats are written by the real CWI ops cron (`gear-ledger-heartbeat`, every 10 min); presence older than 30 min is stale and must render as such. Label it **poll-synced LIVE** — never fake push, never fake sub-second realtime.

## Quick start

```bash
# read the live store
node cli/ledger.js state get | jq '.tasks | length'
node cli/ledger.js state version

# create a task (state: created)
node cli/ledger.js task create --type data.scan --title "Rescan WATCH THA GAP VOL.5" \
  --created-by agent:CWI_Data \
  --inputs-json '{"source":"spotify","scope":"spotify:playlist:WATCH_THAGAP_V5","metric_names":["track_presence"]}' \
  --acceptance "add confirmed or unconfirmed;scan completed"

# open-board claim (first-write-wins; loser gets 409 task.already_claimed + winner)
node cli/ledger.js task claim tsk_XXX --as agent:CWI_Data

# lifecycle
node cli/ledger.js task start   tsk_XXX --by agent:CWI_Data
node cli/ledger.js task deliver tsk_XXX --by agent:CWI_Data --report "scan done" \
  --artifact "scan|workspace://scan.json"
node cli/ledger.js task verify  tsk_XXX --by agent:CWI_Affairs --note "numbers match sources"
# rollback: node cli/ledger.js task verify tsk_XXX --by agent:CWI_Affairs --verdict needs_work --notes "..."

# presence heartbeat (what the cron runs)
node cli/ledger.js presence heartbeat --agent agent:CWI_Data --status online --task tsk_XXX
```

$0. No secrets in this repo (public key only). Apache-2.0-style CWI internal use.
