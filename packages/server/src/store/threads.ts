/**
 * Треды и сообщения.
 *
 * Сообщения нумеруются полем `seq` внутри треда, а не сортируются по времени:
 * при стриминге несколько сообщений могут получить одинаковую метку времени.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  contextCheckpointSchema,
  PROJECT_CHAT_OWNERSHIP_VERSION,
  turnErrorSchema,
  type ContextCheckpoint,
  type Message,
  type Thread,
  type ThreadWithOwnership,
  type ThreadMode,
  type ThreadOptions,
  type ToolCall,
  type TurnError,
  type TurnStatus,
  type TurnStopReason,
  type TurnTerminalOutcome,
  type Usage,
} from '@guanxi/contract'
import type { Db } from './db.ts'

interface ThreadRow {
  id: string
  title: string
  mode: string
  model: string
  workspace_id: string | null
  project_id: string | null
  num_ctx: number
  temperature: number
  think: string
  created_at: string
  updated_at: string
  message_count?: number
}

interface MessageRow {
  id: string
  thread_id: string
  job_id: string | null
  seq: number
  role: string
  content: string
  thinking: string | null
  artifact_thinking?: string | null
  artifact_version?: number | null
  tool_calls: string
  usage: string | null
  is_compaction: number
  created_at: string
  turn_status: string | null
  turn_error: string | null
  stop_reason: string | null
}

interface ContextCheckpointRow {
  id: string
  checkpoint_version: number
  thread_id: string
  previous_checkpoint_id: string | null
  up_to_seq: number
  source_state: string
  source_message_count: number
  summary_text: string
  summary_byte_size: number
  summary_sha256: string
  created_at: string
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode as ThreadMode,
    model: row.model,
    workspaceId: row.workspace_id,
    options: {
      numCtx: row.num_ctx,
      temperature: row.temperature,
      think: row.think as ThreadOptions['think'],
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
  }
}

function toThreadWithOwnership(row: ThreadRow): ThreadWithOwnership {
  return {
    ...toThread(row),
    ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
    projectId: row.project_id,
  }
}

function toMessage(row: MessageRow): Message {
  if (row.artifact_version !== undefined && row.artifact_version !== null && row.artifact_version !== 1) {
    throw new Error(`Message ${row.id} references an unsupported reasoning Artifact version`)
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    jobId: row.job_id,
    role: row.role as Message['role'],
    content: row.content,
    thinking: row.artifact_thinking ?? row.thinking,
    toolCalls: JSON.parse(row.tool_calls) as ToolCall[],
    usage: row.usage ? (JSON.parse(row.usage) as Usage) : null,
    createdAt: row.created_at,
    isCompaction: row.is_compaction === 1,
    turnStatus: row.turn_status as TurnStatus | null,
    turnError: row.turn_error ? turnErrorSchema.parse(JSON.parse(row.turn_error)) : null,
    stopReason: row.stop_reason as TurnStopReason | null,
  }
}

export interface TerminalMessageUpdate {
  outcome: TurnTerminalOutcome
  error: TurnError | null
  stopReason: TurnStopReason
  content: string
  thinking: string | null
  toolCalls: ToolCall[]
  usage: Usage | null
}

export interface TerminalMessageResult {
  /** false means another terminal outcome won; the existing outcome is unchanged. */
  applied: boolean
  message: Message
}

export interface CompactionCandidates {
  messages: Message[]
  /** Actual persisted sequence of the last message included in the summary. */
  upToSeq: number
  expectedPreviousCheckpointId: string | null
}

export class ContextCheckpointStoreError extends Error {
  readonly code: 'invalid_input' | 'stale_checkpoint' | 'stored_data_invalid'

  constructor(
    code: 'invalid_input' | 'stale_checkpoint' | 'stored_data_invalid',
    message: string,
  ) {
    super(message)
    this.code = code
  }
}

