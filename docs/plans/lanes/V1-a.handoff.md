# V1-a handoff — deterministic glossary replacement

**Status:** locally validated on `codex/v1a-glossary-replacement` (base `069eeb24`).
**V1 is not complete:** this is only the pure post-ASR replacement engine.

## What exists

- `packages/server/src/voice/translit.ts`: `foldKey` with the fixed Cyrillic table, NFKD mark stripping, Latin phonetic normalisation, doubled-letter collapse and non-word removal.
- `packages/server/src/voice/glossary.ts`: entries, replacements, `compileGlossary` and `applyGlossary`, with validation, cross-entry key collision detection, longest-match scanning, case-sensitive mode, D-157 inflection, URL/backtick protection and original-string offsets.
- `packages/server/test/voice/glossary-replacement.test.ts` and `packages/server/test/voice/fixtures/golden.json`: 64 golden cases against one shared glossary plus unit tests.
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
- Matching is leftmost-longest. A full direct key match suppresses inflection, so entry-order ties apply among direct matches; a later direct match can beat an earlier entry's inflected match. Key equality is token-boundary agnostic: `ворк три` can match the one-token variant `ворктри`.
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
