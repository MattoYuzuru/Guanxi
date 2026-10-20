/**
 * The session event log (K2, ADR-0023): one append-only log per session in the
 * node's SQLite database, written by exactly one writer (D-116).
 *
 * - **Single writer.** `open()` hands out one `SessionHandle` per session per
 *   process, and a durable writer row with an epoch fences every other writer:
 *   the database refuses an event whose epoch is not the session's current one.
 *   A writer changes only by a transaction: first grant, release, expiry, or a
 *   handover from a writer process that is gone (ADR-0018).
 * - **Crash-safe append.** One transaction advances the head, inserts the event
 *   and indexes it, so a crash at any point leaves the event fully present or
 *   fully absent. A retried append with the same idempotency key (or the same
 *   expected `seq`) returns the stored event instead of a duplicate.
 * - **Persisted before streamed.** Subscribers are woken only after commit and
 *   read the log from SQLite after their own cursor.
 * - **Scrubbed at write and at read.** Every payload passes the egress scrubber
 *   before it is stored and again on the way out (D-141).
 * - **Reasoning** is its own class with an expiry; agents on remote providers
 *   never receive it, and exports never contain it (D-113).
 */
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import {
  SESSION_EVENT_VERSION,
  SEARCH_MATCH_CLOSE,
  SEARCH_MATCH_OPEN,
  sessionEventClassOf,
  sessionEventDataSchemas,
  sessionEventSchema,
  type SessionAudience,
  type SessionEvent,
  type SessionEventData,
  type SessionEventType,
  type SessionKind,
  type SessionListItem,
  type SessionSearchHit,
  type SessionTokenMeter,
  type SessionWriterReason,
} from '@guanxi/contract'
import { REDACTION_MARKER_PREFIX, type EgressScrubber } from '../egress/types.ts'
import type { Db } from '../store/db.ts'

export const DEFAULT_WRITER_TTL_MS = 30_000
export const DEFAULT_REASONING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_PAGE = 1_000

/** The points of one append, in order. Fault injection can stop at each. */
export const SESSION_APPEND_POINTS = [
  'begin',
  'writer_checked',
  'head_advanced',
  'event_inserted',
  'before_commit',
  'committed',
] as const
export type SessionAppendPoint = (typeof SESSION_APPEND_POINTS)[number]

export type SessionLogErrorCode =
  | 'session_not_found'
  | 'writer_busy'
  | 'writer_fenced'
  | 'sequence_conflict'
  | 'idempotency_conflict'
  | 'invalid_event'
  | 'stored_data_invalid'
  | 'closed'

export class SessionLogError extends Error {
  readonly code: SessionLogErrorCode

  constructor(code: SessionLogErrorCode, message: string) {
    super(message)
    this.name = 'SessionLogError'
    this.code = code
  }
}

export interface SessionWriterIdentity {
  readonly id: string
  readonly pid: number | null
  readonly host: string | null
}

export interface SessionLogOptions {
  db: Db
  scrubber: EgressScrubber
  clock?: () => Date
  writer?: SessionWriterIdentity
  writerTtlMs?: number
  reasoningRetentionMs?: number
  /** Liveness of a writer process on this host; tests replace it. */
  isProcessAlive?: (pid: number) => boolean
  /** Fault injection for crash tests; it may throw or kill the process. */
  fault?: (point: SessionAppendPoint, detail: { sessionId: string; type: SessionEventType }) => void
}

export interface SessionEventInput<T extends SessionEventType = SessionEventType> {
  type: T
  data: SessionEventData<T>
  spanId?: string | null
  parentSpanId?: string | null
  jobId?: string | null
  jobSequence?: number | null
  /** Overrides the reasoning expiry (for example a shorter parent retention). */
  expiresAt?: string
}

export interface AppendOptions {
  /** Retrying an append with the same key returns the stored event. */
  idempotencyKey?: string
  /** The `seq` this event must get; a stored identical event at it is returned. */
  expectedSeq?: number
}