export class ThreadStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /* ──────────────────────────────── Треды ────────────────────────────────── */

  list(): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t
         WHERE t.chat_lifecycle_state = 'active'
           AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=t.id)
         ORDER BY t.updated_at DESC`,
      )
      .all() as unknown as ThreadRow[]
    return rows.map(toThread)
  }

  listProjectless(): ThreadWithOwnership[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t
         WHERE t.project_id IS NULL AND t.chat_lifecycle_state = 'active'
           AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=t.id)
         ORDER BY t.updated_at DESC, t.id`,
      )
      .all() as unknown as ThreadRow[]
    return rows.map(toThreadWithOwnership)
  }

  listByProject(projectId: string): ThreadWithOwnership[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t
         WHERE t.project_id = ? AND t.chat_lifecycle_state = 'active'
           AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=t.id)
         ORDER BY t.updated_at DESC, t.id`,
      )
      .all(projectId) as unknown as ThreadRow[]
    return rows.map(toThreadWithOwnership)
  }

  get(id: string): Thread | null {
    const row = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.id = ? AND t.chat_lifecycle_state = 'active'
           AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=t.id)`,
      )
      .get(id) as unknown as ThreadRow | undefined
    return row ? toThread(row) : null
  }

  getWithOwnership(id: string): ThreadWithOwnership | null {
    const row = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.id = ? AND t.chat_lifecycle_state = 'active'
           AND NOT EXISTS (SELECT 1 FROM native_sessions n WHERE n.thread_id=t.id)`,
      )
      .get(id) as unknown as ThreadRow | undefined
    return row ? toThreadWithOwnership(row) : null
  }

  create(input: {
    title: string
    mode: ThreadMode
    model: string
    workspaceId: string | null
    options: ThreadOptions
  }): Thread {
    const id = this.insert({ ...input, projectId: null })
    return this.get(id)!
  }

  createWithOwnership(input: {
    title: string
    model: string
    projectId: string
    options: ThreadOptions
  }): ThreadWithOwnership {
    const id = this.insert({ ...input, mode: 'chat', workspaceId: null })
    return this.getWithOwnership(id)!
  }

  private insert(input: {
    title: string
    mode: ThreadMode
    model: string
    workspaceId: string | null
    projectId: string | null
    options: ThreadOptions
  }): string {
    const now = new Date().toISOString()
    const id = randomUUID()

    this.db
      .prepare(
        `INSERT INTO threads (
           id, title, mode, model, workspace_id, project_id,
           num_ctx, temperature, think, created_at, updated_at,
           retention_policy, retention_policy_source, retention_policy_updated_at,
           last_user_activity_at, last_user_activity_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default', ?, ?, 'chat_created')`,
      )
      .run(
        id,
        input.title,
        input.mode,
        input.model,
        input.workspaceId,
        input.projectId,
        input.options.numCtx,
        input.options.temperature,
        input.options.think,
        now,
        now,
        input.mode === 'chat' ? 'ttl' : 'keep',
        now,
        now,
      )

    return id
  }

  update(
    id: string,
    patch: {
      title?: string
      model?: string
      workspaceId?: string | null
      options?: Partial<ThreadOptions>
    },
  ): Thread | null {
    const existing = this.get(id)
    if (!existing) return null

    const merged = {
      title: patch.title ?? existing.title,
      model: patch.model ?? existing.model,
      workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : existing.workspaceId,
      numCtx: patch.options?.numCtx ?? existing.options.numCtx,
      temperature: patch.options?.temperature ?? existing.options.temperature,
      think: patch.options?.think ?? existing.options.think,
    }

    this.db
      .prepare(
        `UPDATE threads
         SET title = ?, model = ?, workspace_id = ?, num_ctx = ?, temperature = ?, think = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.model,
        merged.workspaceId,
        merged.numCtx,
        merged.temperature,
        merged.think,
        new Date().toISOString(),
        id,
      )

    return this.get(id)
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM threads WHERE id = ? AND chat_lifecycle_state = 'active'")
      .run(id)
    return result.changes > 0
  }

  private touch(threadId: string): void {
    this.db
      .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), threadId)
  }

  /* ─────────────────────────────── Сообщения ─────────────────────────────── */

  messages(threadId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, a.content_text AS artifact_thinking, a.artifact_version
         FROM messages m
         LEFT JOIN reasoning_artifacts a ON a.source_message_id = m.id
         WHERE m.thread_id = ?
         ORDER BY m.seq`,
      )
      .all(threadId) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /** Explicit canonical checkpoints plus projections of pre-v24 destructive summaries. */
  contextCheckpoints(threadId: string): ContextCheckpoint[] {
    const canonical = this.canonicalContextCheckpoints(threadId)
    const legacy = (this.db
      .prepare(
        `SELECT m.*, NULL AS artifact_thinking, NULL AS artifact_version
         FROM messages m
         WHERE m.thread_id = ? AND m.is_compaction = 1
         ORDER BY m.seq, m.id`,
      )
      .all(threadId) as unknown as MessageRow[]).map((row) => {
      const content = row.content.trim()
      if (!content) {
        throw new ContextCheckpointStoreError(
          'stored_data_invalid',
          `Legacy context checkpoint ${row.id} has empty content`,
        )
      }
      return contextCheckpointSchema.parse({
        contextCheckpointVersion: 1,
        id: row.id,
        threadId: row.thread_id,
        previousCheckpointId: null,
        source: {
          state: 'legacy_source_unavailable',
          upToSeq: row.seq,
          messageCount: null,
        },
        summary: {
          format: 'text_utf8_v1',
          content: row.content,
          byteSize: Buffer.byteLength(row.content, 'utf8'),
          sha256: createHash('sha256').update(Buffer.from(row.content, 'utf8')).digest('hex'),
        },
        createdAt: row.created_at,
      })
    })
    return [...legacy, ...canonical].sort((left, right) =>
      left.source.upToSeq - right.source.upToSeq || left.createdAt.localeCompare(right.createdAt),
    )
  }

  /** Resolves one client compaction intent without crossing Thread ownership. */
  contextCheckpointByIntent(threadId: string, checkpointId: string): ContextCheckpoint | null {
    const checkpoint = this.canonicalContextCheckpoints(threadId)
      .find((candidate) => candidate.id === checkpointId)
    if (checkpoint) return checkpoint
    const collision = this.db
      .prepare('SELECT thread_id FROM context_checkpoints WHERE id = ?')
      .get(checkpointId) as { thread_id: string } | undefined
    if (collision) {
      throw new ContextCheckpointStoreError(
        'invalid_input',
        'Context checkpoint idempotency key belongs to another Thread',
      )
    }
    return null
  }

  /** Only the latest summary plus the unsummarized original tail sent to a model. */
  activeContextMessages(threadId: string): Message[] {
    const latest = this.canonicalContextCheckpoints(threadId).at(-1)
    if (!latest) return this.messages(threadId)
    const rows = this.db
      .prepare(
        `SELECT m.*, a.content_text AS artifact_thinking, a.artifact_version
         FROM messages m
         LEFT JOIN reasoning_artifacts a ON a.source_message_id = m.id
         WHERE m.thread_id = ? AND m.seq > ? ORDER BY m.seq`,
      )
      .all(threadId, latest.source.upToSeq) as unknown as MessageRow[]
    return [this.checkpointMessage(latest), ...rows.map(toMessage)]
  }

  /**
   * Selects the prefix for compaction and preserves its real persisted boundary.
   *
   * Array indexes are not persisted sequence numbers, so callers must never
   * derive the checkpoint boundary from length.
   */
  compactionCandidates(threadId: string, keepTail: number): CompactionCandidates | null {
    const rows = this.db
      .prepare(
        `SELECT m.*, NULL AS artifact_thinking, NULL AS artifact_version
         FROM messages m WHERE m.thread_id = ? ORDER BY m.seq`,
      )
      .all(threadId) as unknown as MessageRow[]

    const latest = this.canonicalContextCheckpoints(threadId).at(-1) ?? null
    const tail = latest ? rows.filter((row) => row.seq > latest.source.upToSeq) : rows
    const activeCount = tail.length + (latest ? 1 : 0)
    if (activeCount <= keepTail + 1) return null
    const originalCount = activeCount - keepTail - (latest ? 1 : 0)
    const candidateRows = tail.slice(0, originalCount)
    const boundary = candidateRows.at(-1)
    if (!boundary) return null
    if (candidateRows.some((row) => row.role === 'assistant' && row.turn_status === 'pending')) {
      return null
    }

    return {
      messages: [
        ...(latest ? [this.checkpointMessage(latest)] : []),
        ...candidateRows.map(toMessage),
      ],
      upToSeq: boundary.seq,
      expectedPreviousCheckpointId: latest?.id ?? null,
    }
  }

  createContextCheckpoint(input: {
    checkpointId?: string
    threadId: string
    upToSeq: number
    expectedPreviousCheckpointId: string | null
    summary: string
  }): ContextCheckpoint {
    const summary = input.summary.trim()
    if (!summary) {
      throw new ContextCheckpointStoreError('invalid_input', 'Context checkpoint summary is empty')
    }
    if (!Number.isSafeInteger(input.upToSeq) || input.upToSeq < 0) {
      throw new ContextCheckpointStoreError('invalid_input', 'Context checkpoint boundary is invalid')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const canonical = this.canonicalContextCheckpoints(input.threadId)
      const existing = input.checkpointId
        ? canonical.find((checkpoint) => checkpoint.id === input.checkpointId)
        : null
      if (existing) {
        this.db.exec('COMMIT')
        return existing
      }
      if (input.checkpointId) this.contextCheckpointByIntent(input.threadId, input.checkpointId)
      const latest = canonical.at(-1) ?? null
      if ((latest?.id ?? null) !== input.expectedPreviousCheckpointId) {
        throw new ContextCheckpointStoreError(
          'stale_checkpoint',
          'The active context checkpoint changed before persistence',
        )
      }
      const source = this.db.prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE thread_id = ? AND seq <= ?`,
      ).get(input.threadId, input.upToSeq) as unknown as { count: number }
      if (source.count < 1) {
        throw new ContextCheckpointStoreError(
          'invalid_input',
          'Context checkpoint boundary was not found',
        )
      }
      const id = input.checkpointId ?? randomUUID()
      const createdAt = new Date().toISOString()
      const byteSize = Buffer.byteLength(summary, 'utf8')
      const sha256 = createHash('sha256').update(Buffer.from(summary, 'utf8')).digest('hex')
      this.db.prepare(
        `INSERT INTO context_checkpoints (
           id, checkpoint_version, thread_id, previous_checkpoint_id, up_to_seq,
           source_state, source_message_count, summary_text, summary_byte_size,
           summary_sha256, created_at
         ) VALUES (?, 1, ?, ?, ?, 'source_preserved', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.threadId,
        input.expectedPreviousCheckpointId,
        input.upToSeq,
        source.count,
        summary,
        byteSize,
        sha256,
        createdAt,
      )
      const checkpoint = this.canonicalContextCheckpoints(input.threadId).at(-1)
      if (!checkpoint || checkpoint.id !== id) {
        throw new Error('Context checkpoint insert was not visible')
      }
      this.touch(input.threadId)
      this.db.exec('COMMIT')
      return checkpoint
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private nextSeq(threadId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE thread_id = ?')
      .get(threadId) as unknown as { next: number }
    return row.next
  }

  addMessage(input: {
    threadId: string
    role: Message['role']
    content: string
    thinking?: string | null
    toolCalls?: ToolCall[]
    usage?: Usage | null
    isCompaction?: boolean
    turnStatus?: TurnStatus | null
    turnError?: TurnError | null
    stopReason?: TurnStopReason | null
    jobId?: string | null
    /** Явная позиция в треде. Нужна компакции, чтобы резюме встало в начало, а не в конец. */
    seq?: number
  }): Message {
    const id = randomUUID()
    const now = new Date().toISOString()
    const seq = input.seq ?? this.nextSeq(input.threadId)

    this.db
      .prepare(
        `INSERT INTO messages (
           id, thread_id, seq, role, content, thinking, tool_calls, usage,
           is_compaction, created_at, turn_status, turn_error, stop_reason, job_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        seq,
        input.role,
        input.content,
        input.thinking ?? null,
        JSON.stringify(input.toolCalls ?? []),
        input.usage ? JSON.stringify(input.usage) : null,
        input.isCompaction ? 1 : 0,
        now,
        input.turnStatus ?? (input.role === 'assistant' ? 'pending' : null),
        input.turnError ? JSON.stringify(input.turnError) : null,
        input.stopReason ?? null,
        input.jobId ?? null,
      )

    this.touch(input.threadId)

    return {
      id,
      threadId: input.threadId,
      jobId: input.jobId ?? null,
      role: input.role,
      content: input.content,
      thinking: input.thinking ?? null,
      toolCalls: input.toolCalls ?? [],
      usage: input.usage ?? null,
      createdAt: now,
      isCompaction: input.isCompaction ?? false,
      turnStatus: input.turnStatus ?? (input.role === 'assistant' ? 'pending' : null),
      turnError: input.turnError ?? null,
      stopReason: input.stopReason ?? null,
    }
  }

  /** Дописывает содержимое стримящегося сообщения. */
  updateMessage(
    id: string,
    patch: { content?: string; thinking?: string | null; toolCalls?: ToolCall[]; usage?: Usage | null },
  ): void {
    const sets: string[] = []
    const values: (string | null)[] = []

    if (patch.content !== undefined) {
      sets.push('content = ?')
      values.push(patch.content)
    }
    if (patch.thinking !== undefined) {
      sets.push('thinking = ?')
      values.push(patch.thinking)
    }
    if (patch.toolCalls !== undefined) {
      sets.push('tool_calls = ?')
      values.push(JSON.stringify(patch.toolCalls))
    }
    if (patch.usage !== undefined) {
      sets.push('usage = ?')
      values.push(patch.usage ? JSON.stringify(patch.usage) : null)
    }
    if (sets.length === 0) return

    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare(
      `SELECT m.*, a.content_text AS artifact_thinking, a.artifact_version
       FROM messages m
       LEFT JOIN reasoning_artifacts a ON a.source_message_id = m.id
       WHERE m.id = ?`,
    ).get(id) as unknown as
      | MessageRow
      | undefined
    return row ? toMessage(row) : null
  }

  latestPendingAssistantForJob(jobId: string): Message | null {
    const row = this.db
      .prepare(
        `SELECT m.*, a.content_text AS artifact_thinking, a.artifact_version
         FROM messages m
         LEFT JOIN reasoning_artifacts a ON a.source_message_id = m.id
         WHERE m.job_id = ? AND m.role = 'assistant' AND m.turn_status = 'pending'
         ORDER BY m.seq DESC
         LIMIT 1`,
      )
      .get(jobId) as unknown as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  pendingAssistantsForJob(jobId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, a.content_text AS artifact_thinking, a.artifact_version
         FROM messages m
         LEFT JOIN reasoning_artifacts a ON a.source_message_id = m.id
         WHERE m.job_id = ? AND m.role = 'assistant' AND m.turn_status = 'pending'
         ORDER BY m.seq ASC`,
      )
      .all(jobId) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /**
   * Atomically commits the final projection and terminal outcome.
   *
   * The compare-and-set predicate is the bridge invariant: once a message is
   * failed or cancelled, a late success path cannot rewrite it to completed.
   */
  terminalizeMessage(id: string, update: TerminalMessageUpdate): TerminalMessageResult {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET content = ?,
             thinking = ?,
             tool_calls = ?,
             usage = ?,
             turn_status = ?,
             turn_error = ?,
             stop_reason = ?
         WHERE id = ?
           AND role = 'assistant'
           AND turn_status = 'pending'`,
      )
      .run(
        update.content,
        update.thinking,
        JSON.stringify(update.toolCalls),
        update.usage ? JSON.stringify(update.usage) : null,
        update.outcome,
        update.error ? JSON.stringify(update.error) : null,
        update.stopReason,
        id,
      )

    const message = this.getMessage(id)
    if (!message) throw new Error(`Assistant message ${id} was not found during terminalization`)
    return { applied: result.changes > 0, message }
  }

  private toContextCheckpoint(row: ContextCheckpointRow): ContextCheckpoint {
    const byteSize = Buffer.byteLength(row.summary_text, 'utf8')
    const sha256 = createHash('sha256')
      .update(Buffer.from(row.summary_text, 'utf8'))
      .digest('hex')
    const parsed = contextCheckpointSchema.safeParse({
      contextCheckpointVersion: row.checkpoint_version,
      id: row.id,
      threadId: row.thread_id,
      previousCheckpointId: row.previous_checkpoint_id,
      source: {
        state: row.source_state,
        upToSeq: row.up_to_seq,
        messageCount: row.source_message_count,
      },
      summary: {
        format: 'text_utf8_v1',
        content: row.summary_text,
        byteSize: row.summary_byte_size,
        sha256: row.summary_sha256,
      },
      createdAt: row.created_at,
    })
    if (
      !parsed.success ||
      byteSize !== row.summary_byte_size ||
      sha256 !== row.summary_sha256
    ) {
      throw new ContextCheckpointStoreError(
        'stored_data_invalid',
        `Context checkpoint ${row.id} failed integrity validation`,
      )
    }
    return parsed.data
  }

  private canonicalContextCheckpoints(threadId: string): ContextCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_checkpoints
         WHERE thread_id = ? ORDER BY up_to_seq, id`,
      )
      .all(threadId) as unknown as ContextCheckpointRow[]
    const checkpoints: ContextCheckpoint[] = []
    let expectedPreviousCheckpointId: string | null = null
    for (const row of rows) {
      const checkpoint = this.toContextCheckpoint(row)
      const source = this.db
        .prepare(
          `SELECT
             EXISTS (
               SELECT 1 FROM messages boundary
               WHERE boundary.thread_id = ? AND boundary.seq = ?
             ) AS boundary_exists,
             COUNT(*) AS message_count
           FROM messages source
           WHERE source.thread_id = ? AND source.seq <= ?`,
        )
        .get(threadId, checkpoint.source.upToSeq, threadId, checkpoint.source.upToSeq) as {
          boundary_exists: number
          message_count: number
        }
      if (
        checkpoint.threadId !== threadId ||
        checkpoint.previousCheckpointId !== expectedPreviousCheckpointId ||
        source.boundary_exists !== 1 ||
        source.message_count !== checkpoint.source.messageCount
      ) {
        throw new ContextCheckpointStoreError(
          'stored_data_invalid',
          `Context checkpoint ${checkpoint.id} failed source-chain validation`,
        )
      }
      checkpoints.push(checkpoint)
      expectedPreviousCheckpointId = checkpoint.id
    }
    return checkpoints
  }

  private checkpointMessage(checkpoint: ContextCheckpoint): Message {
    return {
      id: `context-checkpoint:${checkpoint.id}`,
      threadId: checkpoint.threadId,
      jobId: null,
      role: 'system',
      content: checkpoint.summary.content,
      thinking: null,
      toolCalls: [],
      usage: null,
      createdAt: checkpoint.createdAt,
      isCompaction: true,
      turnStatus: null,
      turnError: null,
      stopReason: null,
    }
  }

  /**
   * Пишет текущее состояние вызова инструмента в отдельный журнал.
   * Сообщение хранит финальные карточки для истории, а журнал позволяет
   * диагностировать pending/running-вызовы после обрыва процесса.
   */
  recordToolRun(threadId: string, messageId: string, call: ToolCall): void {
    this.db
      .prepare(
        `INSERT INTO tool_runs (
           id, thread_id, message_id, name, arguments, status, result, error,
           duration_ms, source, parsed_from, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status,
           result = excluded.result,
           error = excluded.error,
           duration_ms = excluded.duration_ms`,
      )
      .run(
        call.id,
        threadId,
        messageId,
        call.name,
        JSON.stringify(call.arguments),
        call.status,
        call.result,
        call.error,
        call.durationMs,
        call.source,
        call.parsedFrom,
        new Date().toISOString(),
      )
  }
}
