import { LocalApiError, LocalApiShapeError } from '../../src/lib/local-api.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  InboxStore, classifyFailure, outcomeUnknown, unreadSummary, visibleIds, type InboxApi,
} from '../../src/features/notifications/inbox-store.ts'
import { notification, notificationId } from '../fixtures/notifications-server.ts'

type Rows = ReturnType<typeof notification>[]
const page = (notifications: Rows, nextCursor: string | null = null) => ({ notifications, nextCursor })

function fakeApi(overrides: Partial<InboxApi> = {}): InboxApi {
  return {
    list: vi.fn(async () => page([])),
    get: vi.fn(async (id: string) => notification(Number.parseInt(id.slice(4), 16), { state: 'read' })),
    markRead: vi.fn(async (id: string) => notification(Number.parseInt(id.slice(4), 16), { state: 'read', updatedAt: Date.now() * 2 })),
    snooze: vi.fn(),
    actions: vi.fn(async () => ({ actions: [] })),
    execute: vi.fn(async (id: string, body: { action: string }) => ({ notificationId: id, action: body.action as 'open', status: 'done' as const, result: null, duplicate: false })),
    ...overrides,
  } as InboxApi
}

describe('failure classification', () => {
  it('separates "no answer" from "answered with a code" from "answered in a shape we do not know"', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'), 5)).toEqual({ kind: 'offline', code: 'offline', status: null, at: 5 })
    expect(classifyFailure(new LocalApiError(503, 'notifications_unavailable'), 5)).toEqual({ kind: 'server', code: 'notifications_unavailable', status: 503, at: 5 })
    expect(classifyFailure(new LocalApiShapeError('/x', []), 5).kind).toBe('contract')
    expect(classifyFailure(new Error('boom'), 5).kind).toBe('contract')
  })

  it('keeps the key only when the outcome of the request is unknown', () => {
    const server = (code: string) => classifyFailure(new LocalApiError(500, code as 'internal_error'), 0)
    for (const code of ['internal_error', 'notifications_unavailable', 'action_in_progress', 'action_outcome_unknown', 'unexpected_response']) {
      expect(outcomeUnknown(server(code)), code).toBe(true)
    }
    for (const code of ['not_configured', 'port_failed', 'validation_failed', 'notification_not_found', 'action_not_offered', 'notification_acted', 'idempotency_conflict', 'invalid_snooze_time']) {
      expect(outcomeUnknown(server(code)), code).toBe(false)
    }
    expect(outcomeUnknown(classifyFailure(new TypeError('x'), 0))).toBe(true)
    expect(outcomeUnknown(classifyFailure(new LocalApiShapeError('/x', []), 0))).toBe(true)
  })
})

describe('inbox store', () => {
  it('derives the unread summary from the rows it holds', async () => {
    const api = fakeApi({ list: vi.fn(async () => page([notification(2), notification(1)], notificationId(1))) })
    const store = new InboxStore(api)
    expect(unreadSummary(store.getSnapshot())).toMatchObject({ loaded: false, count: 0, failure: null })
    await store.refresh()
    expect(unreadSummary(store.getSnapshot())).toMatchObject({ loaded: true, count: 2, atLeast: true })
    expect(visibleIds(store.getSnapshot(), 'unread')).toEqual([notificationId(2), notificationId(1)])
  })

  it('does not count arrivals on the first read or from paging, only from a later head read', async () => {
    let rows: Rows = [notification(1), notification(2)]
    const api = fakeApi({ list: vi.fn(async (params) => params?.before ? page([notification(0)]) : page([...rows].reverse(), notificationId(1))) })
    const store = new InboxStore(api)
    await store.refresh()
    expect(store.getSnapshot().arrivals).toBe(0)
    await store.loadMore('unread')
    expect(store.getSnapshot().arrivals).toBe(0)
    rows = [...rows, notification(3)]
    await store.refresh()
    expect(store.getSnapshot().arrivals).toBe(1)
    await store.refresh()
    expect(store.getSnapshot().arrivals).toBe(1)
  })

  it('a row the user read stays read when an older answer still lists it as unread', async () => {
    const stale = notification(1, { updatedAt: 10 })
    let answer = page([stale])
    const api = fakeApi({
      list: vi.fn(async () => answer),
      markRead: vi.fn(async () => notification(1, { state: 'read', updatedAt: 20 })),
    })
    const store = new InboxStore(api)
    await store.refresh()
    answer = page([])
    await store.markRead(notificationId(1))
    answer = page([stale])
    await store.refresh()
    expect(store.getSnapshot().rows[notificationId(1)]?.state).toBe('read')
    expect(unreadSummary(store.getSnapshot()).count).toBe(0)
  })

  it('one coalesced read per list while it is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const list = vi.fn(async () => { await gate; return page([notification(1)]) })
    const store = new InboxStore(fakeApi({ list }))
    const reads = [store.refresh(), store.refresh(), store.refresh()]
    release()
    await Promise.all(reads)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('refuses a second action on a row that is still working', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const execute = vi.fn(async (id: string) => { await gate; return { notificationId: id, action: 'open' as const, status: 'done' as const, result: null, duplicate: false } })
    const store = new InboxStore(fakeApi({ execute: execute as unknown as InboxApi['execute'] }), { newKey: () => 'key-000001' })
    const first = store.execute(notificationId(1), { action: 'open', args: {} })
    const second = await store.execute(notificationId(1), { action: 'open', args: {} })
    expect(second).toEqual({ ok: false, busy: true, failure: null })
    release()
    expect(await first).toMatchObject({ ok: true })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('maps the same intent to the same key regardless of argument order, and different arguments to different keys', async () => {
    const keys: string[] = []
    const execute = vi.fn(async (id: string, _body: unknown, key: string) => {
      keys.push(key)
      throw new TypeError('Failed to fetch')
      return { notificationId: id, action: 'open' as const, status: 'done' as const, result: null, duplicate: false }
    })
    let n = 0
    const store = new InboxStore(fakeApi({ execute: execute as unknown as InboxApi['execute'] }), { newKey: () => `key-${String(++n).padStart(6, '0')}` })
    const id = notificationId(1)
    await store.execute(id, { action: 'pause_runs', args: { runIds: ['a'], connectionId: 'c' } })
    store.dismissOp(id)
    await store.execute(id, { action: 'pause_runs', args: { connectionId: 'c', runIds: ['a'] } })
    store.dismissOp(id)
    await store.execute(id, { action: 'pause_runs', args: { connectionId: 'other' } })
    expect(keys).toEqual(['key-000001', 'key-000001', 'key-000002'])
  })

  it('dispose aborts reads and clears the loading flags so a remount can read again', async () => {
    const list = vi.fn((_params: unknown, signal?: AbortSignal) => new Promise<ReturnType<typeof page>>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
    void store.refresh()
    expect(store.getSnapshot().lists.unread.loading).toBe(true)
    store.dispose()
    expect(store.getSnapshot().lists.unread.loading).toBe(false)
    expect(store.getSnapshot().lists.unread.failure).toBeNull()
  })
})
