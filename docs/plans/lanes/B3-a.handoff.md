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
  a throwing getter leaked its message and large top-level arrays (evidence and trials) were
  parsed fully. All fixed (`complete` needs an observation, `coverage.cycles.missing`,
  single-use kinds, a `forecast_cycle_not_reached` rule, try/catch and top-level pre-parse
  bounds); nested array bounds were still missing and are fixed in the review-fix round below.
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

## Independent review fixes (Opus)

**Scope:** second independent review of `7fd35758`; fixes on `codex/b3a-offline-evidence`.
B3 stays proposed and this round evaluates no B3 gate. P2-2.1, P2-2.2 and P2-2.3 were already
implemented: their commits add the missing failing assertions and named mutations, not
production changes. Every other finding changes production or documentation.

| Finding | Commit | Change |
| --- | --- | --- |
| P2-1 critical-field `complete` with no occasions | `1e5b023a` | `complete` requires `expected > 0` and no observed group missing a scope/field. Buckets report `groupsWithoutOccasion`; per-field missing groups add `critical_field_grades_partial`. Asserted for all-whole-answer and mixed cycle-2-whole-answer cases. |
| P2-2.1 attempt binding unasserted | `85f8345d` | A cycle receipt backed by an `att-2` record rejects `reference_mismatch/ref_binding`; the mutation drops the attempt conjunct. |
| P2-2.2 final unknown unasserted | `85625b4c` | A known first failure followed by an unknown retry gives `complete: false`; the mutation drops the `finalUnknown` conjunct. |
| P2-2.3 row taint unasserted | `beeacb75` | Infra taint on an item-assessment row and on a probe-grade row each sets `trials.tainted` to 1 and excludes the task from pairing. Two mutations replace each row check with `false`. |
| P3.1 assessment `head` unbound | `b3feb151` | Recorded deviation: evidence metadata carries no `head` field, so no binding is possible without a new evidence version. The plan and this hand-off name the limitation; no swapped-head rejection is claimed. |
| P3.2 trial clock infra taint | `898b19bc` | Unknown `startedAtMs` or `finishedAtMs` with reason `infra_tainted` marks the trial tainted and excludes it from the paired comparison and the ETA row. |
| P3.3 nested size limit | `3a7e0bc9` | A fixed-path length walk before Zod covers plan tasks/seeds/arms, attempts, cycles, forecasts, and item/probe/context/guard manifests and rows. A 300k shared-reference cycles array is refused on length alone; the test uses poison elements, so touching one would fail. |
| P3.4 duplicate `(scope, field)` | `b5bce4ee` | A repeated scope/field occasion within one cycle rejects `duplicate_key/probe_field_repeat`; the valid 24/12 critical-field and head counts stay pinned. |
| P3.5 missing-cycle name and attempts | `43571b00` | `cycles.trialsMissing` became `trialCyclesMissing` (the counted unit), and arms report `trials.attempts` plus `trials.multipleAttempts` separately from trial items. The `< 250 ms` timing assertion was replaced by a deterministic poison-element bounds assertion. |

**Counts (WORKFLOW 4a):** 31 new / 137 unchanged regression envelope (bench total 168, up from
165; 15 protocol and 16 reducer tests). Three new cases cover attempt totals, duplicate
scope/field rejection and nested bounds; the rest extend existing cases.

**Gates:** relay tests 31/31; full bench 168/168; `npx tsc --noEmit -p packages/bench` exit 0;
`node packages/bench/tools/mutations.ts` 45/45 cases killed, including 20 `b3a-*` cases;
markdownlint on this plan and hand-off 0 errors. No B3 gate, model, network or host was used.

**Deviations:** assessment `head` stays reported but unbound because no evidence field carries
it. The nested bounds walk covers the fixed schema paths; unknown-key subtrees are left to Zod's
strict rejection, and the existing 50k evidence / 10k trial top-level limits are unchanged.
P2-2.1–3 changed tests and mutations only because the production checks were already present.
