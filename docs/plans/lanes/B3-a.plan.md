# B3-a — offline relay-benchmark evidence validator: plan

**Status:** implemented locally as a pure parser and reducer; fixture-validated only, B3 stays proposed · **Updated:** 2026-10-23 ·
**Branch:** `codex/b3a-offline-evidence` · **Base:** `069eeb24` · **Ports:** 5211 / 4411

## Goal

A pure, no-IO, no-clock parser and reducer for a **recorded** B3 measurement envelope
(`guanxi.b3.measurement/v1`). It validates structure and bindings, keeps every unknown, and
reports descriptive counts. It evaluates **no** B3 exit criterion. B3 stays `proposed`; this
slice supplies one strict, auditable denominator for a later collector and statistical slice.
Sources: ROADMAP B3, ADR-0020 validation list, ADR-0025, and the outside-Git plan and
independent review of 2026-10-22 (the review's narrowing is binding).

## Non-goals

No model or provider call, no benchmark or calibration run, no SSH or other host, no secret
handling, no filesystem or database writer, no CLI mode, no runner/plugin/REST/UI wiring, no
new dependency, no slope, bootstrap, non-inferiority or B1 `conclusion()` call, no gate
verdict, no change to B1 `Plan`/`Trial` schemas or thresholds, no real-evidence credit, no
imputation. The CLI is deliberately absent: the review forbids a CLI mode for this slice.

## Evidence format (versioned, Zod 3 strict objects)

Top level: `format`, `declaredOrigin` (`synthetic_fixture` | `recorded_observation`),
`recordedAtMs`, `analysisAsOfMs`, `plan`, `planSha256`, `evidence[]`, `trials[]`. One clock
domain; no wall clock. Unknown keys, versions or free text are rejected.

- **Plan:** one stratum (provider, model, revision, quantization or explicit `not_applicable`,
  runtime/adapter/resource digests, window `W`, token-count convention, `E` calibration
  `unknown` or a plan-level evidence ref), task/acceptance/verifier/source digests, tasks,
  seeds, fixed `horizon`, the ETA selection cycle and cohort id, and up to five arms
  (`ledger_relay`, `naive_compaction`, `observation_masking`, `single_large_window`,
  `mini_swe_control`; one arm per kind, each with its own harness digest and explicit
  `planned` or `unsupported` availability). `planSha256` is a fixed-field tuple digest
  (unordered sets sorted), exported as `relayPlanDigest`.
- **Evidence metadata:** id, kind, trial/attempt/cycle binding and a metadata digest
  (`relayEvidenceDigest`). Content is never supplied or fetched.
- **Trial slot** per `[task, arm, seed]`: `missing{reason}` or `observed` (run id, attempts with
  epochs and receipt refs, outcome, start/finish observations, one slot per cycle `1..horizon`,
  forecasts). Cycle slot: `observed`, `unknown{reason}` or `not_reached{reason}` (terminal).
- **Observed cycle groups:** items (manifest of opportunity ids + one assessment per
  opportunity), probes (manifest of occasions, scope `whole_answer`|`critical_field`, field key,
  graded attempts), context (manifest of runtime samples: actual `W`, rendered tokens,
  truncation events), guards (manifest of dead-end checks), integrity (reported ledger/handoff/
  bundle digests), each `unknown{reason}` as a whole or fully covered. Manifest digests
  (`relayManifestDigest`) are checked against the supplied rows.
- **Reasons** are a closed enum; there is no free text anywhere.

## Validation rules (fixed error codes, no input echoed)

`schema_invalid`, `identity_mismatch`, `duplicate_key`, `missing_slot`, `chronology_invalid`,
`reference_mismatch`. Errors carry code, a fixed rule name and a location built from indices and
schema field names only. Rules: plan digest; unique tasks/seeds/arm ids/arm kinds/evidence ids;
exact Cartesian trial coverage over planned arms (foreign key, duplicate, omission); exactly
`horizon` cycle slots with ordinals `1..horizon` and a terminal `not_reached` tail; manifests
match their digest and rows cover them exactly (unknown row = present, omitted = rejected);
acceptance/plan digests equal the plan's; every ref resolves to evidence of the right kind
bound to the same trial, attempt and cycle; evidence digests verify; attempt epochs strictly
increase; times ordered (`start <= assigned <= assessed <= end`, forecast before completion,
all `<= recordedAt <= analysisAsOf`); receipt, grading, sample, guard, seal and forecast records
back exactly one observation each; a duplicate `(scope, field)` probe occasion within one cycle
rejects; a forecast for an unreached cycle rejects; hostile input (throwing getters, oversized
arrays at any fixed nesting level) yields a fixed `schema_invalid` before Zod walks the elements.

## Reported counts (descriptive, per arm and per cycle ordinal)

Trial and cycle coverage (expected, observed, missing, unknown, not reached, outcomes,
tainted, including infra taint recorded in a trial clock, cycle or group/row slot); attempts and
trials with more than one attempt are reported separately from trial items; missing trials are
counted as distinct missing tasks and as missing trial-cycle slots; item tallies from rows (expected, passed, failed, unknown); probe tallies split by
scope, field key and first attempt versus after-retry, retry rescues; truncation samples and
events, window mismatches; guarded and unguarded repeats; reported integrity agreement
(`reported_match` / `reported_mismatch` / unknown, authenticated count always 0); selected-
forecast ETA coverage with exclusions; paired relay-versus-naive whole-task exclusion and raw
outcome counts with **no** delta or interval. Fractions are `null` when a denominator is
unknown; `complete` says whether any unknown remains; unresolved items are a sorted fixed list.

## Unknown and unevaluated by construction

Report constants: `gate: measurement_only`, `b3Decision: unevaluated`, `authenticity:
not_verified_offline`, `realEvidenceCredit: 0`. Seven criteria (slope CI, naive non-inferiority,
critical probe accuracy, guarded repeats, truncation, ledger/handoff consistency, ETA P80) are
typed as the literal `unevaluated` with fixed reasons. MS1's six-hour other-node run, `E`
calibration, the real cohort and D-194 measurement are never touched.

## Documented deviation: assessment `head`

`items[].assessments[].head` is a revision string retained as reported structure. Evidence
metadata (`relayEvidenceDigest`) carries id, kind, trial, attempt and cycle only; it carries no
head field, so no supplied record can bind the assessment head. The validator therefore does
not reject a swapped head. Binding it requires a later evidence version with a head-bearing
reference; until then this is a known limitation, not an asserted rule.

## Review-point mapping

| Review point | Handling |
| --- | --- |
| Gap 1 explicit missing slots | omitted slot rejects; `missing`/`unknown` slots valid, zero credit |
| Gap 2 structure is not authenticity | no `verified` field; equal supplied hashes are `reported_match` only |
| Gap 3 measurement units | whole-answer never makes field grades; retries split; HEAD change is no new opportunity; one selected forecast per trial |
| Gap 4 stay descriptive | no estimator, CI or verdict code; criteria typed `unevaluated` |
| Fixed error codes | six codes, content-free messages |
| Evidence references resolve | kind and trial/attempt/cycle binding checked, digests verified |
| Zero-tolerance with unknowns | violations counted, unknown kept, never a "zero verified" flag |
| Paired exclusion | whole task dropped from both arms on missing, infra, cancelled or unknown outcome |
| Origin and credit | origin retained, credit 0 even for `recorded_observation` |
| No B1 contamination | new files, additive exports, B1 validators untouched and tested to refuse B3 input |

## File ownership

New: `packages/bench/src/relay-protocol.ts`, `relay-measurement.ts`,
`test/relay-fixtures.ts`, `test/relay-protocol.test.ts`, `test/relay-measurement.test.ts`,
this plan and `B3-a.handoff.md`. Shared edits (minimal): `packages/bench/src/index.ts`
(exports), `packages/bench/tools/mutations.ts` (B3-a cases), `packages/bench/README.md` (short
section). `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not touched.

## Test list (every claim has a failing assertion)

1. Valid fixture: exact hand counts, origin retained, constants and seven `unevaluated`
   criteria, credit 0 for both origins; identical reports up to origin.
2. Rejections by code: unknown key/version, free text, gate-verdict and `verified`/seal fields,
   omitted, duplicate and foreign slots/rows, swapped plan/arm/task/model/window/resource digests.
3. Numeric and time: negative/unsafe/fractional numbers, bad digests, reversed or duplicate
   cycle/attempt order, forecast after completion; errors contain no supplied marker.
4. Probes: whole-answer gives no field grades; retry rescue leaves first-attempt accuracy;
   9 correct + 1 unknown gives `0.9` with `complete: false`; zero opportunities gives `null`.
5. Zero-tolerance: unknown plus zero violations is incomplete; one truncation and one guarded
   repeat are visible; unknown manifest gives a `null` fraction.
6. Integrity: equal hashes are `reported_match` not authenticated; evidence digest or binding
   mismatch rejects; purged source stays unknown.
7. ETA: equality is covered; late forecast rejects; taint/noncompletion excluded and listed;
   several forecasts count as one.
8. Pairing: one infra-tainted or missing seed removes the task from both arms; early terminal
   runs stay present; no delta emitted.
9. Permutation of unordered inputs leaves the report unchanged; reordered cycles reject;
   frozen input untouched; output not aliased; the module imports no IO or clock.
10. B1 `validatePlan`/`validateResults` refuse B3 input and B3 refuses B1 records.
11. Mutations (added to `tools/mutations.ts`): remove the plan digest check, row-coverage check,
    first-attempt split, unknown-to-fraction guard, and the paired exclusion; each must fail.

## Gates

`npx tsc --noEmit -p packages/bench`, `npm run typecheck`, `npm run lint:md`,
`npm run check:licenses`, then `agent-dev run --resource heavy ... npm run test` (one gate per
call). Web is untouched; no browser gate.

## Residuals this slice cannot close

Real cohort of about 20 tasks with hidden verifiers, effective-length `E` per model and
quantization, measurement on the D-194 node, authenticated seal and collector, the item-success
estimand and slope or non-inferiority reducer, ETA calibration on at least 20 real runs, MS1.
