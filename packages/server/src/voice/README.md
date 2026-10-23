# Voice glossary replacement

**Status:** implemented (V1-a) · **Scope:** pure, in-memory post-ASR replacement.

This directory implements ADR-0028 decision 3: deterministic glossary replacement with
transliteration-aware matching. It has no STT adapter, audio, LLM, database, UI or network I/O.

- `translit.ts` exports `foldKey(s)`: a matching key that folds Cyrillic and Latin spellings to
  one form (`хоно` and `Hono` both become `hono`; `Guanxi` becomes `guanksi`).
- `glossary.ts` exports `GlossaryEntry`, `Replacement`, `ReplaceResult`, `compileGlossary` and
  `applyGlossary`.

## Usage

```ts
import { applyGlossary, compileGlossary } from './glossary.ts'

const glossary = compileGlossary([
  { id: 'hono', canonical: 'Hono', variants: ['хоно', 'хона'], language: 'en' },
  { id: 'pr', canonical: 'PR', variants: ['пиар'], language: 'en' },
])

applyGlossary(glossary, '`хоно` и пиара').text // '`хоно` и PR-а'
```

`compileGlossary` validates ids, canonical terms, variants and cross-entry key collisions, and
throws `TypeError` on bad input. The returned glossary is frozen and independent of the input
array. `applyGlossary` is pure and returns offsets into the original string.

## Matching

A candidate is a run of Unicode word tokens joined by single spaces. A run of N tokens can only
match a form with exactly N whitespace-separated words, so a single-word form never matches
across token boundaries. A candidate matches when its folded key equals a canonical or variant
key; multi-word forms therefore match token sequences separated by single spaces. The run length
is bounded by the longest form's word count. Longest matches win, then input order; matches never
overlap. Matching is case-insensitive unless `caseSensitive` is set, and output always uses the
canonical casing.

Explicit variants are required for irregular spellings because the key only bridges script and
common phonetic drift (`Guanxi` and `гуанси` deliberately differ; the variant carries the
exception).

For a Latin `language: 'en'` canonical with `inflect` not `false`, a Cyrillic candidate may lose
one Russian ending and keep it after a hyphen (D-157): `пиара` becomes `PR-а`, `воркт триах`
becomes `worktree-ах`. Only spoken forms containing Cyrillic are inflection stems; the folded
Latin canonical is never a stem, so common Russian words such as `про`, `при` and `пра` stay
unchanged instead of becoming `PR-о`, `PR-и` and `PR-а`. Combining marks, including a stress
mark, are ignored while matching the ending and the original ending slice keeps them in the
output: `пиара́` becomes `PR-а́`. `inflect: false` and `caseSensitive: true` disable inflection.
Stems shorter than three letters are rejected, so a two-letter variant such as `пр` does not turn
`про` into `PR-о`; `пиара` still becomes `PR-а` from the four-letter stem `пиар`.

Text inside backtick code spans and `https?://\S+` URLs is protected. All other characters,
including spacing and newlines, are preserved byte-for-byte.

## Limits

Per-project storage, biasing for STT backends, voice-origin markers, `voice.flag_term` and the
learning loop are later V1/V2 slices. An unclosed backtick does not create a protected span.
Canonicals and variants must be word-token sequences: edge punctuation such as `C++` or `Hono!`
is not absorbed into the matched span and is outside this module's contract. Cyrillic-mapped
Latin is not re-fed through the Latin digraph rules, so mixed-script digraphs split across a
script boundary are not bridged; use explicit variants. The D-157 rule is a stem-plus-ending
match against stored spoken forms, not a full feminine `-а` paradigm: `на Федоре` and
`с Олламой` stay unchanged. `caseSensitive: true` also disables inflection.

## Store, service and voice marker (V1-b)

**Status:** implemented (V1-b), locally validated. This appended section supersedes the
V1-a-only statement under "Limits" that per-project storage and voice-origin markers are later
slices.

