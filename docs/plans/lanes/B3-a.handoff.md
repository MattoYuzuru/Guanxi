# B3-a hand-off — offline relay-benchmark evidence validator

**Status:** implementation, tests and independent review complete; full local gates green on
the pinned code. B3 and MS1 are **not** closed and no B3 criterion is evaluated ·
**Updated:** 2026-10-23 · **Branch:** `codex/b3a-offline-evidence` · **Base:** `069eeb24` ·
**Plan:** [B3-a plan](B3-a.plan.md)

## What exists

- `packages/bench/src/relay-protocol.ts`: strict Zod 3 schema for `guanxi.b3.measurement/v1`,
  fixed-field digests (`relayPlanDigest`, `relayEvidenceDigest`, four manifest digests), the
  six fixed error codes, `RelayMeasurementError`, `checkRelayMeasurement` (structured issues,
  non-throwing) and `validateRelayMeasurement` (throws).
- `packages/bench/src/relay-measurement.ts`: `reduceRelayMeasurement`, a descriptive reducer.
  Report constants: `gate: measurement_only`, `b3Decision: unevaluated`, `authenticity:
  not_verified_offline`, `realEvidenceCredit: 0`. Seven criteria are typed with the single
  state `unevaluated` and fixed reasons.
- Additive exports in `src/index.ts`, a README section, nine plus three mutation cases in
  `tools/mutations.ts`. No CLI (the review forbids a CLI mode), no IO, no clock, no new
  dependency, no B1 schema or threshold change, no `PHASE_STATUS`/`NEXT_AGENT_PROMPT` edit.

## Gates (Mac, Node 26.9.0, lane ports 5211 / 4411, private `.lane-data`)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit -p packages/bench` | exit 0 |
| `npx eslint packages/bench` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint:md` | 0 errors, 215 files, 698 links, 0 link problems |
| `npm run check:licenses` | 675 packages, 0 not allowed |
| `agent-dev run --resource heavy ... npm run test` | exit 0, receipt `check-5wkg90xl` (`/Users/yuzuru/.local/state/agent-dev/check-5wkg90xl/result.json`), `source_changed: false`; the log redacts some counts |
| bench alone, `node --test 'test/*.test.ts'` | 165 pass, 0 fail, 0 skipped |
| `node tools/mutations.ts` | every case killed by an assertion, including 12 B3-a cases |

The gate ran on code commit `410e92ac`; later commits change only this file. A first heavy
run was stopped on purpose (a code edit landed mid-run) and is not counted. No browser gate.

**Counts (WORKFLOW 4a):** B3-a 28 new / 137 envelope (bench package total 165; the 14 new
protocol and 14 new reducer tests are the only new ones; the envelope is the unchanged
remainder, including `protocol.test.ts` and `stats.test.ts` re-run for B1 compatibility).

## Mutation sanity

Removing each of: the plan-digest check, manifest row coverage, the top-level `.strict()`, the
first-attempt split, the unknown-denominator guard, the paired infra exclusion, the guarded
repeat classification, ETA equality, the zero real-credit constant, single-use evidence,
pre-parse array bounds and cycle-level infra taint turns a test red with an `AssertionError`
(`tools/mutations.ts`, `b3a-*` ids). Each was restored (the tool works on temporary copies).

## Independent verification (separate reviewer, read-only)

`sde-agent:implementation-reviewer` reviewed the diff against the binding review. No accepted
input broke a gate, credit or echo rule. Findings and fixes (commit `410e92ac`):

- Medium: infra taint recorded in a cycle or group slot was scored as a model failure in the
  paired comparison. Fixed: taint anywhere in a trial excludes the task and the ETA row.
- Medium: known-only fractions were non-null with an unknown denominator. Fixed: `null`.
- Low: empty or unsupported arms read `complete: true`; missing-trial cycles had no bucket;
  one evidence record could back many rows; a forecast for an unreached cycle was accepted;
  a throwing getter leaked its message and 2M-element arrays were parsed fully. All fixed
  (`complete` needs an observation, `coverage.cycles.missing`, single-use kinds, a
  `forecast_cycle_not_reached` rule, try/catch and pre-parse bounds).
- Unasserted rules the reviewer deleted without a red test (after-recorded, cycle versus trial
  span, forecast range, repeats, three manifest digests, calibration ref, foreign seed/arm,
  unreferenced evidence flag): each now has a failing assertion.
- Accepted as is: counters named `passed` are tallies, not verdicts; one `verifier_result`
  may back several items of one cycle.

## Review-point mapping

| Point | Where handled |
| --- | --- |
| Gap 1 missing slots explicit | `missing_slot` rejects omissions; `missing`/`unknown` slots valid with zero credit; tests "omitted slots", "explicit missing" |
| Gap 2 structure is not authenticity | no verified/seal fields (strict), `reported_match` only, `authenticated: 0`; tests "unknown fields", "integrity" |
| Gap 3 units | whole-answer gives no field grades, first attempt split from retry, one opportunity per id across HEAD changes, one selected forecast; tests "whole-answer", "ETA", "duplicate" |
| Gap 4 descriptive only | no estimator, CI or `conclusion()` import (purity test); `delta` and `interval` are `null` |
| Fixed errors without echo | six codes, locations from indices and schema names, hostile-input test |
| Zero-tolerance with unknowns | violations counted beside unknowns, `complete` flags, no zero-verified field |
| Paired exclusion | whole task, from both arms, reasons `missing_slot`/`infra`/`cancelled`/`outcome_unknown` |
| Origin and credit | origin retained; credit `0` for both labels; reports equal up to the label |
| B1 untouched | B1 validators refuse B3 input and B3 refuses B1 records (test) |

Documented deviations from the review text: the per-metric `excluded` count is not a field;
exclusion exists only in the paired comparison and tainted rows stay in raw tallies, labelled by
`trials.tainted`. The selected-forecast boundary is the plan's `eta.selectionCycle`.

## Residual risk and not done

- Real cohort of about 20 tasks with hidden verifiers; the five-seed noise floor.
- Effective length `E` per model and quantization (the schema carries an `unknown` or a
  plan-level reference only); loaded-window measurement.
- Actual measurement on the D-194 node; nothing was run on the Mac beyond fixtures.
- Authenticated collector: fenced receipts and seals are never loaded, so every supplied
  reference is structural. A forged but self-consistent envelope gets no authority and no credit.
- Gate evaluation: the item-success slope estimand, clustered CI and non-inferiority
  convention need root and statistical review first. ETA calibration needs at least 20 real
  runs. MS1's six-hour other-node run is untouched.
- The wire format is a proposal; a later collector may need a new version.
- Next: a fenced observer emitting bound fact receipts, then the preregistered statistical
  reducer (per the review). Neither is started.
