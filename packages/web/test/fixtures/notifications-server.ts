/**
 * An in-memory node for the notification center specs. It implements the MS2 REST contract
 * (docs: packages/server/src/notifications/README.md) closely enough that the UI cannot lean on
 * anything the real node would refuse: strict ids, newest-first paging by `before`, snooze expiry
 * on read, `Idempotency-Key` replay with `duplicate: true`, 501 `not_configured` before any
 * reservation, and `notification_acted` once a row has been acted on.
 *
 * Vitest wraps `handle` in a `fetch` stub; Playwright wraps it in a route handler.
 */
import type { NotificationActionsResponse, NotificationWire } from '@guanxi/contract'

type Action = NotificationWire['actions'][number]
type Availability = NotificationActionsResponse['actions'][number]['availability']

export const T0 = Date.parse('2026-10-23T10:00:00.000Z')
export const QUOTA_ACTIONS: Action[] = ['open', 'wake_leads', 'switch_connection', 'pause_runs', 'snooze', 'accept_recommendation']

/** A connection id as the real node issues them (a UUID). */
export const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_CONNECTION_ID = '22222222-2222-4222-8222-222222222222'

export const notificationId = (n: number): string => `ntf_${n.toString(16).padStart(40, '0')}`

export function notification(n: number, overrides: Partial<Omit<NotificationWire, 'facts'>> & { facts?: Partial<NotificationWire['facts']> } = {}): NotificationWire {
  const { facts, ...rest } = overrides
  return {
    id: notificationId(n),
    kind: 'threshold',
    severity: 'warning',
    subject: { type: 'connection', id: CONNECTION_ID },
    facts: {
      window: 'five_hour',
      threshold: 10,
      remainingPercent: 9,
      resetsAt: '2026-10-23T13:00:00.000Z',
      source: 'claude_code.statusline',
      observedAt: '2026-10-23T09:58:00.000Z',
      confidence: 'observed',
      ...facts,
    },
    actions: [...QUOTA_ACTIONS],
    state: 'unread',
    snoozedUntil: null,
    createdAt: T0 + n * 1000,
    updatedAt: T0 + n * 1000,
    ...rest,
  }
}

/** What the shipped node reports: only `open` and `snooze` can run. */
export function shippedAvailability(): Record<Action, Availability> {
  return {
    open: 'available', add_prompt: 'not_exposed', accept_recommendation: 'not_configured', choose_action: 'not_exposed',
    wake_leads: 'not_configured', switch_connection: 'not_configured', pause_runs: 'not_configured',
    resume_runs: 'not_configured', snooze: 'available', raise_budget: 'not_exposed',
  }
}

export function allWireAvailable(): Record<Action, Availability> {
  const map = shippedAvailability()
  for (const action of ['accept_recommendation', 'wake_leads', 'switch_connection', 'pause_runs', 'resume_runs'] as const) map[action] = 'available'
  return map
}

export interface RequestRecord {
  method: string
  path: string
  query: Record<string, string>
  idempotencyKey: string | null
  body: unknown
}

/** `network`: the request never gets an answer. `lose`: the effect happens, then the answer is lost. */
export type Failure = { status: number; body: unknown } | 'network' | 'lose'

export interface Reply {
  status: number
  body: unknown
}

export class FakeNode {
  rows: NotificationWire[]
  availability: Record<Action, Availability>
  clock = T0 + 3_600_000
  requests: RequestRecord[] = []
  /** How many times each action's effect ran (replays do not count). */
  effects: Record<string, number> = {}
  /** Forced failures, matched against `METHOD /path` and consumed in order. */
  private failures: Array<{ match: RegExp; failure: Failure }> = []
  private persistent: Array<{ match: RegExp; failure: Exclude<Failure, 'lose'> }> = []
  /** While true every request is an unreachable node. */
  unreachable = false
  /** Fail `GET /api/notifications/:id` (the row read after an action). */
  failGet = false
  private recorded = new Map<string, { notificationId: string; action: string; status: 'done' | 'failed' }>()
  private holds: Array<{ match: RegExp; gate: Promise<void> }> = []

  constructor(rows: NotificationWire[] = [], availability: Record<Action, Availability> = shippedAvailability()) {
    this.rows = rows
    this.availability = availability
  }

  failNext(match: RegExp, failure: Failure): void {
    this.failures.push({ match, failure })
  }

  /** Fail every matching request until the returned function is called. */
  failWhile(match: RegExp, failure: Exclude<Failure, 'lose'>): () => void {
    const entry = { match, failure }
    this.persistent.push(entry)
    return () => { this.persistent = this.persistent.filter((item) => item !== entry) }
  }

  /** Make matching requests wait for `release()`. */
  hold(match: RegExp): () => void {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.holds.push({ match, gate })
    return release
  }

  count(match: RegExp): number {
    return this.requests.filter((record) => match.test(`${record.method} ${record.path}`)).length
  }

  row(id: string): NotificationWire {
    const found = this.rows.find((row) => row.id === id)
    if (!found) throw new Error(`fixture has no row ${id}`)
    return found
  }

