/**
 * Delivery dispatch for ADR-0033 decision 8: the bridge between the pure
 * `planDelivery` planner and the durable inbox.
 *
 * Ingestion inserts the notification rows first; dispatch runs afterwards, so the
 * notification row is always the source of truth. Planning records one row per channel in
 * `notification_deliveries`. `in_app` needs no adapter (the notification row is the delivery),
 * `push` is not configured yet and is recorded as such, and the `os` channel is attempted
 * through the injected adapter. Deferred rows stay `pending` until the host explicitly calls
 * `deliverDue(now)`; this module starts no timer and reads no wall clock except through the
 * injected `now`.
 */
import { planDelivery, type DeliverySettings } from './delivery.ts'
import type { OsNotifier, UnavailableOsNotifier } from './os-adapter.ts'
import { osPayload } from './payload.ts'
import type { NotificationStore, StoredNotification } from './store.ts'

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'unavailable'
export type DeliveryChannel = 'in_app' | 'os' | 'push'

/** Host settings and adapter for one node. Both are optional only as a whole config. */
export interface NotificationDeliveryConfig {
  /** Load the account's delivery settings. This slice has no persistence/UI. */
  settings(accountId: string): DeliverySettings
  /** Missing means the OS channel is unavailable on this node. */
  os?: OsNotifier | UnavailableOsNotifier
}

export interface DeliveryDispatcherOptions extends NotificationDeliveryConfig {
  /** Caller clock in milliseconds; the dispatcher never reads `Date.now`. */
  now(): number
}

/** Outcome of one dispatch or `deliverDue` call. `pending` is the remaining row count. */
export interface DeliveryCounts {
  delivered: number
  failed: number
  unavailable: number
  pending: number
}

interface DeliveryRow {
  notification_id: string
  channel: string
  account_id: string
  state: string
}

interface PlannedDelivery {
  status: DeliveryStatus
  code: string | null
  attemptedAt: number | null
}

const OUTPUT_CODES: ReadonlySet<DeliveryStatus> = new Set(['delivered', 'failed', 'unavailable'])

