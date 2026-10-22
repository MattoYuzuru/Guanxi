# NC1-b handoff — durable notification inbox and idempotent actions

**Status:** bounded slice implemented and locally validated; independent review recorded below.
NC1 remains **in progress** and the stage is not complete. No status file was edited.
**Date:** 2026-10-23 · **Branch:** `codex/nc1b-inbox-actions` · **Base:** `b085bc5d`

## What exists

`packages/server/src/notifications/` now contains the durable inbox and its action layer:

- `store.ts` — separate `notifications.sqlite` sidecar, WAL, foreign keys, append-only
  `nc1_migrations` v1 (`quota_window_state`, `notifications`, `notification_actions`).
  `recordEvaluation` writes window state and all alert rows in one transaction; duplicate
  idempotency keys insert nothing. Newest-first `list` with state/limit/before filters,
  account-scoped `get`/`markRead`/`snooze`, reset-aware `expireSnoozed`, and the
  `beginAction`/`finishAction` status machine.
- `service.ts` — `NotificationService.ingestQuotaFact` loads the previous NC1-a window state,
  evaluates with the caller clock and persists via `recordEvaluation`. Identical fact
  re-ingestion inserts nothing.
- `actions.ts` — ten typed commands, `ActionPorts` with one async method each, offered-action
  validation, idempotency reservation, terminal-result replay, content-free `port_failed`
  storage and the crash-recovery `hasCompleted` probe. `wakeLeads(connectionId, ctx)` is
  called at most once per notification and exactly once per successful effect; every port
  receives the idempotency key in its context.
- `recommend.ts` — deterministic rules: defer lead wakes until a sooner reset, switch to the
  first fallback, snooze until a known reset. No clock, model or randomness.
- `payload.ts` — `{ title, tag }` only, from fixed kind/window templates; no subject, source, time, run or session content.
- `README.md` — appended NC1-b store, action crash contract, recommender, payload, evidence and residual sections.
- `packages/server/test/notifications/` — `inbox-store.test.ts`, `actions.test.ts`, `recommend-payload.test.ts`.

## Evidence

```bash
nice -n 10 node --test packages/server/test/notifications/*.test.ts
```

```text
ℹ tests 40
ℹ pass 40
ℹ fail 0
```

```bash
nice -n 10 npx tsc --noEmit -p packages/server
```

Result: exit 0, no diagnostics.

```bash
npx markdownlint-cli2 packages/server/src/notifications/README.md docs/plans/lanes/NC1-b.handoff.md
```

Result: `Summary: 0 error(s)`.

### New / regression envelope

- **New:** 29 tests in three files: 10 store/service tests (migration idempotence and WAL/FK,
  duplicate-id rollback, stale-observation conflict, ADR-0033 3-then-1 counts, duplicate fact,
  account isolation, snooze/expire, list paging and same-millisecond cursors, per-kind action
  lists), 12 action tests (each port once, terminal replay and immutability, concurrent calls
  sharing one effect, second-key and in-progress refusal, not-offered/unknown refusal,
  content-free failure, crash probe true/false, `wake_leads` once, empty connection id,
  no-probe refusal) and 7 recommend/payload tests (determinism, each rule, offsetless
  timestamps, secret/remaining-value absence, exact titles).
- **Regression envelope:** the 11 existing NC1-a rule tests in the same command; `tsc` over the
  whole server source and test tree; markdownlint on the two owned Markdown files. Per lane
  instructions, `npm test`, browser tests, builds and servers were not run.

## Independent verification

A separate read-only reviewer reproduced five blocking gaps before commit: concurrent same-key
double port call, optional finish account, reuse after acted, snooze deadline loss and same-ms
paging loss. Fixes: in-flight promise coalescing, required finish account, acted/in-progress
guards, snoozed terminal state and a `(created_at, rowid)` cursor. It also found the
read-evaluate-write race (fixed with CAS and three attempts), empty wake connection ids (now
rejected) and two documented boundaries (global connection ownership; intentional
threshold/window title fields). Commands re-ran after fixes: 40/40, tsc exit 0.

## Residuals (later NC1 slices)

