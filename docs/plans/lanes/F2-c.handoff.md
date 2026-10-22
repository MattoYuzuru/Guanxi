# F2-c — remote attempt cost ledger handoff

**Status:** completed · **Updated:** 2026-10-23 ·
**Branch:** `codex/f2c-remote-cost-ledger` · **Base:** `a64d7d1b` (main)

## Result

Remote terminal token usage now lands in the child run's R1 cost ledger atomically with the
terminal receipt and completion. The lead (parent) run's totals are unchanged.

R1 seam (`packages/server/src/runs/store.ts`, integrator-authorized shared edit; no schema or
migration change):

- `CostInput` is exported. Validation moved to `validateCostInput(input)`; the prior-row
  idempotency check, `run_costs` insert and `cost` event moved to `insertCost(attempt, input)`,
  which assumes an open transaction and an already checked fence.
- `recordCost` is now `validateCostInput` → `tx('cost')` → `fenced` → `insertCost`; observable
  behaviour is unchanged.
- `complete(attempt, outcome, receipt?, cost?)` validates `cost` before `BEGIN IMMEDIATE`.
  Inside the existing `tx('complete')`, after `fenced` and `syncCallback(receipt)`, it calls
  `insertCost` and then `terminal`. Existing callers pass no cost.

F2 use (`packages/server/src/remote-attempts/dispatch.ts`, `ingest()`): a `terminal` event with
both token counts non-null integers passes a `remote-dispatch:<offer id>` observation with
`costMicrounits: null` and currency `unknown` to `runs.complete`. Null usage passes no cost and
still completes. Replay takes the existing `prior` path or R1's idempotency key; neither adds a
second row.

## Round 1 blocker

`recordCost` opened its own `BEGIN IMMEDIATE`, so calling it from `complete()`'s receipt
callback raised "cannot start a transaction within a transaction"; before completion it left a
cost row if completion failed, and after completion the released lease failed `fenced()` with
`stale_lease`. The integrator authorized exactly the seam above; no store semantics changed for
current callers.

## Tests

New (9): `durable-runs.test.ts` adds complete-with-cost (exact one row, one event), throwing
receipt rollback, idempotent replay vs changed-observation conflict, and validation before the
transaction. New `remote-attempt-costs.test.ts` adds the five F2 cases: completed usage (child
totals include it, parent totals exact-equal before/after), null usage, terminal replay with one
row, cost-insert failure rolling back receipt + cost + completion, and canceled/failed usage.

Commands:

- `nice -n 10 node --test packages/server/test/durable-runs.test.ts packages/server/test/durable-run-review.test.ts packages/server/test/remote-attempt-costs.test.ts packages/server/test/remote-dispatch.test.ts packages/server/test/remote-attempts.test.ts` → tests 97, pass 97, fail 0, skipped 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0.
- `npx markdownlint-cli2 packages/server/src/remote-attempts/README.md
  packages/server/src/runs/README.md docs/plans/lanes/F2-c.handoff.md` → 0 errors.

**New:** 9. **Regression envelope:** 88 pre-existing cases in the command above, zero skips.
`durable-run-crash.test.ts` was not run (it SIGKILLs child processes; the integrator runs it).

## Independent review test gaps

Three gaps from the independent review are closed with tests only; production code was not
changed. Each gap is a separate commit on `codex/f2c-remote-cost-ledger`.

1. **Cost-before-terminal order.** The `complete(..., cost)` case in `durable-runs.test.ts` now
   reads the run's K2 `run.lifecycle` events and asserts the `cost` action precedes `terminal`
   and that the `cost` event's state is `working`. Mutation check: moving `insertCost` after
   `terminal()` made exactly this case red; restored.
2. **F2 atomicity distinguishes one transaction from two.** `remote-attempt-costs.test.ts` now
   delivers a terminal with usage after the dispatch deadline has passed, so the receipt
   callback throws `dispatch_deadline` inside `complete()`. It asserts the run is still `working`,
   the terminal receipt is absent and `run_costs` has 0 rows. Mutation check: recording the cost
   in a separate earlier `recordCost` transaction made this case fail with 1 row; restored.
3. **Crash coverage of `complete(..., cost)`.** The `resolve` crash stage now passes a cost to
   `complete()`. The crash test keeps its full point enumeration and asserts the exact
   `run_costs` key: 0 rows before the completion transaction commits and exactly 1 after,
   including later transactions. `run_costs` is already part of `runStateSnapshot`; the explicit
   count assertion covers the same before/after boundary. As instructed, this file was not run
   locally (it SIGKILLs child processes); it typechecks and is left to the integrator.

Verification for gaps 1–2:

- `nice -n 10 node --test packages/server/test/durable-runs.test.ts packages/server/test/remote-attempt-costs.test.ts`
  → tests 30, pass 30, fail 0, skipped 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0.

**New:** 2 cases plus 2 strengthened existing cases (cost event order and crash cost boundary).

## Residuals

Monetary pricing for paid remotes stays out of scope (local compute remains
`costMicrounits: null`, currency `unknown`, never zero). Aggregation views across child runs,
the MS1 assertion over a real wake, and toolful R2 transport remain open; F2-b's “R1
cost-ledger aggregation” residual is closed for terminal usage.
