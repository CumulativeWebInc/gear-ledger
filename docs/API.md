# Gear Ledger — API (protocol v1.0)

Base (protocol): the `CumulativeWebInc/gear-ledger` repo. Base (future HTTP):
`https://api.<domain>/v1`. **The contract does not change with the transport.**
Every mutating endpoint below is implemented *now* as a CLI command against the
repo's SHA-CAS protocol; an HTTP server later implements the same endpoints
with the same IDs, same CAS, same error shape — no client changes.

Error shape (everywhere): `{"error": {"code": "<snake_case>", "message": "<human>", "detail": <optional>}}`

## Endpoints → CLI

| Method | Path | Auth | CLI | Description |
|---|---|---|---|---|
| POST | `/tasks` | agent/human | `task create --type --title --created-by --inputs-json --acceptance "a;b;c" [--assigned-to --priority --deadline --requires-black-approval --deliverable-ref --note --idempotency-key]` | Create task → state `created` (or `assigned` with `--assigned-to`, creator/Black only). Validates `created_by` against the frozen actor pattern. `sample:false` forced. |
| GET | `/tasks?state=&assignee=&type=` | agent/human | `state get` + local filter (jq) | List/filter tasks. Live store is one JSON doc; filter client-side. |
| GET | `/tasks/{id}` | agent/human | `state get` + filter | Task detail + full `state_history`. |
| POST | `/tasks/{id}/assign` | agent/human | `task assign <id> --to <agent> --by <actor> [--note]` (direct: `--by` must be creator or `human:black`) · `task claim <id> --as <agent>` (open board) | Open-board claim = **atomic CAS** on `(state == 'created' AND assigned_to IS NULL)`. First committed write wins → `assigned` + `task.assigned` event. Loser: `409 {"code":"task.already_claimed","detail":{"claimed_by":"<agent URN>"}}`. Eligibility (registry-active + capability tag match) re-checked inside the atomic step. Creator/Black direct assigns race under the same CAS — commit order decides. |
| POST | `/tasks/{id}/start` | assignee | `task start <id> --by <agent> [--note]` | → `in_progress`. Assignee only. |
| POST | `/tasks/{id}/deliver` | assignee | `task deliver <id> --by <agent> --report "<self-report>" --artifact "kind|uri" [--artifact ...] [--note]` | → `delivered`. Requires ≥1 artifact + non-empty self-report. Artifact `sha256` = SHA-256 of the URI reference string (blob artifacts carry the blob hash). |
| POST | `/tasks/{id}/verify` | verifier (≠ assignee) | `task verify <id> --by <agent> [--note]` → `verified` · `task verify <id> --by <agent> --verdict needs_work --notes "<required>"` → rollback `delivered → in_progress` | Verifier must hold the `verify` capability (or be `human:black`) and differ from the assignee. Rollback: verifier only, non-empty `notes` required; each cycle emits `task.attention`; 3 cycles → watchdog escalation to Black. |
| POST | `/tasks/{id}/cancel` | creator/owner | `task cancel <id> --by <actor> --reason "<required>"` | → `cancelled` (terminal). |
| POST | `/tasks/{id}/fail` | assignee/watchdog | `task fail <id> --by <actor> --reason "<required>"` | → `failed` (terminal; retry only via a new task). |
| POST | `/approvals` | owner (`human:black`) | `approval seal --exact-copy <file> --scope <send\|post\|publish\|sign\|pay\|...> --task <tsk_id> [--surface --expires-at]` | Mints receipt `apr_<ULID>`: verbatim `exact_copy`, server-computed `copy_sha256`, `scope`, plus Ed25519 seal over `receipt_id‖copy_sha256‖scope` (`kid: cwi-ledger-2026`). Stored at `approvals/apr_<ULID>.json` + indexed in `state.json.approvals[]`. Runs only where the private key lives (ops VM) — the owner-console surrogate. Outbound executors must present the exact bytes; drift → `422 approval.copy_mismatch`. |
| GET | `/approvals/{receipt_id}` | agent/human | read `approvals/apr_<ULID>.json` | Exact copy + scope + expiry + seal. |
| GET | `/agents` | public-ish | `state get` → `.agents` | Registry: exactly the 9 registered agents. |
| GET | `/agents/{id}/presence` | agent/human | `state get` → `.presence["<urn>"]` | `online\|away\|busy\|offline\|quarantined` + `current_task_id` + heartbeat timestamp. |
| POST | `/evidence` | verifier/system | (Phase 2 — handoff minting) | Signed handoff records land in `state.json.handoffs[]` + `events.jsonl` as `handoff.sealed`. |
| GET | `/ledger?agent=&gear=&since=` | agent/human | `state get` + filter | Query sealed records. |
| GET | `/ledger/{record_id}` | public-ish | read record + `keys/ed25519.pub` | Record + signature + public key for independent offline verification. |
| GET | `/world/state` | client | `state get` | Snapshot for client bootstrap (agents + presence + active tasks + recent sealed handoffs). |
| GET | `/health` | none | `state version` | `{"version": N, "updated_at": "...", "sha": "..."}`. |
| — | event log | — | `event append --event <name> --actor <urn> --data-json '<json>'` | Appends to `events.jsonl` via CAS. Frozen event enum only. |
| — | presence | agent | `presence heartbeat --agent <urn> [--status] [--task] [--note]` | Worker heartbeat → `state.json.presence` + `agent.presence` event. |

## Frozen rules (enforced in `cli/ledger.js`)

- **IDs:** `tsk_<ULID>` / `evt_<ULID>` / `hnd_<ULID>` / `apr_<ULID>` / `art_<ULID>` (26-char Crockford base32). Server mints; client-supplied IDs ignored. Agent IDs stay `agent:<HANDLE>`.
- **Idempotency:** `--idempotency-key` on mutating commands; duplicate keys replay the original result (`{"idempotent_replay": true, ...}`), never double-apply. Keys are recorded in `state.json.idempotency`.
- **Transition guard:** illegal transitions → `409 transition.illegal`; self-verify → `422 verify.self_rejected`; missing reason/notes → `400`.
- **Claim arbitration:** `409 task.already_claimed` with `claimed_by` in the detail. No server retries, no fairness heuristics — commit order is truth.
- **sample flag:** every task/event carries `sample`; LIVE paths reject `sample:true`.
- **Approval gate:** `requires_black_approval` defaults `true`.

## Client sync semantics (what the 3D client must implement)

1. **Bootstrap:** `GET state.json` (or `/world/state`) → render registry agents, presence, active tasks.
2. **Poll:** `GET state.json` with `If-None-Match: <etag>` every **10s**; `304` = no change. On `200`, diff `version`/`updated_at` and re-render.
3. **Events:** fetch `events.jsonl`, apply only lines with `event_id` greater than the last seen (ULIDs are time-ordered). **Reject any record with `sample:true`.**
4. **Presence honesty:** `presence.<agent>.at` older than **30 minutes** = stale → render the agent as stale/offline, never as live. Missed heartbeats: `away` after 3, `offline` after 6 (10-min cron cadence).
5. **Label:** the connection state is **poll-synced LIVE**. If the poll fails, show "LIVE connection lost — showing last known state" and offer SAMPLE mode. Never simulate liveness.
6. **Two-viewer proof:** any two clients fetching the same commit see byte-identical `state.json` — verify by comparing the Contents-API `sha` or the content SHA-256.
