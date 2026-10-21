import { createHash, randomUUID } from 'node:crypto'
import {
  chatJobInputSnapshotSchema,
  createRecipeJobSnapshotBody,
  jobErrorSchema,
  jobEventTypeSchema,
  jobEventOutputSchema,
  jobKindSchema,
  jobOutcomeSchema,
  jobSchema,
  jobStateSchema,
  jobStreamEventSchema,
  jobTerminalStateSchema,
  recipeJobSnapshotPathParams,
  recipeJobSnapshotSchema,
  recipeJobSnapshotScopeSchema,
  recipeConfigurationSchema,
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
  type RecipeJobSnapshot,
  type RecipeJobSnapshotScope,
  type RecipeModelReference,
  type RecipeOperation,
  type SafeJobMetadata,
} from '@guanxi/contract'
import { isCanonicalNonTerminalTransition } from '../jobs/lifecycle.ts'
import type { JobEventMirror } from '../session-log/chat-mirror.ts'
import type { Db } from './db.ts'
import { canonicalRecipeConfiguration, RecipeStore } from './recipes.ts'
import type { TerminalMessageUpdate } from './threads.ts'

const TERMINAL_STATES = new Set<JobState>(jobTerminalStateSchema.options)

function recipeSnapshotIdempotencyScope(): string {
  return 'recipe_job_snapshot:v1'
}

function recipeSnapshotFingerprint(input: {
  recipeId: string
  recipeRevision: number
  scope: RecipeJobSnapshotScope
  operation: RecipeOperation
  model: RecipeModelReference
  canonicalSha256: string
}): string {
  const exactIntent = JSON.stringify({
    recipeJobSnapshotVersion: 1,
    jobKind: 'inference',
    recipeId: input.recipeId,
    recipeRevision: input.recipeRevision,
    scope: input.scope.scope,
    projectId: input.scope.scope === 'project' ? input.scope.projectId : null,
    operation: input.operation,
    model: input.model,
    canonicalSha256: input.canonicalSha256,
  })
  return createHash('sha256').update(Buffer.from(exactIntent, 'utf8')).digest('hex')
}

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

interface ChatRecoveryRow {
  job_id: string
  input_job_id: string | null
  thread_id: string | null
  user_message_id: string | null
  assistant_message_id: string | null
  request_fingerprint: string | null
  input_json: string | null
  input_created_at: string | null
}

interface RecipeJobSnapshotRow {
  job_id: string
  snapshot_version: number
  recipe_id: string
  recipe_revision: number
  scope: string
  project_id: string | null
  job_kind: string
  operation: string
  model_state: string
  model_provider: string | null
  model_reference: string | null
  configuration_json: string
  configuration_byte_size: number
  configuration_sha256: string
  request_fingerprint: string
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

export interface ChatRecoveryCursor {
  createdAt: string
  jobId: string
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

export interface RecipeJobSnapshotAssociation {
  job: Job
  snapshot: RecipeJobSnapshot
}

export interface CreateRecipeJobSnapshotInput {
  recipeId: string
  recipeRevision: number
  scope: RecipeJobSnapshotScope
  idempotencyKey: string
}

export interface CreateRecipeJobSnapshotResult extends RecipeJobSnapshotAssociation {
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
  private readonly reasoningChecksum: (content: string) => string
  private readonly sessionMirror: JobEventMirror | null

  constructor(
    db: Db,
    options: {
      reasoningChecksum?: (content: string) => string
      /** Appends the session-log trace of Chat Jobs inside each Job transaction (K2). */
      sessionMirror?: JobEventMirror
    } = {},
  ) {
    this.db = db
    this.sessionMirror = options.sessionMirror ?? null
    this.reasoningChecksum = options.reasoningChecksum ?? ((content) =>
      `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`)
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

      const thread = this.db
        .prepare('SELECT id, mode FROM threads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=threads.id)')
        .get(threadId) as unknown as { id: string; mode: string } | undefined
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

      this.sessionMirror?.recordChatCreated({ jobId: id, threadId, userMessageId, input: snapshot, createdAt })
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
          .prepare(
            `UPDATE threads
             SET title = ?, updated_at = ?,
                 last_user_activity_at = CASE WHEN mode = 'chat' THEN ? ELSE last_user_activity_at END,
                 last_user_activity_source = CASE WHEN mode = 'chat' THEN 'user_message' ELSE last_user_activity_source END,
                 last_user_restore_at = CASE WHEN mode = 'chat' THEN NULL ELSE last_user_restore_at END
             WHERE id = ?`,
          )
          .run(derivedTitle, createdAt, createdAt, threadId)
      } else {
        this.db
          .prepare(
            `UPDATE threads
             SET updated_at = ?,
                 last_user_activity_at = CASE WHEN mode = 'chat' THEN ? ELSE last_user_activity_at END,
                 last_user_activity_source = CASE WHEN mode = 'chat' THEN 'user_message' ELSE last_user_activity_source END,
                 last_user_restore_at = CASE WHEN mode = 'chat' THEN NULL ELSE last_user_restore_at END
             WHERE id = ?`,
          )
          .run(createdAt, createdAt, threadId)
      }

