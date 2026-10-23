# V1-c handoff — voice eval metrics and candidate pre-apply rule

**Status:** locally validated on `codex/v1c-voice-eval`. **V1 remains in progress:** this slice
adds pure scoring and gates, not the eval set, STT adapters or the learning loop.

## What exists

- `packages/server/src/voice/eval.ts`: `normalizeForWer`, `wordErrors` (Levenshtein with a
  documented match/sub/del/ins tie-break), `scoreEval` (WER, B-WER, U-WER, term P/R/F1, counts,
  origin, sorted item ids) and `compareEval` (point deltas, V1 gate, V2 pre-apply rule).
- `packages/server/test/voice/eval.test.ts`: 69 tests over normalization, alignment, word errors,
  B/U split, term multiset metrics, null denominators, origins, determinism and gate boundaries.
- `packages/server/src/voice/README.md`: appended V1-c definitions, Le et al. 2021 and lane 5
  citations, normalization/alignment contract, D-157 hyphen handling and gate reasons.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/voice/*.test.ts`: `tests 212`, `pass 212`,
  `fail 0` (143 existing V1-a/V1-b cases + 69 new).
- `nice -n 10 npx tsc --noEmit -p packages/server`: exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/voice/README.md docs/plans/lanes/V1-c.handoff.md`:
  `Summary: 0 error(s)`.
- No `npm test`, browser gate, server or network: this lane runs the targeted envelope only.

## Envelope

- **New:** 69 tests — 7 normalization, 9 alignment, 8 WER, 17 B/U split, 12 term metrics,
  4 origin, 2 determinism and 10 gate cases.
- **Regression envelope:** all `packages/server/test/voice/*.test.ts` (212 pass, 0 fail) plus
  `tsc -p packages/server`. No broader suite was run.

## Judgement calls

- Deltas are percentage points, rounded to nine decimals so the inclusive 10 and 1 boundaries are
  stable. Evidence precedence is empty, item mismatch, mixed origin, synthetic origin.
- `v2Apply` reasons are `within_bounds`, `term_f1_drop`, `u_wer_rise` or `missing_metrics`;
  refusal evidence keeps the exact gate reason, and pure synthetic evidence reports
  `synthetic_eval` even when its metrics pass.
- Term occurrences are non-overlapping and leftmost-longest per item, then aggregated as a corpus
  multiset. Matching is case-insensitive and textual after `normalizeForWer`; it does not
  transliterate Russian-script forms into Latin terms.
- The D-157 hyphen suffix applies only to the last token of a Latin term and accepts any non-empty
  all-Cyrillic suffix. B-WER's denominator stays the biased-reference-word count, so a biased
  insertion can make B-WER exceed 1 or leave it null when no biased reference word exists.
- Term F1 uses occurrence counts (`2 * matched / (reference + hypothesis)`), so it is 0 when
  terms exist but none match and null only when both occurrence totals are 0.

**Verification:** Author re-read the diff against the lane contract and ran the commands above.
No separate cross-family reviewer ran in this session; independent review remains an integrator duty.

## Residuals

- The owner's 100–150 recordings are absent, so the V1 exit gate is not measurable here.
- STT adapters with capability evidence and backend biasing mapping are absent.
- The candidate queue store and UI, auto-apply/revert, and `voice.flag_term` are absent.
- No route, contract type, plugin wiring or eval CLI exposes `scoreEval`/`compareEval`.
- No paired bootstrap confidence interval or significance test; metrics are point estimates.
- Corpus-level term matching can offset a miss in one item with an extra term in another.

V1 remains in progress; this slice is not the V1 exit gate.
