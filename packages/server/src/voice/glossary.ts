/**
 * Deterministic post-ASR glossary replacement with transliteration-aware matching.
 *
 * Pure and in-memory: no storage, no STT adapter, no network and no module-level mutable state.
 */

import { foldKey } from './translit.ts'

export type GlossaryLanguage = 'en' | 'ru' | 'any'

export interface GlossaryEntry {
  /** Stable identifier used in replacements and collision errors. */
  id: string
  /** Preferred output spelling; always used as the replacement casing. */
  canonical: string
  /** Explicit spoken or misrecognised forms, in any script. */
  variants: string[]
  /** Language of the canonical term. */
  language: GlossaryLanguage
  /** Match the original's exact form instead of the folding key. Defaults to false. */
  caseSensitive?: boolean
  /** Inflect Latin English canonicals in Cyrillic text per D-157. Defaults to true. */
  inflect?: boolean
}

export interface Replacement {
  start: number
  end: number
  original: string
  replacement: string
  entryId: string
}

export interface ReplaceResult {
  text: string
  replacements: Replacement[]
}

export type CompiledGlossaryEntry = Readonly<
  Omit<GlossaryEntry, 'variants'> & { variants: readonly string[] }
>

export interface CompiledGlossary {
  /** Normalised, frozen copy of the input entries in input order. */
  readonly entries: readonly CompiledGlossaryEntry[]
}

interface CompiledForm {
  readonly entryIndex: number
  readonly key: string
  readonly raw: string
  readonly wordCount: number
  readonly caseSensitive: boolean
}

interface CompiledMatcher {
  readonly entries: readonly CompiledGlossaryEntry[]
  readonly byKey: ReadonlyMap<string, readonly CompiledForm[]>
  readonly inflectByKey: ReadonlyMap<string, readonly CompiledForm[]>
  readonly maxWordCount: number
}

const MATCHER = Symbol('guanxi.glossary.matcher')

interface CompiledGlossaryInternal extends CompiledGlossary {
  readonly [MATCHER]: CompiledMatcher
}

interface TextToken {
  readonly start: number
  readonly end: number
  readonly key: string
}

interface Match {
  readonly entryIndex: number
  readonly replacement: string
  readonly tokenCount: number
}

const LATIN_LETTER = /\p{Script=Latin}/u
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u
const LETTER = /\p{L}/u
const COMBINING_MARK = /\p{M}/u

/** Longest endings first. */
const RUSSIAN_ENDINGS: readonly string[] = Object.freeze([
  'ами',
  'ями',
  'ах',
  'ях',
  'ов',
  'ев',
  'ей',
  'ом',
  'ем',
  'ой',
  'ою',
  'ую',
  'ам',
  'ям',
  'а',
  'я',
  'у',
  'ю',
  'е',
  'ы',
  'и',
  'о',
])

function countLetters(value: string): number {
  let count = 0
  for (const character of value) {
    if (LETTER.test(character)) count += 1
  }
  return count
}

interface LowerWithoutMarks {
  readonly text: string
  /** Original offset of each comparison character, plus the end offset. */
  readonly boundaries: readonly number[]
}

/** Lower-case and strip combining marks while keeping original offsets for the output slice. */
function lowerWithoutMarks(value: string): LowerWithoutMarks {
  const characters: string[] = []
  const boundaries: number[] = []
  let offset = 0
  while (offset < value.length) {
    const base = String.fromCodePoint(value.codePointAt(offset)!)
    let end = offset + base.length
    let cluster = base
    while (end < value.length) {
      const next = String.fromCodePoint(value.codePointAt(end)!)
      if (!COMBINING_MARK.test(next)) break
      cluster += next
      end += next.length
    }
    for (const character of cluster.normalize('NFC').toLowerCase().replace(/\p{M}+/gu, '')) {
      characters.push(character)
      boundaries.push(offset)
    }
    offset = end
  }
  boundaries.push(value.length)
  return { text: characters.join(''), boundaries }
}

