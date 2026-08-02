import { randomUUID } from 'node:crypto'
import {
  chatJobInputSnapshotSchema,
  jobErrorSchema,
  jobEventTypeSchema,
  jobEventOutputSchema,
  jobKindSchema,
  jobOutcomeSchema,
  jobSchema,
  jobStateSchema,
  jobStreamEventSchema,
  jobTerminalStateSchema,
  safeJobMetadataSchema,
  turnErrorSchema,
  type ChatJobInputSnapshot,
  type Job,
  type JobError,
  type JobEventOutput,
  type JobEventType,
  type JobKind,
  type JobOutcome,
  type JobState,
  type JobStreamEvent,
  type JobTerminalState,
  type SafeJobMetadata,
} from '@alamo/contract'
import { isCanonicalNonTerminalTransition } from '../jobs/lifecycle.ts'
import type { Db } from './db.ts'
import type { TerminalMessageUpdate } from './threads.ts'

const TERMINAL_STATES = new Set<JobState>(jobTerminalStateSchema.options)

export type JobStoreErrorCode =
  | 'job_not_found'
  | 'job_terminal'
  | 'invalid_transition'
  | 'sequence_conflict'
  | 'stored_data_invalid'
  | 'invalid_input'
  | 'idempotency_conflict'

export class JobStoreError extends Error {
  readonly code: JobStoreErrorCode

  constructor(code: JobStoreErrorCode, message: string) {
    super(message)
    this.name = 'JobStoreError'
    this.code = code
  }
}

interface JobRow {
  id: string
  kind: string
  operation: string
  status: string
  phase: string | null
  idempotency_scope: string
  idempotency_key: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  outcome: string | null
  stop_reason: string | null
  last_event_sequence: number
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

interface ChatJobInputRow {
  job_id: string
  thread_id: string
  user_message_id: string
  assistant_message_id: string
  request_fingerprint: string
  input_json: string
  created_at: string
}

export interface CreateJobInput {
  kind: JobKind
  operation: string
  idempotencyScope: string
  idempotencyKey: string
}

export interface CreateJobResult {
  /** false means the scoped idempotency key already owned the returned canonical Job. */
  created: boolean
  job: Job
}

export interface ChatJobAssociation {
  job: Job
  threadId: string
  userMessageId: string
  assistantMessageId: string
  requestFingerprint: string
  input: ChatJobInputSnapshot
  createdAt: string
}

export interface CreateChatJobInput {
  threadId: string
  idempotencyScope: string
  idempotencyKey: string
  requestFingerprint: string
  input: ChatJobInputSnapshot
  derivedTitle: string
}

export interface CreateChatJobResult extends ChatJobAssociation {
  created: boolean
}

export interface AppendJobEventInput {
  jobId: string
  expectedNextSequence: number
  type: JobEventType
  metadata?: SafeJobMetadata
  output?: JobEventOutput | null
}

export interface TerminalizeJobInput {
  jobId: string
  expectedStatus: JobState
  status: JobTerminalState
  error?: JobError | null
  outcome?: JobOutcome | null
  stopReason?: string | null
  /** Optional private payload committed on the same terminal event. */
  output?: JobEventOutput | null
}

export interface TerminalizeChatJobInput extends TerminalizeJobInput {
  messageId: string
  message: TerminalMessageUpdate
}

export interface TransitionJobInput {
  jobId: string
  expectedStatus: JobState
  status: JobState
  phase?: string | null
  metadata?: SafeJobMetadata
}

export interface TransitionJobResult {
  /** false means the expected state lost a compare-and-set; no event was appended. */
  applied: boolean
  job: Job
}

export interface TerminalizeJobResult {
  /** false means the expected state lost a compare-and-set; no event was appended. */
  applied: boolean
  job: Job
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) {
    throw new JobStoreError('invalid_input', `${field} must not be empty`)
  }
  return normalized
}

function parseInput<T>(value: unknown, schema: { parse(value: unknown): T }, field: string): T {
  try {
    return schema.parse(value)
  } catch {
    throw new JobStoreError('invalid_input', `${field} is invalid`)
  }
}