`store.ts` exports `GlossaryStore` over a separate `<dataDir>/voice.sqlite` sidecar with WAL,
`foreign_keys=ON`, its own `v1_migrations` table and version 1. Entry ids are per account:
`glossary_entries` is keyed by `(account_id, id)` and `glossary_revisions` by
`(account_id, entry_id, revision)`, with a composite foreign key back to the entry. Version 1 was
revised in place during the V1-b review before any user database applied it and is frozen from
here. Every mutation runs in one `BEGIN IMMEDIATE` transaction that also appends exactly one
revision row; validation failure rolls the whole mutation back. Revisions form a chain of create,
update, deactivate, reactivate and revert.
`revert` restores the previous revision's entry, and reverting a lone create deactivates the
entry. `history` returns revisions in ascending order. `list` returns account entries plus,
when `projectId` is supplied, that project's entries; inactive rows are excluded unless
`includeInactive` is set.

Validation compiles each stored entry on its own and every effective set a mutation could
change: account-scope mutations check every known project, project-scope mutations check their
project. An active project entry whose canonical term equals an account entry's canonical term
(case-insensitive) hides the account entry from that project's effective set instead of
colliding. Any other canonical or variant key collision throws and leaves the database
unchanged. Entry lookups use `(account_id, id)`, so another account's id is simply
`entry_not_found`; two accounts may use the same id, while one account cannot repeat an id across
projects.

`service.ts` exports `GlossaryService`. `effective` returns active project entries first
(ordered by `created_at`, then `id`), then the active account entries the project does not
override, each carrying its stored revision. `apply` returns the V1-a `ReplaceResult`.
Compiled glossaries are cached per (account, project); a committed account-scope mutation
invalidates the whole account cache and a project-scope mutation invalidates only that
project.

`marker.ts` exports `VoiceOrigin`, `validateVoiceOrigin`, `voiceBlock` and
`glossaryRevisionHash`. Validation checks identity fields, sorted non-overlapping confidence
spans inside `finalText.length`, finite confidence in [0, 1] and replacement slices equal to
`finalText.slice(start, end)`. `voiceBlock(origin, finalText, maxChars = 400)` revalidates the
origin against `finalText`, states that the prompt was dictated, names the backend, model,
language and glossary revision, lists at most five replaced terms and at most five low-confidence
(<0.6) quoted fragments, and truncates to `maxChars` code points without splitting surrogate
pairs. The final text is supplied by the caller
and is not stored on the origin, so a spread or `structuredClone` of the origin produces the same
block. `glossaryRevisionHash` is SHA-256 over sorted `{id, revision}` JSON and is independent of
input order.

Limits: this slice does not add a web glossary editor, an STT adapter, backend biasing mapping,
the `voice.flag_term` tool or V2 candidate learning. (The plugin, REST routes and contract type
landed in MS2, below.) The V1 exit gate still needs the owner's evaluation recordings and is not
measurable here.

## MS2: plugin, REST routes and wire contract

**Status:** implemented, locally validated · **Updated:** 2026-10-23 · **Scope:** MS2 backend wiring

`plugin.ts` provides `guanxi.voice` (T0, service `voice.glossary` = `{ store, service }`). It opens
`<dataDir>/voice.sqlite` on load and registers close effects for the store and the service's cache
subscription; it starts no timer and no audio or STT path. `routes.ts` mounts at
`/api/voice/glossary`; `wire.ts` maps to `packages/contract/src/voice.ts` and drops the account id.

| Method and path | Purpose |
| --- | --- |
| `GET /api/voice/glossary?projectId=&includeInactive=` | Without `projectId`, every entry the account owns; with it, account entries plus that project's. |
| `POST /api/voice/glossary` | `{ id?, scope, projectId?, entry }`. The node assigns `gl_<uuid>` when `id` is absent. 201. |
| `PUT /api/voice/glossary/:id` | `{ entry }`; the id comes from the path and the body may not carry one. |
| `POST /api/voice/glossary/:id/deactivate`, `/reactivate`, `/revert` | Body `{}`. |
| `GET /api/voice/glossary/:id/history` | Revisions in ascending order. |
| `POST /api/voice/glossary/apply-preview` | `{ text, projectId? }` returns the replaced text, replacements and `glossaryRevision`. Stores nothing. |

Rules pinned by tests:

- Revisions written over HTTP always have source `user`; a body that names a `source` is refused.
  `import` and `candidate` belong to later adapters.
