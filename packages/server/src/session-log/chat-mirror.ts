/**
 * The legacy durable Chat job store, behind the session log (K2 strangler step).
 *
 * `JobStore` calls this mirror inside every transaction that inserts a Job
 * event. For Chat Jobs the mirror appends the matching session events in the
 * same transaction, so a Job event and its trace commit or roll back together.
 *
 * Token and thinking deltas are not mirrored one by one. When the next
 * non-delta Job event arrives, the mirror reads the deltas since the last
 * mirrored Job event back from `job_events` (same transaction) and appends one
 * `reasoning` and one `assistant.message` event. The mirror therefore keeps no
 * state in memory, a crash loses nothing that recovery will not terminalize,
 * and the scrubber sees whole messages, so a secret split across deltas is
 * still redacted.
 *
 * While the egress scrubber is not ready, the log holds these writes back in a
 * bounded buffer (see `SessionLog.appendAsSystemWithin`); the mirror confirms
 * them after the Job transaction commits and discards them after a rollback.
 */
import type { ChatJobInputSnapshot, ChatJobOutput, JobStreamEvent, SessionEventType, SessionKind } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { SessionEventInput, SessionLog } from './log.ts'

const DAY_MS = 24 * 60 * 60 * 1_000

/** The hook `JobStore` calls; every method runs inside the store's transaction. */
export interface JobEventMirror {
  recordChatCreated(input: {
    jobId: string
    threadId: string
    userMessageId: string
    input: ChatJobInputSnapshot
  }): void
  recordJobEvent(event: JobStreamEvent): void
  /** Called after the store's COMMIT. */
  afterCommit(): void
  /** Called after the store's ROLLBACK. */
  afterRollback(): void
}

interface ChatSource {
  thread_id: string
  mode: string
  retention_policy: string | null
  last_user_activity_at: string | null
  created_at: string
}

export function turnSpanId(jobId: string): string {
  return `job:${jobId}`
}
export function stepSpanId(messageId: string): string {
  return `step:${messageId}`
}
export function toolSpanId(toolCallId: string): string {
  return `tool:${toolCallId}`
}

export class ChatSessionMirror implements JobEventMirror {
  private readonly log: SessionLog
  private readonly db: Db
  private readonly reasoningRetentionMs: number
  private readonly pending = new Set<string>()

  constructor(options: { log: SessionLog; db: Db; reasoningRetentionMs?: number }) {
    this.log = options.log
    this.db = options.db
    this.reasoningRetentionMs = options.reasoningRetentionMs ?? 7 * DAY_MS
  }

  recordChatCreated(input: {
    jobId: string
    threadId: string
    userMessageId: string
    input: ChatJobInputSnapshot
  }): void {
    const source = this.sourceForThread(input.threadId)
    if (!source) return
    this.append(source, input.jobId, null, `job:${input.jobId}:prompt`, {
      type: 'prompt',
      data: {
        origin: 'typed',
        messageId: input.userMessageId,
        text: input.input.content,
        attachmentCount: input.input.attachments.length,
      },
      spanId: turnSpanId(input.jobId),
    })
  }

  recordJobEvent(event: JobStreamEvent): void {
    const output = event.output?.event ?? null
    if (output && (output.type === 'thinking' || output.type === 'token')) return
    const source = this.sourceForJob(event.jobId)
    if (!source) return

    this.flushDeltas(source, event)

    const step = this.currentStep(source.thread_id, event.jobId)
    const stepSpan = step?.messageId ? stepSpanId(step.messageId) : turnSpanId(event.jobId)
    const key = (part: string) => `job:${event.jobId}:${event.sequence}:${part}`
    const append = (part: string, input: SessionEventInput) =>
      this.append(source, event.jobId, event.sequence, key(part), input)

    if (output) this.recordOutput(output, event, stepSpan, append)

    if (event.type === 'lifecycle') {
      append('lifecycle', {
        type: 'job.lifecycle',
        data: {
          jobSequence: event.sequence,
          state: event.state,
          phase: event.phase,
          metadata: event.metadata,
        },
        spanId: turnSpanId(event.jobId),
      })
      if (event.state === 'cancelling' && event.metadata['stopReason'] === 'user_requested') {
        append('intervention', {
          type: 'intervention',
          data: { action: 'stop', reason: 'user_requested' },
          spanId: turnSpanId(event.jobId),
        })
      }
    }
  }

