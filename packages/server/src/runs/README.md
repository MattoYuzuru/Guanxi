# Durable runs (R1)

**Status:** implemented, single node · **Updated:** 2026-10-21

`guanxi.durable-runs` provides `runs.durable` on the own kernel. It depends on K2's
`session.log` and `egress.scrubber`. The service exposes `store` and `health()`; unload closes
the store, stops the scheduler and releases its home lease. A stale service cannot write.
Construction does not claim the home: the pump retries `heartbeat` while health reports
`writer_busy`, so an unclean predecessor never prevents the rest of the server from serving.
`store.failures()` exposes per-run operation/error codes; one refused session trace does not
block another run's timers, recovery or delivery. Health reports `run_failure` while these
records remain.

## Boundary

This is the durable orchestration substrate for K4/R2, not a model executor. No model, shell,
worktree creation or network call is performed here. An executor calls `start`, consumes a
pending wake with `deliver` (an explicit claim) or `dispatch(claim)`, then calls `modelStarted` **after observing the first
model call start**. Preparation is not acknowledgment. A crashed, unacknowledged delivery gets
a new fenced attempt after another executor claim; an acknowledged wake is never delivered
again. `dispatch()` without a claim callback allocates nothing: an unavailable executor does
not create attempts, consume leases, change the lead to `working` or churn trace events. Model execution itself
is not exactly once. External effects still need the ADR-0018 target-side fences/idempotency
keys at their executor boundary.

Startup recovery snapshots inherited attempts when the home is claimed, before admitting
work. Public `reconcile()` can only lose those inherited attempts; a force-all variant is
private and accessed solely by the crash-simulation test adapter. If vault readiness
is delayed, reconciliation cannot mark newly admitted attempts as lost when readiness opens.
Until reconciliation loses an inherited attempt, `deliver` withholds it and mutations using
its credentials fail with `stale_lease`. The next executor claim can then obtain a fresh
attempt; acknowledging it cannot be undone by a later startup reconciliation pass.

The default server boots this plugin but does **not** assert `alwaysOn`. Delegation fails with
`no_always_on_home` until the host explicitly supplies `runs.alwaysOn: true`. No power assertion
or handover is invented for a laptop. Those integrations belong to F1/ADR-0038.

Migrations 30–31 extend the legacy Job store's persisted-first, transactional patterns in the
same node SQLite database. Its `durable_runs` table keeps the new state machine separate from
legacy Job CHECKs and chat recovery. Legacy Jobs/routes keep their existing wire contract;
R1's internal plugin API is not a new REST endpoint. The additive `run.lifecycle` session event
has a contract schema and renders in the existing inspector timeline (English/Russian).

## Transactions and ownership

- One `BEGIN IMMEDIATE` commits every state transition with its K2 event(s); notifications
  happen only after commit. A refused trace/readiness gate rolls the state change back.
- The execution home has a durable owner lease. Each mutation verifies its owner id/token
  and unreleased state. The same holder/token may renew after a stall because no successor
  has acquired the row. A released or replaced holder is fenced. Home renewal happens at
  `ownerTtl/3`; idle pump passes do no writes or write transactions between renewals. Tick
  reads for due attempts/timers before taking a separate transaction for each item.
  An unclean takeover waits for the predecessor's persisted `regrant_after` (owner expiry +
  maximum attempt TTL + 1000ms), with an active-execution expiry floor. On first observation
  the successor caps this wait at its own `now + ownerTtl + recoveryMaxTtl + 1000ms`, so a
  predecessor clock ahead of the corrected clock cannot block recovery indefinitely. An
  observed renewed bound or changed active-execution expiry restarts this cap.
  `recoveryMaxTtl` preserves the larger of the predecessor's persisted relative maximum and
  the successor's new-grant limit; reducing the latter cannot shorten an inherited attempt's grace. An unclean predecessor also
  requires at least `recoveryMaxTtl + 1000ms` of successor-local monotonic time after first
  observation, so a forward wall correction cannot count as elapsed grace. A live predecessor
  is never stolen from merely because an old observation aged. Defaults are 30 s owner TTL
  and 60 s execution TTL: recovery waits at most 91 s after the last observed bound change. The pump keeps serving
  with `writer_busy` meanwhile. A clean close releases the home. A plain restart does not
  bump the epoch; backup restore/cloning and epoch handover belong to F1.
- Each run has one `run:<id>/exec` lease. Tokens increase on each grant. Expired, released,
  mismatched and superseded attempts fail with `409 stale_lease`. Timeouts stop execution;
  `tick` marks expired local attempts lost before another attempt can be admitted. There is
  no automatic replay of an interrupted mutating step.
- Deadlines, retention and observations use wall time with a process high-water mark, so
  suspend is included even on Linux. Leases use monotonic elapsed time anchored to a wall
  reference. Deterministic tests can inject both clocks. The home owns deadline decisions.
- `delegate` atomically creates the child, promise and timer, releases the lead attempt and
  enters `waiting_children`. Retrying a delegation key returns its original child and rejects
  a changed brief. No per-run executor or model lease remains while waiting.
