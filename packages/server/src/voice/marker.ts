/**
 * Voice-origin marker types, validation and the short agent-facing voice block.
 *
 * No contract, route or STT adapter is wired here yet. Offsets are JavaScript string offsets
 * into the final (post-replacement) prompt text.
 */

import { createHash } from 'node:crypto'

export interface VoiceConfidenceSpan {
  start: number
  end: number
  /** Calibrated or adapter-reported confidence in [0, 1]. */
  confidence: number
}

export interface VoiceReplacement {
  start: number
  end: number
  original: string
  replacement: string
  entryId: string
}

export interface VoiceOrigin {
  origin: 'voice'
  /** Adapter id, for example `whisper.cpp`. */
  backend: string
  model: string
  language: string | null
  /** Offsets into the final text, sorted and non-overlapping. */
  confidenceSpans: VoiceConfidenceSpan[]
  /** Replacement offsets refer to the final text. */
  replacements: VoiceReplacement[]
  /** Stable hash of the effective entry ids and revisions used. */
  glossaryRevision: string
}

export interface GlossaryRevisionEntry {
  id: string
  revision: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`Voice origin field "${field}" must be a non-empty string`)
  }
  return value
}

function requireOffset(value: unknown, field: string, length: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > length) {
    throw new TypeError(`Voice origin field "${field}" must be an integer in [0, ${length}]`)
  }
  return value
}

function requireSpan(value: unknown, field: string, length: number): { start: number; end: number } {
  if (!isRecord(value)) {
    throw new TypeError(`Voice origin field "${field}" must be an object`)
  }
  const start = requireOffset(value.start, `${field}.start`, length)
  const end = requireOffset(value.end, `${field}.end`, length)
  if (end < start) {
    throw new TypeError(`Voice origin field "${field}" must not end before it starts`)
  }
  return { start, end }
}

/**
 * Validate an untrusted voice-origin value against the final prompt text.
 *
 * Checks identity fields, sorted non-overlapping confidence spans, finite confidence values and
 * replacement slices. Throws `TypeError` on the first violation.
 */
export function validateVoiceOrigin(value: unknown, finalText: string): VoiceOrigin {
  if (typeof finalText !== 'string') {
    throw new TypeError('Voice origin validation requires the final text as a string')
  }
  if (!isRecord(value)) {
    throw new TypeError('Voice origin must be an object')
  }
  if (value.origin !== 'voice') {
    throw new TypeError('Voice origin field "origin" must be "voice"')
  }
  const backend = requireString(value.backend, 'backend')
  const model = requireString(value.model, 'model')
  const language = value.language === null ? null : requireString(value.language, 'language')
  const glossaryRevision = requireString(value.glossaryRevision, 'glossaryRevision')

  if (!Array.isArray(value.confidenceSpans)) {
    throw new TypeError('Voice origin field "confidenceSpans" must be an array')
  }
  const confidenceSpans: VoiceConfidenceSpan[] = []
  let previousEnd = 0
  for (const [index, raw] of value.confidenceSpans.entries()) {
    const field = `confidenceSpans[${index}]`
    const { start, end } = requireSpan(raw, field, finalText.length)
    if (start === end) {
      throw new TypeError(`Voice origin field "${field}" must not be zero-length`)
    }
    if (start < previousEnd) {
      throw new TypeError(`Voice origin field "${field}" is unsorted or overlaps the previous span`)
    }
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)
      || raw.confidence < 0 || raw.confidence > 1) {
      throw new TypeError(`Voice origin field "${field}.confidence" must be finite in [0, 1]`)
    }
    confidenceSpans.push({ start, end, confidence: raw.confidence })
    previousEnd = end
  }

  if (!Array.isArray(value.replacements)) {
    throw new TypeError('Voice origin field "replacements" must be an array')
  }
  const replacements: VoiceReplacement[] = []
  let previousReplacementEnd = 0
  for (const [index, raw] of value.replacements.entries()) {
    const field = `replacements[${index}]`
    const { start, end } = requireSpan(raw, field, finalText.length)
    if (start < previousReplacementEnd) {
      throw new TypeError(`Voice origin field "${field}" is unsorted or overlaps the previous span`)
    }
    const original = requireString(raw.original, `${field}.original`)
    const replacement = requireString(raw.replacement, `${field}.replacement`)
    const entryId = requireString(raw.entryId, `${field}.entryId`)
    if (finalText.slice(start, end) !== replacement) {
      throw new TypeError(
        `Voice origin field "${field}" does not match finalText[${start}..${end}]`,
      )
    }
    replacements.push({ start, end, original, replacement, entryId })
    previousReplacementEnd = end
  }

  return {
    origin: 'voice',
    backend,
    model,
    language,
    confidenceSpans,
    replacements,
    glossaryRevision,
  }
}

