/**
 * The legacy durable Chat job store, behind the session log (K2 strangler step).
 *
 * `JobStore` calls this mirror inside every transaction that inserts a Job
 * event. For Chat Jobs the mirror appends the matching session events in the
 * same transaction, so a Job event and its trace commit or roll back together.
 *
 * The trace is a deterministic function of the durable Job store
 * (`chat_job_inputs` and `job_events`), and the mirror works by catching up:
 * for a Job it mirrors every Job event after the trace's cursor (the highest
 * mirrored Job sequence), through the same mapping, in order.
 * - Token and thinking deltas are not mirrored one by one. At the next
 *   non-delta Job event the deltas since the cursor are read back and appended
 *   as one `reasoning` and one `assistant.message` event, so the scrubber sees
 *   whole messages and a secret split across deltas is still redacted.
 * - While the egress scrubber is not ready (K3 review H3), the mirror writes no
 *   trace at all. Inside the Job transaction it records only the Job id in
 *   `session_mirror_backlog` (no payload). Once the scrubber is ready, at the
 *   next Job event of that Job or at the next start, it catches the Job up from
 *   the Job store. Nothing secret-bearing is held, and a crash before readiness
 *   loses nothing (GPT review R2).
 * - Every mirrored event carries the Job event's time and an idempotency key
 *   `job:<jobId>:<jobSequence>:<part>`, so a reconstruction is identical to
 *   the trace a ready mirror would have written, and running it twice adds
 *   nothing.
 */
import {
  jobStreamEventSchema,
  type ChatJobInputSnapshot,
  type ChatJobOutput,
  type JobStreamEvent,
  type SessionEventType,
  type SessionKind,
} from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import { DEFAULT_REASONING_RETENTION_MS, type SessionEventInput, type SessionLog } from './log.ts'

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

interface JobEventRow {
  id: string
  job_id: string
  sequence: number
  type: string
  state: string
  phase: string | null
  metadata: string
  output: string | null
  output_privacy: string | null
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

function isDelta(event: JobStreamEvent): boolean {
  const output = event.output?.event
  return output?.type === 'thinking' || output?.type === 'token'
}

export class ChatSessionMirror implements JobEventMirror {
  private readonly log: SessionLog
  private readonly db: Db
  private readonly reasoningRetentionMs: number
  private readonly pending = new Set<string>()
  private backlogScheduled = false

  constructor(options: { log: SessionLog; db: Db; reasoningRetentionMs?: number }) {
    this.log = options.log
    this.db = options.db
    this.reasoningRetentionMs = options.reasoningRetentionMs ?? DEFAULT_REASONING_RETENTION_MS
    // Jobs deferred before a restart are caught up as soon as the scrubber is ready.
    this.scheduleBacklog()
  }

  recordChatCreated(input: {
    jobId: string
    threadId: string
    userMessageId: string
    input: ChatJobInputSnapshot
  }): void {
    const source = this.sourceForThread(input.threadId)
    if (!source) return
    if (!this.log.egressReady) {
      this.defer(input.jobId, source.thread_id)
      return
    }
    this.writePrompt(source, input.jobId, input.userMessageId, input.input, new Date().toISOString())
  }

  recordJobEvent(event: JobStreamEvent): void {
    if (isDelta(event)) return
    const source = this.sourceForJob(event.jobId)
    if (!source) return
    if (!this.log.egressReady) {
      this.defer(event.jobId, source.thread_id)
      return
    }
    this.catchUpWithin(source, event.jobId)
  }

  afterCommit(): void {
    if (this.pending.size === 0) return
    const sessionIds = [...this.pending]
    this.pending.clear()
    this.log.notify(sessionIds)
  }

  afterRollback(): void {
    this.pending.clear()
  }

  /** Jobs whose trace is still deferred, in order (ids only). */
  backlog(): string[] {
    return (this.db
      .prepare('SELECT job_id FROM session_mirror_backlog ORDER BY deferred_at, job_id')
      .all() as unknown as { job_id: string }[]).map((row) => row.job_id)
  }

  /**
   * Catches every deferred Job up, each in its own transaction. Stops at the
   * first failure and keeps the rest for the next attempt (the Job's next event,
   * the next readiness change or the next start). Returns the Jobs caught up.
   */
  catchUpBacklog(): number {
    if (this.log.isClosed || !this.log.egressReady) return 0
    let done = 0
    for (const jobId of this.backlog()) {
      if (!this.log.egressReady) break
      try {
        this.db.exec('BEGIN IMMEDIATE')
        const source = this.sourceForJob(jobId)
        if (source) this.catchUpWithin(source, jobId)
        else this.db.prepare('DELETE FROM session_mirror_backlog WHERE job_id = ?').run(jobId)
        this.db.exec('COMMIT')
      } catch {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // The transaction may already be over.
        }
        this.afterRollback()
        break
      }
      this.afterCommit()
      done++
    }
    return done
  }

