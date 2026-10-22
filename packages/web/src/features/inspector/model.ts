/**
 * Pure inspector state: the timeline a reload rebuilds from the log must equal
 * the one a live subscriber built, so merging is by `seq` and idempotent.
 */
import {
  INPUT_EXCERPT_BYTES,
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_OPEN,
  REDACTION_MARKER_PREFIX,
  promptTextOf,
  toolCallArgumentsTextOf,
  type SessionEvent,
  type SessionEventType,
  type SessionInputArtifactRef,
} from '@guanxi/contract'
import { translate, type LocaleKey } from '../../lib/locale.ts'

const WRITER_REASON_KEYS = {
  initial: 'inspector.writerReason.initial',
  released: 'inspector.writerReason.released',
  expired: 'inspector.writerReason.expired',
  writer_process_gone: 'inspector.writerReason.processGone',
} as const satisfies Record<string, LocaleKey>

export interface TimelineState {
  /** Events in `seq` order, each `seq` once. */
  events: SessionEvent[]
  lastSeq: number
}

export const EMPTY_TIMELINE: TimelineState = { events: [], lastSeq: 0 }

/** Merges events into the timeline; a repeated `seq` keeps the stored copy. */
export function mergeEvents(state: TimelineState, incoming: readonly SessionEvent[]): TimelineState {
  if (incoming.length === 0) return state
  const bySeq = new Map(state.events.map((event) => [event.seq, event]))
  let changed = false
  for (const event of incoming) {
    if (bySeq.has(event.seq)) continue
    bySeq.set(event.seq, event)
    changed = true
  }
  if (!changed) return state
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return { events, lastSeq: events.at(-1)?.seq ?? 0 }
}

export function countByType(events: readonly SessionEvent[]): Partial<Record<SessionEventType, number>> {
  const counts: Partial<Record<SessionEventType, number>> = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

export type TextSegment = { kind: 'text'; text: string } | { kind: 'redacted'; ref: string }

/** Splits scrubbed text so redaction markers render as badges, never as raw brackets. */
export function segmentRedactions(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const start = text.indexOf(REDACTION_MARKER_PREFIX, cursor)
    if (start < 0) break
    const end = text.indexOf(REDACTION_MARKER_CLOSE, start)
    if (end < 0) break
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    segments.push({ kind: 'redacted', ref: text.slice(start + REDACTION_MARKER_PREFIX.length, end) })
    cursor = end + REDACTION_MARKER_CLOSE.length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * A marker-safe UTF-8 prefix for display. The inspector never needs the full
 * executable value; a legacy inline item can be much larger than the published
 * excerpt bound, so rows show a bounded preview and say so.
 */
export function boundedPreview(text: string, maxBytes = INPUT_EXCERPT_BYTES): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  const clipped = new TextDecoder().decode(bytes.subarray(0, end))
  // Only a real `⟦REDACTED …⟧` marker gets marker-safe backtracking. An
  // ordinary decorative `⟦` is user text and must keep its maximal prefix.
  const open = clipped.lastIndexOf(REDACTION_MARKER_OPEN)
  if (open < 0 || clipped.indexOf(REDACTION_MARKER_CLOSE, open) >= 0) return clipped
  if (!text.startsWith(REDACTION_MARKER_PREFIX, open)) return clipped
  if (text.indexOf(REDACTION_MARKER_CLOSE, open + REDACTION_MARKER_PREFIX.length) < 0) return clipped
  return clipped.slice(0, open)
}

export type QueueRenderItem =
  | {
      id: string
      kind: 'inline'
      text: string
      shownBytes: number
      totalBytes: number
      artifact: null
    }
  | {
      id: string
      kind: 'artifact'
      text: string
      shownBytes: number
      totalBytes: number
      artifact: SessionInputArtifactRef
    }

/** One bounded display row per queue item, in snapshot order, including legacy v1 entries. */
export function queueRenderItems(event: Extract<SessionEvent, { type: 'agent.queue' }>): QueueRenderItem[] {
  return event.data.items.map((item) => {
    if ('kind' in item && item.kind === 'artifact') {
      const text = boundedPreview(item.artifact.excerpt)
      return {
        id: item.id,
        kind: 'artifact' as const,
        text,
        shownBytes: utf8Bytes(text),
        totalBytes: item.artifact.byteSize,
        artifact: item.artifact,
      }
    }
    const text = boundedPreview(item.text)
    return {
      id: item.id,
      kind: 'inline' as const,
      text,
      shownBytes: utf8Bytes(text),
      totalBytes: utf8Bytes(item.text),
      artifact: null,
    }
  })
}

/** Short machine-value summary of an event for its timeline row. */
export function eventDetail(event: SessionEvent): string | null {
  switch (event.type) {
    case 'agent.policy':
      return event.data.mode
    case 'agent.state':
      return translate(`native.${event.data.status}`)
    case 'agent.plan':
      return event.data.items.map(item => item.text).join('\n')
    case 'agent.queue':
      // Rendered per item by QueueBody; joining would hide item boundaries and
      // could put an unbounded legacy tail into one paragraph.
      return null
    case 'agent.note':
      return event.data.text
    case 'prompt':
      return promptTextOf(event)
    case 'assistant.message':
      return event.data.text
    case 'reasoning':
      return event.data?.text ?? null
    case 'tool.call':
      return `${event.data.name} ${toolCallArgumentsTextOf(event)}`
    case 'tool.result':
      return event.data.error ?? event.data.result
    case 'tool.approval':
      return event.data.toolCallId
    case 'assistant.started':
      return `${event.data.model} · ${event.data.step}`
    case 'run.lifecycle':
      return `${event.data.runId} · ${event.data.state} · ${event.data.action}`
    case 'job.lifecycle':
      return event.data.phase ? `${event.data.state} · ${event.data.phase}` : event.data.state
    case 'usage':
      return `${event.data.promptTokens} → ${event.data.evalTokens}`
    case 'context':
      return `${event.data.usedTokens} / ${event.data.allocatedTokens}`
    case 'turn.done':
      return event.data.outcome ?? event.data.stopReason
    case 'error':
      return `${event.data.code}: ${event.data.message}`
    case 'intervention':
      // The type label already says the person stopped it; the reason code is internal.
      return null
    case 'writer.acquired':
      return translate('inspector.detail.writer', {
        epoch: event.data.epoch,
        reason: translate(WRITER_REASON_KEYS[event.data.reason]),
      })
    case 'session.created':
      return event.data.kind
  }
}

/** Nesting depth of an event's span for indentation (turn 0, step 1, tool 2). */
export function spanDepth(spanId: string | null): number {
  if (!spanId) return 0
  if (spanId.startsWith('tool:')) return 2
  if (spanId.startsWith('step:')) return 1
  return 0
}
