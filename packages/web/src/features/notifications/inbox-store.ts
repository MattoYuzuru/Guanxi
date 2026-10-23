import type {
  ExecuteNotificationActionBody,
  NotificationActionsResponse,
  NotificationErrorCode,
  NotificationWire,
} from '@guanxi/contract'
import { LocalApiError, LocalApiShapeError } from '../../lib/local-api.ts'
import { newIdempotencyKey, notificationsApi } from './api.ts'

/**
 * The notification inbox as one framework-free store, so the status-strip bell and the
 * notification center read the same rows and cannot disagree. Every fetched row is kept as the
 * newest known version (server `updatedAt` wins, so a slow poll never un-reads a row the user
 * just read); the unread badge is derived from the same rows as the Unread list.
 */

export type NotificationState = NotificationWire['state']
export type NotificationActionName = NotificationWire['actions'][number]
export type Availability = NotificationActionsResponse['actions'][number]['availability']
export type InboxApi = Pick<typeof notificationsApi, 'list' | 'get' | 'markRead' | 'snooze' | 'actions' | 'execute'>

export const FILTERS = ['unread', 'all', 'read', 'snoozed', 'acted'] as const
export type ListFilter = (typeof FILTERS)[number]

/** The unread list is also the badge, so it takes the largest page the node allows. */
export const PAGE_SIZE: Readonly<Record<ListFilter, number>> = { unread: 200, all: 50, read: 50, snoozed: 50, acted: 50 }
const STATES: Readonly<Record<ListFilter, readonly NotificationState[] | undefined>> = {
  unread: ['unread'], all: undefined, read: ['read'], snoozed: ['snoozed'], acted: ['acted'],
}

export type FailureCode = NotificationErrorCode | 'offline' | 'timeout' | 'contract_mismatch' | 'unexpected_response'
export interface Failure {
  /** `offline`: the request never got an answer. `server`: the node answered with a `{ code }`. */
  kind: 'offline' | 'server' | 'contract'
  code: FailureCode
  status: number | null
  /** Caller clock, epoch milliseconds. */
  at: number
}

export function classifyFailure(error: unknown, at: number): Failure {
  if (error instanceof LocalApiError) {
    // Behind a dev proxy or gateway a dead node answers with an empty 5xx (or an HTML 502/504) instead
    // of the node's `{ code }`; that is "no answer from the node", the same as a refused connection.
    // A 5xx that does carry a `{ code }` (503 notifications_unavailable, 502 port_failed) is the node.
    if (error.status >= 500 && error.code === 'unexpected_response') return { kind: 'offline', code: 'offline', status: error.status, at }
    return { kind: 'server', code: error.code as FailureCode, status: error.status, at }
  }
  // `fetch` rejects with a TypeError when no answer arrived at all.
  if (error instanceof TypeError) return { kind: 'offline', code: 'offline', status: null, at }
  if (error instanceof LocalApiShapeError) return { kind: 'contract', code: 'contract_mismatch', status: null, at }
  // The body is validated before it leaves the browser; a ZodError means nothing was sent.
  if (error instanceof Error && error.name === 'ZodError') return { kind: 'contract', code: 'validation_failed', status: null, at }
  return { kind: 'contract', code: 'contract_mismatch', status: null, at }
}

/**
 * After these the request may or may not have taken effect, so the next attempt of the same
 * intent must reuse its key. Everything else is a definite answer; a new attempt is a new intent.
 */
const OUTCOME_UNKNOWN_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'internal_error', 'notifications_unavailable', 'action_in_progress', 'action_outcome_unknown', 'unexpected_response',
])
export const outcomeUnknown = (failure: Failure): boolean =>
  failure.kind === 'server'
    ? OUTCOME_UNKNOWN_CODES.has(failure.code)
    : !(failure.kind === 'contract' && failure.code === 'validation_failed')

/** A read that gets no answer in this long is reported as an unreachable node. */
export const READ_TIMEOUT_MS = 15_000
/** An action that gets no answer in this long has an unknown outcome; its key is kept for the retry. */
export const ACTION_TIMEOUT_MS = 30_000
/** Refusals that mean this copy of the row is out of date. */
const ROW_CHANGED_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>(['notification_acted', 'action_not_offered', 'notification_not_found'])