- `glossaryRevision` in the preview is `glossaryRevisionHash` over the effective entry ids and
  revisions, the value the voice marker records; an edit changes it.
- A bad term or a key collision answers `422 glossary_invalid` with no term in the body, and the
  transaction rolls back (no entry, no revision row). The compiler's `TypeError`s quote the user's
  terms, so they are converted only inside store mutations (`mutating`); a stray `TypeError`
  elsewhere is `500 internal_error`.
- Another account's entry id is `404 entry_not_found`; two accounts may use one id and one spoken
  form. A preview body is bounded at 250 000 characters and every body at 2 MiB (transport
  budgets, not dictation limits).
- Guard, error body shape and the fixed local account follow the notifications section: loopback
  peer, same-origin or dev origin, JSON on mutations, `{ code }` only.

Evidence: `ms2-glossary-routes.test.ts` (14 tests), the voice parts of `ms2-plugins.test.ts` and
`ms2-contract.test.ts`.

Still later: the glossary editor UI, STT adapters and backend biasing, `voice.flag_term` and V2
candidate learning.

## Evaluation metrics and gates (V1-c)

**Status:** implemented (V1-c), locally validated. `eval.ts` is pure and in-memory; it has no
audio, STT adapter, filesystem, database, network or UI. It scores reference/hypothesis text pairs
and cannot create the owner's eval set.

`eval.ts` exports `EvalItem`, `EvalOrigin`, `normalizeForWer`, `wordErrors`, `scoreEval`,
`compareEval` and their result types (`WordErrors`, `EvalCounts`, `EvalScore`, `EvalComparison`).

### Definitions and citations

