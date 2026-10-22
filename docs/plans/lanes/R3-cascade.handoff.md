# R3 cascade and delegation brief foundation

**Status:** implemented opt-in internal foundation; independent review and broader gates pending.
**Branch:** `codex/r3-cascade` · **Base:** reviewed `cd00a82` + reviewed main `6da2058`
**Updated:** 2026-10-22 · **Environment:** local Mac, Node26, ports 5211/4411, `.lane-data`

## Implemented contract

Feature absence preserves relay execution and creates no new R3 ledger. Optional T0
`RelayInput.cascade` is constructor argument nine, after existing judgeSignals. An immutable
version-one delegation brief binds exact plan/caps/hash to the run and each admitted attempt
before cycle work; replay is idempotent and changed admission conflicts. The brief records
constraints/resources/estimates/model roles/checker/judge/wake/report policy; it is no independent
host authority. Role-selection utility implements session > project > explicit policy, hard
local/consent filtering and refusal of automatic selection without fresh validated calibration.
No real calibration/history discovery or default policy activation is supplied.

Independent additive ledger38 shares R1/K2 SQLite, leaving main user_version and prior ledgers
unchanged. Fenced request identity includes run/attempt/epoch/token/cycle/phase/layer/reason/
brief hash; evidence changes conflict. Prepare/dispatch/outcome and their K2 trace are atomic.
Duplicates share a pending or recorded result and never dispatch twice. Lost-attempt pending
work becomes abandoned; no automatic replay or refund of unknown/failed reservations.

At actual cycle_start/pre_seal boundaries, the host may provide a lead checker pinned by
base/path/content digest and verified bytes. The T0 supervisor owns read-only execution,
timeout/output policy and actual cleanup acknowledgment; no production script supervisor is
included. J2 runs two/three fresh tool-free samples over scrubbed harness evidence and quoted
untrusted executor claims, with strict taxonomy/verdict/existing-evidence refs/diagnosis schema.
Disagreement is uncalibrated; invalid/unavailable output cannot mark an item done. J3 requests
only flagged/probe/final reviews and predebits call/token/money bounds, counting in relay caps.
Default account/local-night maximum is three across runs, with explicit recorded overrides;
persistent account timezone/night-start binding prevents namespace substitution. Three distinct
unavailable cycles request one existing R1 parent escalation; phases/samples do not multiply it.
A valid J2 resets the streak. No judge overrides failing gates or existing hard/probe guards.

Pure observation/admission waits abort-race with late outcomes consumed. Active resourceful
checker/model promises remain owned until actual adapter settlement. Every asynchronous boundary
checks R1 home/attempt/cycle before publication. Judge references enter safe ledger snapshots;
sealed hashes remain authoritative. Requested defer-until-08 wake intent is recorded, while R1
completion semantics remain immediate and durable night scheduling is explicitly unfinished.

`ConnectionJudgeModel` calls public K3 with the real T0 account, an exact rendered token meter,
fresh installed-local digest/consent observation and no cloud/API fallback. Local_runtime kind
alone is insufficient. It requests one tool-free user message per sample with adapter-supplied
window/output limits, final scrub/count/fence checks and no reasoning field. The existing
K3 after-version preparation/POST-settlement gaps are activation dependencies below.

## New / regression evidence

**New: 24 tests** in `relay/judge-cascade.test.ts` (21) and `relay/judge-model.test.ts` (3).
The new fixtures assert immutable/replay/plan/caps/fence bindings, actual executor boundaries and
seal references, two/three samples, strict invalid schema/evidence, disagreement, exact duplicate
calls/debits, pinned-checker zero execution on mismatch, real-supervisor-contract settlement,
observation cancellation, stale cycle/home, wall expiry, three distinct unavailable cycles/reset/
parent wake deduplication, cross-run/night budget/override/rollover, crash non-replay and atomic
K2 refusal rollback. K3 construction/account/scrub/placement/queued-fence checks use fake local
transport and generated private temporary data only. Selector calibration fixtures are invented
protocol facts, not real labelled evidence.

Current author checks:21/21 pure fixtures, server tsc passed. Three positive K3 fixtures passed
in an earlier four-case envelope; the fourth actual POST-abort fixture exposed the separate
client dependency and is retained outside the checkout. Clean pinned combined check and exact
regression count will be appended after commit. Root owns independent GPT review and broader
integration/browser/build gates. No claim of a completed R3, B3 or MS1.

## Required activation dependencies and remaining work

- Existing K3/Ollama client abort-races an active model POST before injected fetch settlement,
  releasing its governor permit early. Exact external fixture
  `Guanxi-lanes/reviews/r3-k3-post-settlement-probe-20261022.ts` observes GET1/POST1,
  postAborted=true/fetchSettled=false/callSettled=true/governorHeld=false. Separately owned
  client fix must retain local POST/body ownership until settlement, while preserving version/
  pure GET observation liveness. Fetch settlement cannot prove backend inference stopped.
- R2's separately owned chat prepare/authorize seam must keep final scrub/onPrepared after
  version preflight and directly before actual POST, with zero stale dispatch. The judge uses
  that public K3 seam; this lane does not edit Connections, client.ts or relay/model.ts.
- No concrete production checker sandbox supervisor or installed-model observation collector,
  real model inference, paid call, SSH/remote host, owner data or live activation was run.
- No toolful F2 workspace/meter/bundle-seal transport, full client delegation workflow, automatic
  model-tier switching, real prices/usage integration or durable deferred wake scheduler.
- Real ADR0025 paired bench, monthly20–30 labelled judge calibration, precision>=0.8/recall>=0.9,
  >=20-run ETA P80 coverage0.7–0.9, B3 non-inferiority and the>=6-hour MS1 envelope stay unearned.

## Compatibility, rollback and shared edits

Ledger38 is new and additive; feature off leaves old runs/ledgers untouched. Rollback disables
new admission and retains evidence/debits; no down migration or automatic restart inference.
No migration33/35/37 rewrite or public REST/SSE schema change. No dependencies or copied third-
party code were introduced. Own modules: delegation-brief, judge-await, judge-store, judge-cascade,
judge-model. Minimal shared edits: executor optional ninth argument and safe-boundary calls,
Ledger optional judge reference/intent, plugin T0 input/type/forwarding. R2 owns its public start,
relay/model.ts and Connections; root resolves its plugin construction seam on integration.

## Review and next slice

Independent review pending. Findings must be fixed in separate commits. Next: merge the separately
reviewed K3 client/R2 preparation fixes, run the actual active-POST ownership/fence fixtures, then
independently review this pinned opt-in foundation. Live policy remains gated by ADR0025 evidence.