export interface AppendResult {
  event: SessionEvent
  /** True when the append matched an event that was already stored. */
  duplicate: boolean
}

export interface OpenSessionInput {
  kind: SessionKind
  threadId?: string | null
}

/** The only way to append to a session. One open handle per session per process. */
export interface SessionHandle {
  readonly sessionId: string
  readonly epoch: number
  readonly closed: boolean
  append<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): AppendResult
  /** Releases the writer row so another writer may take over at once. */
  close(): void
}

interface EventRow {
  row_id: number
  session_id: string
  seq: number
  id: string
  event_version: number
  type: string
  class: string
  span_id: string | null
  parent_span_id: string | null
  job_id: string | null
  job_sequence: number | null
  writer_epoch: number
  idempotency_key: string | null
  payload: string | null
  payload_sha256: string
  search_text: string | null
  redactions: number
  created_at: string
  expires_at: string | null
  purged_at: string | null
}

interface WriterRow {
  session_id: string
  writer_id: string
  epoch: number
  pid: number | null
  host: string | null
  acquired_at: string
  renewed_at: string
  expires_at: string
  released_at: string | null
}

interface SessionRow {
  id: string
  kind: string
  thread_id: string | null
  created_at: string
  last_seq: number
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

function countMarkers(text: string): number {
  let count = 0
  for (let index = text.indexOf(REDACTION_MARKER_PREFIX); index >= 0; index = text.indexOf(REDACTION_MARKER_PREFIX, index + 1)) {
    count++
  }
  return count
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** unicode61 folds Latin diacritics only; fold the Russian ё as well, at index and query time. */
function foldForSearch(text: string): string {
  return text.replaceAll('ё', 'е').replaceAll('Ё', 'Е')
}

/** Text the FTS5 index holds for an event; content-free events have none. */
export function searchTextOf(type: SessionEventType, data: unknown): string | null {
  const text = rawSearchTextOf(type, data)
  return text === null ? null : foldForSearch(text)
}

function rawSearchTextOf(type: SessionEventType, data: unknown): string | null {
  const value = data as Record<string, unknown>
  switch (type) {
    case 'prompt':
    case 'assistant.message':
    case 'reasoning':
      return typeof value['text'] === 'string' && value['text'].length > 0 ? value['text'] : null
    case 'tool.call':
      return `${String(value['name'])} ${JSON.stringify(value['arguments'])}`
    case 'tool.result':
      return [value['result'], value['error']].filter((part) => typeof part === 'string').join('\n') || null
    case 'error':
      return `${String(value['code'])} ${String(value['message'])}`
    default:
      return null
  }
}

/** An FTS5 query that matches every whitespace-separated term literally. */
export function literalFtsQuery(text: string): string | null {
  const terms = foldForSearch(text).split(/\s+/u).filter((term) => term.length > 0).slice(0, 16)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ')
}

class SubscriptionWake {
  version = 0
  private resolveWait: (() => void) | null = null

  notify(): void {
    this.version += 1
    this.resolveWait?.()
  }

  waitForChange(observedVersion: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.version !== observedVersion) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        if (this.resolveWait === finish) this.resolveWait = null
        resolve()
      }
      this.resolveWait = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted || this.version !== observedVersion) finish()
    })
  }
}

export class SessionLog {
  readonly writer: SessionWriterIdentity
  private readonly db: Db
  private readonly scrubber: EgressScrubber
  private readonly clock: () => Date
  private readonly writerTtlMs: number
  private readonly reasoningRetentionMs: number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly fault: SessionLogOptions['fault']
  /** Sessions this process writes: an open handle, or the system writer's epoch. */
  private readonly writers = new Map<string, { epoch: number; handle: Handle | null }>()
  private readonly subscribers = new Map<string, Set<SubscriptionWake>>()
  private closing = false