function isCyrillicOnly(value: string): boolean {
  let hasCyrillic = false
  for (const character of value) {
    if (!LETTER.test(character)) continue
    if (!CYRILLIC_LETTER.test(character)) return false
    hasCyrillic = true
  }
  return hasCyrillic
}

function isInflectable(entry: GlossaryEntry, caseSensitive: boolean, inflect: boolean): boolean {
  return (
    entry.language === 'en' &&
    inflect &&
    !caseSensitive &&
    LATIN_LETTER.test(entry.canonical) &&
    !CYRILLIC_LETTER.test(entry.canonical)
  )
}

function normalizeEntry(entry: GlossaryEntry): CompiledGlossaryEntry {
  return Object.freeze({
    id: entry.id,
    canonical: entry.canonical,
    variants: Object.freeze(entry.variants) as readonly string[],
    language: entry.language,
    caseSensitive: entry.caseSensitive,
    inflect: entry.inflect,
  })
}

/**
 * Validate and precompile a glossary. Throws `TypeError` on bad input.
 *
 * Keys must be unique across entries: a canonical or variant key of one entry may not equal any
 * canonical or variant key of another entry. Duplicate keys inside one entry are allowed.
 */
export function compileGlossary(entries: GlossaryEntry[]): CompiledGlossary {
  if (!Array.isArray(entries)) {
    throw new TypeError('Glossary entries must be an array')
  }

  const ids = new Set<string>()
  const keyOwners = new Map<string, string>()
  const byKey = new Map<string, CompiledForm[]>()
  const inflectByKey = new Map<string, CompiledForm[]>()
  const normalizedEntries: CompiledGlossaryEntry[] = []
  let maxWordCount = 0

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Glossary entry at index ${entryIndex} must be an object`)
    }
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
      throw new TypeError(`Glossary entry at index ${entryIndex} has an empty id`)
    }
    if (ids.has(entry.id)) {
      throw new TypeError(`Glossary contains a duplicate id "${entry.id}"`)
    }
    ids.add(entry.id)

    if (typeof entry.canonical !== 'string') {
      throw new TypeError(`Glossary entry "${entry.id}" has a non-string canonical term`)
    }
    const canonical = entry.canonical.trim()
    if (canonical.length === 0) {
      throw new TypeError(`Glossary entry "${entry.id}" has an empty canonical term`)
    }

    if (!Array.isArray(entry.variants)) {
      throw new TypeError(`Glossary entry "${entry.id}" must have a variants array`)
    }
    if (entry.language !== 'en' && entry.language !== 'ru' && entry.language !== 'any') {
      throw new TypeError(`Glossary entry "${entry.id}" has an invalid language`)
    }
    if (entry.caseSensitive !== undefined && typeof entry.caseSensitive !== 'boolean') {
      throw new TypeError(`Glossary entry "${entry.id}" has a non-boolean caseSensitive flag`)
    }
    if (entry.inflect !== undefined && typeof entry.inflect !== 'boolean') {
      throw new TypeError(`Glossary entry "${entry.id}" has a non-boolean inflect flag`)
    }

    const variants: string[] = []
    for (const variant of entry.variants) {
      if (typeof variant !== 'string') {
        throw new TypeError(`Glossary entry "${entry.id}" has a non-string variant`)
      }
      const trimmed = variant.trim()
      if (foldKey(trimmed).length === 0) {
        throw new TypeError(`Glossary entry "${entry.id}" has a variant with an empty fold key`)
      }
      variants.push(trimmed)
    }

    const canonicalKey = foldKey(canonical)
    if (canonicalKey.length === 0) {
      throw new TypeError(`Glossary entry "${entry.id}" has a canonical term with an empty fold key`)
    }

    const caseSensitive = entry.caseSensitive === true
    const inflect = entry.inflect !== false
    const inflectable = isInflectable(entry, caseSensitive, inflect)

    normalizedEntries.push(
      normalizeEntry({
        ...entry,
        canonical,
        variants,
        caseSensitive,
        inflect,
      }),
    )

    const forms: Array<{ raw: string; key: string }> = [
      { raw: canonical, key: canonicalKey },
      ...variants.map((variant) => ({ raw: variant, key: foldKey(variant) })),
    ]
    for (const form of forms) {
      const wordCount = form.raw.split(/\s+/u).length
      maxWordCount = Math.max(maxWordCount, wordCount)
      const owner = keyOwners.get(form.key)
      if (owner !== undefined && owner !== entry.id) {
        throw new TypeError(
          `Glossary key collision for "${form.key}" between entries "${owner}" and "${entry.id}"`,
        )
      }
      keyOwners.set(form.key, entry.id)

      const compiledForm: CompiledForm = {
        entryIndex,
        key: form.key,
        raw: form.raw,
        wordCount,
        caseSensitive,
      }
      const bucket = byKey.get(form.key)
      if (bucket === undefined) byKey.set(form.key, [compiledForm])
      else bucket.push(compiledForm)

      if (inflectable && CYRILLIC_LETTER.test(form.raw)) {
        const inflectBucket = inflectByKey.get(form.key)
        if (inflectBucket === undefined) inflectByKey.set(form.key, [compiledForm])
        else inflectBucket.push(compiledForm)
      }
    }
  }

  const matcher: CompiledMatcher = {
    entries: Object.freeze(normalizedEntries),
    byKey,
    inflectByKey,
    maxWordCount,
  }
  const compiled: CompiledGlossaryInternal = {
    entries: matcher.entries,
    [MATCHER]: matcher,
  }
  return Object.freeze(compiled)
}

function markCodeSpans(text: string, protectedMask: Uint8Array): void {
  let index = 0
  while (index < text.length) {
    if (text[index] !== '`' || protectedMask[index] === 1) {
      index += 1
      continue
    }
    let openingEnd = index
    while (openingEnd < text.length && text[openingEnd] === '`') openingEnd += 1
    const runLength = openingEnd - index
    let cursor = openingEnd
    let closingEnd = -1
    while (cursor < text.length) {
      if (text[cursor] !== '`') {
        cursor += 1
        continue
      }
      let candidateEnd = cursor
      while (candidateEnd < text.length && text[candidateEnd] === '`') candidateEnd += 1
      if (protectedMask[cursor] !== 1 && candidateEnd - cursor === runLength) {
        closingEnd = candidateEnd
        break
      }
      cursor = candidateEnd
    }
    if (closingEnd < 0) {
      index = openingEnd
      continue
    }
    protectedMask.fill(1, index, closingEnd)
    index = closingEnd
  }
}