export interface ListSlice {
  /** Newest first. Visible rows are these ids whose current state matches the filter. */
  ids: readonly string[]
  nextCursor: string | null
  loaded: boolean
  loading: boolean
  loadingMore: boolean
  /** Caller clock when the head of this list was last read successfully. */
  observedAt: number | null
  failure: Failure | null
  moreFailure: Failure | null
}

export interface RowOp {
  kind: 'read' | 'snooze' | 'action'
  action?: NotificationActionName
  status: 'pending' | 'failed' | 'stale'
  failure: Failure | null
  /** True when a retry reuses the same Idempotency-Key. */
  keepsKey: boolean
}

export interface AvailabilitySlice {
  loaded: boolean
  /** Caller clock when the node last reported what it can run. */
  observedAt: number | null
  loading: boolean
  map: Readonly<Partial<Record<NotificationActionName, Availability>>>
  failure: Failure | null
}

export interface InboxSnapshot {
  rows: Readonly<Record<string, NotificationWire>>
  lists: Readonly<Record<ListFilter, ListSlice>>
  availability: AvailabilitySlice
  ops: Readonly<Record<string, RowOp>>
  /** Rows that appeared as unread in a later read of the head of the Unread list (not from paging). */
  arrivals: number
}

export type OpResult =
  | { ok: true; duplicate: boolean; stale: boolean }
  | { ok: false; busy: boolean; failure: Failure | null }

const emptySlice = (): ListSlice => ({
  ids: [], nextCursor: null, loaded: false, loading: false, loadingMore: false, observedAt: null, failure: null, moreFailure: null,
})

export const matchesFilter = (filter: ListFilter, state: NotificationState): boolean => filter === 'all' || state === filter

export function visibleIds(snapshot: InboxSnapshot, filter: ListFilter): string[] {
  return snapshot.lists[filter].ids.filter((id) => {
    const row = snapshot.rows[id]
    return row !== undefined && matchesFilter(filter, row.state)
  })
}

export interface UnreadSummary {
  loaded: boolean
  count: number
  /** More unread rows exist than are loaded, so `count` is a lower bound. */
  atLeast: boolean
  observedAt: number | null
  failure: Failure | null
}

export function unreadSummary(snapshot: InboxSnapshot): UnreadSummary {
  const slice = snapshot.lists.unread
  return {
    loaded: slice.loaded,
    count: visibleIds(snapshot, 'unread').length,
    atLeast: slice.nextCursor !== null,
    observedAt: slice.observedAt,
    failure: slice.failure,
  }
}

const newerFirst = (a: NotificationWire, b: NotificationWire): boolean =>
  a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)

function mergeRows(held: InboxSnapshot['rows'], fetched: readonly NotificationWire[]): InboxSnapshot['rows'] {
  const next = { ...held }
  for (const row of fetched) {
    const known = next[row.id]
    next[row.id] = known !== undefined && known.updatedAt > row.updatedAt ? known : row
  }
  return next
}