function emptyCounts(): DeliveryCounts {
  return { delivered: 0, failed: 0, unavailable: 0, pending: 0 }
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite millisecond timestamp`)
  }
  return value
}

export class DeliveryDispatcher {
  private readonly store: NotificationStore
  private readonly options: DeliveryDispatcherOptions
  /** Serialises due-delivery passes so one pending row is attempted by one call at a time. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(store: NotificationStore, options: DeliveryDispatcherOptions) {
    this.store = store
    this.options = options
  }

  /**
   * Record the plan for freshly inserted notifications and attempt every row that is already
   * due. Resolves with the delivery counts of the pass; safe to call twice for the same rows
   * because `(notification_id, channel)` is unique and only `pending` rows are attempted.
   */
  dispatch(notifications: readonly StoredNotification[]): Promise<DeliveryCounts> {
    return this.schedule(notifications)
  }

  /** Fire-and-forget variant used by ingestion: plan synchronously, then deliver due rows. */
  schedule(notifications: readonly StoredNotification[]): Promise<DeliveryCounts> {
    if (notifications.length === 0) return Promise.resolve(emptyCounts())
    const now = this.clock()
    this.plan(notifications, now)
    return this.deliverDue(now)
  }

  /**
   * Deliver pending rows whose `deliver_at` is at or before `now`. Idempotent: terminal rows
   * are never attempted again, and the terminal update is guarded by `status='pending'`.
   * The caller (the host, not this plugin) owns the timer that decides when to call this.
   */
  deliverDue(now: number = this.clock()): Promise<DeliveryCounts> {
    const timestamp = finiteTimestamp(now, 'now')
    return this.enqueue(() => this.deliverDueNow(timestamp))
  }

  private clock(): number {
    return finiteTimestamp(this.options.now(), 'now()')
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    // A rejected pass must not poison later passes; the caller still sees the rejection.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private transaction<T>(run: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.store.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.store.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      throw error
    }
  }

  private notifier(): OsNotifier | null {
    const os = this.options.os
    if (os === undefined) return null
    return typeof (os as OsNotifier).notify === 'function' ? os as OsNotifier : null
  }

  private unavailableReason(): string {
    const os = this.options.os
    if (os === undefined) return 'os_not_configured'
    const reason = (os as UnavailableOsNotifier).unavailable
    return typeof reason === 'string' && reason.length > 0 ? reason : 'os_unavailable'
  }

  /**
   * `in_app` is delivered by the notification row itself; `push` has no adapter in this
   * slice; the OS channel is pending only when an adapter exists.
   */
  private planned(channel: DeliveryChannel, now: number): PlannedDelivery {
    if (channel === 'in_app') return { status: 'delivered', code: 'in_app', attemptedAt: now }
    if (channel === 'push') return { status: 'unavailable', code: 'push_not_configured', attemptedAt: now }
    if (this.notifier() === null) {
      return { status: 'unavailable', code: this.unavailableReason(), attemptedAt: now }
    }
    return { status: 'pending', code: null, attemptedAt: null }
  }

  private plan(notifications: readonly StoredNotification[], now: number): void {
    this.transaction(() => {
      const insert = this.store.db.prepare(`
        INSERT INTO notification_deliveries(notification_id, channel, deliver_at, status, code, attempted_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(notification_id, channel) DO NOTHING
      `)
      for (const notification of notifications) {
        const decisions = planDelivery(
          {
            kind: notification.kind,
            severity: notification.severity,
            createdAt: notification.createdAt,
          },
          this.options.settings(notification.accountId),
          now,
        )
        for (const decision of decisions) {
          const channel = decision.channel
          const planned = this.planned(channel, now)
          insert.run(
            notification.id,
            channel,
            decision.deliverAt,
            planned.status,
            planned.code,
            planned.attemptedAt,
          )
        }
      }
    })
  }

  /** Move one still-pending row to a terminal state. Returns false when another caller won. */
  private transition(notificationId: string, channel: string, status: DeliveryStatus, code: string): boolean {
    if (!OUTPUT_CODES.has(status)) throw new TypeError(`invalid delivery status ${status}`)
    const info = this.store.db.prepare(`
      UPDATE notification_deliveries
      SET status=?, code=?, attempted_at=?
      WHERE notification_id=? AND channel=? AND status='pending'
    `).run(status, code, this.clock(), notificationId, channel)
    return Number(info.changes) === 1
  }

  private async deliverDueNow(now: number): Promise<DeliveryCounts> {
    const counts = emptyCounts()
    const due = this.store.db.prepare(`
      SELECT d.notification_id AS notification_id, d.channel AS channel, n.account_id AS account_id, n.state AS state
      FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id
      WHERE d.status='pending' AND d.deliver_at <= ?
      ORDER BY d.deliver_at, d.notification_id, d.channel
    `).all(now) as unknown as DeliveryRow[]
    const notifier = this.notifier()

    for (const row of due) {
      const channel = row.channel
      // A notification the user already read, acted on or that expired is not re-announced by a
      // deferred or crash-leftover OS delivery.
      if (row.state !== 'unread' && row.state !== 'snoozed') {
        if (this.transition(row.notification_id, channel, 'unavailable', 'notification_inactive')) counts.unavailable += 1
        continue
      }
      if (channel === 'os') {
        if (notifier === null) {
          if (this.transition(row.notification_id, channel, 'unavailable', this.unavailableReason())) {
            counts.unavailable += 1
          }
          continue
        }
        let outcome: { delivered: boolean; code: string }
        try {
          outcome = await notifier.notify(osPayload(this.store.get(row.account_id, row.notification_id)))
        } catch {
          // The adapter and the payload are content-free; keep only a code, never a message.
          outcome = { delivered: false, code: 'os_notify_failed' }
        }
        const delivered = outcome.delivered === true
        const code = typeof outcome.code === 'string' && outcome.code.length > 0
          ? outcome.code
          : delivered ? 'delivered' : 'os_notify_failed'
        if (this.transition(row.notification_id, channel, delivered ? 'delivered' : 'failed', code)) {
          if (delivered) counts.delivered += 1
          else counts.failed += 1
        }
        continue
      }
      if (channel === 'push') {
        if (this.transition(row.notification_id, channel, 'unavailable', 'push_not_configured')) {
          counts.unavailable += 1
        }
        continue
      }
      if (channel === 'in_app') {
        if (this.transition(row.notification_id, channel, 'delivered', 'in_app')) counts.delivered += 1
        continue
      }
      if (this.transition(row.notification_id, channel, 'unavailable', 'channel_unsupported')) {
        counts.unavailable += 1
      }
    }

    counts.pending = Number(this.store.db.prepare(
      "SELECT COUNT(*) AS n FROM notification_deliveries WHERE status='pending'",
    ).get()?.n ?? 0)
    return counts
  }
}