  constructor(options: SessionLogOptions) {
    this.db = options.db
    this.scrubber = options.scrubber
    this.clock = options.clock ?? (() => new Date())
    this.writer = options.writer ?? { id: randomUUID(), pid: process.pid, host: hostname() }
    this.writerTtlMs = options.writerTtlMs ?? DEFAULT_WRITER_TTL_MS
    this.reasoningRetentionMs = options.reasoningRetentionMs ?? DEFAULT_REASONING_RETENTION_MS
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    this.fault = options.fault
  }

  /* ───────────────────────────── writing ───────────────────────────── */

  /**
   * Opens the single writer for a session, creating the session if needed.
   * Fails with `writer_busy` while another handle or another live writer holds it.
   */
  open(sessionId: string, input: OpenSessionInput): SessionHandle {
    this.assertOpen()
    if (this.writers.has(sessionId)) {
      throw new SessionLogError('writer_busy', `Session ${sessionId} already has a writer in this process`)
    }
    const epoch = this.transaction(() => this.acquireWithin(sessionId, input), sessionId, 'session.created')
    const handle = new Handle(this, sessionId, epoch)
    this.writers.set(sessionId, { epoch, handle })
    this.notify([sessionId])
    return handle
  }

  /**
   * The system writer used by the legacy job store mirror: it appends inside a
   * transaction the caller owns, acquiring or renewing the writer row as needed.
   * The caller must call `notify` after its commit.
   */
  appendAsSystemWithin<T extends SessionEventType>(
    sessionId: string,
    session: OpenSessionInput,
    input: SessionEventInput<T>,
    options: AppendOptions = {},
  ): AppendResult {
    this.assertOpen()
    const held = this.writers.get(sessionId)
    if (held?.handle) {
      throw new SessionLogError('writer_busy', `Session ${sessionId} has an open handle`)
    }
    const epoch = this.acquireWithin(sessionId, session)
    this.writers.set(sessionId, { epoch, handle: null })
    return this.appendWithin(sessionId, epoch, input, options)
  }

  /** @internal Handle append: its own transaction, no re-acquisition. */
  appendForHandle<T extends SessionEventType>(
    sessionId: string,
    epoch: number,
    input: SessionEventInput<T>,
    options: AppendOptions,
  ): AppendResult {
    this.assertOpen()
    const result = this.transaction(() => this.appendWithin(sessionId, epoch, input, options), sessionId, input.type)
    this.notify([sessionId])
    return result
  }

  /** @internal */
  releaseHandle(handle: Handle): void {
    const held = this.writers.get(handle.sessionId)
    if (held?.handle !== handle) return
    this.writers.delete(handle.sessionId)
    if (this.closing && !this.dbOpen()) return
    this.db
      .prepare(
        `UPDATE session_writers SET released_at = ?
         WHERE session_id = ? AND writer_id = ? AND epoch = ? AND released_at IS NULL`,
      )
      .run(this.clock().toISOString(), handle.sessionId, this.writer.id, handle.epoch)
  }

  /** Wakes subscribers of sessions whose appends have committed. */
  notify(sessionIds: Iterable<string>): void {
    for (const sessionId of new Set(sessionIds)) {
      for (const subscriber of this.subscribers.get(sessionId) ?? []) subscriber.notify()
    }
  }

  /** Purges expired reasoning content in one bounded batch; the events stay. */
  purgeExpiredReasoning(limit = 200): { purged: number; sessionIds: string[] } {
    this.assertOpen()
    const now = this.clock().toISOString()
    const rows = this.db
      .prepare(
        `SELECT row_id, session_id FROM session_events
         WHERE class = 'reasoning' AND purged_at IS NULL AND expires_at <= ?
         ORDER BY expires_at, row_id LIMIT ?`,
      )
      .all(now, Math.min(Math.max(1, limit), MAX_PAGE)) as unknown as { row_id: number; session_id: string }[]
    if (rows.length === 0) return { purged: 0, sessionIds: [] }
    this.transaction(() => {
      const purge = this.db.prepare(
        `UPDATE session_events SET payload = NULL, search_text = NULL, purged_at = ?
         WHERE row_id = ? AND purged_at IS NULL`,
      )
      for (const row of rows) purge.run(now, row.row_id)
    }, rows[0]!.session_id, 'reasoning')
    const sessionIds = [...new Set(rows.map((row) => row.session_id))]
    this.notify(sessionIds)
    return { purged: rows.length, sessionIds }
  }

