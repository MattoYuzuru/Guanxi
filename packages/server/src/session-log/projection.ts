/**
 * Pure projections over an ordered list of session events: the span tree and
 * the token meter the inspector shows, and the transcript state replay tests
 * compare against the live state.
 */
import {
  promptTextOf,
  type SessionEvent,
  type SessionEventType,
  type SessionSpan,
  type SessionSpanKind,
  type SessionTokenMeter,
} from '@guanxi/contract'

function spanKind(spanId: string): SessionSpanKind | null {
  if (spanId.startsWith('job:')) return 'turn'
  if (spanId.startsWith('step:')) return 'step'
  if (spanId.startsWith('tool:')) return 'tool'
  return null
}

/** Spans in order of their first event; a usage event counts toward its step and turn. */
export function projectSpans(events: readonly SessionEvent[]): SessionSpan[] {
  const spans = new Map<string, SessionSpan>()
  for (const event of events) {
    if (!event.spanId) continue
    const kind = spanKind(event.spanId)
    if (!kind) continue
    let span = spans.get(event.spanId)
    if (!span) {
      span = {
        id: event.spanId,
        parentId: event.parentSpanId,
        kind,
        label: event.spanId.slice(event.spanId.indexOf(':') + 1),
        firstSeq: event.seq,
        lastSeq: event.seq,
        startedAt: event.createdAt,
        endedAt: event.createdAt,
        eventCount: 0,
        status: null,
        promptTokens: 0,
        completionTokens: 0,
      }
      spans.set(event.spanId, span)
    }
    span.parentId ??= event.parentSpanId
    span.lastSeq = event.seq
    span.endedAt = event.createdAt
    span.eventCount += 1
    if (event.type === 'assistant.started') span.label = event.data.model
    if (event.type === 'tool.call') span.label = event.data.name
    if (event.type === 'tool.result') span.status = event.data.status
    if (event.type === 'job.lifecycle') span.status = event.data.state
    if (event.type === 'usage') {
      span.promptTokens += event.data.promptTokens
      span.completionTokens += event.data.evalTokens
      const parent = span.parentId ? spans.get(span.parentId) : undefined
      if (parent && parent !== span) {
        parent.promptTokens += event.data.promptTokens
        parent.completionTokens += event.data.evalTokens
      }
    }
  }
  return [...spans.values()]
}

export function projectTokenMeter(events: readonly SessionEvent[]): SessionTokenMeter {
  const meter: SessionTokenMeter = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    samples: 0,
    context: null,
  }
  for (const event of events) {
    if (event.type === 'usage') {
      meter.promptTokens += event.data.promptTokens
      meter.completionTokens += event.data.evalTokens
      meter.cachedTokens += event.data.cachedTokens
      meter.samples += 1
    } else if (event.type === 'context') {
      meter.context = event.data
    }
  }
  return meter
}

export interface SessionTranscriptState {
  counts: Partial<Record<SessionEventType, number>>
  lastSeq: number
  /** User prompts in order, by message id. */
  prompts: { messageId: string; text: string }[]
  /** Assistant text per message id, joined across flushes in order. */
  assistantText: Record<string, string>
  toolCalls: { toolCallId: string; name: string; status: string | null }[]
  /** Final Job state per Job id. */
  turns: Record<string, string>
  reasoningEvents: number
}

/** The transcript a client rebuilds from the log; replay must reproduce it exactly. */
export function projectTranscript(events: readonly SessionEvent[]): SessionTranscriptState {
  const state: SessionTranscriptState = {
    counts: {},
    lastSeq: 0,
    prompts: [],
    assistantText: {},
    toolCalls: [],
    turns: {},
    reasoningEvents: 0,
  }
  const tools = new Map<string, { toolCallId: string; name: string; status: string | null }>()
  for (const event of events) {
    state.counts[event.type] = (state.counts[event.type] ?? 0) + 1
    state.lastSeq = Math.max(state.lastSeq, event.seq)
    switch (event.type) {
      case 'prompt':
        state.prompts.push({ messageId: event.data.messageId, text: promptTextOf(event) })
        break
      case 'assistant.message':
        if (event.data.messageId) {
          state.assistantText[event.data.messageId] = (state.assistantText[event.data.messageId] ?? '') + event.data.text
        }
        break
      case 'tool.call': {
        const call = { toolCallId: event.data.toolCallId, name: event.data.name, status: null as string | null }
        tools.set(call.toolCallId, call)
        state.toolCalls.push(call)
        break
      }
      case 'tool.result': {
        const call = tools.get(event.data.toolCallId)
        if (call) call.status = event.data.status
        break
      }
      case 'job.lifecycle':
        if (event.jobId) state.turns[event.jobId] = event.data.state
        break
      case 'reasoning':
        state.reasoningEvents += 1
        break
      default:
        break
    }
  }
  return state
}