  afterCommit(): void {
    this.log.confirmPending()
    if (this.pending.size === 0) return
    const sessionIds = [...this.pending]
    this.pending.clear()
    this.log.notify(sessionIds)
  }

  afterRollback(): void {
    this.log.discardProvisional()
    this.pending.clear()
  }

  private recordOutput(
    output: ChatJobOutput,
    event: JobStreamEvent,
    stepSpan: string,
    append: (part: string, input: SessionEventInput) => void,
  ): void {
    switch (output.type) {
      case 'start':
        append('output', {
          type: 'assistant.started',
          data: { messageId: output.data.messageId, model: output.data.model, step: output.data.step },
          spanId: stepSpanId(output.data.messageId),
          parentSpanId: turnSpanId(event.jobId),
        })
        return
      case 'tool_call':
        append('output', {
          type: 'tool.call',
          data: {
            toolCallId: output.data.id,
            name: output.data.name,
            arguments: output.data.arguments,
            source: output.data.source,
            parsedFrom: output.data.parsedFrom,
            diffPath: output.data.diff?.path ?? null,
          },
          spanId: toolSpanId(output.data.id),
          parentSpanId: stepSpan,
        })
        return
      case 'tool_approval_required':
        append('output', {
          type: 'tool.approval',
          data: { toolCallId: output.data.toolCall.id, timeoutMs: output.data.timeoutMs },
          spanId: toolSpanId(output.data.toolCall.id),
          parentSpanId: stepSpan,
        })
        return
      case 'tool_result':
        append('output', {
          type: 'tool.result',
          data: {
            toolCallId: output.data.toolCallId,
            status: output.data.status,
            result: output.data.result,
            error: output.data.error,
            durationMs: output.data.durationMs,
          },
          spanId: toolSpanId(output.data.toolCallId),
          parentSpanId: stepSpan,
        })
        return
      case 'usage':
        append('output', { type: 'usage', data: output.data, spanId: stepSpan, parentSpanId: turnSpanId(event.jobId) })
        return
      case 'context':
        append('output', { type: 'context', data: output.data, spanId: stepSpan, parentSpanId: turnSpanId(event.jobId) })
        return
      case 'done':
        append('output', {
          type: 'turn.done',
          data: {
            messageId: output.data.messageId,
            outcome: output.data.outcome ?? null,
            stopReason: output.data.terminalStopReason ?? output.data.stopReason,
            steps: output.data.steps,
          },
          spanId: turnSpanId(event.jobId),
        })
        return
      case 'error':
        append('output', {
          type: 'error',
          data: { code: output.data.turnError?.code ?? output.data.code, message: output.data.message },
          spanId: turnSpanId(event.jobId),
        })
        return
      case 'thinking':
      case 'token':
        return
    }
  }

