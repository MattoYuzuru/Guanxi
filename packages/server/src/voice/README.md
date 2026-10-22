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
Stems shorter than two letters are rejected.

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
`finalText.slice(start, end)`. `voiceBlock` states that the prompt was dictated, names the
backend, model, language and glossary revision, lists at most five replaced terms and at most
five low-confidence (<0.6) quoted fragments, and truncates to `maxChars`. The final text is
retained on the validated origin only as a non-enumerable in-process symbol, so it is never
serialised. `glossaryRevisionHash` is SHA-256 over sorted `{id, revision}` JSON and is
independent of input order.

Limits: this slice does not add plugin wiring, an HTTP route, a contract type, a web glossary
editor, an STT adapter, backend biasing mapping, the `voice.flag_term` tool or V2 candidate
learning. The V1 exit gate still needs the owner's evaluation recordings and is not measurable
here.
