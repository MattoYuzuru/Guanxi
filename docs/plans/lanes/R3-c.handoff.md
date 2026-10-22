# R3-c ETA P80 coverage calibration scorer hand-off

**Status:** implemented offline foundation; synthetic-only validation; R3 remains in progress.
**Branch:** `codex/r3c-eta-calibration` · **Base:** `38ff464c` · **Updated:** 2026-10-23
**Environment:** local macOS, Node 26.9.0; no network, live model, server or browser run.

## What exists

- `packages/server/src/relay/eta-calibration.ts` defines corpus v1 and a strict `parseEtaCorpus`: unknown/missing keys, bad version, invalid values/enums, a known finish not after `projectedAt`, reversed P50/P80 and duplicate `(runId, projectedAt)` raise a `TypeError` whose message starts with the offending path. P50/P80 are independently nullable. It validates but does not clone.
- `scoreEta` selects `first` (default), `last` or `all` projections per run before eligibility. Eligible means `completed` with known `actualFinishAt` and `p80FinishAt`; other selected projections count by `not_completed`, `unknown_actual` or `unknown_projection` in that order.
- P80 coverage is `covered / eligible` with `actualFinishAt <= p80FinishAt`, including equality. P50 coverage uses eligible projections that also have a known P50; each is null when its denominator is zero. Rows report selected/eligible/covered counts, P50 counts and distinct eligible runs, per cohort (sorted) and overall.
- The Wilson 95% interval uses `z = 1.96`, `denominator = 1 + z²/n`, `centre = (p + z²/(2n)) / denominator`, `margin = (z/denominator) * sqrt(p(1-p)/n + z²/(4n²))`, clamped to `[0, 1]`; null for `n = 0`.
- The gate is evaluated only for a non-empty, fully `recorded` corpus with at least 20 distinct eligible runs. Then `met = coverage >= 0.7 && coverage <= 0.9` on the point estimate and `wilsonInside` reports whether the interval is wholly inside `[0.7, 0.9]`, information only. Otherwise it returns `empty_corpus`, `synthetic_corpus`, `not_all_samples_recorded` or `insufficient_runs` and omits `met`/`wilsonInside`.
- `packages/server/test/relay/eta-calibration.test.ts` covers parser invalid classes, hand-computed coverage with the equality boundary, reason precedence, all selection modes, the cohort rows, Wilson values for 16/20 and 0/5, gate labelling/thresholds and input immutability.

## Commands and result lines

- `nice -n 10 node --test packages/server/test/relay/eta-calibration.test.ts` — **9/9 pass, 0 fail, 0 skip**, duration about 0.1 s.
- `nice -n 10 npx tsc --noEmit -p packages/server` — **exit 0**, no diagnostics.
- `npx eslint packages/server/src/relay/eta-calibration.ts packages/server/test/relay/eta-calibration.test.ts` — **exit 0**, no findings.
- `npx markdownlint-cli2 docs/plans/lanes/R3-c.handoff.md` — **0 issues** (final check after this file was written).

## New / regression envelope

**New:** the 9 focused tests above and one source module. **Regression:** none claimed: no existing relay file, test, dependency, migration or wire contract was edited; only the targeted file and server typecheck were run, not `npm test` or a full relay suite.

## Residual risk and next work

- No recorder yet turns real relay runs into `recorded` samples; synthetic scores are pipeline checks only and must never be presented as R3 gate evidence.
- ETA P80 coverage is unmeasured on real data: a recorder plus at least 20 real runs on the Fedora node is still required. The night-run J3 wake rate (≤1 per hour average) is separate unfinished R3 evidence.
- The gate is a point-estimate decision; `wilsonInside` does not widen or override it. Live projections keep `low` confidence and `unvalidated` calibration until recorded evidence exists.
- P50 coverage deliberately excludes eligible projections with unknown P50; this convention needs confirmation when the first recorder corpus arrives.
- Next: build the relay-run recorder, collect and label ≥20 real Fedora runs, then add them to this scorer alongside judge replay and night-wake evidence.

## Independent verification

A separate read-only reviewer checked the parser classes, eligibility/selection order, coverage denominators, Wilson arithmetic, gate precedence and test non-vacuity; it found no correctness findings in the in-lane review; see the independent review fixes below and did not run the suite. No live or recorded corpus was used.

## Independent review fixes (Opus, 2026-10-23)

- P1: with `perRun: 'all'`, 80 covered projections of one run plus 19 uncovered runs gave
  `met: true`. The gate now always uses the earliest projection per run (`first`), whatever mode
  the report shows; `last` cannot be cherry-picked either. New 1-of-20 regression test.
- P3: a projection at or after the actual finish is rejected by the parser (it would always count
  as covered). Residuals kept: selection happens before eligibility (a run whose first projection
  lacks P80 drops out); `scoreEta` expects a parsed corpus.