  /** Appends one reasoning and one message event for the deltas since the last mirrored Job event. */
  private flushDeltas(source: ChatSource, event: JobStreamEvent): void {
    const stored = this.db
      .prepare('SELECT MAX(job_sequence) AS seq FROM session_events WHERE session_id = ? AND job_id = ?')
      .get(source.thread_id, event.jobId) as unknown as { seq: number | null }
    // Writes held back until the scrubber is ready count as mirrored already.
    const heldBack = this.log
      .pendingFor(source.thread_id, event.jobId)
      .reduce((max, input) => Math.max(max, input.jobSequence ?? 0), 0)
    const last = { seq: Math.max(stored.seq ?? 0, heldBack) }
    const rows = this.db
      .prepare(
        `SELECT output FROM job_events
         WHERE job_id = ? AND sequence > ? AND sequence < ? AND type = 'output'
           AND output_privacy = 'private_chat'
         ORDER BY sequence`,
      )
      .all(event.jobId, last.seq ?? 0, event.sequence) as unknown as { output: string }[]
    let thinking = ''
    let text = ''
    for (const row of rows) {
      const output = JSON.parse(row.output) as ChatJobOutput
      if (output.type === 'thinking') thinking += output.data.delta
      else if (output.type === 'token') text += output.data.delta
    }
    if (!thinking && !text) return

    const step = this.currentStep(source.thread_id, event.jobId)
    const spanId = step?.messageId ? stepSpanId(step.messageId) : turnSpanId(event.jobId)
    const parentSpanId = step?.messageId ? turnSpanId(event.jobId) : null
    const base = { messageId: step?.messageId ?? null, step: step?.step ?? null }
    if (thinking) {
      this.append(source, event.jobId, event.sequence, `job:${event.jobId}:${event.sequence}:reasoning`, {
        type: 'reasoning',
        data: { ...base, text: thinking },
        spanId,
        parentSpanId,
        expiresAt: this.reasoningExpiry(source, event.createdAt),
      })
    }
    if (text) {
      this.append(source, event.jobId, event.sequence, `job:${event.jobId}:${event.sequence}:message`, {
        type: 'assistant.message',
        data: { ...base, text },
        spanId,
        parentSpanId,
      })
    }
  }

  /** The default reasoning expiry, or the parent Chat's rolling TTL when it is sooner. */
  private reasoningExpiry(source: ChatSource, createdAt: string): string {
    const own = Date.parse(createdAt) + this.reasoningRetentionMs
    const parent = source.retention_policy === 'ttl'
      ? Date.parse(source.last_user_activity_at ?? source.created_at) + 7 * DAY_MS
      : Number.POSITIVE_INFINITY
    return new Date(Math.min(own, parent)).toISOString()
  }

  private currentStep(sessionId: string, jobId: string): { messageId: string; step: number } | null {
    const heldBack = this.log
      .pendingFor(sessionId, jobId)
      .filter((input) => input.type === 'assistant.started')
      .at(-1)
    if (heldBack?.type === 'assistant.started') {
      const data = heldBack.data as { messageId: string; step: number }
      return { messageId: data.messageId, step: data.step }
    }
    const row = this.db
      .prepare(
        `SELECT payload FROM session_events
         WHERE session_id = ? AND job_id = ? AND type = 'assistant.started'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, jobId) as unknown as { payload: string } | undefined
    if (!row) return null
    const data = JSON.parse(row.payload) as { messageId: string; step: number }
    return { messageId: data.messageId, step: data.step }
  }

  private append(
    source: ChatSource,
    jobId: string,
    jobSequence: number | null,
    idempotencyKey: string,
    input: SessionEventInput<SessionEventType>,
  ): void {
    const kind: SessionKind = source.mode === 'agent' ? 'agent' : 'chat'
    this.log.appendAsSystemWithin(
      source.thread_id,
      { kind, threadId: source.thread_id },
      { ...input, jobId, jobSequence },
      { idempotencyKey },
    )
    this.pending.add(source.thread_id)
  }

  private sourceForJob(jobId: string): ChatSource | null {
    const row = this.db
      .prepare(
        `SELECT t.id AS thread_id, t.mode, t.retention_policy, t.last_user_activity_at, t.created_at
         FROM chat_job_inputs i JOIN threads t ON t.id = i.thread_id
         WHERE i.job_id = ?`,
      )
      .get(jobId) as unknown as ChatSource | undefined
    return row ?? null
  }

  private sourceForThread(threadId: string): ChatSource | null {
    const row = this.db
      .prepare(
        `SELECT id AS thread_id, mode, retention_policy, last_user_activity_at, created_at
         FROM threads WHERE id = ?`,
      )
      .get(threadId) as unknown as ChatSource | undefined
    return row ?? null
  }
}
