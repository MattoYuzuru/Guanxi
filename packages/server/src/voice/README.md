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

Evidence: `ms2-glossary-routes.test.ts` (13 tests), the voice parts of `ms2-plugins.test.ts` and
`ms2-contract.test.ts`.

Still later: the glossary editor UI, STT adapters and backend biasing, `voice.flag_term` and V2
candidate learning.