function parseStoredJson<T>(
  raw: string,
  schema: { parse(value: unknown): T },
  recordKind: 'Job' | 'Job event',
  recordId: string,
): T {
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    throw new JobStoreError(
      'stored_data_invalid',
      `${recordKind} ${recordId} contains invalid stored data`,
    )
  }
}

function parseStoredUnknownJson(raw: string, recordKind: 'Job' | 'Job event', recordId: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new JobStoreError(
      'stored_data_invalid',
      `${recordKind} ${recordId} contains invalid stored data`,
    )
  }
}

function toJob(row: JobRow): Job {
  const candidate = {
    id: row.id,
    kind: row.kind,
    operation: row.operation,
    status: row.status,
    phase: row.phase,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error ? parseStoredJson(row.error, jobErrorSchema, 'Job', row.id) : null,
    outcome: row.outcome ? parseStoredJson(row.outcome, jobOutcomeSchema, 'Job', row.id) : null,
    stopReason: row.stop_reason,
    lastEventSequence: row.last_event_sequence,
  }
  const parsed = jobSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new JobStoreError('stored_data_invalid', `Job ${row.id} contains invalid stored data`)
  }
  return parsed.data
}

function toJobEvent(row: JobEventRow): JobStreamEvent {
  let output: JobEventOutput | null = null
  if (row.output !== null || row.output_privacy !== null) {
    if (row.output === null || row.output_privacy === null) {
      throw new JobStoreError(
        'stored_data_invalid',
        `Job event ${row.id} contains an incomplete private output boundary`,
      )
    }
    output = parseStoredJson(
      JSON.stringify({
        privacyClassification: row.output_privacy,
        event: parseStoredUnknownJson(row.output, 'Job event', row.id),
      }),
      jobEventOutputSchema,
      'Job event',
      row.id,
    )
  }
  const candidate = {
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    type: row.type,
    state: row.state,
    phase: row.phase,
    metadata: parseStoredJson(row.metadata, safeJobMetadataSchema, 'Job event', row.id),
    output,
    createdAt: row.created_at,
  }
  const parsed = jobStreamEventSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new JobStoreError(
      'stored_data_invalid',
      `Job event ${row.id} contains invalid stored data`,
    )
  }
  return parsed.data
}

export class JobStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  create(input: CreateJobInput): CreateJobResult {
    const kind = parseInput(input.kind, jobKindSchema, 'kind')
    const operation = nonEmpty(input.operation, 'operation')
    const idempotencyScope = nonEmpty(input.idempotencyScope, 'idempotencyScope')
    const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey')

