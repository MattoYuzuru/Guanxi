# V1-a handoff — deterministic glossary replacement

**Status:** locally validated on `codex/v1a-glossary-replacement` (base `069eeb24`).
**V1 is not complete:** this is only the pure post-ASR replacement engine.

## What exists

- `packages/server/src/voice/translit.ts`: `foldKey` with the fixed Cyrillic table, NFKD mark stripping, Latin phonetic normalisation, doubled-letter collapse and non-word removal.
- `packages/server/src/voice/glossary.ts`: entries, replacements, `compileGlossary` and `applyGlossary`, with validation, cross-entry key collision detection, longest-match scanning, case-sensitive mode, D-157 inflection, URL/backtick protection and original-string offsets.
- `packages/server/test/voice/glossary-replacement.test.ts` and `packages/server/test/voice/fixtures/golden.json`: 72 golden cases against one shared glossary plus unit tests (64 at the original hand-off; eight added by the review fixes below).
- `packages/server/src/voice/README.md`: module contract and deliberate limits.

No STT adapter, audio, network, database, LLM, UI or project storage is added.

## Commands and evidence

- `nice -n 10 node --test packages/server/test/voice/glossary-replacement.test.ts`: `tests 91`, `pass 91`, `fail 0`; 64 golden cases; performance about 30 ms for 50 KB / 500 entries.
- `nice -n 10 npx tsc --noEmit -p packages/server`: exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/voice/README.md docs/plans/lanes/V1-a.handoff.md`: `Summary: 0 error(s)`.
- Full `npm test`, browser tests and servers were not run: this is a pure module and the lane prompt restricts checks to the targeted test file and server `tsc`.

## Envelope

- **New:** 91 tests in `packages/server/test/voice/glossary-replacement.test.ts` (64 golden, 27 unit/integration/performance/meta).
- **Regression envelope:** the same targeted file plus `tsc -p packages/server`. No existing test file was changed or run in full, so no broader regression claim is made.

## Judgement calls

- A canonical with an empty fold key (`!!!`) is rejected in addition to the specified empty-variant rejection.
- `caseSensitive: true` disables inflection: exact-form matching wins over key/stem matching.
- Inflection requires `language: 'en'`, a Latin-only canonical, an all-Cyrillic candidate and a stem of at least two letters; ending casing is preserved.
- Matching is leftmost-longest. A full direct key match suppresses inflection at the same token count, so entry-order ties apply among direct matches; a longer match still wins. A run of N tokens only matches a form with exactly N words.
- An unclosed backtick does not protect the rest of the text; only paired same-length backtick runs (including fences) are protected.
- `опустить` stays because no listed ending yields `opus`; `федорова` stays because stripping `а` yields `федоров` (`fedorov`), not `fedora`. No stop list is used.
- Canonical terms and variants are trimmed; ids are compared exactly; duplicate keys inside one entry are allowed, cross-entry collisions throw a `TypeError` naming both ids.
- Casing is preserved; a case-insensitive match emits canonical casing, and a slice equal to the canonical output emits no replacement.
- URL protection is case-insensitive; `\S+` intentionally includes trailing punctuation.
- Cyrillic mapping is inline and its Latin output is not re-fed through Latin digraph rules: `ч` stays `ch` rather than becoming `kh`; mixed-script digraphs split across a boundary are not bridged.
- The performance test asserts a documented 400 ms CI cap rather than skipping the bound; local runs are far below 200 ms.

## Independent verification

A separate read-only reviewer sub-agent checked the implementation and ran the test/typecheck commands. It found one real URL/backtick overlap bug (fixed by protecting code spans before URLs, with a golden case), the direct-versus-inflected tie ambiguity (resolved by rule 4's "never strip when the full candidate already matches", now documented and tested), and two documented limitations: edge-punctuation canonicals and mixed-script digraph folding. No correctness finding remains open.

## Residuals

- STT adapters with capability evidence (biasing method, languages, streaming, diarization, max duration, audio destination) are not implemented.
- Per-project glossary storage and account scoping are not implemented.
- Mapping the glossary to each backend's biasing mechanism is not implemented.
- Voice-origin markers (`origin: voice`, backend, model, confidence spans) are not implemented.
- `voice.flag_term` and the V2 learning loop (candidate sources, RC0 pre-apply gate, one-click revert, review queue) are not implemented.
- The V1 exit gate is not measurable here: it needs the owner's 100–150-phrase recordings (about 20 minutes) and B-WER/U-WER/term-F1 evaluation; the eval set is not in this repository.
- Edge-punctuation canonicals such as `C++` are outside the token-span contract; use word terms. No full regression or browser-gate evidence exists for this module-only slice.

V1 remains open; the engine alone is not the V1 exit gate.

## Independent review fixes

An independent reviewer found the defects below in the V1-a matcher. Each was fixed on
`codex/v1b-glossary-store` in its own commit with a failing-first test; no existing correct
assertion was removed or weakened. The V1-a file now has 103 tests (91 before this round); the
whole voice suite has 134 (122 before).

| Finding | Fix commit | New tests |
| --- | --- | --- |
| P1 — common Russian words inflected into a Latin canonical | `eb0dd208` | 5 golden cases: `про это`, `при этом`, `пра`, `Про Хоно`, `прям сейчас`; `пиара` -> `PR-а` still passes |
| P2-a — single-word forms matched across several tokens | `61d16b25` | 3 negative golden cases: `Федор а он ушёл`, `о лама сказал`, `со нет`; `ворк три` kept by adding it as an explicit variant |
| P2-b — character bound and key rebuild made multi-word variants slow | `c7137759` | 1 performance case: 500 entries, 6–8 word variants, 50 KB |
| P2-c — the no-overlap rule was untested | `ce8fdb53` | 1 test: `дип сик` yields exactly one replacement (`DeepSeek`) |
| P3 — `isCyrillicOnly` untested; trailing stress mark blocked inflection | `f57921ef` | 2 tests: mixed-script `PRа`/`пиаRа` are not inflected; `пиара́` -> `PR-а́` |

Details:

- P1 registers a form in `inflectByKey` only when its raw text contains Cyrillic. The folded
  Latin canonical is never an inflection stem, so `про`, `при`, `пра`, `прям` and `пре` stay
  unchanged; `пиара` still matches the spoken variant `пиар`.
- P2-a stores each form's whitespace word count and requires `wordCount === tokenCount` for
  direct and inflected matches. `ворк три` remains a match because it is now an explicit
  two-word `worktree` variant, not because a one-word form spans two tokens.
- P2-b bounds the candidate run by the maximum form word count and extends the key one token at
  a time; inflection receives the prefix key instead of rebuilding it. The second performance
  case took about 926 ms before the fix and about 79 ms after it, under the 400 ms 2x CI cap.
- P2-c's mutation (`index += match.tokenCount` -> `index += 1`) turned the new test red with
  `DeepSeekSick`; the mutation was restored before the commit.
- P3 strips combining marks from the lowercase comparison copy while mapping back to the
  original offsets, so the ending output slice keeps the mark. Removing the `isCyrillicOnly`
  Latin rejection turns `пиаRа` into `PR-а`.

**Judgement calls (no code change):** feminine `-а` canonicals do not inflect under the D-157
rule as implemented (`на Федоре`, `с Олламой` stay unchanged); `caseSensitive: true` disables
inflection.

**V1-b dependency:** no V1-b test encoded the changed matcher behaviour. Store and service cases
use direct forms (`пиар`, `ворктри`, `хоно`), so no V1-b test was changed; the store, service and
marker suites pass inside the 134-test envelope.

**Envelope:** new 12 tests (V1-a 91 -> 103; whole voice suite 122 -> 134). Regression envelope:
`node --test packages/server/test/voice/*.test.ts` 134 pass, 0 fail;
`npx tsc --noEmit -p packages/server` exit 0. Markdown lint was run on the README and both
hand-offs.
