/**
 * A contract-valid session trace for inspector tests: one completed turn with
 * a tool call, a redacted secret reference, live and purged reasoning, usage
 * and context. Every value is a fake.
 */
import { sessionEventSchema, type SessionEvent, type SessionSummary } from '@guanxi/contract'

export const SESSION_ID = 'thread-k2-inspector'
const JOB = 'job-k2-inspector'
const STEP = 'message-k2-step'
const TOOL = 'tool-k2-call'
export const REASONING_TEXT = 'privatewalrus reasoning about the lookup'

function at(seq: number): string {
  return new Date(Date.parse('2026-10-20T10:00:00.000Z') + seq * 1_000).toISOString()
}

type Draft = Pick<SessionEvent, 'type' | 'data'> & Partial<Pick<SessionEvent, 'spanId' | 'parentSpanId' | 'jobId' | 'redactions'>> & {
  expiresAt?: string
  purgedAt?: string | null
}

export function sessionTrace(): SessionEvent[] {
  const drafts: Draft[] = [
    { type: 'session.created', data: { kind: 'chat', threadId: SESSION_ID } },
    { type: 'writer.acquired', data: { epoch: 1, previousEpoch: null, reason: 'initial' } },
    {
      type: 'prompt',
      data: { origin: 'typed', messageId: 'message-k2-user', text: 'Use my key ⟦REDACTED secret://vault/demo⟧ please', attachmentCount: 0 },
      spanId: `job:${JOB}`,
      jobId: JOB,
      redactions: 1,
    },
    { type: 'job.lifecycle', data: { jobSequence: 1, state: 'queued', phase: null, metadata: {} }, spanId: `job:${JOB}`, jobId: JOB },
    { type: 'assistant.started', data: { messageId: STEP, model: 'fixture-model', step: 0 }, spanId: `step:${STEP}`, parentSpanId: `job:${JOB}`, jobId: JOB },
    {
      type: 'reasoning',
      data: null,
      spanId: `step:${STEP}`,
      parentSpanId: `job:${JOB}`,
      jobId: JOB,
      expiresAt: at(100),
      purgedAt: at(90),
    },
    {
      type: 'reasoning',
      data: { messageId: STEP, step: 0, text: REASONING_TEXT },
      spanId: `step:${STEP}`,
      parentSpanId: `job:${JOB}`,
      jobId: JOB,
      expiresAt: '2026-10-27T10:00:00.000Z',
      purgedAt: null,
    },
    { type: 'assistant.message', data: { messageId: STEP, step: 0, text: 'Looking it up' }, spanId: `step:${STEP}`, parentSpanId: `job:${JOB}`, jobId: JOB },
    {
      type: 'tool.call',
      data: { toolCallId: TOOL, name: 'lookup', arguments: { query: 'demo' }, source: 'builtin', parsedFrom: 'native', diffPath: null },
      spanId: `tool:${TOOL}`,
      parentSpanId: `step:${STEP}`,
      jobId: JOB,
    },
    {
      type: 'tool.result',
      data: { toolCallId: TOOL, status: 'ok', result: 'found it', error: null, durationMs: 12 },
      spanId: `tool:${TOOL}`,
      parentSpanId: `step:${STEP}`,
      jobId: JOB,
    },
    {
      type: 'usage',
      data: {
        promptTokens: 40, evalTokens: 12, promptEvalDurationMs: 100, evalDurationMs: 50,
        loadDurationMs: 0, totalDurationMs: 150, tokensPerSecond: 240, cacheHit: false, cachedTokens: 0,
      },
      spanId: `step:${STEP}`,
      parentSpanId: `job:${JOB}`,
      jobId: JOB,
    },
    {
      type: 'context',
      data: { usedTokens: 52, allocatedTokens: 4_096, percent: 1.27, cacheHit: false, cachedTokens: 0, compactable: false, estimatedRepefillMs: 0 },
      spanId: `step:${STEP}`,
      parentSpanId: `job:${JOB}`,
      jobId: JOB,
    },
    { type: 'turn.done', data: { messageId: STEP, outcome: 'completed', stopReason: 'stop', steps: 1 }, spanId: `job:${JOB}`, jobId: JOB },
    { type: 'job.lifecycle', data: { jobSequence: 9, state: 'completed', phase: null, metadata: {} }, spanId: `job:${JOB}`, jobId: JOB },
  ]
  return drafts.map((draft, index) => {
    const seq = index + 1
    const base = {
      sessionId: SESSION_ID,
      seq,
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      version: 1,
      spanId: draft.spanId ?? null,
      parentSpanId: draft.parentSpanId ?? null,
      jobId: draft.jobId ?? null,
      writerEpoch: 1,
      redactions: draft.redactions ?? 0,
      createdAt: at(seq),
      type: draft.type,
      class: draft.type === 'reasoning' ? 'reasoning' : 'standard',
      data: draft.data,
      ...(draft.type === 'reasoning' ? { expiresAt: draft.expiresAt, purgedAt: draft.purgedAt ?? null } : {}),
    }
    return sessionEventSchema.parse(base)
  })
}

export function sessionSummary(events: SessionEvent[]): SessionSummary {
  const counts: SessionSummary['counts'] = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return {
    sessionId: SESSION_ID,
    kind: 'chat',
    threadId: SESSION_ID,
    title: 'Inspector fixture',
    createdAt: events[0]!.createdAt,
    lastSeq: events.length,
    lastEventAt: events.at(-1)!.createdAt,
    counts,
    eventCount: events.length,
    reasoningPurged: 1,
    redactions: 1,
    tokens: { promptTokens: 40, completionTokens: 12, cachedTokens: 0, samples: 1, context: null },
  }
}