function isMasked(mask: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (mask[index] === 1) return true
  }
  return false
}

function directMatch(
  matcher: CompiledMatcher,
  key: string,
  raw: string,
  tokenCount: number,
): { entryIndex: number; replacement: string } | null {
  const forms = matcher.byKey.get(key)
  if (forms === undefined) return null
  for (const form of forms) {
    if (form.wordCount !== tokenCount) continue
    if (form.caseSensitive && form.raw !== raw) continue
    const entry = matcher.entries[form.entryIndex]
    if (entry === undefined) continue
    return { entryIndex: form.entryIndex, replacement: entry.canonical }
  }
  return null
}

function inflectionMatch(
  matcher: CompiledMatcher,
  tokens: readonly TextToken[],
  from: number,
  tokenCount: number,
  text: string,
  prefixKey: string,
): { entryIndex: number; replacement: string } | null {
  const first = tokens[from]!
  const last = tokens[from + tokenCount - 1]!
  const raw = text.slice(first.start, last.end)
  if (!isCyrillicOnly(raw)) return null

  const lastRaw = text.slice(last.start, last.end)
  const lastLower = lowerWithoutMarks(lastRaw)
  for (const ending of RUSSIAN_ENDINGS) {
    if (!lastLower.text.endsWith(ending)) continue
    const stemEnd = lastLower.boundaries[lastLower.text.length - ending.length]!
    const stem = lastRaw.slice(0, stemEnd)
    if (countLetters(stem) < 2) continue

    const key = prefixKey + foldKey(stem)
    const forms = matcher.inflectByKey.get(key)
    if (forms === undefined || forms.length === 0) continue
    const form = forms.find((candidate) => candidate.wordCount === tokenCount)
    if (form === undefined) continue
    const entry = matcher.entries[form.entryIndex]
    if (entry === undefined) continue
    const originalEnding = lastRaw.slice(stemEnd)
    return {
      entryIndex: form.entryIndex,
      replacement: `${entry.canonical}-${originalEnding}`,
    }
  }
  return null
}

