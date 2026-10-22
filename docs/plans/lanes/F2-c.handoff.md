# F2-c — remote attempt cost ledger handoff

**Status:** blocked on an R1 transaction-aware cost seam · **Updated:** 2026-10-22 ·
**Branch:** `codex/f2c-remote-cost-ledger` · **Base:** `a64d7d1b` (main)

## Finding

The requested atomic recording cannot be implemented inside `dispatch.ts` with the current R1
API. `RunStore.recordCost()` opens its own transaction: `tx()` unconditionally executes
`BEGIN IMMEDIATE` (`store.ts:174-204`) and `recordCost` calls `tx('cost')`
(`store.ts:760-778`). The only point before `complete()` ends the fence is its receipt callback
(`store.ts:518-531`: `fenced` → `syncCallback(receipt)` → `terminal`). Calling `recordCost`
there throws SQLite `cannot start a transaction within a transaction` and rolls the ingest
back. Calling it before `complete()` commits a separate transaction, so a failed completion
leaves the cost row; calling it after `complete()` fails `fenced()` with `stale_lease` because
`terminal()` has set the attempt to `completed`/`canceled` and released its lease
(`store.ts:301-315`, `532-548`).

Temporary probes (run, then removed):

- `complete(a, 'completed', () => recordCost(a, …))` → nested-transaction error; run stayed
  `working`, zero cost rows.
- `recordCost` before `complete` → one cost row; after `complete` → `stale_lease`.
- `recordCost`, then a completion that fails `stale_lease` → the cost row remains, proving the
  separate-transaction result is not atomic.

## Required R1 seam (not changed here)

The task forbids a store change and R1-semantic change, so this lane stops. Recovery:

1. Add `recordCostWithin(db, attempt, input)` in R1 with today's validation, idempotency check,
   `run_costs` insert and K2 `cost` event; `recordCost` wraps it in `tx('cost')`.
2. In `ingest`, give `complete` a receipt callback that runs `record(db)` then
   `recordCostWithin(db, a, { key: 'remote-dispatch:' + e.ref.id, inputTokens, outputTokens,
   costMicrounits: null, currency: 'unknown' })` when both counts are non-null integers.
3. Add R1 rollback/idempotency tests, then the five F2-c cases from the task.
   Alternative (broader): make `tx` savepoint-aware with the same regression coverage.

## Commands and results

- `nice -n 10 node --test packages/server/test/remote-dispatch.test.ts
  packages/server/test/remote-attempts.test.ts` → tests 48, pass 48, fail 0, skipped 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0.
- `npx markdownlint-cli2 packages/server/src/remote-attempts/README.md
  docs/plans/lanes/F2-c.handoff.md` → 0 errors.

**New:** 0; tests 1–5 are blocked with the implementation. **Regression envelope:** the 48
existing F2 dispatch/offer cases above, zero skips. No production or test behavior changed.

## Residuals

Unchanged: monetary pricing for paid remotes (local compute stays `costMicrounits: null`,
currency `unknown`, never zero); aggregation views across child runs and the MS1 assertion that
the lead's counter does not change; toolful R2 transport. F2-b's “R1 cost-ledger aggregation”
residual stays open until the seam above lands.
