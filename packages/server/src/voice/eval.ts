/**
 * Deterministic word-error and glossary-term evaluation for the V1 voice gate.
 *
 * Pure and in-memory: no storage, STT adapter, network, filesystem or module-level mutable state.
 * B-WER/U-WER follow the standard biased/unbiased split (Le et al., Interspeech 2021): reference
 * words covered by a glossary term are biased, all other reference words are unbiased, and an
 * insertion is biased only when the inserted hypothesis token belongs to a glossary term.
 */

export type EvalOrigin = 'synthetic' | 'owner_recording'

export interface EvalItem {
  id: string
  reference: string
  hypothesis: string
  origin: EvalOrigin
}

export type AlignmentOp = 'ok' | 'sub' | 'del' | 'ins'

export interface AlignmentStep {
  op: AlignmentOp
  ref?: string
  hyp?: string
}

export interface WordErrors {
  substitutions: number
  deletions: number
  insertions: number
  alignment: AlignmentStep[]
}

export interface EvalCounts {
  items: number
  syntheticItems: number
  ownerRecordingItems: number
  refWords: number
  hypWords: number
  substitutions: number
  deletions: number
  insertions: number
  errors: number
  biasedRefWords: number
  unbiasedRefWords: number
  biasedSubstitutions: number
  biasedDeletions: number
  biasedInsertions: number
  unbiasedSubstitutions: number
  unbiasedDeletions: number
  unbiasedInsertions: number
  biasedErrors: number
  unbiasedErrors: number
  termRefOccurrences: number
  termHypOccurrences: number
  matchedTermOccurrences: number
}

export interface EvalScore {
  wer: number | null
  bWer: number | null
  uWer: number | null
  termPrecision: number | null
  termRecall: number | null
  termF1: number | null
  counts: EvalCounts
  origin: EvalOrigin | 'mixed' | 'empty'
  /** Sorted item ids, used by the gate comparison to require the same evaluation set. */
  itemIds: string[]
}