- Plugin wiring and boot; no route, contract or web change is in this slice.
- HTTP routes, `packages/contract` notification/action schemas and the web/desktop notification center UI.
- Real ports against R1 `wake`/run pause and K3 role rebinding, including a durable cross-process action lease; the current in-flight guard is process-local.
- Run-policy automatic reactions with undo, quiet hours, OS/push delivery and the remaining attention kinds (runs, judge, nodes, security, evolution, bench).
- v1 keeps the requested global `(connection_id, window)` and idempotency-key shapes; connection ids must stay globally unique and account-owned.

## Stage status

NC1 stays **in progress**. This slice does not close the stage: routing, UI, real ports,
automatic reactions and delivery above remain unfinished. `PHASE_STATUS.md` and
`NEXT_AGENT_PROMPT.md` were not edited; the integrator folds this handoff in.

## Independent review fixes

Applied on 2026-10-23 in three commits after an independent read-only review reproduced the
defects below with a probe. Every fix carries a test that failed before the change.

- **P2-1 snooze revived an `acted` row** → `3c96a3c5`. `snooze` and `markRead` now refuse an
  `acted` row with `notification_acted`, so `expireSnoozed` cannot turn it into `unread` and a
  second key cannot call a port. New test: `snooze and markRead cannot revive an acted
  notification for a second action` (wake, snooze, expire, second wake; port calls stay 1).
- **P2-2 `hasCompleted(key)` was unanswerable for `wake_leads`** → `3cb62777`. `wakeLeads`
  now receives `ActionPortContext` as its last argument, like every other port; the README
  requires ports to record and dedupe by `context.idempotencyKey` and answer `hasCompleted`
  from those records. The test fakes now derive `hasCompleted` from keys they actually
  received. New test: `a crash after the port returned is recovered from the key the port
  recorded` (the port returns, `finishAction` fails once, the same-key retry does not call the
  port again). **Spec deviation:** `wakeLeads` keeps the connection id as its first argument
  and adds the context last; it is the only port not called with a context alone.
- **P3-1 `open` blocked later actions** → `50841892`. Only `wake_leads`,
  `switch_connection`, `pause_runs`, `resume_runs`, `choose_action`, `add_prompt` and
  `raise_budget` complete a row as `acted`; `open` and `accept_recommendation` mark it `read`;
  `snooze` keeps `snoozed`. New test: `open marks the notification read and leaves a
  state-changing action available` (open then `wake_leads` succeeds once).
- **P3-2 cross-account cursor** → `50841892`. New regression test: `another account cannot
  use a notification id as its pagination cursor` (`notification_not_found` for both id and
  composite cursors). The production predicate already had the account filter.
- **P3-3 v1 index** → `50841892`. The migration test now asserts that
  `notifications_account_state_created` exists in `sqlite_master`; the index was already in
  migration v1.
- **P3-4 leaked `DatabaseSync` on a failed open** → `50841892`. The PRAGMA/create-table exec
  is inside the same try/close as the migration block; the handle is closed before the
  original error is rethrown. New test: `a failed open closes the sqlite handle` (a
  pre-existing non-database file, `close` called once).
- **P3-5 implicit rowid paging** → `50841892`. `list` orders and pages same-millisecond rows
  by `(created_at, id)` instead of rowid. New test: `list breaks same-timestamp ties by id so
  paging does not depend on rowid`; the existing paging tests stay green.

### New / regression envelope

- **New:** 6 tests (3 action, 3 store) plus the `sqlite_master` index assertion inside the
  existing migration test. The notification suite went from 42 to 48 tests.
- **Regression envelope:** all pre-existing NC1-b store/action/recommend/payload tests and
  the 13 NC1-a rule tests in the same run; `tsc` over the server source and test tree;
  markdownlint on this hand-off and the notifications README. Result: 48/48 pass, tsc exit 0,
  markdownlint 0 errors.

### Review residuals (no code in this round)

- A crashed `started` row still blocks other keys for the same notification until a same-key
  retry finishes it; there is no admin or timeout path yet.
- Cross-process double execution remains possible until a durable action lease lands; the
  in-flight guard is process-local and `hasCompleted` is advisory.
- Recommendations are not persisted, so `accept_recommendation` has nothing durable to
  reference yet; it records the action and marks the row read.