function findMatch(
  matcher: CompiledMatcher,
  tokens: readonly TextToken[],
  from: number,
  text: string,
): Match | null {
  const maximum = Math.min(tokens.length - from, matcher.maxWordCount)
  let key = ''
  let best: Match | null = null
  for (let tokenCount = 1; tokenCount <= maximum; tokenCount += 1) {
    const prefixKey = key
    key += tokens[from + tokenCount - 1]!.key
    const first = tokens[from]!
    const last = tokens[from + tokenCount - 1]!
    const raw = text.slice(first.start, last.end)

    const direct = directMatch(matcher, key, raw, tokenCount)
    if (direct !== null) {
      best = { ...direct, tokenCount }
      continue
    }

    const inflected = inflectionMatch(matcher, tokens, from, tokenCount, text, prefixKey)
    if (inflected !== null) best = { ...inflected, tokenCount }
  }
  return best
}

/** Apply a compiled glossary to text. The input string is never mutated. */
export function applyGlossary(glossary: CompiledGlossary, text: string): ReplaceResult {
  if (glossary === null || typeof glossary !== 'object') {
    throw new TypeError('applyGlossary requires a glossary compiled by compileGlossary')
  }
  if (typeof text !== 'string') {
    throw new TypeError('applyGlossary requires a string input')
  }
  const matcher = (glossary as CompiledGlossaryInternal)[MATCHER]
  if (matcher === undefined) {
    throw new TypeError('applyGlossary requires a glossary compiled by compileGlossary')
  }

  const protectedMask = new Uint8Array(text.length)
  // Code spans first: a URL's `\S+` tail may otherwise swallow a closing backtick and make the
  // following code span unprotected.
  markCodeSpans(text, protectedMask)
  for (const match of text.matchAll(/https?:\/\/\S+/giu)) {
    const start = match.index
    if (start === undefined) continue
    protectedMask.fill(1, start, start + match[0].length)
  }

  const tokens: TextToken[] = []
  const tokenPattern =
    /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['-][\p{L}\p{N}\p{M}]+)*/gu
  for (const match of text.matchAll(tokenPattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (isMasked(protectedMask, start, end)) continue
    const key = foldKey(match[0])
    if (key.length === 0) continue
    tokens.push({ start, end, key })
  }

  const groups: TextToken[][] = []
  let group: TextToken[] = []
  for (const token of tokens) {
    const previous = group[group.length - 1]
    if (previous !== undefined && token.start === previous.end + 1 && text[previous.end] === ' ') {
      group.push(token)
    } else {
      if (group.length > 0) groups.push(group)
      group = [token]
    }
  }
  if (group.length > 0) groups.push(group)

  const replacements: Replacement[] = []
  for (const tokenGroup of groups) {
    let index = 0
    while (index < tokenGroup.length) {
      const match = findMatch(matcher, tokenGroup, index, text)
      if (match === null) {
        index += 1
        continue
      }
      const entry = matcher.entries[match.entryIndex]
      if (entry === undefined) {
        index += 1
        continue
      }
      const first = tokenGroup[index]!
      const last = tokenGroup[index + match.tokenCount - 1]!
      const original = text.slice(first.start, last.end)
      if (original !== match.replacement) {
        replacements.push({
          start: first.start,
          end: last.end,
          original,
          replacement: match.replacement,
          entryId: entry.id,
        })
      }
      index += match.tokenCount
    }
  }

  if (replacements.length === 0) return { text, replacements: [] }

  let output = ''
  let cursor = 0
  for (const replacement of replacements) {
    output += text.slice(cursor, replacement.start)
    output += replacement.replacement
    cursor = replacement.end
  }
  output += text.slice(cursor)
  return { text: output, replacements }
}
