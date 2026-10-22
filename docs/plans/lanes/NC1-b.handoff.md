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
