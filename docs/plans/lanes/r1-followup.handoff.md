# R1 follow-up hand-off

**Status:** locally validated · **Date:** 2026-10-21 · **Branch:** `lane/r1-followup`
**Base:** `cf52c4b` · **Checked code:** `bc465a4`

## Completed residuals

| Merge-record item | Commit | Evidence |
| --- | --- | --- |
| 1 — inherited attempts before reconciliation | `3811d51` | `deliver` withholds inherited live attempts; the central fence rejects their credentials. Clean close → immediate claim → delayed readiness → recovery → fresh wake acknowledgment survives later reconciliation. Direct delivery, dispatch and credential refusal are asserted. |
| 2 — Node transaction-property compatibility | `ebeafe3` | Home appends use the existing tolerant `=== false` check. A database facade stubs `isTransaction` as undefined while executing real SQLite operations; explicit false still refuses an append outside a transaction. |
| 3 — three missing guard assertions | `d4f2806` | Lost home throws globally in expiry, timer, reconciliation and dispatch passes. Log close releases its two home rows and preserves another writer. A temporary SQLite trigger counts actual home renewals before/at two `ownerTtl/3` boundaries during busy transactions. |

`bc465a4` fixes the new test's SQLite row typing after the first typecheck failed; the final
typecheck passes. No schema, dependency, wire-contract or executor changes were made.
Shared K2 edit: `packages/server/src/session-log/log.ts` only. Status files remain untouched.

## New / regression envelope

**New:** six tests in `packages/server/test/durable-run-followup.test.ts`.
**Regression envelope:** 908 existing core/CLI, 106 kernel, 299 web component, 50 UI gate and
51 mocked Chromium tests. All pass, with no failures or skips.

Both item-1 tests failed against the base (`check-ma4wqcde`); item 2 failed with the old
guard (`check-zbyeeae5`). Each item-3 guard was removed separately and its named assertion
failed: global home loss `check-alari0p6`, close release `check-yndkgigy`, busy renewal
`check-g6i9idsu`. All mutations were restored; the fixed six-test run passed
(`check-hj27zei4`) before the final full gates.

## Checks and review

`npm ci` ran first; `@guanxi/contract` resolved inside this worktree. Every check exported
`GUANXI_WEB_PORT=5195`, `GUANXI_API_PORT=4395`, `GUANXI_DATA_DIR="$PWD/.lane-data"`.
Node 26.9.0; heavy checks ran sequentially through
`agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- <command>`.

| Command | Final result / receipt |
| --- | --- |
| `npm run typecheck` (direct) | PASS, all workspaces |
| `npm run lint:md` (direct) | PASS, including this hand-off |
| `npm run check:licenses` (direct) | PASS, 437 packages / 0 not allowed |
| `npm test` | PASS: core/CLI 914, kernel 106, web 299, UI gates 50; `check-hdyp4zkk/result.json` |
| `npm run test:web:browser` | PASS: 51 mocked Chromium tests; `check-ihos_e9t/result.json` |
| `npm run build` | PASS; existing chunk-size warning; `check-yu15iks4/result.json` |

Receipts live under `/Users/yuzuru/.local/state/agent-dev/`. The existing
`.claude/skills/guanxi-ui` symlink makes `source_verifiable` and `reusable` false; these are
observed local passes. Full gates checked clean code at `bc465a4`; the final commit is docs only.

Fresh self-review separately checked startup ordering, fence callers, rollback, redelivery,
compatibility and assertions: no further findings. Independent read-only reviewer
`/root/r1_followup_review` reviewed `cf52c4b..bc465a4`: no findings; it did not rerun tests.
No live models, provider calls or owner data were used. Older Node behavior is simulated,
not a check on a Node 22.5 runtime.

## Still open — do not implement in this lane

Residual numbers below refer to the [integrator merge record](../evidence/R1.md#integrator-merge-record-2026-10-21).

- **4:** A claimed wake that is never acknowledged can create about 61 attempts/hour;
  there is no backoff or `lead_unavailable` handling.
- **5:** A waiting contender's `BEGIN IMMEDIATE` per tick may block its event loop for up
  to 5 seconds. Unclean recovery waits at least 61 seconds; a deposed home remains
  `stale_lease` until restart.
- **6 (K4):** Lifecycle appends share the handle epoch, so K4 appends using `expectedSeq`
  can encounter `sequence_conflict`.

Next: integrator review of this follow-up, then the separately scoped R1/K4 integration
work above. No push or merge was performed; all commits remain on this lane branch.
