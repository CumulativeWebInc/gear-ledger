# Approval receipts

This directory holds Black's approval receipts: `apr_<ULID>.json` files minted
**only** by `human:black`'s explicit exact-copy approval
(`cli/ledger.js approval seal`).

Each receipt stores the **verbatim** exact copy he approved, its `copy_sha256`
(content address), the covered `task_id`, `scope` (send | post | publish |
sign | pay | equip-external | register-agent), `surface` (audit context), and
his Ed25519 seal over `receipt_id ‖ copy_sha256 ‖ scope` (`kid: cwi-ledger-2026`).

Outbound executors must cite `approval_receipt_id` and present the exact bytes
they are about to send. The server compares SHA-256 of those bytes against the
receipt's `copy_sha256`. Any drift — trim, reword, added emoji — is a different
copy: `422 approval.copy_mismatch`, and a new receipt is required.

Receipts are append-only and immutable. Currently **zero** receipts exist —
nothing has been approved through this ledger yet, and no receipt will be
minted until Black approves exact copy. This directory is empty by rule, not by
accident.