    return this.transaction(() => {
      const existing = this.jobByIdempotency(idempotencyScope, idempotencyKey)
      if (existing) return { created: false, job: existing }

      const id = randomUUID()
      const eventId = randomUUID()
      const createdAt = new Date().toISOString()
      this.db
        .prepare(
          `INSERT INTO jobs (
             id, kind, operation, status, phase, idempotency_scope, idempotency_key,
             created_at, started_at, finished_at, error, outcome, stop_reason,
             last_event_sequence
           ) VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1)`,
        )
        .run(id, kind, operation, idempotencyScope, idempotencyKey, createdAt)
      this.insertEvent({
        id: eventId,
        jobId: id,
        sequence: 1,
        type: 'lifecycle',
        state: 'queued',
        phase: null,
        metadata: {},
        output: null,
        createdAt,
      })

      return { created: true, job: this.requireJob(id) }
    })
  }

  /**
   * Atomically owns Chat command deduplication and its durable projections.
   * Private input is stored in `chat_job_inputs`, never in Job metadata/events.
   */
  createChat(input: CreateChatJobInput): CreateChatJobResult {
    const threadId = nonEmpty(input.threadId, 'threadId')
    const idempotencyScope = nonEmpty(input.idempotencyScope, 'idempotencyScope')
    const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotencyKey')
    const requestFingerprint = nonEmpty(input.requestFingerprint, 'requestFingerprint')
    const snapshot = parseInput(input.input, chatJobInputSnapshotSchema, 'input')
    const derivedTitle = nonEmpty(input.derivedTitle, 'derivedTitle')

    return this.transaction(() => {
      const existing = this.jobByIdempotency(idempotencyScope, idempotencyKey)
      if (existing) {
        const association = this.requireChatInput(existing.id)
        if (association.requestFingerprint !== requestFingerprint) {
          throw new JobStoreError(
            'idempotency_conflict',
            'The Chat idempotency key is already bound to different input',
          )
        }
        return { created: false, ...association }
      }

      const thread = this.db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)
      if (!thread) throw new JobStoreError('invalid_input', `Thread ${threadId} was not found`)

      const id = randomUUID()
      const userMessageId = randomUUID()
      const assistantMessageId = randomUUID()
      const createdAt = new Date().toISOString()
      const nextRow = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE thread_id = ?')
        .get(threadId) as unknown as { next: number }

      this.db
        .prepare(
          `INSERT INTO jobs (
             id, kind, operation, status, phase, idempotency_scope, idempotency_key,
             created_at, started_at, finished_at, error, outcome, stop_reason,
             last_event_sequence
           ) VALUES (?, 'inference', 'chat', 'queued', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1)`,
        )
        .run(id, idempotencyScope, idempotencyKey, createdAt)

      this.db
        .prepare(
          `INSERT INTO messages (
             id, thread_id, seq, role, content, thinking, tool_calls, usage,
             is_compaction, created_at, turn_status, turn_error, stop_reason, job_id
           ) VALUES (?, ?, ?, 'user', ?, NULL, '[]', NULL, 0, ?, NULL, NULL, NULL, ?)`,
        )
        .run(userMessageId, threadId, nextRow.next, snapshot.content, createdAt, id)
      this.db
        .prepare(
          `INSERT INTO messages (
             id, thread_id, seq, role, content, thinking, tool_calls, usage,
             is_compaction, created_at, turn_status, turn_error, stop_reason, job_id
           ) VALUES (?, ?, ?, 'assistant', '', NULL, '[]', NULL, 0, ?, 'pending', NULL, NULL, ?)`,
        )
        .run(assistantMessageId, threadId, nextRow.next + 1, createdAt, id)

      this.db
        .prepare(
          `INSERT INTO chat_job_inputs (
             job_id, thread_id, user_message_id, assistant_message_id,
             request_fingerprint, input_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          threadId,
          userMessageId,
          assistantMessageId,
          requestFingerprint,
          JSON.stringify(snapshot),
          createdAt,
        )

      this.insertEvent({
        id: randomUUID(),
        jobId: id,
        sequence: 1,
        type: 'lifecycle',
        state: 'queued',
        phase: null,
        metadata: { threadId, userMessageId, assistantMessageId },
        output: null,
        createdAt,
      })

      const priorCount = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM messages
           WHERE thread_id = ? AND (job_id IS NULL OR job_id <> ?)`,
        )
        .get(threadId, id) as unknown as { count: number }
      if (priorCount.count === 0) {
        this.db
          .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
          .run(derivedTitle, createdAt, threadId)
      } else {
        this.db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(createdAt, threadId)
      }

      return { created: true, ...this.requireChatInput(id) }
    })
  }

  chatInput(jobId: string): ChatJobAssociation | null {
    const row = this.db
      .prepare('SELECT * FROM chat_job_inputs WHERE job_id = ?')
      .get(jobId) as unknown as ChatJobInputRow | undefined
    return row ? this.toChatInput(row) : null
  }

  activeChatJobForThread(threadId: string): ChatJobAssociation | null {
    const row = this.db
      .prepare(
        `SELECT input.*
         FROM chat_job_inputs input
         JOIN jobs job ON job.id = input.job_id
         WHERE input.thread_id = ?
           AND job.status NOT IN ('completed','failed','cancelled','interrupted')
         ORDER BY job.created_at DESC
         LIMIT 1`,
      )
      .get(threadId) as unknown as ChatJobInputRow | undefined
    return row ? this.toChatInput(row) : null
  }

  get(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as unknown as
      | JobRow
      | undefined
    return row ? toJob(row) : null
  }

  eventsAfter(jobId: string, afterSequence: number, limit = 100): JobStreamEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new JobStoreError('invalid_input', 'afterSequence must be a non-negative integer')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new JobStoreError('invalid_input', 'limit must be an integer from 1 to 1000')
    }
    if (!this.get(jobId)) {
      throw new JobStoreError('job_not_found', `Job ${jobId} was not found`)
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM job_events
         WHERE job_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(jobId, afterSequence, limit) as unknown as JobEventRow[]
    return rows.map(toJobEvent)
  }

  appendEvent(input: AppendJobEventInput): JobStreamEvent {
    if (!Number.isInteger(input.expectedNextSequence) || input.expectedNextSequence < 1) {
      throw new JobStoreError(
        'invalid_input',
        'expectedNextSequence must be a positive integer',
      )
    }
    const type = parseInput(input.type, jobEventTypeSchema, 'type')
    const metadata = parseInput(input.metadata ?? {}, safeJobMetadataSchema, 'metadata')
    const output = input.output
      ? parseInput(input.output, jobEventOutputSchema, 'output')
      : null

    return this.transaction(() => {
      const job = this.requireJob(input.jobId)
      if (TERMINAL_STATES.has(job.status)) {
        throw new JobStoreError('job_terminal', `Job ${input.jobId} is already terminal`)
      }
      const nextSequence = job.lastEventSequence + 1
      if (input.expectedNextSequence !== nextSequence) {
        throw new JobStoreError(
          'sequence_conflict',
          `Job ${input.jobId} expected event sequence ${nextSequence}`,
        )
      }

      const advanced = this.db
        .prepare(
          `UPDATE jobs
           SET last_event_sequence = ?
           WHERE id = ? AND last_event_sequence = ?
             AND status NOT IN ('completed','failed','cancelled','interrupted')`,
        )
        .run(nextSequence, input.jobId, job.lastEventSequence)
      if (advanced.changes !== 1) {
        throw new JobStoreError('sequence_conflict', `Job ${input.jobId} event sequence changed`)
      }

      const event: JobStreamEvent = {
        id: randomUUID(),
        jobId: input.jobId,
        sequence: nextSequence,
        type,
        state: job.status,
        phase: job.phase,
        metadata,
        output,
        createdAt: new Date().toISOString(),
      }
      this.insertEvent(event)
      return event
    })
  }

  transition(input: TransitionJobInput): TransitionJobResult {
    const expectedStatus = parseInput(input.expectedStatus, jobStateSchema, 'expectedStatus')
    const status = parseInput(input.status, jobStateSchema, 'status')
    if (TERMINAL_STATES.has(expectedStatus) || TERMINAL_STATES.has(status)) {
      throw new JobStoreError(
        'invalid_transition',
        'transition only accepts canonical non-terminal states',
      )
    }
    if (!isCanonicalNonTerminalTransition(expectedStatus, status)) {
      throw new JobStoreError(
        'invalid_transition',
        `Job transition ${expectedStatus} -> ${status} is not canonical`,
      )
    }
    const phase = input.phase === undefined || input.phase === null
      ? null
      : nonEmpty(input.phase, 'phase')
    const metadata = parseInput(input.metadata ?? {}, safeJobMetadataSchema, 'metadata')

    return this.transaction(() => {
      const existing = this.requireJob(input.jobId)
      if (TERMINAL_STATES.has(existing.status)) {
        throw new JobStoreError('job_terminal', `Job ${input.jobId} is already terminal`)
      }
      if (existing.status !== expectedStatus) {
        return { applied: false, job: existing }
      }

      const createdAt = new Date().toISOString()
      const nextSequence = existing.lastEventSequence + 1
      const updated = this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, phase = ?,
               started_at = CASE
                 WHEN status = 'queued' AND started_at IS NULL THEN ?
                 ELSE started_at
               END,
               last_event_sequence = ?
           WHERE id = ? AND status = ? AND last_event_sequence = ?
             AND finished_at IS NULL`,
        )
        .run(
          status,
          phase,
          createdAt,
          nextSequence,
          input.jobId,
          expectedStatus,
          existing.lastEventSequence,
        )
      if (updated.changes !== 1) {
        return { applied: false, job: this.requireJob(input.jobId) }
      }

      this.insertEvent({
        id: randomUUID(),
        jobId: input.jobId,
        sequence: nextSequence,
        type: 'lifecycle',
        state: status,
        phase,
        metadata,
        output: null,
        createdAt,
      })

      return { applied: true, job: this.requireJob(input.jobId) }
    })
  }

  terminalize(input: TerminalizeJobInput): TerminalizeJobResult {
    const expectedStatus = parseInput(input.expectedStatus, jobStateSchema, 'expectedStatus')
    if (TERMINAL_STATES.has(expectedStatus)) {
      throw new JobStoreError('invalid_input', 'expectedStatus must be non-terminal')
    }
    const status = parseInput(input.status, jobTerminalStateSchema, 'status')
    const error = input.error ? parseInput(input.error, jobErrorSchema, 'error') : null
    const outcome = input.outcome ? parseInput(input.outcome, jobOutcomeSchema, 'outcome') : null
    const stopReason = input.stopReason ? nonEmpty(input.stopReason, 'stopReason') : null
    const output = input.output ? parseInput(input.output, jobEventOutputSchema, 'output') : null
    if (status === 'completed' && error) {
      throw new JobStoreError('invalid_input', 'completed Job must not contain an error')
    }
    if (status === 'failed' && !error) {
      throw new JobStoreError('invalid_input', 'failed Job requires a safe structured error')
    }

    return this.transaction(() => {
      const existing = this.requireJob(input.jobId)
      if (TERMINAL_STATES.has(existing.status) || existing.status !== expectedStatus) {
        return { applied: false, job: existing }
      }

      const finishedAt = new Date().toISOString()
      const terminalSequence = existing.lastEventSequence + 1
      const updated = this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, finished_at = ?, error = ?, outcome = ?, stop_reason = ?,
               last_event_sequence = ?
           WHERE id = ? AND status = ? AND finished_at IS NULL
             AND last_event_sequence = ?`,
        )
        .run(
          status,
          finishedAt,
          error ? JSON.stringify(error) : null,
          outcome ? JSON.stringify(outcome) : null,
          stopReason,
          terminalSequence,
          input.jobId,
          expectedStatus,
          existing.lastEventSequence,
        )
      if (updated.changes !== 1) {
        return { applied: false, job: this.requireJob(input.jobId) }
      }

      const metadata: SafeJobMetadata = {
        outcomeCode: outcome?.code ?? null,
        errorCategory: error?.category ?? null,
        errorCode: error?.code ?? null,
        retryable: error?.retryable ?? null,
        stopReason,
      }
      this.insertEvent({
        id: randomUUID(),
        jobId: input.jobId,
        sequence: terminalSequence,
        type: 'lifecycle',
        state: status,
        phase: existing.phase,
        metadata,
        output,
        createdAt: finishedAt,
      })

      return { applied: true, job: this.requireJob(input.jobId) }
    })
  }

  /** Atomically terminalizes the final assistant projection and its owning Job. */
  terminalizeChat(input: TerminalizeChatJobInput): TerminalizeJobResult {
    const expectedStatus = parseInput(input.expectedStatus, jobStateSchema, 'expectedStatus')
    if (TERMINAL_STATES.has(expectedStatus)) {
      throw new JobStoreError('invalid_input', 'expectedStatus must be non-terminal')
    }
    const status = parseInput(input.status, jobTerminalStateSchema, 'status')
    const error = input.error ? parseInput(input.error, jobErrorSchema, 'error') : null
    const outcome = input.outcome ? parseInput(input.outcome, jobOutcomeSchema, 'outcome') : null
    const stopReason = input.stopReason ? nonEmpty(input.stopReason, 'stopReason') : null
    const output = input.output ? parseInput(input.output, jobEventOutputSchema, 'output') : null
    const turnError = input.message.error
      ? parseInput(input.message.error, turnErrorSchema, 'message.error')
      : null
    if (status === 'completed' && error) {
      throw new JobStoreError('invalid_input', 'completed Job must not contain an error')
    }
    if (status === 'failed' && !error) {
      throw new JobStoreError('invalid_input', 'failed Job requires a safe structured error')
    }

    return this.transaction(() => {
      const existing = this.requireJob(input.jobId)
      if (TERMINAL_STATES.has(existing.status) || existing.status !== expectedStatus) {
        return { applied: false, job: existing }
      }

      const projected = this.db
        .prepare(
          `UPDATE messages
           SET content = ?, thinking = ?, tool_calls = ?, usage = ?, turn_status = ?,
               turn_error = ?, stop_reason = ?
           WHERE id = ? AND job_id = ? AND role = 'assistant' AND turn_status = 'pending'`,
        )
        .run(
          input.message.content,
          input.message.thinking,
          JSON.stringify(input.message.toolCalls),
          input.message.usage ? JSON.stringify(input.message.usage) : null,
          input.message.outcome,
          turnError ? JSON.stringify(turnError) : null,
          input.message.stopReason,
          input.messageId,
          input.jobId,
        )
      if (projected.changes !== 1) {
        throw new JobStoreError(
          'sequence_conflict',
          `Chat Job ${input.jobId} final Message projection changed`,
        )
      }

      const finishedAt = new Date().toISOString()
      const terminalSequence = existing.lastEventSequence + 1
      const updated = this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, finished_at = ?, error = ?, outcome = ?, stop_reason = ?,
               last_event_sequence = ?
           WHERE id = ? AND status = ? AND finished_at IS NULL
             AND last_event_sequence = ?`,
        )
        .run(
          status,
          finishedAt,
          error ? JSON.stringify(error) : null,
          outcome ? JSON.stringify(outcome) : null,
          stopReason,
          terminalSequence,
          input.jobId,
          expectedStatus,
          existing.lastEventSequence,
        )
      if (updated.changes !== 1) {
        throw new JobStoreError('sequence_conflict', `Chat Job ${input.jobId} state changed`)
      }

      this.insertEvent({
        id: randomUUID(),
        jobId: input.jobId,
        sequence: terminalSequence,
        type: 'lifecycle',
        state: status,
        phase: existing.phase,
        metadata: {
          outcomeCode: outcome?.code ?? null,
          errorCategory: error?.category ?? null,
          errorCode: error?.code ?? null,
          retryable: error?.retryable ?? null,
          stopReason,
        },
        output,
        createdAt: finishedAt,
      })

      return { applied: true, job: this.requireJob(input.jobId) }
    })
  }

  private jobByIdempotency(scope: string, key: string): Job | null {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE idempotency_scope = ? AND idempotency_key = ?')
      .get(scope, key) as unknown as JobRow | undefined
    return row ? toJob(row) : null
  }

  private toChatInput(row: ChatJobInputRow): ChatJobAssociation {
    return {
      job: this.requireJob(row.job_id),
      threadId: row.thread_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id,
      requestFingerprint: row.request_fingerprint,
      input: parseStoredJson(
        row.input_json,
        chatJobInputSnapshotSchema,
        'Job',
        row.job_id,
      ),
      createdAt: row.created_at,
    }
  }

  private requireChatInput(jobId: string): ChatJobAssociation {
    const row = this.db
      .prepare('SELECT * FROM chat_job_inputs WHERE job_id = ?')
      .get(jobId) as unknown as ChatJobInputRow | undefined
    if (!row) {
      throw new JobStoreError(
        'idempotency_conflict',
        `Job ${jobId} is not associated with a Chat command`,
      )
    }
    return this.toChatInput(row)
  }

  private requireJob(jobId: string): Job {
    const job = this.get(jobId)
    if (!job) throw new JobStoreError('job_not_found', `Job ${jobId} was not found`)
    return job
  }

  private insertEvent(event: JobStreamEvent): void {
    const parsed = jobStreamEventSchema.parse(event)
    this.db
      .prepare(
        `INSERT INTO job_events (
           id, job_id, sequence, type, state, phase, metadata, output,
           output_privacy, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.jobId,
        parsed.sequence,
        parsed.type,
        parsed.state,
        parsed.phase,
        JSON.stringify(parsed.metadata),
        parsed.output ? JSON.stringify(parsed.output.event) : null,
        parsed.output?.privacyClassification ?? null,
        parsed.createdAt,
      )
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original operation error if SQLite already ended the transaction.
      }
      throw error
    }
  }
}
