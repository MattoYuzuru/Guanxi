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

A candidate is a run of Unicode word tokens joined by single spaces. A candidate matches when
its folded key equals a canonical or variant key; multi-word forms therefore match token
sequences separated by single spaces. Longest matches win, then input order; matches never
overlap. Matching is case-insensitive unless `caseSensitive` is set, and output always uses the
canonical casing.

Explicit variants are required for irregular spellings because the key only bridges script and
common phonetic drift (`Guanxi` and `гуанси` deliberately differ; the variant carries the
exception).

For a Latin `language: 'en'` canonical with `inflect` not `false`, a Cyrillic candidate may lose
one Russian ending and keep it after a hyphen (D-157): `пиара` becomes `PR-а`, `воркт триах`
becomes `worktree-ах`. `inflect: false` and `caseSensitive: true` disable this. Stems shorter than
two letters are rejected.

Text inside backtick code spans and `https?://\S+` URLs is protected. All other characters,
including spacing and newlines, are preserved byte-for-byte.

## Limits

Per-project storage, biasing for STT backends, voice-origin markers, `voice.flag_term` and the
learning loop are later V1/V2 slices. An unclosed backtick does not create a protected span.
Canonicals and variants must be word-token sequences: edge punctuation such as `C++` or `Hono!`
is not absorbed into the matched span and is outside this module's contract. Cyrillic-mapped
Latin is not re-fed through the Latin digraph rules, so mixed-script digraphs split across a
script boundary are not bridged; use explicit variants.
