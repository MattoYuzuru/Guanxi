# R3-b judge replay corpus and scorer hand-off

**Status:** implemented offline foundation; synthetic-only validation; R3 remains in progress.
**Branch:** `codex/r3b-judge-replay` · **Base:** `e19f0aac` · **Updated:** 2026-10-23
**Environment:** local macOS, Node 26.9.0; no network, live model, server or browser run.

## What exists

- `packages/server/src/relay/judge-replay.ts` defines replay corpus v1 and a strict
  `parseReplayCorpus`: unknown/missing keys, bad version, invalid observation/policy values,
  non-increasing `observedAt`, out-of-range/duplicate labels and duplicate run ids raise a
  `TypeError` whose message starts with the offending path. It validates but does not clone.
- Default detectors map `evaluateJudgeSignals` per step: loop from `no_progress`,
  `repeated_failure`, `edit_revert`, `repeated_dead_end`; protected/out-of-scope/stall from
  their exact signals. `premature_done` is the documented rule: done claim plus explicit
  `acceptancePassed === false` fires; done claim with `null`/absent acceptance is `unknown`,
  never a firing; passing acceptance is a near-miss negative.
- `score(corpus, detectors?)` returns per-class and micro TP/FP/FN/TN, precision/recall
  (`null` when the denominator is zero), latency median/max in steps, unknown counts, a
  synthetic/recorded origin breakdown and the gate object. Custom detectors replace the
  default for exactly one class.
- An early firing before a label's `firstStep` is a run-level false positive; a later
  at-or-after-onset firing is still a true positive. An early-only labelled run also counts
  as a false negative. Counts can therefore exceed the run count.
- The gate is never evaluated for synthetic corpora (`evaluated: false`,
  `reason: 'synthetic_corpus'`). It is evaluated only when every run is recorded and at
  least one run is labelled for `loop`, `protected_path_edit` and `premature_done`; `met`
  compares the corpus-wide micro precision/recall with the rule thresholds.
- `packages/server/src/relay/judge-replay-inject.ts` generates deterministic synthetic
  corpora with mulberry32 and a caller policy. Faulty runs rotate through all five classes
  and cross the relevant threshold/list/claim/heartbeat boundary at `firstStep`. Healthy
  runs include loop streaks one below threshold, a passing done claim and a heartbeat gap
  one below threshold.
- `packages/server/test/relay/judge-replay.test.ts` covers strict parsing, an exact
  hand-written confusion matrix and null denominators, early firing as FP, premature/unknown
  semantics, a 240-run deterministic generator corpus with `gate.evaluated === false`,
  recorded-gate evaluation and missing-class/mixed-origin reasons, one-class detector
  replacement, and zero firings on generator near-miss negatives.

## Commands and result lines

- `nice -n 10 node --test packages/server/test/relay/judge-replay.test.ts` — **9/9 pass,
  0 fail, 0 skip**, duration about 0.1 s.
- `nice -n 10 npx tsc --noEmit -p packages/server` — **exit 0**, no diagnostics.
- `npx eslint` on the three new TypeScript files — **exit 0**, no findings.
- `npx markdownlint-cli2 docs/plans/lanes/R3-b.handoff.md` — **0 issues** (final check
  after this file was written).

## New / regression envelope

**New:** the 9 focused tests above and two source modules. **Regression:** none claimed:
no existing relay file, test, dependency, migration or wire contract was edited; only the
targeted file and server typecheck were run, not `npm test` or a full relay suite.

## Residual risk and next work

- No recorder yet that turns real relay runs into `recorded` corpora; synthetic scores are
  pipeline checks only and must never be presented as R3 gate evidence.
- Monthly 20–30 owner-labelled judge calibration is not done; J2/J3 model layers are not
  part of scoring, so this measures deterministic J0/J1 behaviour only.
- Night-run J3 wake rate (≤1/hour average) and ETA P80 coverage (0.7–0.9 over ≥20 real
  runs) remain unmeasured. R3 stays in progress; no synthetic result closes it.
- The early-firing overlap and median convention are deliberate and documented in source;
  they need confirmation when the first recorded corpus arrives.
- The synthetic timeline uses a fixed safe epoch: heartbeat thresholds beyond it are outside
  generator range, and a manually empty corpus reports `empty_corpus` rather than a synthetic
  reason because origin is stored per run only.
- Next: build the relay-run recorder, collect and label real corpora, then add J2/J3
  verdicts and night/ETA evidence to the same scorer.

## Independent verification

A separate review pass checked format fields, parser classes, detection mapping, gate
conditions, generator patterns and test non-vacuity. It found no blocking correctness
findings. Review-driven hardening (bounded latency selection, positive run-count validation,
origin/generator/early-only/mixed-origin assertions) is recorded in the review-fix commit.
No live or recorded corpus was used.