- A child's terminal transition and its deadline race in SQLite: first commit resolves the
  promise once and creates one outbox wake. A fenced escalation/quota signal wakes the lead
  without resolution. The outbox deduplicates by source. Wake sequence and delivery attempt
  are separate; later wakes wait while a handler is active. The pump leaves pending wakes durable until an executor claims them; that executor owns
  model calls and acknowledgment. A handler can
  yield for queued wakes even after its last promise resolves; normal completion refuses to
  discard an unacknowledged wake. Explicit cancellation may suppress pending wakes.
- Default deadline policy requests `wrapping_up`; a report-only attempt finishes as `canceled`.
  It does not automatically replay the child's work. `detach` leaves the child running and
  prevents its later completion from waking the parent. Cancellation follows each edge's
  cancel/detach policy in one transaction, including grandchildren, and suppresses pending
  wakes of terminal runs. Repeated cancel changes no terminal row and adds no cancel event.

## Restart table (local only)

| Stored state | Reconciliation |
| --- | --- |
| `submitted` | Remains submitted; executor admission is explicit |
| `waiting_children`, `input_required` | Remain unchanged |
| `working` with local delivered/started attempt | Attempt lost, execution lease released, run interrupted |
| Unacknowledged wake | Original attempt lost; the next executor claim creates a fresh attempt under a higher token |
| Acknowledged wake | Never redelivered; interrupted work needs an explicit retry |
| `wrapping_up` | Remains a durable report request; `start` resumes a report-only attempt |
| Terminal | Unchanged |

An `interrupted` lead with an unacknowledged wake may resume on the next explicit executor
claim without a separate run retry. This retries the wake handler under a fresh fence; an
acknowledged wake never resumes implicitly (L6).

Remote attempts/grace, federation, power assertions, full wake-packet/handoff artifacts,
external lead protocols and fallback connections are later integrations, not implemented R1
claims. R1 stores outcome/reference metadata only and never loads a full trace into a lead.

## Resources and costs

`retain` records a run-owned worktree/scratch lease independently of the attempt lease.
`reapResources` releases only terminal-run resources whose `retain_until` has passed. A
nonterminal run always protects its retained resources, even beyond that timestamp and across
restart. It returns opaque resource keys; the resource owner performs filesystem cleanup in
its own allowed-root boundary. R1 never deletes a path. Resource keys do not contain paths,
workspace content, reasoning or credentials.

`recordCost` appends an idempotent observation per run/call key under an active fence. Tokens
and integer monetary microunits are separate; null monetary cost stays unknown. Totals group
by currency and do not turn an unknown sample into a zero-price claim. Retries with changed
observations fail. These are caller observations, not provider balance or billing estimates.

## Migration and recovery

Migration 30 adds `durable_runs`, `run_attempts`, `leases`, `promises`, `timers`, `outbox`,
`run_resources`, `run_costs` and K2's additive
`idx_session_mirror_backlog_thread` index on `session_mirror_backlog(thread_id, job_id)`.
The index supports thread readiness/catch-up lookups; it changes no K2 table or wire schema. Migration 31 adds the persisted home regrant bound;
migration 30 remains byte-identical. Migrations 1–29 remain byte-identical
and are pinned by digest. No legacy Job is backfilled into an inferred agent run.

Stop the node and back up SQLite with its WAL before upgrading. Prefer a forward fix. No
production down migration deletes run state. An older binary cannot parse the new session
event type; rollback needs the stopped pre-upgrade backup, not dropping R1 tables under a
running node. The down helper exists only for isolated migration test fixtures.

## Evidence

- `durable-run-crash.test.ts`: exhaustive `SIGKILL` at every store mutation/boundary and K2
  append point in delegation, child admission/model start, completion, post-deadline reports,
  deadline resolution, signal/input-required wakes, delivery, acknowledgment, both handler
  sleep branches, recursive cancellation and a second crash during recovery. Before recovery,
  each crash checks the exact legal committed pre-state or post-state across domain tables,
  execution fences and K2 event payloads. Recovery checks exact
  promise, wake and acknowledgment counts, contiguous replay, SQLite/FK/FTS integrity.
- `durable-runs.test.ts`: deadline without child progress, both resolution orders, stale
  fences, two signal/completion wakes, eight simulated hours with a real temporary worktree,
  unchanged cost/attempt counts while sleeping, recursive cancel, detach, restart table,
  owner exclusivity and changed-TTL takeover, cost conflicts/unknowns, readiness, refused
  post-mutation K2 writes, live subscriber notification, always-on admission and plugin cleanup.
- `durable-run-review.test.ts`: regression probes for busy boot, clock correction, sleep,
  independent run failures, executor-less idle operation, K2 handles in both orders,
  retention/deadline boundaries and the three review mutations (all killed).
- `durable-run-migration.test.ts`: all shipped migration bytes, unchanged prior table rows,
  rollback of failed DDL, retry and reopen.
- `inspector.test.tsx`: exact one run-event row across persisted/live overlap and reload.

See the [R1 evidence](../../../../docs/plans/evidence/R1.md) for command results, independent
review, limits and the next integration slice.
