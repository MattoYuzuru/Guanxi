/**
 * Search snippets built from scrubbed text (K2 review fixes).
 *
 * FTS5's own `snippet()` cuts text at token boundaries, so it can split a
 * redaction marker or slip highlight characters into a value registered after
 * the event was written, which then no longer matches exactly. The log instead
 * scrubs the whole indexed text, keeps a hit only if a query term still occurs
 * in it, and cuts a window that never splits a marker.
 */
import {
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_PREFIX,
  SEARCH_MATCH_CLOSE,
  SEARCH_MATCH_OPEN,
} from '@guanxi/contract'

const WINDOW = 80
const MAX_SNIPPET = 240

/** Folds text the way the FTS5 tokenizer compares it: case, Latin diacritics and ё. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ё', 'е')
}

/** Query terms as the tokenizer splits them: runs of letters and digits. */
export function searchTerms(query: string): string[] {
  return [...new Set((fold(query).match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 0))]
}

interface Span {
  start: number
  end: number
  marker: boolean
}

function spansOf(text: string): Span[] {
  const spans: Span[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(REDACTION_MARKER_PREFIX, cursor)
    const end = start < 0 ? -1 : text.indexOf(REDACTION_MARKER_CLOSE, start)
    if (start < 0 || end < 0) {
      spans.push({ start: cursor, end: text.length, marker: false })
      break
    }
    if (start > cursor) spans.push({ start: cursor, end: start, marker: false })
    spans.push({ start, end: end + REDACTION_MARKER_CLOSE.length, marker: true })
    cursor = end + REDACTION_MARKER_CLOSE.length
  }
  return spans
}

/** Folded text with a map from each folded index back to the original index. */
function foldWithMap(text: string, from: number, to: number): { folded: string; origin: number[] } {
  let folded = ''
  const origin: number[] = []
  for (let index = from; index < to;) {
    const codePoint = text.codePointAt(index)!
    const character = String.fromCodePoint(codePoint)
    const piece = fold(character)
    for (let k = 0; k < piece.length; k++) origin.push(index)
    folded += piece
    index += character.length
  }
  origin.push(to)
  return { folded, origin }
}

function matchesIn(text: string, span: Span, terms: string[]): { start: number; end: number }[] {
  const { folded, origin } = foldWithMap(text, span.start, span.end)
  const found: { start: number; end: number }[] = []
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
      found.push({ start: origin[at]!, end: origin[at + term.length]! })
    }
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * The snippet for one hit, or `null` when no query term occurs in the scrubbed
 * text (the term matched only inside a value that is now redacted).
 */
export function buildSnippet(scrubbed: string, terms: readonly string[]): string | null {
  if (terms.length === 0) return null
  const spans = spansOf(scrubbed)
  const plain = spans.filter((span) => !span.marker)
  const markerText = fold(spans.filter((span) => span.marker).map((span) => scrubbed.slice(span.start, span.end)).join(' '))
  const plainMatches = plain.flatMap((span) => matchesIn(scrubbed, span, [...terms]))
  const everyTermPresent = terms.every((term) =>
    markerText.includes(term) || plain.some((span) => fold(scrubbed.slice(span.start, span.end)).includes(term)))
  if (!everyTermPresent) return null

  const anchor = plainMatches[0]?.start ?? spans.find((span) => span.marker && fold(scrubbed.slice(span.start, span.end)).includes(terms[0]!))?.start ?? 0
  let start = Math.max(0, anchor - WINDOW)
  let end = Math.min(scrubbed.length, anchor + WINDOW)
  // Never cut a marker: widen the window to whole markers at both edges.
  for (const span of spans) {
    if (!span.marker) continue
    if (span.start < start && span.end > start) start = span.start
    if (span.start < end && span.end > end) end = span.end
  }
  if (end - start > MAX_SNIPPET) {
    end = start + MAX_SNIPPET
    for (const span of spans) if (span.marker && span.start < end && span.end > end) end = span.start
  }

  let output = start > 0 ? '…' : ''
  let cursor = start
  for (const match of plainMatches) {
    if (match.start < cursor || match.end > end) continue
    output += scrubbed.slice(cursor, match.start) + SEARCH_MATCH_OPEN + scrubbed.slice(match.start, match.end) + SEARCH_MATCH_CLOSE
    cursor = match.end
  }
  output += scrubbed.slice(cursor, end) + (end < scrubbed.length ? '…' : '')
  return output
}
