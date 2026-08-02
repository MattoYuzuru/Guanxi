/**
 * Треды и сообщения.
 *
 * Сообщения нумеруются полем `seq` внутри треда, а не сортируются по времени:
 * при стриминге несколько сообщений могут получить одинаковую метку времени.
 */
import { randomUUID } from 'node:crypto'
import {
  turnErrorSchema,
  type Message,
  type Thread,
  type ThreadMode,
  type ThreadOptions,
  type ToolCall,
  type TurnError,
  type TurnStatus,
  type TurnStopReason,
  type TurnTerminalOutcome,
  type Usage,
} from '@alamo/contract'
import type { Db } from './db.ts'

interface ThreadRow {
  id: string
  title: string
  mode: string
  model: string
  workspace_id: string | null
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
  seq: number
  role: string
  content: string
  thinking: string | null
  tool_calls: string
  usage: string | null
  is_compaction: number
  created_at: string
  turn_status: string | null
  turn_error: string | null
  stop_reason: string | null
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

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as Message['role'],
    content: row.content,
    thinking: row.thinking,
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
         ORDER BY t.updated_at DESC`,
      )
      .all() as unknown as ThreadRow[]
    return rows.map(toThread)
  }

  get(id: string): Thread | null {
    const row = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
         FROM threads t WHERE t.id = ?`,
      )
      .get(id) as unknown as ThreadRow | undefined
    return row ? toThread(row) : null
  }

  create(input: {
    title: string
    mode: ThreadMode
    model: string
    workspaceId: string | null
    options: ThreadOptions
  }): Thread {
    const now = new Date().toISOString()
    const id = randomUUID()

    this.db
      .prepare(
        `INSERT INTO threads (id, title, mode, model, workspace_id, num_ctx, temperature, think, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.mode,
        input.model,
        input.workspaceId,
        input.options.numCtx,
        input.options.temperature,
        input.options.think,
        now,
        now,
      )

    return this.get(id)!
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
    const result = this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
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
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq')
      .all(threadId) as unknown as MessageRow[]
    return rows.map(toMessage)
  }

  /**
   * Selects the prefix for compaction and preserves its real persisted boundary.
   *
   * Array indexes stop matching `seq` after the first summary replaces a
   * prefix, so callers must never derive the delete boundary from length.
   */
  compactionCandidates(threadId: string, keepTail: number): CompactionCandidates | null {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq')
      .all(threadId) as unknown as MessageRow[]

    if (rows.length <= keepTail + 1) return null
    const candidates = rows.slice(0, rows.length - keepTail)
    const boundary = candidates.at(-1)
    if (!boundary) return null

    return {
      messages: candidates.map(toMessage),
      upToSeq: boundary.seq,
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
           is_compaction, created_at, turn_status, turn_error, stop_reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )

    this.touch(input.threadId)

    return {
      id,
      threadId: input.threadId,
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
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
      | MessageRow
      | undefined
    return row ? toMessage(row) : null
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

  /**
   * Сворачивает начало треда в одно резюме: удаляет сообщения до `upToSeq`
   * включительно и ставит на освободившуюся позицию резюмирующее сообщение.
   *
   * Позицию задаём явно: если бы резюме получило следующий свободный `seq`,
   * оно оказалось бы в конце треда, после сообщений, которые оно должно предварять.
   */
  replaceWithSummary(threadId: string, upToSeq: number, summary: string, usage: Usage | null): Message {
    this.db.exec('BEGIN')
    try {
      this.db
        .prepare('DELETE FROM messages WHERE thread_id = ? AND seq <= ?')
        .run(threadId, upToSeq)
      const message = this.addMessage({
        threadId,
        role: 'system',
        content: summary,
        usage,
        isCompaction: true,
        seq: upToSeq,
      })
      this.db.exec('COMMIT')
      return message
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
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