  /** Releases every writer row this process holds and ends every subscription. */
  close(): void {
    if (this.closing) return
    this.closing = true
    for (const [sessionId, held] of [...this.writers]) {
      if (held.handle) held.handle.close()
      else this.releaseSystemWriter(sessionId, held.epoch)
    }
    this.writers.clear()
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) subscriber.notify()
    }
  }

  get isClosed(): boolean {
    return this.closing
  }

  /* ───────────────────────────── reading ───────────────────────────── */

  /** Scrubs a value that leaves the log by another path (for example an echoed query). */
  redact<T>(value: T): T {
    return this.scrubber.scrub(value)
  }

  session(sessionId: string): SessionListItem | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.kind, s.thread_id, s.created_at, s.last_seq, t.title,
                (SELECT MAX(created_at) FROM session_events e WHERE e.session_id = s.id) AS last_event_at
         FROM sessions s LEFT JOIN threads t ON t.id = s.thread_id
         WHERE s.id = ?`,
      )
      .get(sessionId) as unknown as (SessionRow & { title: string | null; last_event_at: string | null }) | undefined
    return row ? this.toListItem(row) : null
  }

  list(limit = 50): SessionListItem[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.kind, s.thread_id, s.created_at, s.last_seq, t.title,
                (SELECT MAX(created_at) FROM session_events e WHERE e.session_id = s.id) AS last_event_at
         FROM sessions s LEFT JOIN threads t ON t.id = s.thread_id
         ORDER BY COALESCE(last_event_at, s.created_at) DESC, s.id
         LIMIT ?`,
      )
      .all(Math.min(Math.max(1, limit), 200)) as unknown as (SessionRow & {
      title: string | null
      last_event_at: string | null
    })[]
    return rows.map((row) => this.toListItem(row))
  }

  /** Thread titles are derived from the first prompt, so they are scrubbed too. */
  private toListItem(row: SessionRow & { title: string | null; last_event_at: string | null }): SessionListItem {
    return {
      sessionId: row.id,
      kind: row.kind as SessionKind,
      threadId: row.thread_id,
      title: row.title === null ? null : this.scrubber.scrub(row.title),
      createdAt: row.created_at,
      lastSeq: row.last_seq,
      lastEventAt: row.last_event_at,
    }
  }

  /** A page after `afterSeq`, filtered for the audience and scrubbed again. */
  read(
    sessionId: string,
    options: { afterSeq?: number; limit?: number; audience: SessionAudience },
  ): { events: SessionEvent[]; lastSeq: number; hasMore: boolean } {
    const head = this.requireSession(sessionId)
    const afterSeq = options.afterSeq ?? 0
    const limit = Math.min(Math.max(1, options.limit ?? 200), MAX_PAGE)
    const rows = this.db
      .prepare(
        `SELECT * FROM session_events
         WHERE session_id = ? AND seq > ? ${options.audience === 'remote_agent' ? "AND class = 'standard'" : ''}
         ORDER BY seq LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit + 1) as unknown as EventRow[]
    const page = rows.slice(0, limit)
    return {
      events: page.map((row) => this.toEvent(row)),
      lastSeq: head.last_seq,
      hasMore: rows.length > limit,
    }
  }

  /** Every event of a session in order (bounded pages internally). */
  readAll(sessionId: string, audience: SessionAudience): SessionEvent[] {
    const events: SessionEvent[] = []
    let after = 0
    while (true) {
      const page = this.read(sessionId, { afterSeq: after, limit: MAX_PAGE, audience })
      events.push(...page.events)
      if (!page.hasMore || page.events.length === 0) return events
      after = page.events.at(-1)!.seq
    }
  }

  search(
    text: string,
    options: { sessionId?: string; audience: SessionAudience; limit?: number },
  ): SessionSearchHit[] {
    const query = literalFtsQuery(text)
    if (!query) return []
    const limit = Math.min(Math.max(1, options.limit ?? 25), 100)
    const rows = this.db
      .prepare(
        `SELECT e.session_id, e.seq, e.type, e.class, e.created_at,
                snippet(session_events_fts, 0, ?, ?, '…', 16) AS snippet
         FROM session_events_fts
         JOIN session_events e ON e.row_id = session_events_fts.rowid
         WHERE session_events_fts MATCH ?
           ${options.sessionId ? 'AND e.session_id = ?' : ''}
           ${options.audience === 'remote_agent' ? "AND e.class = 'standard'" : ''}
         ORDER BY rank, e.session_id, e.seq
         LIMIT ?`,
      )
      .all(
        ...[SEARCH_MATCH_OPEN, SEARCH_MATCH_CLOSE, query],
        ...(options.sessionId ? [options.sessionId] : []),
        limit,
      ) as unknown as {
      session_id: string
      seq: number
      type: SessionEventType
      class: 'standard' | 'reasoning'
      created_at: string
      snippet: string
    }[]
    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      class: row.class,
      snippet: this.scrubber.scrub(row.snippet),
      createdAt: row.created_at,
    }))
  }

  /** Per-type counts over every event (people see all of them). */
  counts(sessionId: string): { counts: Partial<Record<SessionEventType, number>>; purged: number; redactions: number } {
    this.requireSession(sessionId)
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS count, SUM(purged_at IS NOT NULL) AS purged, SUM(redactions) AS redactions
         FROM session_events WHERE session_id = ? GROUP BY type`,
      )
      .all(sessionId) as unknown as { type: SessionEventType; count: number; purged: number; redactions: number }[]
    const counts: Partial<Record<SessionEventType, number>> = {}
    let purged = 0
    let redactions = 0
    for (const row of rows) {
      counts[row.type] = row.count
      purged += row.purged
      redactions += row.redactions
    }
    return { counts, purged, redactions }
  }

  /** Totals of every usage event and the latest context state. */
  tokenMeter(sessionId: string): SessionTokenMeter {
    this.requireSession(sessionId)
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(json_extract(payload, '$.promptTokens')), 0) AS prompt,
                COALESCE(SUM(json_extract(payload, '$.evalTokens')), 0) AS completion,
                COALESCE(SUM(json_extract(payload, '$.cachedTokens')), 0) AS cached,
                COUNT(*) AS samples
         FROM session_events WHERE session_id = ? AND type = 'usage'`,
      )
      .get(sessionId) as unknown as { prompt: number; completion: number; cached: number; samples: number }
    const context = this.db
      .prepare(
        `SELECT * FROM session_events WHERE session_id = ? AND type = 'context'
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as unknown as EventRow | undefined
    const contextEvent = context ? this.toEvent(context) : null
    return {
      promptTokens: totals.prompt,
      completionTokens: totals.completion,
      cachedTokens: totals.cached,
      samples: totals.samples,
      context: contextEvent?.type === 'context' ? contextEvent.data : null,
    }
  }

  async *subscribe(
    sessionId: string,
    afterSeq: number,
    audience: SessionAudience,
    signal: AbortSignal,
  ): AsyncGenerator<SessionEvent> {
    this.requireSession(sessionId)
    const wake = new SubscriptionWake()
    const set = this.subscribers.get(sessionId) ?? new Set<SubscriptionWake>()
    set.add(wake)
    this.subscribers.set(sessionId, set)
    let cursor = afterSeq
    try {
      while (!signal.aborted && !this.closing) {
        const observed = wake.version
        const page = this.read(sessionId, { afterSeq: cursor, limit: 200, audience })
        if (page.events.length === 0) {
          await wake.waitForChange(observed, signal)
          continue
        }
        for (const event of page.events) {
          if (signal.aborted) return
          cursor = event.seq
          yield event
        }
      }
    } finally {
      set.delete(wake)
      if (set.size === 0) this.subscribers.delete(sessionId)
    }
  }

  subscriberCount(sessionId?: string): number {
    if (sessionId !== undefined) return this.subscribers.get(sessionId)?.size ?? 0
    let count = 0
    for (const set of this.subscribers.values()) count += set.size
    return count
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  private assertOpen(): void {
    if (this.closing) throw new SessionLogError('closed', 'The session log is closed')
  }

  private dbOpen(): boolean {
    return (this.db as unknown as { isOpen?: boolean }).isOpen !== false
  }

  private releaseSystemWriter(sessionId: string, epoch: number): void {
    if (!this.dbOpen()) return
    try {
      this.db
        .prepare(
          `UPDATE session_writers SET released_at = ?
           WHERE session_id = ? AND writer_id = ? AND epoch = ? AND released_at IS NULL`,
        )
        .run(this.clock().toISOString(), sessionId, this.writer.id, epoch)
    } catch {
      // Closing must not throw; the row then expires like a crashed writer's.
    }
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as unknown as
      | SessionRow
      | undefined
    if (!row) throw new SessionLogError('session_not_found', `Session ${sessionId} was not found`)
    return row
  }

  /** Inside a transaction: create the session if needed and make this process its writer. */
  private acquireWithin(sessionId: string, input: OpenSessionInput): number {
    const now = this.clock()
    const nowText = now.toISOString()
    const expires = new Date(now.getTime() + this.writerTtlMs).toISOString()
    const created = this.db
      .prepare(
        `INSERT INTO sessions (id, kind, thread_id, created_at, last_seq)
         VALUES (?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING`,
      )
      .run(sessionId, input.kind, input.threadId ?? null, nowText).changes === 1

    const row = this.db.prepare('SELECT * FROM session_writers WHERE session_id = ?').get(sessionId) as unknown as
      | WriterRow
      | undefined
    let reason: SessionWriterReason | null = null
    let epoch: number
    let previousEpoch: number | null = null
    if (!row) {
      reason = 'initial'
      epoch = 1
      this.db
        .prepare(
          `INSERT INTO session_writers (session_id, writer_id, epoch, pid, host, acquired_at, renewed_at, expires_at, released_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(sessionId, this.writer.id, this.writer.pid, this.writer.host, nowText, nowText, expires)
    } else if (row.writer_id === this.writer.id && row.released_at === null) {
      epoch = row.epoch
      if (Date.parse(row.expires_at) - now.getTime() < this.writerTtlMs / 2) {
        this.db
          .prepare(
            `UPDATE session_writers SET renewed_at = ?, expires_at = ?
             WHERE session_id = ? AND writer_id = ? AND epoch = ?`,
          )
          .run(nowText, expires, sessionId, this.writer.id, row.epoch)
      }
    } else {
      reason = row.released_at !== null
        ? 'released'
        : Date.parse(row.expires_at) <= now.getTime()
          ? 'expired'
          : this.writerProcessGone(row)
            ? 'writer_process_gone'
            : null
      if (!reason) {
        throw new SessionLogError('writer_busy', `Session ${sessionId} is held by another live writer`)
      }
      previousEpoch = row.epoch
      epoch = row.epoch + 1
      this.db
        .prepare(
          `UPDATE session_writers
           SET writer_id = ?, epoch = ?, pid = ?, host = ?, acquired_at = ?, renewed_at = ?, expires_at = ?, released_at = NULL
           WHERE session_id = ? AND epoch = ?`,
        )
        .run(this.writer.id, epoch, this.writer.pid, this.writer.host, nowText, nowText, expires, sessionId, row.epoch)
    }

    if (created) {
      this.appendWithin(sessionId, epoch, {
        type: 'session.created',
        data: { kind: input.kind, threadId: input.threadId ?? null },
      }, {})
    }
    if (reason) {
      this.appendWithin(sessionId, epoch, {
        type: 'writer.acquired',
        data: { epoch, previousEpoch, reason },
      }, {})
    }
    return epoch
  }

  private writerProcessGone(row: WriterRow): boolean {
    return (
      row.host !== null &&
      row.host === this.writer.host &&
      row.pid !== null &&
      row.pid !== this.writer.pid &&
      !this.isProcessAlive(row.pid)
    )
  }

  /** Inside a transaction: the append itself. */
  private appendWithin<T extends SessionEventType>(
    sessionId: string,
    epoch: number,
    input: SessionEventInput<T>,
    options: AppendOptions,
  ): AppendResult {
    const schema = sessionEventDataSchemas[input.type]
    if (!schema) throw new SessionLogError('invalid_event', `Unknown session event type ${String(input.type)}`)
    const parsed = schema.safeParse(input.data)
    if (!parsed.success) throw new SessionLogError('invalid_event', `Invalid ${input.type} event data`)

    const data = this.scrubber.scrub(parsed.data) as SessionEventData<T>
    const payload = JSON.stringify(data)
    const payloadSha256 = sha256(payload)
    const redactions = Math.max(0, countMarkers(payload) - countMarkers(JSON.stringify(parsed.data)))

    const writer = this.db
      .prepare('SELECT writer_id, epoch, released_at FROM session_writers WHERE session_id = ?')
      .get(sessionId) as unknown as Pick<WriterRow, 'writer_id' | 'epoch' | 'released_at'> | undefined
    if (!writer || writer.writer_id !== this.writer.id || writer.epoch !== epoch || writer.released_at !== null) {
      throw new SessionLogError('writer_fenced', `Writer epoch ${epoch} no longer owns session ${sessionId}`)
    }
    this.fault?.('writer_checked', { sessionId, type: input.type })

    if (options.idempotencyKey !== undefined) {
      const existing = this.db
        .prepare('SELECT * FROM session_events WHERE session_id = ? AND idempotency_key = ?')
        .get(sessionId, options.idempotencyKey) as unknown as EventRow | undefined
      if (existing) {
        if (existing.type !== input.type || existing.payload_sha256 !== payloadSha256) {
          throw new SessionLogError('idempotency_conflict', 'The idempotency key is bound to a different event')
        }
        return { event: this.toEvent(existing), duplicate: true }
      }
    }

    const head = this.requireSession(sessionId).last_seq
    if (options.expectedSeq !== undefined) {
      if (options.expectedSeq <= head) {
        const existing = this.db
          .prepare('SELECT * FROM session_events WHERE session_id = ? AND seq = ?')
          .get(sessionId, options.expectedSeq) as unknown as EventRow | undefined
        if (existing && existing.type === input.type && existing.payload_sha256 === payloadSha256 &&
          existing.idempotency_key === (options.idempotencyKey ?? null)) {
          return { event: this.toEvent(existing), duplicate: true }
        }
        throw new SessionLogError('sequence_conflict', `Session ${sessionId} already has seq ${options.expectedSeq}`)
      }
      if (options.expectedSeq !== head + 1) {
        throw new SessionLogError('sequence_conflict', `Session ${sessionId} expects seq ${head + 1}`)
      }
    }

    const advanced = this.db
      .prepare('UPDATE sessions SET last_seq = last_seq + 1 WHERE id = ? AND last_seq = ? RETURNING last_seq')
      .get(sessionId, head) as unknown as { last_seq: number } | undefined
    if (!advanced) throw new SessionLogError('sequence_conflict', `Session ${sessionId} head moved`)
    this.fault?.('head_advanced', { sessionId, type: input.type })

    const createdAt = this.clock().toISOString()
    const eventClass = sessionEventClassOf(input.type)
    const expiresAt = eventClass === 'reasoning'
      ? input.expiresAt ?? new Date(Date.parse(createdAt) + this.reasoningRetentionMs).toISOString()
      : null
    const row: EventRow = {
      row_id: 0,
      session_id: sessionId,
      seq: advanced.last_seq,
      id: randomUUID(),
      event_version: SESSION_EVENT_VERSION,
      type: input.type,
      class: eventClass,
      span_id: input.spanId ?? null,
      parent_span_id: input.parentSpanId ?? null,
      job_id: input.jobId ?? null,
      job_sequence: input.jobSequence ?? null,
      writer_epoch: epoch,
      idempotency_key: options.idempotencyKey ?? null,
      payload,
      payload_sha256: payloadSha256,
      search_text: searchTextOf(input.type, data),
      redactions,
      created_at: createdAt,
      expires_at: expiresAt,
      purged_at: null,
    }
    const event = this.toEvent(row, { rescrub: false })
    this.db
      .prepare(
        `INSERT INTO session_events (
           session_id, seq, id, event_version, type, class, span_id, parent_span_id,
           job_id, job_sequence, writer_epoch, idempotency_key, payload, payload_sha256,
           search_text, redactions, created_at, expires_at, purged_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        row.session_id, row.seq, row.id, row.event_version, row.type, row.class, row.span_id,
        row.parent_span_id, row.job_id, row.job_sequence, row.writer_epoch, row.idempotency_key,
        row.payload, row.payload_sha256, row.search_text, row.redactions, row.created_at, row.expires_at,
      )
    this.fault?.('event_inserted', { sessionId, type: input.type })
    return { event, duplicate: false }
  }

  private toEvent(row: EventRow, options: { rescrub?: boolean } = {}): SessionEvent {
    let data: unknown = null
    if (row.payload !== null) {
      if (sha256(row.payload) !== row.payload_sha256) {
        throw new SessionLogError('stored_data_invalid', `Session event ${row.id} failed its checksum`)
      }
      try {
        data = JSON.parse(row.payload) as unknown
      } catch {
        throw new SessionLogError('stored_data_invalid', `Session event ${row.id} is not valid JSON`)
      }
      if (options.rescrub !== false) data = this.scrubber.scrub(data)
    }
    const candidate: Record<string, unknown> = {
      sessionId: row.session_id,
      seq: row.seq,
      id: row.id,
      version: row.event_version,
      type: row.type,
      class: row.class,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      jobId: row.job_id,
      writerEpoch: row.writer_epoch,
      redactions: row.redactions,
      createdAt: row.created_at,
      data,
    }
    if (row.class === 'reasoning') {
      candidate['expiresAt'] = row.expires_at
      candidate['purgedAt'] = row.purged_at
    }
    const parsed = sessionEventSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new SessionLogError('stored_data_invalid', `Session event ${row.id} contains invalid stored data`)
    }
    return parsed.data
  }

  private transaction<T>(operation: () => T, sessionId: string, type: SessionEventType): T {
    this.fault?.('begin', { sessionId, type })
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = operation()
      this.fault?.('before_commit', { sessionId, type })
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // SQLite may already have ended the transaction.
      }
      throw error
    }
    this.fault?.('committed', { sessionId, type })
    return result
  }
}

class Handle implements SessionHandle {
  readonly sessionId: string
  readonly epoch: number
  private readonly log: SessionLog
  private isClosed = false

  constructor(log: SessionLog, sessionId: string, epoch: number) {
    this.log = log
    this.sessionId = sessionId
    this.epoch = epoch
  }

  get closed(): boolean {
    return this.isClosed
  }

  append<T extends SessionEventType>(input: SessionEventInput<T>, options: AppendOptions = {}): AppendResult {
    if (this.isClosed) throw new SessionLogError('writer_fenced', 'The session handle is closed')
    return this.log.appendForHandle(this.sessionId, this.epoch, input, options)
  }

  close(): void {
    if (this.isClosed) return
    this.isClosed = true
    this.log.releaseHandle(this)
  }
}
