import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Alert, QuotaWindowKind, WindowState } from './types.ts'

/** Durable notification states from ADR-0033 decision 3. */
export const NOTIFICATION_STATES = ['unread', 'read', 'acted', 'snoozed', 'expired'] as const
export type NotificationState = (typeof NOTIFICATION_STATES)[number]

/** Every typed action from ADR-0033 decision 4; quota alerts offer a subset. */
export const NOTIFICATION_ACTIONS = [
  'open',
  'add_prompt',
  'accept_recommendation',
  'choose_action',
  'wake_leads',
  'switch_connection',
  'pause_runs',
  'resume_runs',
  'snooze',
  'raise_budget',
] as const
export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number]

/** Quota alerts expose only the actions that make sense for a connection subject. */
export const QUOTA_ALERT_ACTIONS: Record<Alert['kind'], readonly NotificationAction[]> = {
  threshold: ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation'],
  forecast: ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation'],
  exhausted: ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation', 'resume_runs'],
}

export interface NotificationSubject {
  type: string
  id: string
}

/** The alert provenance plus the window fields the payload and recommendations need. */
export interface NotificationFacts {
  window: QuotaWindowKind
  threshold: number | null
  instanceKey: string
  remainingPercent: number | null
  resetsAt: string | null
  source: string
  observedAt: string
  confidence: 'observed' | 'estimated'
  forecast?: {
    exhaustsAt: string
    before: 'reset' | 'dependent_run_eta'
    runId?: string
  }
}

export interface StoredNotification {
  id: string
  accountId: string
  kind: Alert['kind']
  severity: Alert['severity']
  subject: NotificationSubject
  idempotencyKey: string
  facts: NotificationFacts
  actions: NotificationAction[]
  state: NotificationState
  snoozedUntil: number | null
  createdAt: number
  updatedAt: number
}

export type ActionStatus = 'started' | 'done' | 'failed'

export interface StoredNotificationAction {
  notificationId: string
  action: NotificationAction
  idempotencyKey: string
  status: ActionStatus
  result: unknown
  createdAt: number
  updatedAt: number
}

export type NotificationStoreErrorCode =
  | 'invalid_input'
  | 'invalid_action'
  | 'notification_not_found'
  | 'account_mismatch'
  | 'action_not_offered'
  | 'action_not_found'
  | 'action_in_progress'
  | 'notification_acted'
  | 'state_conflict'
  | 'idempotency_conflict'
  | 'stored_data_invalid'

export class NotificationStoreError extends Error {
  readonly code: NotificationStoreErrorCode
  constructor(code: NotificationStoreErrorCode, message: string) {
    super(message)
    this.name = 'NotificationStoreError'
    this.code = code
  }
}

interface NotificationRow {
  id: string
  account_id: string
  kind: string
  severity: string
  subject_type: string
  subject_id: string
  idempotency_key: string
  facts: string
  actions: string
  state: string
  snoozed_until: number | null
  created_at: number
  updated_at: number
}

interface ActionRow {
  notification_id: string
  action: string
  idempotency_key: string
  status: string
  result: string | null
  created_at: number
  updated_at: number
  account_id?: string
}

export interface NotificationCursor {
  createdAt: number
  id: string
}

export interface RecordEvaluationOptions {
  /**
   * Optimistic concurrency check: the previous state's `lastObservedAt` (or null when there was
   * no row). A mismatch means another writer won; the caller should re-read and re-evaluate.
   */
  expectedObservedAt?: string | null
}

export interface FinishActionOptions {
  /** Set by the typed `snooze` action so completion enters `snoozed` instead of `acted`. */
  snoozedUntil?: number
}

export interface ListNotificationsOptions {
  states?: readonly NotificationState[]
  limit?: number
  /**
   * Strictly older than a timestamp, a notification id, or a full `(createdAt, id)` cursor.
   * The id/cursor form is stable when several notifications share one millisecond.
   */
  before?: number | string | NotificationCursor
}

/** Stable id: a duplicate idempotency key maps to the same notification row. */
export function notificationIdFor(accountId: string, idempotencyKey: string): string {
  return `ntf_${createHash('sha256').update(`${accountId}\0${idempotencyKey}`).digest('hex').slice(0, 40)}`
}

function isState(value: string): value is NotificationState {
  return (NOTIFICATION_STATES as readonly string[]).includes(value)
}