const WORD_TOKEN = /[\p{L}\p{N}\p{M}]+(?:[-'][\p{L}\p{N}\p{M}]+)*/gu

const CYRILLIC_SUFFIX = /^[\p{Script=Cyrillic}\p{M}]+$/u
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/u

/**
 * Normalise text for word-error scoring.
 *
 * Order: NFC, lower-case, `ё` to `е`, tokenise. Tokens are runs of Unicode letters, numbers and
 * combining marks; a hyphen or apostrophe is kept only between two such runs. All other
 * punctuation is stripped and whitespace is collapsed by the token scan.
 */
export function normalizeForWer(text: string): string[] {
  if (typeof text !== 'string') {
    throw new TypeError('normalizeForWer requires a string')
  }
  const normalized = text.normalize('NFC').toLowerCase().replace(/ё/gu, 'е')
  return normalized.match(WORD_TOKEN) ?? []
}

/**
 * Levenshtein word alignment with a deterministic tie-break.
 *
 * The traceback prefers, in order: an equal-token diagonal step (`ok`), a diagonal substitution,
 * a deletion from the reference and an insertion from the hypothesis. Ambiguous optima therefore
 * always produce the same alignment for the same input.
 */
export function wordErrors(ref: string[], hyp: string[]): WordErrors {
  if (!Array.isArray(ref) || !Array.isArray(hyp)) {
    throw new TypeError('wordErrors requires reference and hypothesis token arrays')
  }

  const refLength = ref.length
  const hypLength = hyp.length
  const width = hypLength + 1
  const matrix = new Int32Array((refLength + 1) * width)

  for (let refIndex = 0; refIndex <= refLength; refIndex += 1) {
    matrix[refIndex * width] = refIndex
  }
  for (let hypIndex = 0; hypIndex <= hypLength; hypIndex += 1) {
    matrix[hypIndex] = hypIndex
  }

  for (let refIndex = 1; refIndex <= refLength; refIndex += 1) {
    for (let hypIndex = 1; hypIndex <= hypLength; hypIndex += 1) {
      const cell = refIndex * width + hypIndex
      if (ref[refIndex - 1] === hyp[hypIndex - 1]) {
        matrix[cell] = matrix[(refIndex - 1) * width + hypIndex - 1]!
        continue
      }
      const substitution = matrix[(refIndex - 1) * width + hypIndex - 1]!
      const deletion = matrix[(refIndex - 1) * width + hypIndex]!
      const insertion = matrix[refIndex * width + hypIndex - 1]!
      matrix[cell] = 1 + Math.min(substitution, deletion, insertion)
    }
  }

  let substitutions = 0
  let deletions = 0
  let insertions = 0
  const reversed: AlignmentStep[] = []
  let refIndex = refLength
  let hypIndex = hypLength

  while (refIndex > 0 || hypIndex > 0) {
    const cell = matrix[refIndex * width + hypIndex]!
    const reference = refIndex > 0 ? ref[refIndex - 1]! : undefined
    const hypothesis = hypIndex > 0 ? hyp[hypIndex - 1]! : undefined

    if (
      refIndex > 0 &&
      hypIndex > 0 &&
      reference === hypothesis &&
      cell === matrix[(refIndex - 1) * width + hypIndex - 1]!
    ) {
      reversed.push({ op: 'ok', ref: reference, hyp: hypothesis })
      refIndex -= 1
      hypIndex -= 1
      continue
    }

    if (
      refIndex > 0 &&
      hypIndex > 0 &&
      cell === matrix[(refIndex - 1) * width + hypIndex - 1]! + 1
    ) {
      reversed.push({ op: 'sub', ref: reference, hyp: hypothesis })
      substitutions += 1
      refIndex -= 1
      hypIndex -= 1
      continue
    }

    if (refIndex > 0 && cell === matrix[(refIndex - 1) * width + hypIndex]! + 1) {
      reversed.push({ op: 'del', ref: reference })
      deletions += 1
      refIndex -= 1
      continue
    }

    if (hypIndex > 0 && cell === matrix[refIndex * width + hypIndex - 1]! + 1) {
      reversed.push({ op: 'ins', hyp: hypothesis })
      insertions += 1
      hypIndex -= 1
      continue
    }

    // The matrix is built from the same recurrence, so a complete traceback always exists.
    throw new Error('wordErrors: inconsistent alignment matrix')
  }

  return {
    substitutions,
    deletions,
    insertions,
    alignment: reversed.reverse(),
  }
}

interface CompiledTerm {
  readonly key: string
  readonly tokens: readonly string[]
}

function compileGlossaryTerms(glossaryTerms: string[]): CompiledTerm[] {
  const seen = new Set<string>()
  const compiled: CompiledTerm[] = []
  for (const glossaryTerm of glossaryTerms) {
    const tokens = normalizeForWer(glossaryTerm)
    if (tokens.length === 0) continue
    const key = tokens.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    compiled.push({ key, tokens })
  }
  return compiled
}

function termTokenMatches(token: string, termToken: string): boolean {
  if (token === termToken) return true
  const prefix = `${termToken}-`
  if (!token.startsWith(prefix)) return false
  const ending = token.slice(prefix.length)
  return ending.length > 0 && CYRILLIC_SUFFIX.test(ending) && CYRILLIC_LETTER.test(ending)
}

function matchesTermAt(tokens: string[], index: number, term: CompiledTerm): boolean {
  if (index + term.tokens.length > tokens.length) return false
  for (let offset = 0; offset < term.tokens.length - 1; offset += 1) {
    if (tokens[index + offset] !== term.tokens[offset]) return false
  }
  return termTokenMatches(tokens[index + term.tokens.length - 1]!, term.tokens[term.tokens.length - 1]!)
}

/** Mark every token covered by any glossary term occurrence, including overlapping ones. */
function collectBiasedTokens(tokens: string[], terms: CompiledTerm[]): Uint8Array {
  const marks = new Uint8Array(tokens.length)
  for (const term of terms) {
    for (let index = 0; index + term.tokens.length <= tokens.length; index += 1) {
      if (matchesTermAt(tokens, index, term)) {
        marks.fill(1, index, index + term.tokens.length)
      }
    }
  }
  return marks
}

/**
 * Extract non-overlapping term occurrences, leftmost-longest. A shorter term that starts later
 * never replaces a term already chosen at an earlier token; equal token lengths keep the glossary
 * input order.
 */
function extractTermOccurrences(tokens: string[], terms: CompiledTerm[]): string[] {
  const occurrences: string[] = []
  let index = 0
  while (index < tokens.length) {
    let best: CompiledTerm | null = null
    for (const term of terms) {
      if (!matchesTermAt(tokens, index, term)) continue
      if (best === null || term.tokens.length > best.tokens.length) best = term
    }
    if (best === null) {
      index += 1
      continue
    }
    occurrences.push(best.key)
    index += best.tokens.length
  }
  return occurrences
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/**
 * Score a corpus of reference/hypothesis pairs.
 *
 * Corpus metrics aggregate token counts, not per-item averages. B-WER and U-WER use reference
 * token counts as denominators; insertions in a glossary term are charged to B-WER, every other
 * insertion to U-WER. Term precision and recall use multiset matching over extracted term
 * occurrences and share the normalised token stream, so matching is case-insensitive.
 */
export function scoreEval(items: EvalItem[], glossaryTerms: string[]): EvalScore {
  if (!Array.isArray(items)) {
    throw new TypeError('scoreEval requires an items array')
  }
  if (!Array.isArray(glossaryTerms)) {
    throw new TypeError('scoreEval requires a glossaryTerms array')
  }

  const terms = compileGlossaryTerms(glossaryTerms)
  const itemIds: string[] = []
  const refTermCounts = new Map<string, number>()
  const hypTermCounts = new Map<string, number>()

  let syntheticItems = 0
  let ownerRecordingItems = 0
  let refWords = 0
  let hypWords = 0
  let substitutions = 0
  let deletions = 0
  let insertions = 0
  let biasedRefWords = 0
  let unbiasedRefWords = 0
  let biasedSubstitutions = 0
  let biasedDeletions = 0
  let biasedInsertions = 0
  let unbiasedSubstitutions = 0
  let unbiasedDeletions = 0
  let unbiasedInsertions = 0

  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      throw new TypeError('scoreEval items must be objects')
    }
    if (item.origin !== 'synthetic' && item.origin !== 'owner_recording') {
      throw new TypeError(`Eval item "${String(item.id)}" has an invalid origin`)
    }
    itemIds.push(item.id)
    if (item.origin === 'synthetic') syntheticItems += 1
    else ownerRecordingItems += 1

    const reference = normalizeForWer(item.reference)
    const hypothesis = normalizeForWer(item.hypothesis)
    refWords += reference.length
    hypWords += hypothesis.length

    const errors = wordErrors(reference, hypothesis)
    substitutions += errors.substitutions
    deletions += errors.deletions
    insertions += errors.insertions

    const refBiased = collectBiasedTokens(reference, terms)
    const hypBiased = collectBiasedTokens(hypothesis, terms)
    let biasedCount = 0
    for (const mark of refBiased) {
      if (mark === 1) biasedCount += 1
    }
    biasedRefWords += biasedCount
    unbiasedRefWords += reference.length - biasedCount

    let refIndex = 0
    let hypIndex = 0
    for (const step of errors.alignment) {
      if (step.op === 'ok') {
        refIndex += 1
        hypIndex += 1
        continue
      }
      if (step.op === 'sub') {
        if (refBiased[refIndex] === 1) biasedSubstitutions += 1
        else unbiasedSubstitutions += 1
        refIndex += 1
        hypIndex += 1
        continue
      }
      if (step.op === 'del') {
        if (refBiased[refIndex] === 1) biasedDeletions += 1
        else unbiasedDeletions += 1
        refIndex += 1
        continue
      }
      if (hypBiased[hypIndex] === 1) biasedInsertions += 1
      else unbiasedInsertions += 1
      hypIndex += 1
    }

    for (const key of extractTermOccurrences(reference, terms)) {
      refTermCounts.set(key, (refTermCounts.get(key) ?? 0) + 1)
    }
    for (const key of extractTermOccurrences(hypothesis, terms)) {
      hypTermCounts.set(key, (hypTermCounts.get(key) ?? 0) + 1)
    }
  }

  let termRefOccurrences = 0
  let termHypOccurrences = 0
  let matchedTermOccurrences = 0
  for (const [key, count] of refTermCounts) {
    termRefOccurrences += count
    matchedTermOccurrences += Math.min(count, hypTermCounts.get(key) ?? 0)
  }
  for (const count of hypTermCounts.values()) termHypOccurrences += count

  const biasedErrors = biasedSubstitutions + biasedDeletions + biasedInsertions
  const unbiasedErrors = unbiasedSubstitutions + unbiasedDeletions + unbiasedInsertions
  const errorCount = substitutions + deletions + insertions

  let origin: EvalScore['origin']
  if (items.length === 0) origin = 'empty'
  else if (syntheticItems === items.length) origin = 'synthetic'
  else if (ownerRecordingItems === items.length) origin = 'owner_recording'
  else origin = 'mixed'

  itemIds.sort()

  return {
    wer: ratio(errorCount, refWords),
    bWer: ratio(biasedErrors, biasedRefWords),
    uWer: ratio(unbiasedErrors, unbiasedRefWords),
    termPrecision: ratio(matchedTermOccurrences, termHypOccurrences),
    termRecall: ratio(matchedTermOccurrences, termRefOccurrences),
    termF1:
      termRefOccurrences + termHypOccurrences === 0
        ? null
        : (2 * matchedTermOccurrences) / (termRefOccurrences + termHypOccurrences),
    counts: {
      items: items.length,
      syntheticItems,
      ownerRecordingItems,
      refWords,
      hypWords,
      substitutions,
      deletions,
      insertions,
      errors: errorCount,
      biasedRefWords,
      unbiasedRefWords,
      biasedSubstitutions,
      biasedDeletions,
      biasedInsertions,
      unbiasedSubstitutions,
      unbiasedDeletions,
      unbiasedInsertions,
      biasedErrors,
      unbiasedErrors,
      termRefOccurrences,
      termHypOccurrences,
      matchedTermOccurrences,
    },
    origin,
    itemIds,
  }
}