  private scheduleBacklog(): void {
    if (this.backlogScheduled) return
    this.backlogScheduled = true
    this.log.whenEgressReady().then(
      () => {
        this.backlogScheduled = false
        this.catchUpBacklog()
      },
      () => {
        this.backlogScheduled = false
      },
    )
  }

  /** Inside the Job transaction: remember that this Job's trace is to be reconstructed. */
  private defer(jobId: string, threadId: string): void {
    this.db
      .prepare(
        `INSERT INTO session_mirror_backlog (job_id, thread_id, deferred_at)
         VALUES (?, ?, ?) ON CONFLICT(job_id) DO NOTHING`,
      )
      .run(jobId, threadId, new Date().toISOString())
    this.scheduleBacklog()
  }

  /** Inside a transaction: mirror every Job event after the trace's cursor, from the Job store. */
  private catchUpWithin(source: ChatSource, jobId: string): void {
    if (!this.hasPrompt(source.thread_id, jobId)) {
      const input = this.db
        .prepare('SELECT user_message_id, input_json, created_at FROM chat_job_inputs WHERE job_id = ?')
        .get(jobId) as unknown as { user_message_id: string; input_json: string; created_at: string } | undefined
      if (input) {
        this.writePrompt(source, jobId, input.user_message_id, JSON.parse(input.input_json) as ChatJobInputSnapshot, input.created_at)
      }
    }
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence')
      .all(jobId, this.cursor(source.thread_id, jobId)) as unknown as JobEventRow[]
    for (const row of rows) {
      const event = this.toJobEvent(row)
      if (!isDelta(event)) this.mirrorEvent(source, event)
    }
    this.db.prepare('DELETE FROM session_mirror_backlog WHERE job_id = ?').run(jobId)
  }

  private cursor(sessionId: string, jobId: string): number {
    const row = this.db
      .prepare('SELECT MAX(job_sequence) AS seq FROM session_events WHERE session_id = ? AND job_id = ?')
      .get(sessionId, jobId) as unknown as { seq: number | null }
    return row.seq ?? 0
  }

  private hasPrompt(sessionId: string, jobId: string): boolean {
    return this.db
      .prepare('SELECT 1 FROM session_events WHERE session_id = ? AND idempotency_key = ?')
      .get(sessionId, `job:${jobId}:prompt`) !== undefined
  }

  private toJobEvent(row: JobEventRow): JobStreamEvent {
    return jobStreamEventSchema.parse({
      id: row.id,
      jobId: row.job_id,
      sequence: row.sequence,
      type: row.type,
      state: row.state,
      phase: row.phase,
      metadata: JSON.parse(row.metadata) as unknown,
      output: row.output === null || row.output_privacy === null
        ? null
        : { privacyClassification: row.output_privacy, event: JSON.parse(row.output) as unknown },
      createdAt: row.created_at,
    })
  }

  private writePrompt(source: ChatSource, jobId: string, userMessageId: string, input: ChatJobInputSnapshot, occurredAt: string): void {
    this.append(source, jobId, null, `job:${jobId}:prompt`, {
      type: 'prompt',
      data: {
        origin: 'typed',
        messageId: userMessageId,
        text: input.content,
        attachmentCount: input.attachments.length,
      },
      spanId: turnSpanId(jobId),
      occurredAt,
    })
  }

  /** The mapping of one non-delta Job event, after flushing the deltas before it. */
  private mirrorEvent(source: ChatSource, event: JobStreamEvent): void {
    const output = event.output?.event ?? null
    this.flushDeltas(source, event)

    const step = this.currentStep(source.thread_id, event.jobId)
    const stepSpan = step?.messageId ? stepSpanId(step.messageId) : turnSpanId(event.jobId)
    const key = (part: string) => `job:${event.jobId}:${event.sequence}:${part}`
    const append = (part: string, input: SessionEventInput) =>
      this.append(source, event.jobId, event.sequence, key(part), { ...input, occurredAt: event.createdAt })

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
    const rows = this.db
      .prepare(
        `SELECT output FROM job_events
         WHERE job_id = ? AND sequence > ? AND sequence < ? AND type = 'output'
           AND output_privacy = 'private_chat'
         ORDER BY sequence`,
      )
      .all(event.jobId, this.cursor(source.thread_id, event.jobId), event.sequence) as unknown as { output: string }[]
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
        occurredAt: event.createdAt,
      })
    }
    if (text) {
      this.append(source, event.jobId, event.sequence, `job:${event.jobId}:${event.sequence}:message`, {
        type: 'assistant.message',
        data: { ...base, text },
        spanId,
        parentSpanId,
        occurredAt: event.createdAt,
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