function isAction(value: string): value is NotificationAction {
  return (NOTIFICATION_ACTIONS as readonly string[]).includes(value)
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new NotificationStoreError('invalid_input', `${field} must be a non-empty string`)
  }
  return value
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NotificationStoreError('invalid_input', `${field} must be a finite millisecond timestamp`)
  }
  return value
}

function parseJson<T>(text: string, field: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new NotificationStoreError('stored_data_invalid', `${field} is not valid JSON`)
  }
}

function actionResult(result: string | null): unknown {
  return result === null ? null : parseJson<unknown>(result, 'notification action result')
}

function notificationFacts(alert: Alert): NotificationFacts {
  return {
    window: alert.window,
    threshold: alert.threshold,
    instanceKey: alert.instanceKey,
    remainingPercent: alert.facts.remainingPercent,
    resetsAt: alert.facts.resetsAt,
    source: alert.facts.source,
    observedAt: alert.facts.observedAt,
    confidence: alert.facts.confidence,
    ...(alert.forecast === undefined ? {} : { forecast: alert.forecast }),
  }
}

function rowToNotification(row: NotificationRow): StoredNotification {
  if (!isState(row.state)) {
    throw new NotificationStoreError('stored_data_invalid', `unknown notification state ${row.state}`)
  }
  const actions = parseJson<unknown>(row.actions, 'notification actions')
  if (!Array.isArray(actions) || actions.some(action => typeof action !== 'string' || !isAction(action))) {
    throw new NotificationStoreError('stored_data_invalid', 'notification actions are invalid')
  }
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    kind: String(row.kind) as Alert['kind'],
    severity: String(row.severity) as Alert['severity'],
    subject: { type: String(row.subject_type), id: String(row.subject_id) },
    idempotencyKey: String(row.idempotency_key),
    facts: parseJson<NotificationFacts>(row.facts, 'notification facts'),
    actions,
    state: row.state,
    snoozedUntil: row.snoozed_until === null ? null : Number(row.snoozed_until),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function rowToAction(row: ActionRow): StoredNotificationAction {
  if (row.status !== 'started' && row.status !== 'done' && row.status !== 'failed') {
    throw new NotificationStoreError('stored_data_invalid', `unknown action status ${row.status}`)
  }
  const action = String(row.action)
  if (!isAction(action)) {
    throw new NotificationStoreError('stored_data_invalid', `unknown action ${row.action}`)
  }
  return {
    notificationId: String(row.notification_id),
    action,
    idempotencyKey: String(row.idempotency_key),
    status: row.status,
    result: actionResult(row.result),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** v1 is append-only: later slices add v2+ and never rewrite these statements. */
const MIGRATION_V1 = `
  CREATE TABLE quota_window_state(
    connection_id TEXT NOT NULL,
    window TEXT NOT NULL,
    account_id TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY(connection_id, window)
  );
  CREATE TABLE notifications(
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    facts TEXT NOT NULL,
    actions TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('unread','read','acted','snoozed','expired')),
    snoozed_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_account_state_created
    ON notifications(account_id, state, created_at);
  CREATE TABLE notification_actions(
    notification_id TEXT NOT NULL REFERENCES notifications(id),
    action TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('started','done','failed')),
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO nc1_migrations VALUES(1);
`

/** A separate SQLite file with its own migration table, like the K3 connection store. */
export class NotificationStore {
  readonly db: DatabaseSync
  readonly path: string
  private readonly clock: () => number
  private closed = false

  constructor(path: string, clock: () => number = Date.now) {
    this.path = path
    this.clock = clock
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS nc1_migrations(version INTEGER PRIMARY KEY);`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT version FROM nc1_migrations WHERE version=1').get()) {
        this.db.exec(MIGRATION_V1)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* The closed handle below is the fallback boundary. */ }
      this.db.close()
      this.closed = true
      throw error
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private now(): number {
    const value = this.clock()
    return requireTimestamp(value, 'clock()')
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  }

  private rawNotification(id: string): NotificationRow | undefined {
    return this.db.prepare('SELECT * FROM notifications WHERE id=?').get(id) as NotificationRow | undefined
  }

  private ownedNotification(accountId: string, id: string): NotificationRow {
    const row = this.rawNotification(id)
    if (!row) throw new NotificationStoreError('notification_not_found', 'Notification not found')
    if (String(row.account_id) !== accountId) {
      throw new NotificationStoreError('account_mismatch', 'Notification belongs to another account')
    }
    return row
  }

  windowState(connectionId: string, window: string, accountId?: string): WindowState | null {
    const row = this.db.prepare('SELECT account_id, state FROM quota_window_state WHERE connection_id=? AND window=?')
      .get(connectionId, window) as { account_id: string; state: string } | undefined
    if (!row) return null
    if (accountId !== undefined && String(row.account_id) !== accountId) {
      throw new NotificationStoreError('account_mismatch', 'Window state belongs to another account')
    }
    return parseJson<WindowState>(String(row.state), 'quota window state')
  }

  /**
   * Persist the new window state and append one notification per alert in the same transaction
   * (ADR-0033 outbox rule). Duplicate idempotency keys insert nothing.
   */
  recordEvaluation(
    accountId: string,
    state: WindowState,
    alerts: readonly Alert[],
    subject: NotificationSubject,
    options: RecordEvaluationOptions = {},
  ): StoredNotification[] {
    requireText(accountId, 'accountId')
    if (state === null || typeof state !== 'object') {
      throw new NotificationStoreError('invalid_input', 'state must be a WindowState object')
    }
    requireText(state.connectionId, 'state.connectionId')
    requireText(state.window, 'state.window')
    requireText(subject.type, 'subject.type')
    requireText(subject.id, 'subject.id')
    if (!Array.isArray(alerts)) throw new NotificationStoreError('invalid_input', 'alerts must be an array')
    const alertList = alerts as readonly Alert[]

    return this.transaction(() => {
      const existing = this.db.prepare(
        'SELECT account_id, state FROM quota_window_state WHERE connection_id=? AND window=?',
      ).get(state.connectionId, state.window) as { account_id: string; state: string } | undefined
      if (existing && String(existing.account_id) !== accountId) {
        throw new NotificationStoreError('account_mismatch', 'Window state belongs to another account')
      }
      if (options.expectedObservedAt !== undefined) {
        const previous = existing === undefined
          ? null
          : parseJson<WindowState>(String(existing.state), 'quota window state')
        const actual = previous?.lastObservedAt ?? null
        if (actual !== options.expectedObservedAt) {
          throw new NotificationStoreError('state_conflict', 'Window state changed during evaluation')
        }
      }
      this.db.prepare(`
        INSERT INTO quota_window_state(connection_id, window, account_id, state)
        VALUES(?,?,?,?)
        ON CONFLICT(connection_id, window) DO UPDATE SET
          account_id=excluded.account_id,
          state=excluded.state
      `).run(state.connectionId, state.window, accountId, JSON.stringify(state))

      const inserted: StoredNotification[] = []
      const now = this.now()
      for (const alert of alertList) {
        requireText(alert.idempotencyKey, 'alert.idempotencyKey')
        const actions = QUOTA_ALERT_ACTIONS[alert.kind]
        if (actions === undefined) throw new NotificationStoreError('invalid_input', `unknown alert kind ${alert.kind}`)
        const facts = notificationFacts(alert)
        const id = notificationIdFor(accountId, alert.idempotencyKey)
        const info = this.db.prepare(`
          INSERT INTO notifications(
            id, account_id, kind, severity, subject_type, subject_id, idempotency_key,
            facts, actions, state, snoozed_until, created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,'unread',NULL,?,?)
          ON CONFLICT(idempotency_key) DO NOTHING
        `).run(
          id,
          accountId,
          alert.kind,
          alert.severity,
          subject.type,
          subject.id,
          alert.idempotencyKey,
          JSON.stringify(facts),
          JSON.stringify(actions),
          now,
          now,
        )
        if (Number(info.changes) === 0) {
          const duplicate = this.db.prepare('SELECT account_id FROM notifications WHERE idempotency_key=?')
            .get(alert.idempotencyKey) as { account_id: string } | undefined
          if (duplicate && String(duplicate.account_id) !== accountId) {
            throw new NotificationStoreError('account_mismatch', 'Notification idempotency key belongs to another account')
          }
          continue
        }
        inserted.push({
          id,
          accountId,
          kind: alert.kind,
          severity: alert.severity,
          subject: { type: subject.type, id: subject.id },
          idempotencyKey: alert.idempotencyKey,
          facts,
          actions: [...actions],
          state: 'unread',
          snoozedUntil: null,
          createdAt: now,
          updatedAt: now,
        })
      }
      return inserted
    })
  }

  list(accountId: string, options: ListNotificationsOptions = {}): StoredNotification[] {
    requireText(accountId, 'accountId')
    const limit = options.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new NotificationStoreError('invalid_input', 'limit must be an integer between 1 and 500')
    }
    const before = options.before
    let rowIdCursor: { createdAt: number; rowId: number } | null = null
    if (typeof before === 'number') {
      requireTimestamp(before, 'before')
    } else if (typeof before === 'string' || (before !== null && typeof before === 'object' && !Array.isArray(before))) {
      const cursorId = typeof before === 'string' ? before : before.id
      requireText(cursorId, 'before.id')
      const row = this.db.prepare('SELECT rowid AS row_id, created_at FROM notifications WHERE id=? AND account_id=?')
        .get(cursorId, accountId) as { row_id: number; created_at: number } | undefined
      if (!row) throw new NotificationStoreError('notification_not_found', 'Pagination cursor not found')
      const rowCreatedAt = Number(row.created_at)
      if (typeof before === 'object') {
        requireTimestamp(before.createdAt, 'before.createdAt')
        if (before.createdAt !== rowCreatedAt) {
          throw new NotificationStoreError('invalid_input', 'Pagination cursor timestamp does not match')
        }
      }
      rowIdCursor = { createdAt: rowCreatedAt, rowId: Number(row.row_id) }
    } else if (before !== undefined) {
      throw new NotificationStoreError('invalid_input', 'before must be a timestamp, notification id or cursor')
    }

    const states = options.states === undefined ? [] : [...new Set(options.states)]
    for (const state of states) {
      if (!isState(state)) throw new NotificationStoreError('invalid_input', `unknown notification state ${state}`)
    }

    let sql = 'SELECT * FROM notifications WHERE account_id=?'
    const params: Array<string | number> = [accountId]
    if (states.length > 0) {
      sql += ` AND state IN (${states.map(() => '?').join(',')})`
      params.push(...states)
    }
    if (typeof before === 'number') {
      sql += ' AND created_at < ?'
      params.push(before)
    } else if (rowIdCursor !== null) {
      sql += ' AND (created_at < ? OR (created_at = ? AND rowid < ?))'
      params.push(rowIdCursor.createdAt, rowIdCursor.createdAt, rowIdCursor.rowId)
    }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params).map(row => rowToNotification(row as unknown as NotificationRow))
  }

  get(accountId: string, id: string): StoredNotification {
    return rowToNotification(this.ownedNotification(accountId, id))
  }

  markRead(accountId: string, id: string): StoredNotification {
    return this.transaction(() => {
      const row = this.ownedNotification(accountId, id)
      if (row.state === 'acted') {
        throw new NotificationStoreError('notification_acted', 'Notification was already acted on')
      }
      if (row.state === 'unread' || row.state === 'snoozed') {
        this.db.prepare('UPDATE notifications SET state=\'read\', snoozed_until=NULL, updated_at=? WHERE id=?')
          .run(this.now(), id)
      }
      return rowToNotification(this.ownedNotification(accountId, id))
    })
  }

  snooze(accountId: string, id: string, untilMs: number): StoredNotification {
    requireTimestamp(untilMs, 'untilMs')
    return this.transaction(() => {
      const row = this.ownedNotification(accountId, id)
      if (row.state === 'acted') {
        throw new NotificationStoreError('notification_acted', 'Notification was already acted on')
      }
      this.db.prepare('UPDATE notifications SET state=\'snoozed\', snoozed_until=?, updated_at=? WHERE id=?')
        .run(untilMs, this.now(), id)
      return rowToNotification(this.ownedNotification(accountId, id))
    })
  }

  /** Snoozed rows whose time has passed become unread again; returns the number changed. */
  expireSnoozed(nowMs: number): number {
    requireTimestamp(nowMs, 'nowMs')
    return this.transaction(() => {
      const info = this.db.prepare(`
        UPDATE notifications
        SET state='unread', snoozed_until=NULL, updated_at=?
        WHERE state='snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?
      `).run(this.now(), nowMs)
      return Number(info.changes)
    })
  }

  beginAction(
    accountId: string,
    notificationId: string,
    action: NotificationAction,
    idempotencyKey: string,
  ): 'started' | 'duplicate' {
    requireText(accountId, 'accountId')
    requireText(notificationId, 'notificationId')
    requireText(idempotencyKey, 'idempotencyKey')
    if (!isAction(action)) throw new NotificationStoreError('invalid_action', `unknown action ${String(action)}`)

    return this.transaction(() => {
      const notification = rowToNotification(this.ownedNotification(accountId, notificationId))
      if (!notification.actions.includes(action)) {
        throw new NotificationStoreError('action_not_offered', `Action ${action} is not offered by this notification`)
      }
      const existing = this.db.prepare(`
        SELECT a.notification_id, a.action, a.idempotency_key, a.status, a.result, a.created_at, a.updated_at,
               n.account_id AS account_id
        FROM notification_actions a JOIN notifications n ON n.id = a.notification_id
        WHERE a.idempotency_key=?
      `).get(idempotencyKey) as ActionRow | undefined
      if (existing) {
        if (String(existing.account_id) !== accountId) {
          throw new NotificationStoreError('account_mismatch', 'Action belongs to another account')
        }
        if (String(existing.notification_id) !== notificationId || String(existing.action) !== action) {
          throw new NotificationStoreError('idempotency_conflict', 'Idempotency key belongs to another action')
        }
        return 'duplicate'
      }
      if (notification.state === 'acted') {
        throw new NotificationStoreError('notification_acted', 'Notification was already acted on')
      }
      const inProgress = this.db.prepare(
        'SELECT 1 AS present FROM notification_actions WHERE notification_id=? AND status=\'started\' LIMIT 1',
      ).get(notificationId)
      if (inProgress) {
        throw new NotificationStoreError('action_in_progress', 'Another action is already in progress')
      }
      const now = this.now()
      this.db.prepare(`
        INSERT INTO notification_actions(notification_id, action, idempotency_key, status, result, created_at, updated_at)
        VALUES(?,?,?,'started',NULL,?,?)
      `).run(notificationId, action, idempotencyKey, now, now)
      return 'started'
    })
  }

  actionRecord(accountId: string, idempotencyKey: string): StoredNotificationAction | null {
    const row = this.db.prepare(`
      SELECT a.notification_id, a.action, a.idempotency_key, a.status, a.result, a.created_at, a.updated_at,
             n.account_id AS account_id
      FROM notification_actions a JOIN notifications n ON n.id = a.notification_id
      WHERE a.idempotency_key=?
    `).get(idempotencyKey) as ActionRow | undefined
    if (!row) return null
    if (String(row.account_id) !== accountId) {
      throw new NotificationStoreError('account_mismatch', 'Action belongs to another account')
    }
    return rowToAction(row)
  }

  /**
   * Finish a started action. `done` marks the notification acted, except for the typed snooze
   * action, which passes `snoozedUntil` and enters `snoozed`. Terminal rows are immutable so a
   * late duplicate cannot overwrite the first result. The account is always required.
   */
  finishAction(
    idempotencyKey: string,
    status: Exclude<ActionStatus, 'started'>,
    result: unknown,
    accountId: string,
    options: FinishActionOptions = {},
  ): StoredNotificationAction {
    requireText(idempotencyKey, 'idempotencyKey')
    requireText(accountId, 'accountId')
    if (status !== 'done' && status !== 'failed') {
      throw new NotificationStoreError('invalid_input', 'finishAction status must be done or failed')
    }
    if (options.snoozedUntil !== undefined) requireTimestamp(options.snoozedUntil, 'snoozedUntil')
    let serialized: string
    try {
      serialized = JSON.stringify(result ?? null)
    } catch {
      throw new NotificationStoreError('invalid_input', 'action result must be JSON-serialisable')
    }

    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT a.notification_id, a.action, a.idempotency_key, a.status, a.result, a.created_at, a.updated_at,
               n.account_id AS account_id
        FROM notification_actions a JOIN notifications n ON n.id = a.notification_id
        WHERE a.idempotency_key=?
      `).get(idempotencyKey) as ActionRow | undefined
      if (!row) throw new NotificationStoreError('action_not_found', 'Action not found')
      if (String(row.account_id) !== accountId) {
        throw new NotificationStoreError('account_mismatch', 'Action belongs to another account')
      }
      if (options.snoozedUntil !== undefined && String(row.action) !== 'snooze') {
        throw new NotificationStoreError('invalid_input', 'Only the snooze action can set snoozedUntil')
      }
      if (row.status === 'started') {
        const now = this.now()
        this.db.prepare('UPDATE notification_actions SET status=?, result=?, updated_at=? WHERE idempotency_key=?')
          .run(status, serialized, now, idempotencyKey)
        if (status === 'done') {
          const nextState = options.snoozedUntil === undefined ? 'acted' : 'snoozed'
          this.db.prepare('UPDATE notifications SET state=?, snoozed_until=?, updated_at=? WHERE id=?')
            .run(nextState, options.snoozedUntil ?? null, now, row.notification_id)
        }
        row.status = status
        row.result = serialized
        row.updated_at = now
      }
      return rowToAction(row)
    })
  }
}
