import { randomUUID } from 'node:crypto'
import {
  jobErrorSchema,
  jobEventSchema,
  jobEventTypeSchema,
  jobKindSchema,
  jobOutcomeSchema,
  jobSchema,
  jobStateSchema,
  jobTerminalStateSchema,
  safeJobMetadataSchema,
  type Job,
  type JobError,
  type JobEvent,
  type JobEventType,
  type JobKind,
  type JobOutcome,
  type JobState,
  type JobTerminalState,
  type SafeJobMetadata,
} from '@alamo/contract'
import type { Db } from './db.ts'

const TERMINAL_STATES = new Set<JobState>(jobTerminalStateSchema.options)

export type JobStoreErrorCode =
  | 'job_not_found'
  | 'job_terminal'
  | 'sequence_conflict'
  | 'stored_data_invalid'
  | 'invalid_input'

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

export interface AppendJobEventInput {
  jobId: string
  expectedNextSequence: number
  type: JobEventType
  metadata?: SafeJobMetadata
}

export interface TerminalizeJobInput {
  jobId: string
  expectedStatus: JobState
  status: JobTerminalState
  error?: JobError | null
  outcome?: JobOutcome | null
  stopReason?: string | null
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

function toJobEvent(row: JobEventRow): JobEvent {
  const candidate = {
    id: row.id,
    jobId: row.job_id,
    sequence: row.sequence,
    type: row.type,
    state: row.state,
    phase: row.phase,
    metadata: parseStoredJson(row.metadata, safeJobMetadataSchema, 'Job event', row.id),
    createdAt: row.created_at,
  }
  const parsed = jobEventSchema.safeParse(candidate)
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
        createdAt,
      })

      return { created: true, job: this.requireJob(id) }
    })
  }

  get(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as unknown as
      | JobRow
      | undefined
    return row ? toJob(row) : null
  }

  eventsAfter(jobId: string, afterSequence: number, limit = 100): JobEvent[] {
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

  appendEvent(input: AppendJobEventInput): JobEvent {
    if (!Number.isInteger(input.expectedNextSequence) || input.expectedNextSequence < 1) {
      throw new JobStoreError(
        'invalid_input',
        'expectedNextSequence must be a positive integer',
      )
    }
    const type = parseInput(input.type, jobEventTypeSchema, 'type')
    const metadata = parseInput(input.metadata ?? {}, safeJobMetadataSchema, 'metadata')

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

      const event: JobEvent = {
        id: randomUUID(),
        jobId: input.jobId,
        sequence: nextSequence,
        type,
        state: job.status,
        phase: job.phase,
        metadata,
        createdAt: new Date().toISOString(),
      }
      this.insertEvent(event)
      return event
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

  private requireJob(jobId: string): Job {
    const job = this.get(jobId)
    if (!job) throw new JobStoreError('job_not_found', `Job ${jobId} was not found`)
    return job
  }

  private insertEvent(event: JobEvent): void {
    const parsed = jobEventSchema.parse(event)
    this.db
      .prepare(
        `INSERT INTO job_events (
           id, job_id, sequence, type, state, phase, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.jobId,
        parsed.sequence,
        parsed.type,
        parsed.state,
        parsed.phase,
        JSON.stringify(parsed.metadata),
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