B-WER and U-WER follow Le et al., *Contextualized Streaming End-to-End Speech Recognition with
Trie-Based Deep Biasing and Shallow Fusion*, Interspeech 2021
([arXiv:2104.02194](https://arxiv.org/abs/2104.02194)): reference words covered by the utterance's
bias list are biased, every other reference word is unbiased, and B-WER/U-WER are the errors on
each class divided by that class's reference-word count. Insertions of bias-list words are charged
to B-WER; all other insertions to U-WER. The
[lane 5 synthesis §5](../../../../docs/research/2026-10-19-landscape/05-self-evolve-voice-cu.md)
records the same rule (`score.py` of STT-53) and defines biased words for Guanxi as the glossary
canonical terms present in the reference. ADR-0028 decisions 5–6 and the V1/V2 roadmap gates are
the product contract; see [ADR-0028](../../../../docs/decisions/0028-voice-and-glossary.md) and
[ROADMAP](../../../../docs/plans/ROADMAP.md).

Term precision, recall and F1 are term-level multiset metrics over term occurrences: precision is
matched/hypothesis occurrences, recall is matched/reference occurrences, and F1 is
`2 * matched / (reference + hypothesis)`. This is the term-level convention described in lane 5
§5, not a token-level WER variant.

### Normalisation and alignment

`normalizeForWer` applies NFC, lower-cases, maps `ё` to `е`, maps U+2010 and U+2011 to `-` and
U+2019 and U+02BC to `'`, keeps `-` and `'` only inside a word, strips all other punctuation and
returns Unicode letter/number/mark tokens. En and em dashes are not aliases and stay separators.
Whitespace is collapsed by tokenisation. For example `Ёлка, well-known don't!` becomes
`['елка', 'well-known', "don't"]`, and `PR‑а don’t` becomes `['pr-а', "don't"]`.

`wordErrors` runs Levenshtein over normalised tokens and returns substitution, deletion and
insertion counts plus a forward alignment. The traceback tie-break is deterministic: an equal-token
diagonal step first, then a diagonal substitution, then a reference deletion, then a hypothesis
insertion. `ok` steps carry both tokens, `sub` both, `del` the reference token and `ins` the
hypothesis token. WER is `(S + D + I) / reference tokens`; it is `null` when the reference has no
tokens, as are B-WER, U-WER and term metrics when their denominator is zero. No metric defaults to
0 or 1.

### Biased words and hyphen endings

Glossary terms are normalised with `normalizeForWer`; a multi-word term matches a contiguous token
sequence, and duplicate normalised terms are ignored. A reference token is biased when any term
occurrence covers it. Matching is textual after normalisation, not transliteration-aware: `Hono`
does not match a Russian-script `хоно` unless that spelling is supplied as a separate term. Case is
not significant because the shared token stream is lower-cased.

For the D-157 output shape, a Latin canonical plus a Russian ending after a hyphen counts as the
term: with term `PR`, the token `PR-а` (normalised `pr-а`) is biased. The rule applies to the last
token of a multi-word term and accepts any non-empty all-Cyrillic suffix (combining marks allowed),
so `worktree-ах` and `PR-а́` also match. This deliberately mirrors the output shape of
`glossary.ts` without reimplementing its ending table; it is not general Russian morphology.

Insertions are charged to B-WER when the inserted hypothesis token is covered by a glossary term
occurrence, or when the insertion falls between two reference tokens of one multi-word term
occurrence. For example, with term `pull request`, `open pull request now` versus
`open pull the request now` charges `the` to B-WER even though `the` is not a term token, because
it splits a reference term occurrence. Every other insertion goes to U-WER. Substitutions and
deletions are attributed by the reference token. B-WER's denominator remains the number of biased
reference words, so biased insertions can make it exceed 1; when that denominator is zero the value
is `null`, not 0, even if biased insertions exist. U-WER uses all non-biased reference words.

Term occurrences are extracted non-overlapping and leftmost-longest per item; equal token lengths
keep glossary input order. Counts are then aggregated over the whole corpus with multiset
intersection, so a missed occurrence in one item can be offset by an extra occurrence in another.
Terms are case-insensitive because they use `normalizeForWer`; identifier casing is not scored by
this slice.

### Evaluation-set fingerprints

`scoreEval` refuses duplicate item ids with a `TypeError`. It records a SHA-256 fingerprint per
item over the id and normalised reference tokens, sorted by id, plus one over the sorted compiled
glossary keys. `compareEval` requires both before evaluating a gate: the same id with a changed
reference is `item_mismatch`, and a different scoring glossary is `glossary_mismatch`. Refusal
precedence is `empty`, `item_mismatch`, `glossary_mismatch`, `mixed_origin`, `synthetic_eval`.

A V2 candidate changes the glossary used for **replacement**, not the term list used for
**scoring**. Callers must score the baseline and the candidate with the same scoring term list; the
glossary fingerprint enforces this because a different list changes the term metrics and their
denominators.

### Origin and gates

`scoreEval` reports `origin` as `synthetic`, `owner_recording`, `mixed` or `empty`, counts both
origins, and keeps a sorted `itemIds` list. `compareEval` converts metric differences to percentage
points, rounded to nine decimals so inclusive boundaries are stable, and refuses evidence unless
both reports are non-empty owner recordings over the same item references and scoring glossary.

- `v1Gate` is evaluated only on that evidence. Its `reason` is `owner_recordings`; `met` is true
  only when the term-F1 delta is at least 10 points and the U-WER delta is at most 1 point, both
  inclusive. A missing delta leaves `met` false.
- Refusal reasons, in precedence order, are `empty`, `item_mismatch`, `glossary_mismatch`,
  `mixed_origin` and `synthetic_eval`; refused gates omit `met`.
- `v2Apply` is the ADR-0028 §5 pre-apply gate. It is allowed only on the same owner-recording
  evidence, with a term-F1 delta of at least 0 and a U-WER delta of at most 1 point, both
  inclusive. It reports `within_bounds`, `term_f1_drop`, `u_wer_rise` or `missing_metrics`.
  Synthetic evidence is never auto-appliable: `allowed` is false and the reason is
  `synthetic_eval`, even when the metrics would otherwise pass.

### Limits

This slice does not contain the owner's 100–150-recording eval set, STT adapters, audio, backend
biasing, a candidate queue or store, auto-apply/revert, a review UI or `voice.flag_term`. It
reports point estimates only: no paired bootstrap confidence interval or significance test.
Corpus-level term matching can offset one item's miss with another item's extra term. The V1 exit
gate is not measurable until the owner's recordings exist; V1 remains in progress.