      return { created: true, ...this.requireChatInput(id) }
    })
  }

  /**
   * Atomically materializes one immutable Recipe revision into a queued Job.
   * Configuration bytes stay in the dedicated snapshot table and never enter
   * safe Job/event metadata or the private Chat association.
   */
  createRecipeSnapshot(input: CreateRecipeJobSnapshotInput): CreateRecipeJobSnapshotResult {
    const path = parseInput(
      { id: input.recipeId, revision: input.recipeRevision },
      recipeJobSnapshotPathParams,
      'recipe revision',
    )
    const scope = parseInput(input.scope, recipeJobSnapshotScopeSchema, 'scope')
    const body = parseInput(
      scope.scope === 'project'
        ? {
            recipeJobSnapshotVersion: 1,
            scope: 'project',
            projectId: scope.projectId,
            idempotencyKey: input.idempotencyKey,
          }
        : {
            recipeJobSnapshotVersion: 1,
            scope: 'projectless',
            idempotencyKey: input.idempotencyKey,
          },
      createRecipeJobSnapshotBody,
      'Recipe Job snapshot command',
    )
    const idempotencyScope = recipeSnapshotIdempotencyScope()

    return this.transaction(() => {
      const revisionResult = new RecipeStore(this.db).getRevision(path.id, path.revision, scope)
      if (revisionResult.status !== 'ok') {
        throw new JobStoreError(
          'invalid_input',
          `Recipe ${path.id} revision ${path.revision} was not found in this scope`,
        )
      }
      const revision = revisionResult.revision
      const configurationBytes = canonicalRecipeConfiguration(revision.configuration)
      const fingerprint = recipeSnapshotFingerprint({
        recipeId: path.id,
        recipeRevision: path.revision,
        scope,
        operation: revision.configuration.operation,
        model: revision.configuration.model,
        canonicalSha256: revision.canonical.sha256,
      })
      const existing = this.jobByIdempotency(idempotencyScope, body.idempotencyKey)
      if (existing) {
        const association = this.requireRecipeSnapshot(existing.id)
        if (association.requestFingerprint !== fingerprint) {
          throw new JobStoreError(
            'idempotency_conflict',
            'The Recipe Job idempotency key is already bound to different input',
          )
        }
        return { created: false, job: existing, snapshot: association.snapshot }
      }

      const id = randomUUID()
      const createdAt = new Date().toISOString()
      const operation = revision.configuration.operation
      this.db
        .prepare(
          `INSERT INTO jobs (
             id, kind, operation, status, phase, idempotency_scope, idempotency_key,
             created_at, started_at, finished_at, error, outcome, stop_reason,
             last_event_sequence
           ) VALUES (?, 'inference', ?, 'queued', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1)`,
        )
        .run(id, operation, idempotencyScope, body.idempotencyKey, createdAt)

      this.insertEvent({
        id: randomUUID(),
        jobId: id,
        sequence: 1,
        type: 'lifecycle',
        state: 'queued',
        phase: null,
        metadata: {},
        output: null,
        createdAt,
      })

      const model = revision.configuration.model
      this.db
        .prepare(
          `INSERT INTO recipe_job_snapshots (
             job_id, snapshot_version, recipe_id, recipe_revision, scope, project_id,
             job_kind, operation, model_state, model_provider, model_reference,
             configuration_json, configuration_byte_size, configuration_sha256,
             request_fingerprint, created_at
           ) VALUES (?, 1, ?, ?, ?, ?, 'inference', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          path.id,
          path.revision,
          scope.scope,
          scope.scope === 'project' ? scope.projectId : null,
          operation,
          model.state,
          model.state === 'explicit' ? model.provider : null,
          model.state === 'explicit' ? model.reference : null,
          configurationBytes,
          revision.canonical.byteSize,
          revision.canonical.sha256,
          fingerprint,
          createdAt,
        )

      const association = this.requireRecipeSnapshot(id)
      return { created: true, job: association.job, snapshot: association.snapshot }
    })
  }

  recipeSnapshot(jobId: string): RecipeJobSnapshotAssociation | null {
    const row = this.db
      .prepare('SELECT * FROM recipe_job_snapshots WHERE job_id = ?')
      .get(jobId) as unknown as RecipeJobSnapshotRow | undefined
    if (!row) return null
    const { job, snapshot } = this.toRecipeSnapshot(row)
    return { job, snapshot }
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

  /**
   * Stable bounded startup scan for typed Chat commands only.
   *
   * A missing association for a server-owned Chat scope is returned as a
   * controlled storage failure instead of being skipped as a generic Job.
   */
  chatRecoveryPage(
    after: ChatRecoveryCursor | null,
    limit: number,
  ): ChatJobAssociation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new JobStoreError('invalid_input', 'limit must be an integer from 1 to 1000')
    }
    const cursorCreatedAt = after?.createdAt ?? ''
    const cursorJobId = after?.jobId ?? ''
    const rows = this.db
      .prepare(
         `SELECT
           job.id AS job_id,
           input.job_id AS input_job_id,
           input.thread_id AS thread_id,
           input.user_message_id AS user_message_id,
           input.assistant_message_id AS assistant_message_id,
           input.request_fingerprint AS request_fingerprint,
           input.input_json AS input_json,
           input.created_at AS input_created_at
         FROM jobs job
         LEFT JOIN chat_job_inputs input ON input.job_id = job.id
         WHERE job.status NOT IN ('completed','failed','cancelled','interrupted')
           AND (input.job_id IS NOT NULL OR job.idempotency_scope GLOB 'chat:*:send:v1')
           AND (
             job.created_at > ?
             OR (job.created_at = ? AND job.id > ?)
           )
         ORDER BY job.created_at ASC, job.id ASC
         LIMIT ?`,
      )
      .all(cursorCreatedAt, cursorCreatedAt, cursorJobId, limit) as unknown as ChatRecoveryRow[]

    return rows.map((row) => {
      if (
        row.input_job_id === null ||
        row.thread_id === null ||
        row.user_message_id === null ||
        row.assistant_message_id === null ||
        row.request_fingerprint === null ||
        row.input_json === null ||
        row.input_created_at === null
      ) {
        throw new JobStoreError(
          'stored_data_invalid',
          'A non-terminal Chat Job contains an incomplete durable association',
        )
      }
      return this.toChatInput({
        job_id: row.input_job_id,
        thread_id: row.thread_id,
        user_message_id: row.user_message_id,
        assistant_message_id: row.assistant_message_id,
        request_fingerprint: row.request_fingerprint,
        input_json: row.input_json,
        created_at: row.input_created_at,
      })
    })
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

      const finishedAt = new Date().toISOString()
      const reasoning = input.message.thinking
      const projected = this.db
        .prepare(
          `UPDATE messages
           SET content = ?, thinking = ?, tool_calls = ?, usage = ?, turn_status = ?,
               turn_error = ?, stop_reason = ?
           WHERE id = ? AND job_id = ? AND role = 'assistant' AND turn_status = 'pending'`,
        )
        .run(
          input.message.content,
          null,
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

      if (reasoning) {
        const source = this.db
          .prepare(
            `SELECT t.id AS chat_id, t.project_id, t.retention_policy,
                    t.last_user_activity_at, t.created_at
             FROM chat_job_inputs i
             JOIN threads t ON t.id = i.thread_id
             WHERE i.job_id = ?`,
          )
          .get(input.jobId) as unknown as {
            chat_id: string
            project_id: string | null
            retention_policy: 'keep' | 'ttl' | 'session'
            last_user_activity_at: string | null
            created_at: string
          } | undefined
        if (!source) {
          throw new JobStoreError('stored_data_invalid', 'Reasoning Artifact source is unavailable')
        }
        const artifactExpiresAt = new Date(Date.parse(finishedAt) + 7 * 24 * 60 * 60 * 1_000)
          .toISOString()
        const parentExpiresAt = source.retention_policy === 'ttl'
          ? new Date(
              Date.parse(source.last_user_activity_at ?? source.created_at) +
                7 * 24 * 60 * 60 * 1_000,
            ).toISOString()
          : null
        const effectiveExpiresAt = parentExpiresAt && parentExpiresAt < artifactExpiresAt
          ? parentExpiresAt
          : artifactExpiresAt
        const checksum = this.reasoningChecksum(reasoning)
        const expectedChecksum = `sha256:${createHash('sha256')
          .update(Buffer.from(reasoning, 'utf8'))
          .digest('hex')}`
        if (checksum !== expectedChecksum) {
          throw new JobStoreError('stored_data_invalid', 'Reasoning Artifact checksum mismatch')
        }
        this.db
          .prepare(
            `INSERT INTO reasoning_artifacts (
               id, artifact_version, chat_id, project_id, source_message_id,
               source_job_id, media_type, storage_kind, content_text, byte_size,
               checksum, created_at, artifact_expires_at, parent_retention_mode,
               parent_retention_expires_at, effective_expires_at
             ) VALUES (?, 1, ?, ?, ?, ?, 'text/markdown; charset=utf-8',
               'sqlite_text', ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
            source.chat_id,
            source.project_id,
            input.messageId,
            input.jobId,
            reasoning,
            Buffer.byteLength(reasoning, 'utf8'),
            checksum,
            finishedAt,
            artifactExpiresAt,
            source.retention_policy,
            parentExpiresAt,
            effectiveExpiresAt,
          )
      }

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

  private toRecipeSnapshot(
    row: RecipeJobSnapshotRow,
  ): RecipeJobSnapshotAssociation & { requestFingerprint: string } {
    const job = this.requireJob(row.job_id)
    const configuration = parseStoredJson(
      row.configuration_json,
      recipeConfigurationSchema,
      'Job',
      row.job_id,
    )
    const canonicalBytes = canonicalRecipeConfiguration(configuration)
    const canonicalSha256 = createHash('sha256')
      .update(Buffer.from(canonicalBytes, 'utf8'))
      .digest('hex')
    if (
      canonicalBytes !== row.configuration_json ||
      Buffer.byteLength(canonicalBytes, 'utf8') !== row.configuration_byte_size ||
      canonicalSha256 !== row.configuration_sha256
    ) {
      throw new JobStoreError(
        'stored_data_invalid',
        `Recipe Job snapshot ${row.job_id} failed canonical integrity validation`,
      )
    }
    const model = row.model_state === 'explicit'
      ? { state: 'explicit' as const, provider: row.model_provider, reference: row.model_reference }
      : { state: 'none' as const, reason: 'not_selected' as const }
    const parsed = recipeJobSnapshotSchema.safeParse({
      recipeJobSnapshotVersion: row.snapshot_version,
      jobId: row.job_id,
      jobKind: row.job_kind,
      recipeId: row.recipe_id,
      recipeRevision: row.recipe_revision,
      scope: row.scope,
      projectId: row.project_id,
      operation: row.operation,
      model,
      configuration,
      canonical: {
        format: 'canonical_json_v1',
        byteSize: row.configuration_byte_size,
        sha256: row.configuration_sha256,
      },
      createdAt: row.created_at,
      execution: 'not_implemented',
    })
    if (
      !parsed.success ||
      job.id !== parsed.data.jobId ||
      job.kind !== parsed.data.jobKind ||
      job.operation !== parsed.data.operation ||
      job.idempotencyScope !== recipeSnapshotIdempotencyScope() ||
      row.request_fingerprint !== recipeSnapshotFingerprint({
        recipeId: row.recipe_id,
        recipeRevision: row.recipe_revision,
        scope: parsed.data.scope === 'project'
          ? { scope: 'project', projectId: parsed.data.projectId! }
          : { scope: 'projectless' },
        operation: parsed.data.operation,
        model: parsed.data.model,
        canonicalSha256: parsed.data.canonical.sha256,
      })
    ) {
      throw new JobStoreError(
        'stored_data_invalid',
        `Recipe Job snapshot ${row.job_id} contains invalid stored data`,
      )
    }
    return { job, snapshot: parsed.data, requestFingerprint: row.request_fingerprint }
  }

  private requireRecipeSnapshot(
    jobId: string,
  ): RecipeJobSnapshotAssociation & { requestFingerprint: string } {
    const row = this.db
      .prepare('SELECT * FROM recipe_job_snapshots WHERE job_id = ?')
      .get(jobId) as unknown as RecipeJobSnapshotRow | undefined
    if (!row) {
      throw new JobStoreError(
        'idempotency_conflict',
        `Job ${jobId} is not associated with a Recipe snapshot command`,
      )
    }
    return this.toRecipeSnapshot(row)
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
    this.sessionMirror?.recordJobEvent(parsed)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = operation()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original operation error if SQLite already ended the transaction.
      }
      this.sessionMirror?.afterRollback()
      throw error
    }
    // Session subscribers are woken only after the Job and its trace committed.
    this.sessionMirror?.afterCommit()
    return result
  }
}
