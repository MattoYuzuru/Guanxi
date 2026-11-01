# K4 queue v3 Q2 — native producer activation

**Status:** autonomous implementation plan under the owner's 2026-11-01 continuation request.
**Base:** `1be1b6de` (merged wave 8, PR #4). Root owns implementation/integration; separate native
agents audit documentation, adapt inherited tests in isolated worktrees, and review the result.
The D-220 allocation belonged to the earlier wave 7 session; this session uses the available
native agents with the owner's explicit authorization. Only this Mac is available for local checks.

## Outcome and boundaries

Complete Q2 of the [accepted queue contract](K4-queue-v3.plan.md): every new native add/remove
snapshot uses v3, including small/empty queues. Large scrubbed UTF-8 text becomes a session
artifact; retained legacy-large input is normalized, historical events stay immutable, and
retained artifacts use descriptors without hydration. Preserve FIFO order, side-chat operation
IDs, full-byte verified consumption, immediate stop and exactly one writer. No dependency,
database migration, HTTP request shape, provider policy, tool set or prompt change is needed.

Captured attempt/home/session/abort checks surround asynchronous storage and the final atomic
append. An admitted FIFO operation is not refused merely because the turn later seals admission.
Read/projection errors are returned to their caller without aborting the running turn; failed
storage/appends still use the existing single failure terminal. Blobs from failed appends remain
orphans under existing retention, never deleted individually.

## Verification and compatibility

New producer tests use real local artifact storage and a synthetic provider: byte thresholds and
Unicode, distinct IDs/digest deduplication, held-write FIFO, legacy normalization, removal without
blob reads, stop/leave/fence/helper failures, post-write ownership, restart without inference and
known/late secret scrubbing. Inherited Q1 tests retain seeded-v1 reader coverage while replacing
the obsolete producer restrictions with Q2 assertions. Run native queue/input/side-chat/lifecycle
tests, log artifact/version/privacy tests, CLI polling, server types, affected lint and docs checks.
An independent read-only agent reviews the integrated diff; fixes get a separate commit. Finish
with the repository's full hosted PR gate and `npm run ci:finish -- <PR> --wait`.

The rollback floor is Q0+Q1's restricted reader. A max-2 reader stops at the first new v3 event;
rollback before Q0 needs a stopped consistent database/WAL and artifact backup with loss of new
writes. An old POST can return 202 while legacy progress returns typed 406 for pending artifacts;
progress2/result/stop remain usable. No automatic request replay or inference on restart is added.

The existing late-redaction inline-overflow refusal, whole-buffer replay, idle/preparation
mutation admission and missing-attempt-allocation observation remain explicit residuals. No
Fedora, live-model, paid-provider, owner signature or distributed desktop release claim follows
from these checks. Local `agent-dev` receipts currently report a directory symlink as unsupported
for source reuse; report actual check results and rely on hosted CI for the exact final candidate.
