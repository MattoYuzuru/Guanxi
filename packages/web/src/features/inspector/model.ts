/**
 * Pure inspector state: the timeline a reload rebuilds from the log must equal
 * the one a live subscriber built, so merging is by `seq` and idempotent.
 */
import {
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_PREFIX,
  type SessionEvent,
  type SessionEventType,
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

/** Short machine-value summary of an event for its timeline row. */
export function eventDetail(event: SessionEvent): string | null {
  switch (event.type) {
    case 'prompt':
    case 'assistant.message':
      return event.data.text
    case 'reasoning':
      return event.data?.text ?? null
    case 'tool.call':
      return `${event.data.name} ${JSON.stringify(event.data.arguments)}`
    case 'tool.result':
      return event.data.error ?? event.data.result
    case 'tool.approval':
      return event.data.toolCallId
    case 'assistant.started':
      return `${event.data.model} · ${event.data.step}`
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
      return event.data.reason
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
