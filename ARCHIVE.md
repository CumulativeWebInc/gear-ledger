# Gear Ledger archive & retention policy

`state.json` is a **windowed live store**, not an ever-growing log. History
lives in `state-archive/` (tasks) and `events-archive/` (event shards).
This keeps every hot file far under GitHub's 1MB Contents-API ceiling and
shrinks the CAS race window for the 10-minute heartbeat.

## Retention rule

| Data | Rule |
|---|---|
| `verified` / `cancelled` / `failed` tasks | Archived on the first sweep after reaching terminal state (no outgoing transitions exist) |
| `delivered` tasks | Archived 24h after last state change (verification/rollback window) |
| `created` / `assigned` / `in_progress` tasks | **Never** archived |
| Idempotency keys | Archived after 7 days (replay window) |
| `events/YYYY-MM-DD.jsonl` shards | Moved to `events-archive/YYYY-MM/` after 90 days (**moved, never deleted**) |

The 24h delivered window is measured, not guessed: delivered throughput is
~115 tasks/day, so a 72h window would leave ~914KB live; 24h keeps the live
task window under ~200 tasks (~450KB worst case, typically <300KB).

## Layout

- `state-archive/tasks-YYYY-MM.json` — `{archive:'tasks', month, tasks:{task_id: task}, idempotency:{key: entry}, updated_at}`
- `state-archive/index.json` — `{index:'tasks', tasks:{task_id: {path, archived_at, sha256}}, updated_at}` — every archived task is findable here
- `events/2026-09-25.jsonl` — one append-only shard per UTC day (today's is the only hot file)
- `events.jsonl` — legacy monolith, kept as history, never rewritten
- `events-archive/YYYY-MM/YYYY-MM-DD.jsonl` — cold shards

## Safety

Compaction (`ledger.js state compact`) is crash-safe and online-safe:

1. **Phase 1** — CAS-merge eligible tasks into the monthly archive + index (idempotent: ids already archived are skipped).
2. **Phase 2** — read-back verify: every batched id must be present in the archive with a matching sha256.
3. **Phase 3** — CAS-remove from `state.json` **only** ids that verified.

A crash at any point → the next sweep completes the work. Removal never
precedes a verified archive, so there is no data-loss path. No locks are
held; the 10-minute heartbeat and task writers proceed concurrently via the
usual SHA compare-and-swap.

## Proven live (2026-09-25)

- First sweep: 346 tasks + 23 idempotency entries archived to
  `state-archive/tasks-2026-09.json` + `index.json` (read-back verified).
- `state.json` on GitHub: **1,052,990 → 366,084 bytes** (−65%); the Contents
  API serves it directly again (`encoding: base64`, no blob fallback needed).
- Live store after sweep: 151 tasks (106 delivered <24h, 23 in_progress,
  22 assigned), 410 idempotency keys, 22 presence records.
- Heartbeat: `presence heartbeat-batch` pulses all 22 agents in **one**
  compare-and-swap (version +1 per run, not +22); presence events are
  emitted only when a status or pointer actually changes.

## Restore

- `ledger.js task restore <task_id>` — rehydrate one archived task into live state.
- Transitions targeting an archived task **auto-rehydrate** inside the same
  CAS — verifiers and the watchdog never observe archival. (A verify or
  rollback arriving after the 24h window just works, with two extra reads.)

## Operations

- Daily sweep: `state compact` runs once a day (quiet hour) — see the
  `gear-ledger-compact` cron. It also prunes >90d event shards.
- Integrity: every index entry carries sha256 of the canonical archived
  task JSON; restore and rehydrate verify it before use.