function quoted(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/gu, ' ').replace(/"/gu, "'")
  return `"${singleLine}"`
}

/**
 * Build a short agent-facing note.
 *
 * Mentions that the prompt was dictated, the backend/model/language and glossary revision, at
 * most five replaced terms and at most five low-confidence fragments from `finalText`. It never
 * contains audio, full prompt text or credentials. The result is always at most `maxChars`
 * characters.
 */
export function voiceBlock(origin: VoiceOrigin, finalText: string, maxChars = 400): string {
  const validated = validateVoiceOrigin(origin, finalText)
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) {
    throw new TypeError('voiceBlock maxChars must be a finite number')
  }
  const limit = Math.max(0, Math.floor(maxChars))
  if (limit === 0) return ''

  const language = validated.language === null ? 'unknown' : quoted(validated.language)
  const parts = [
    `Voice-origin prompt: dictated audio (backend ${quoted(validated.backend)}, model ${quoted(validated.model)}, language ${language}).`,
    `Glossary revision ${validated.glossaryRevision}.`,
  ]

  const replacements = validated.replacements.slice(0, 5)
  if (replacements.length > 0) {
    const items = replacements.map(
      (item) => `${quoted(item.original)} → ${quoted(item.replacement)}`,
    )
    const more = validated.replacements.length - replacements.length
    parts.push(`Replaced terms: ${items.join('; ')}${more > 0 ? `; (+${more} more)` : ''}.`)
  }

  const lowConfidence = validated.confidenceSpans
    .filter((span) => span.confidence < 0.6)
    .slice(0, 5)
  if (lowConfidence.length > 0) {
    const items = lowConfidence.map((span) => quoted(finalText.slice(span.start, span.end)))
    parts.push(`Low-confidence fragments: ${items.join('; ')}.`)
  }

  const note = parts.join(' ')
  if (note.length <= limit) return note
  if (limit === 1) return '…'
  return `${note.slice(0, limit - 1)}…`
}

function canonicalRevisionJson(entries: readonly GlossaryRevisionEntry[]): string {
  if (!Array.isArray(entries)) {
    throw new TypeError('Glossary revision entries must be an array')
  }
  const seen = new Set<string>()
  const normalized = entries.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`Glossary revision entry at index ${index} must be an object`)
    }
    const id = requireString(entry.id, `entries[${index}].id`)
    if (seen.has(id)) {
      throw new TypeError(`Glossary revision entries contain duplicate id "${id}"`)
    }
    seen.add(id)
    if (typeof entry.revision !== 'number' || !Number.isSafeInteger(entry.revision)
      || entry.revision < 1) {
      throw new TypeError(`Glossary revision entry "${id}" must have a positive integer revision`)
    }
    return { id, revision: entry.revision }
  })
  normalized.sort((first, second) => {
    if (first.id < second.id) return -1
    if (first.id > second.id) return 1
    return 0
  })
  return JSON.stringify(normalized)
}

/** SHA-256 of the canonical JSON of effective entry ids and revisions, independent of order. */
export function glossaryRevisionHash(entries: readonly GlossaryRevisionEntry[]): string {
  return createHash('sha256').update(canonicalRevisionJson(entries)).digest('hex')
}
