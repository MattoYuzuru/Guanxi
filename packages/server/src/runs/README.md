# Durable runs (R1)

**Status:** implemented, single node · **Updated:** 2026-10-21

`guanxi.durable-runs` provides `runs.durable` on the own kernel. It depends on K2's
`session.log` and `egress.scrubber`. The service exposes `store` and `health()`; unload closes
the store, stops the scheduler and releases its home lease. A stale service cannot write.

## Boundary

This is the durable orchestration substrate for K4/R2, not a model executor. No model, shell,
worktree creation or network call is performed here. An executor calls `start`, consumes a
prepared wake with `deliver`/`dispatch`, then calls `modelStarted` **after observing the first
model call start**. Preparation is not acknowledgment. A crashed, unacknowledged delivery gets
a new fenced attempt; an acknowledged wake is never delivered again. Model execution itself
is not exactly once. External effects still need the ADR-0018 target-side fences/idempotency
keys at their executor boundary.

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
- The execution home has a durable owner lease. Competing stores are refused. Each mutation
  verifies its owner id/token and expiry, and renews the home lease. A clean close releases it.
  An unclean takeover waits for the predecessor's persisted
  `regrant_after` (owner expiry + its maximum attempt TTL + 1000ms), also bounded by
  persisted active execution expiries. A shorter successor configuration cannot shorten it. Default owner TTL
  is 30 s and maximum execution TTL 60 s. Recovery can therefore wait up to 91 s after a
  crash; startup reports `writer_busy` during that interval and must be retried. A plain
  restart does not bump the epoch. Backup restore/cloning and epoch handover belong to F1.
- Each run has one `run:<id>/exec` lease. Tokens increase on each grant. Expired, released,
  mismatched and superseded attempts fail with `409 stale_lease`. Timeouts stop execution;
  `tick` marks expired local attempts lost before another attempt can be admitted. There is
  no automatic replay of an interrupted mutating step.
- Production time is a monotonic clock anchored to a wall reference; deterministic tests
  inject time. The home, not a remote holder's clock, owns deadline decisions.
- `delegate` atomically creates the child, promise and timer, releases the lead attempt and
  enters `waiting_children`. Retrying a delegation key returns its original child and rejects
  a changed brief. No per-run executor or model lease remains while waiting.
- A child's terminal transition and its deadline race in SQLite: first commit resolves the
  promise once and creates one outbox wake. A fenced escalation/quota signal wakes the lead
  without resolution. The outbox deduplicates by source. Wake sequence and delivery attempt
  are separate; later wakes wait while a handler is active. The plugin periodically prepares
  pending deliveries; an executor still owns model calls and acknowledgment. A handler can
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
| Unacknowledged wake | Original attempt lost; dispatcher prepares a fresh attempt under a higher token |
| Acknowledged wake | Never redelivered; interrupted work needs an explicit retry |
| `wrapping_up` | Remains a durable report request; `start` resumes a report-only attempt |
| Terminal | Unchanged |

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
`run_resources`, `run_costs` and a backlog-by-thread index. Migration 31 adds the persisted home regrant bound;
migration 30 remains byte-identical. Migrations 1–29 remain byte-identical
and are pinned by digest. No legacy Job is backfilled into an inferred agent run.

Stop the node and back up SQLite with its WAL before upgrading. Prefer a forward fix. No
production down migration deletes run state. An older binary cannot parse the new session
event type; rollback needs the stopped pre-upgrade backup, not dropping R1 tables under a
running node. The down helper exists only for isolated migration test fixtures.

## Evidence

- `durable-run-crash.test.ts`: exhaustive `SIGKILL` at every store mutation/boundary and K2
  append point in delegation, resolution, delivery and acknowledgment; recovery checks exact
  promise, wake and acknowledgment counts, contiguous replay, SQLite/FK/FTS integrity.
- `durable-runs.test.ts`: deadline without child progress, both resolution orders, stale
  fences, two signal/completion wakes, eight simulated hours with a real temporary worktree,
  unchanged cost/attempt counts while sleeping, recursive cancel, detach, restart table,
  owner exclusivity, cost conflicts/unknowns, readiness, always-on admission and plugin cleanup.
- `durable-run-migration.test.ts`: all shipped migration bytes, unchanged prior table rows,
  rollback of failed DDL, retry and reopen.
- `inspector.test.tsx`: exact one run-event row across persisted/live overlap and reload.

See the [lane handoff](../../../../docs/plans/lanes/R1.handoff.md) for command results, independent
review, limits and the next integration slice.