/** Canonical JSON so the same intent always maps to the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export interface InboxStoreOptions {
  now?: () => number
  newKey?: () => string
}

export class InboxStore {
  private snapshot: InboxSnapshot = {
    rows: {},
    lists: { unread: emptySlice(), all: emptySlice(), read: emptySlice(), snoozed: emptySlice(), acted: emptySlice() },
    availability: { loaded: false, observedAt: null, loading: false, map: {}, failure: null },
    ops: {},
    arrivals: 0,
  }
  private readonly listeners = new Set<() => void>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly controllers = new Set<AbortController>()
  /** Intent → Idempotency-Key, kept only while the outcome of the intent is unknown. */
  private readonly intents = new Map<string, string>()
  /** Lists whose in-flight read began before a change and must be read once more. */
  private readonly reread = new Set<ListFilter>()
  private active: ListFilter | null = null
  private disposed = false
  private readonly now: () => number
  private readonly newKey: () => string

  constructor(private readonly api: InboxApi, options: InboxStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.newKey = options.newKey ?? newIdempotencyKey
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): InboxSnapshot => this.snapshot

  /** Cancels in-flight reads; the store stays usable (a remount can read again). */
  dispose(): void {
    this.disposed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.flights.clear()
    const lists = { ...this.snapshot.lists }
    for (const filter of FILTERS) lists[filter] = { ...lists[filter], loading: false, loadingMore: false }
    this.set({ lists, availability: { ...this.snapshot.availability, loading: false } })
  }

  /** Undoes `dispose` for a remount (StrictMode runs an effect's cleanup and setup again). */
  resume(): void {
    this.disposed = false
  }

  private set(patch: Partial<InboxSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private patchSlice(filter: ListFilter, patch: Partial<ListSlice>): void {
    this.set({ lists: { ...this.snapshot.lists, [filter]: { ...this.snapshot.lists[filter], ...patch } } })
  }

  private setOp(id: string, op: RowOp | null): void {
    const ops = { ...this.snapshot.ops }
    if (op === null) delete ops[id]
    else ops[id] = op
    this.set({ ops })
  }

  private putRow(row: NotificationWire): void {
    this.set({ rows: mergeRows(this.snapshot.rows, [row]) })
    this.pruneIntents()
  }

  /** An acted notification takes no further action, so keys kept for retries of its actions are dead. */
  private pruneIntents(): void {
    for (const intent of [...this.intents.keys()]) {
      const id = intent.slice(0, intent.indexOf('\u0000'))
      if (this.snapshot.rows[id]?.state === 'acted') this.intents.delete(intent)
    }
  }

  /* ───────────────────────────────── reads ──────────────────────────────── */

  /** Marks the list the page shows; it is read now and kept fresh by `refresh`. */
  activate(filter: ListFilter | null): Promise<void> {
    this.active = filter
    if (filter === null) return Promise.resolve()
    const slice = this.snapshot.lists[filter]
    // A list the user left and came back to is shown as it was while it is read again.
    return slice.loading ? Promise.resolve() : this.loadHead(filter)
  }

  /** Re-reads the Unread list (the badge), the active list and, while the page is open, what the node can run. */
  async refresh(): Promise<void> {
    const reads = [this.loadHead('unread')]
    if (this.active !== null && this.active !== 'unread') reads.push(this.loadHead(this.active))
    if (this.active !== null) reads.push(this.loadAvailability())
    await Promise.all(reads)
  }

  /** After a change this client made: every list already loaded is read again, even if a read is in flight. */
  private async refreshAfterChange(): Promise<void> {
    // A change that finished after the page went away must not start reads nobody will use.
    if (this.disposed) return
    const reads: Promise<void>[] = []
    for (const filter of FILTERS) {
      if (filter === 'unread' || filter === this.active || this.snapshot.lists[filter].loaded) reads.push(this.loadHead(filter, true))
    }
    await Promise.all(reads)
  }

  loadHead(filter: ListFilter, afterChange = false): Promise<void> {
    const existing = this.flights.get(filter)
    if (existing !== undefined) {
      // That read may have been answered before the change; read once more when it ends.
      if (afterChange) this.reread.add(filter)
      return existing
    }
    const flight = (async () => {
      do {
        this.reread.delete(filter)
        await this.readHead(filter)
      } while (this.reread.has(filter))
    })().finally(() => {
      if (this.flights.get(filter) === flight) this.flights.delete(filter)
    })
    this.flights.set(filter, flight)
    return flight
  }

  /** An abort signal that also fires after READ_TIMEOUT_MS; `timedOut()` tells the two apart. */
  private timed(ms = READ_TIMEOUT_MS): { controller: AbortController; timedOut: () => boolean; done: () => void } {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => { expired = true; controller.abort() }, ms)
    this.controllers.add(controller)
    return { controller, timedOut: () => expired, done: () => { clearTimeout(timer); this.controllers.delete(controller) } }
  }

  private async readHead(filter: ListFilter): Promise<void> {
    const { controller, timedOut, done } = this.timed()
    // The failure of the last read stays shown until a read succeeds, so a retry does not flicker the state.
    this.patchSlice(filter, { loading: true })
    try {
      const page = await this.api.list({ states: STATES[filter], limit: PAGE_SIZE[filter] }, controller.signal)
      if (controller.signal.aborted) throw new Error('aborted')
      this.applyHead(filter, page.notifications, page.nextCursor)
    } catch (error) {
      if (controller.signal.aborted && !timedOut()) return
      this.patchSlice(filter, { loading: false, failure: classifyFailure(timedOut() ? new TypeError('timeout') : error, this.now()) })
    } finally {
      done()
    }
  }

  private applyHead(filter: ListFilter, fetched: readonly NotificationWire[], nextCursor: string | null): void {
    const before = this.snapshot
    const rows = mergeRows(before.rows, fetched)
    const slice = before.lists[filter]
    const fetchedIds = fetched.map((row) => row.id)
    let ids = fetchedIds
    let cursor = nextCursor
    const last = fetched.at(-1)
    if (slice.loaded && nextCursor !== null && last !== undefined) {
      // Keep older pages the user already loaded: rows older than this page's last row.
      const seen = new Set(fetchedIds)
      const older = slice.ids.filter((id) => {
        const row = rows[id]
        return !seen.has(id) && row !== undefined && newerFirst(last, row)
      })
      if (older.length > 0) {
        ids = [...fetchedIds, ...older]
        cursor = slice.nextCursor
      }
    }
    let arrivals = before.arrivals
    if (filter === 'unread' && slice.loaded) {
      const known = new Set(slice.ids.filter((id) => before.rows[id]?.state === 'unread'))
      const newest = slice.ids.reduce((max, id) => Math.max(max, before.rows[id]?.createdAt ?? 0), 0)
      // New: never seen and newer than anything held (an older row sliding into the page is not new),
      // or a snoozed row that came back.
      arrivals += fetched.filter((row) => {
        if (rows[row.id]?.state !== 'unread' || known.has(row.id)) return false
        const held = before.rows[row.id]
        return held === undefined ? row.createdAt > newest : held.state === 'snoozed'
      }).length
    }
    // A row that came back from the node supersedes a "done, but not refreshed" note.
    const ops = { ...before.ops }
    for (const id of fetchedIds) if (ops[id]?.status === 'stale') delete ops[id]
    this.set({
      rows,
      ops,
      arrivals,
      lists: {
        ...before.lists,
        [filter]: { ...slice, ids, nextCursor: cursor, loaded: true, loading: false, observedAt: this.now(), failure: null },
      },
    })
    this.pruneIntents()
  }

  async loadMore(filter: ListFilter): Promise<void> {
    const slice = this.snapshot.lists[filter]
    if (slice.nextCursor === null || slice.loadingMore) return
    const { controller, timedOut, done } = this.timed()
    this.patchSlice(filter, { loadingMore: true, moreFailure: null })
    try {
      const page = await this.api.list({ states: STATES[filter], limit: PAGE_SIZE[filter], before: slice.nextCursor }, controller.signal)
      if (controller.signal.aborted) throw new Error('aborted')
      const current = this.snapshot.lists[filter]
      // A head read that landed meanwhile moved the cursor; this page would leave a gap, so drop it.
      if (current.nextCursor !== slice.nextCursor) { this.patchSlice(filter, { loadingMore: false }); return }
      const rows = mergeRows(this.snapshot.rows, page.notifications)
      const seen = new Set(current.ids)
      this.set({
        rows,
        lists: {
          ...this.snapshot.lists,
          [filter]: {
            ...current,
            ids: [...current.ids, ...page.notifications.map((row) => row.id).filter((id) => !seen.has(id))],
            nextCursor: page.nextCursor,
            loadingMore: false,
          },
        },
      })
      this.pruneIntents()
    } catch (error) {
      if (controller.signal.aborted && !timedOut()) return
      this.patchSlice(filter, { loadingMore: false, moreFailure: classifyFailure(timedOut() ? new TypeError('timeout') : error, this.now()) })
    } finally {
      done()
    }
  }

  async loadAvailability(): Promise<void> {
    if (this.snapshot.availability.loading) return
    const { controller, timedOut, done } = this.timed()
    this.set({ availability: { ...this.snapshot.availability, loading: true } })
    try {
      const answer = await this.api.actions(controller.signal)
      if (controller.signal.aborted) throw new Error('aborted')
      const map: Partial<Record<NotificationActionName, Availability>> = {}
      for (const item of answer.actions) map[item.action] = item.availability
      this.set({ availability: { loaded: true, observedAt: this.now(), loading: false, map, failure: null } })
    } catch (error) {
      if (controller.signal.aborted && !timedOut()) return
      this.set({ availability: { ...this.snapshot.availability, loading: false, failure: classifyFailure(timedOut() ? new TypeError('timeout') : error, this.now()) } })
    } finally {
      done()
    }
  }

  /* ─────────────────────────────── mutations ────────────────────────────── */

  private begin(id: string, kind: RowOp['kind'], action?: NotificationActionName): boolean {
    if (this.snapshot.ops[id]?.status === 'pending') return false
    this.setOp(id, { kind, ...(action ? { action } : {}), status: 'pending', failure: null, keepsKey: false })
    return true
  }

  private fail(id: string, kind: RowOp['kind'], failure: Failure, keepsKey: boolean, action?: NotificationActionName): OpResult {
    this.setOp(id, { kind, ...(action ? { action } : {}), status: 'failed', failure, keepsKey })
    if (failure.kind === 'server' && ROW_CHANGED_CODES.has(failure.code)) {
      // This copy of the row is out of date (acted elsewhere, gone): read it and the lists again.
      if (!this.disposed) void this.api.get(id).then((row) => this.putRow(row), () => undefined).then(() => this.refreshAfterChange())
    }
    if (failure.kind === 'server' && failure.code === 'not_configured' && !this.disposed) void this.loadAvailability()
    return { ok: false, busy: false, failure }
  }

  markRead(id: string): Promise<OpResult> {
    return this.mutateRow(id, 'read', () => this.api.markRead(id))
  }

  snooze(id: string, untilMs: number): Promise<OpResult> {
    return this.mutateRow(id, 'snooze', () => this.api.snooze(id, untilMs))
  }

  private async mutateRow(id: string, kind: 'read' | 'snooze', call: () => Promise<NotificationWire>): Promise<OpResult> {
    if (!this.begin(id, kind)) return { ok: false, busy: true, failure: null }
    let row: NotificationWire
    try {
      row = await call()
    } catch (error) {
      return this.fail(id, kind, classifyFailure(error, this.now()), false)
    }
    this.putRow(row)
    // The node answers 200 with the row unchanged when it was already acted on; that is not "read".
    if (kind === 'read' && row.state === 'acted') {
      return this.fail(id, kind, { kind: 'server', code: 'notification_acted', status: 200, at: this.now() }, false)
    }
    this.setOp(id, null)
    void this.refreshAfterChange()
    return { ok: true, duplicate: false, stale: false }
  }

  /**
   * Runs one action. The Idempotency-Key belongs to the intent (this notification, this action,
   * these arguments): it is created on the first attempt and reused for every retry whose outcome
   * was unknown, and dropped once the node gave a definite answer.
   */
  async execute(id: string, body: ExecuteNotificationActionBody): Promise<OpResult> {
    const action = body.action
    if (!this.begin(id, 'action', action)) return { ok: false, busy: true, failure: null }
    let intent = ''
    let response
    const timer = this.timed(ACTION_TIMEOUT_MS)
    try {
      intent = `${id}\u0000${canonical(body)}`
      const key = this.intents.get(intent) ?? this.newKey()
      this.intents.set(intent, key)
      response = await this.api.execute(id, body, key, timer.controller.signal)
    } catch (error) {
      // No answer in time: the node may still have acted, so the outcome is unknown and the key stays.
      const failure = timer.timedOut() ? { kind: 'offline' as const, code: 'timeout' as const, status: null, at: this.now() } : classifyFailure(error, this.now())
      const keep = outcomeUnknown(failure)
      if (!keep && intent !== '') this.intents.delete(intent)
      return this.fail(id, 'action', failure, keep, action)
    } finally {
      timer.done()
    }
    this.intents.delete(intent)
    if (response.status === 'failed') {
      return this.fail(id, 'action', { kind: 'server', code: 'port_failed', status: null, at: this.now() }, false, action)
    }
    let stale = false
    try {
      this.putRow(await this.api.get(id))
    } catch {
      stale = true
    }
    this.setOp(id, stale ? { kind: 'action', action, status: 'stale', failure: null, keepsKey: false } : null)
    void this.refreshAfterChange()
    return { ok: true, duplicate: response.duplicate, stale }
  }

  /** Clears a shown failure (dismissing it, or starting something else). */
  dismissOp(id: string): void {
    if (this.snapshot.ops[id]?.status === 'failed') this.setOp(id, null)
  }
}