  private touch(row: NotificationWire, patch: Partial<NotificationWire>): NotificationWire {
    this.clock += 1
    Object.assign(row, patch, { updatedAt: this.clock })
    return row
  }

  private expire(): void {
    for (const row of this.rows) {
      if (row.state === 'snoozed' && row.snoozedUntil !== null && row.snoozedUntil <= this.clock) {
        this.touch(row, { state: 'unread', snoozedUntil: null })
      }
    }
  }

  /** Always resolves to a reply, or rejects with a TypeError for an unreachable node. */
  async handle(method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: unknown): Promise<Reply> {
    const idempotencyKey = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1] ?? null
    this.requests.push({ method, path, query, idempotencyKey, body })
    if (this.unreachable) throw new TypeError('Failed to fetch')
    const label = `${method} ${path}`
    for (const hold of this.holds.filter((item) => item.match.test(label))) await hold.gate
    const always = this.persistent.find((item) => item.match.test(label))
    if (always) {
      if (always.failure === 'network') throw new TypeError('Failed to fetch')
      return always.failure
    }
    const forced = this.failures.findIndex((item) => item.match.test(label))
    let lose = false
    if (forced >= 0) {
      const { failure } = this.failures.splice(forced, 1)[0]!
      if (failure === 'network') throw new TypeError('Failed to fetch')
      if (failure === 'lose') lose = true
      else return failure
    }
    const reply = this.route(method, path, query, idempotencyKey, body)
    if (lose) throw new TypeError('Failed to fetch')
    return reply
  }

  private route(method: string, path: string, query: Record<string, string>, key: string | null, body: unknown): Reply {
    const error = (status: number, code: string): Reply => ({ status, body: { code } })
    if (method === 'GET' && path === '/api/notifications') return this.list(query)
    if (method === 'GET' && path === '/api/notifications/actions') {
      return { status: 200, body: { actions: (Object.keys(this.availability) as Action[]).map((action) => ({ action, availability: this.availability[action] })) } }
    }
    const match = /^\/api\/notifications\/(ntf_[0-9a-f]{40})(?:\/(read|snooze|actions))?$/u.exec(path)
    if (!match) return error(404, 'notification_not_found')
    this.expire()
    const row = this.rows.find((item) => item.id === match[1])
    if (!row) return error(404, 'notification_not_found')
    const verb = match[2]
    if (method === 'GET' && verb === undefined) return { status: 200, body: row }
    if (method !== 'POST') return error(404, 'notification_not_found')
    if (verb === 'read') {
      if (row.state === 'acted') return error(409, 'notification_acted')
      return { status: 200, body: this.touch(row, { state: row.state === 'unread' ? 'read' : row.state === 'snoozed' ? 'read' : row.state, snoozedUntil: null }) }
    }
    if (verb === 'snooze') {
      const untilMs = (body as { untilMs?: unknown } | null)?.untilMs
      if (typeof untilMs !== 'number') return error(400, 'validation_failed')
      if (row.state === 'acted') return error(409, 'notification_acted')
      if (untilMs <= this.clock) return error(422, 'invalid_snooze_time')
      return { status: 200, body: this.touch(row, { state: 'snoozed', snoozedUntil: untilMs }) }
    }
    return this.act(row, key, body)
  }

  private act(row: NotificationWire, key: string | null, body: unknown): Reply {
    const error = (status: number, code: string): Reply => ({ status, body: { code } })
    if (key === null) return error(400, 'idempotency_key_required')
    const action = (body as { action?: Action } | null)?.action
    if (action === undefined) return error(400, 'validation_failed')
    const known = this.recorded.get(key)
    if (known) {
      if (known.notificationId !== row.id || known.action !== action) return error(409, 'idempotency_conflict')
      return { status: 200, body: { notificationId: row.id, action, status: known.status, result: null, duplicate: true } }
    }
    if (!row.actions.includes(action)) return error(409, 'action_not_offered')
    if (row.state === 'acted') return error(409, 'notification_acted')
    if (this.availability[action] !== 'available') return error(501, 'not_configured')
    this.recorded.set(key, { notificationId: row.id, action, status: 'done' })
    this.effects[action] = (this.effects[action] ?? 0) + 1
    this.touch(row, { state: action === 'open' || action === 'accept_recommendation' ? 'read' : 'acted' })
    return { status: 200, body: { notificationId: row.id, action, status: 'done', result: { acknowledged: true }, duplicate: false } }
  }

  private list(query: Record<string, string>): Reply {
    this.expire()
    const states = query['state'] ? query['state'].split(',') : null
    const limit = Number(query['limit'] ?? 50)
    let rows = this.rows
      .filter((row) => states === null || states.includes(row.state))
      .sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1))
    const before = query['before']
    if (before) {
      const pivot = this.rows.find((row) => row.id === before)
      if (!pivot) return { status: 404, body: { code: 'notification_not_found' } }
      rows = rows.filter((row) => row.createdAt < pivot.createdAt || (row.createdAt === pivot.createdAt && row.id < pivot.id))
    }
    const page = rows.slice(0, limit)
    return { status: 200, body: { notifications: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null } }
  }
}
