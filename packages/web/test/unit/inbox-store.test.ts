import { LocalApiError, LocalApiShapeError } from '../../src/lib/local-api.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  InboxStore, READ_TIMEOUT_MS, classifyFailure, outcomeUnknown, unreadSummary, visibleIds, type InboxApi,
} from '../../src/features/notifications/inbox-store.ts'
import { T0, notification, notificationId } from '../fixtures/notifications-server.ts'

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
      void id
      throw new TypeError('Failed to fetch')
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

  it('re-reads a list the user returns to, instead of showing it as it was', async () => {
    let snoozed: Rows = []
    const list = vi.fn(async (params?: { states?: readonly string[] }) => params?.states?.[0] === 'snoozed' ? page(snoozed) : page([]))
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
    await store.activate('snoozed')
    expect(visibleIds(store.getSnapshot(), 'snoozed')).toEqual([])
    await store.activate('unread')
    snoozed = [notification(1, { state: 'snoozed', snoozedUntil: 5 })]
    await store.activate('snoozed')
    expect(visibleIds(store.getSnapshot(), 'snoozed')).toEqual([notificationId(1)])
  })

  it('reads the active list again when a change lands while a read of it is in flight', async () => {
    let server: Rows = [notification(1, { state: 'read' })]
    let release!: () => void
    let first = true
    const list = vi.fn(async (params?: { states?: readonly string[] }) => {
      const snapshot = params?.states?.[0] === 'read' ? server.filter((row) => row.state === 'read') : []
      if (first && params?.states?.[0] === 'read') { first = false; await new Promise<void>((resolve) => { release = resolve }) }
      return page(snapshot)
    })
    const markRead = vi.fn(async () => { server = [notification(2, { state: 'read', updatedAt: 99 }), ...server]; return notification(2, { state: 'read', updatedAt: 99 }) })
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'], markRead }))
    void store.activate('read')
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    await store.markRead(notificationId(2))
    release()
    await vi.waitFor(() => expect(visibleIds(store.getSnapshot(), 'read')).toEqual([notificationId(2), notificationId(1)]))
  })

  it('keeps the shown failure while a retry is in flight and clears it only when a read succeeds', async () => {
    let fail = true
    let release!: () => void
    const list = vi.fn(async () => {
      if (fail) throw new TypeError('Failed to fetch')
      await new Promise<void>((resolve) => { release = resolve })
      return page([notification(1)])
    })
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
    await store.refresh()
    expect(store.getSnapshot().lists.unread.failure?.kind).toBe('offline')
    fail = false
    const retry = store.refresh()
    expect(store.getSnapshot().lists.unread.loading).toBe(true)
    expect(store.getSnapshot().lists.unread.failure?.kind).toBe('offline')
    release()
    await retry
    expect(store.getSnapshot().lists.unread.failure).toBeNull()
  })

  it('reports a read that never answers as an unreachable node instead of waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const list = vi.fn((_params: unknown, signal?: AbortSignal) => new Promise<ReturnType<typeof page>>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
      const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
      const read = store.refresh()
      await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1)
      await read
      expect(store.getSnapshot().lists.unread).toMatchObject({ loading: false, failure: { kind: 'offline', code: 'offline' } })
      // A later poll is a new read, not the stuck one.
      await vi.advanceTimersByTimeAsync(1)
      void store.refresh()
      expect(list).toHaveBeenCalledTimes(2)
      store.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Mark read on a row the node reports as acted is a failure, not "read"', async () => {
    const api = fakeApi({ list: vi.fn(async () => page([notification(1)])), markRead: vi.fn(async () => notification(1, { state: 'acted', updatedAt: 50 })) })
    const store = new InboxStore(api)
    await store.refresh()
    const result = await store.markRead(notificationId(1))
    expect(result).toMatchObject({ ok: false, failure: { code: 'notification_acted' } })
    expect(store.getSnapshot().ops[notificationId(1)]).toMatchObject({ status: 'failed' })
  })

  it('a refusal that says the row changed re-reads the row and the lists', async () => {
    const get = vi.fn(async () => notification(1, { state: 'acted', updatedAt: T0 + 999_999_999 }))
    const list = vi.fn(async () => page([notification(1)]))
    const execute = vi.fn(async () => { throw new LocalApiError(409, 'notification_acted') })
    const store = new InboxStore(fakeApi({ get, list: list as unknown as InboxApi['list'], execute: execute as unknown as InboxApi['execute'] }), { newKey: () => 'key-000001' })
    await store.refresh()
    const before = list.mock.calls.length
    await store.execute(notificationId(1), { action: 'pause_runs', args: {} })
    await vi.waitFor(() => expect(store.getSnapshot().rows[notificationId(1)]?.state).toBe('acted'))
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
    expect(unreadSummary(store.getSnapshot()).count).toBe(0)
  })

  it('drops an older page when a newer head read moved the cursor meanwhile', async () => {
    let release!: () => void
    let step = 0
    const list = vi.fn(async (params?: { before?: string }) => {
      step++
      if (params?.before) { await new Promise<void>((resolve) => { release = resolve }); return page([notification(1)], null) }
      return step === 1 ? page([notification(5), notification(4)], notificationId(4)) : page([notification(6), notification(5), notification(4)], null)
    })
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
    await store.refresh()
    const more = store.loadMore('unread')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await store.refresh()
    release()
    await more
    expect(store.getSnapshot().lists.unread.nextCursor).toBeNull()
    expect(visibleIds(store.getSnapshot(), 'unread')).not.toContain(notificationId(1))
  })

  it('counts a row as an arrival only when it is newer than anything held, or came back from snooze', async () => {
    let head: Rows = [notification(10), notification(9)]
    const list = vi.fn(async () => page(head, notificationId(9)))
    const store = new InboxStore(fakeApi({ list: list as unknown as InboxApi['list'] }))
    await store.refresh()
    head = [notification(10), notification(9), notification(2)] // an older row slides into the page
    await store.refresh()
    expect(store.getSnapshot().arrivals).toBe(0)
    head = [notification(11), notification(10), notification(9)]
    await store.refresh()
    expect(store.getSnapshot().arrivals).toBe(1)
  })

  it('a client-side validation error says nothing was sent and keeps no key', async () => {
    const zod = Object.assign(new Error('bad'), { name: 'ZodError' })
    const execute = vi.fn(async () => { throw zod })
    const store = new InboxStore(fakeApi({ execute: execute as unknown as InboxApi['execute'] }), { newKey: () => 'key-000001' })
    const result = await store.execute(notificationId(1), { action: 'open', args: {} })
    expect(result).toMatchObject({ ok: false, failure: { code: 'validation_failed' } })
    expect(store.getSnapshot().ops[notificationId(1)]).toMatchObject({ keepsKey: false })
  })

  it('a key generator that throws leaves the row actionable, not pending forever', async () => {
    const store = new InboxStore(fakeApi(), { newKey: () => { throw new Error('no entropy') } })
    const result = await store.execute(notificationId(1), { action: 'open', args: {} })
    expect(result.ok).toBe(false)
    expect(store.getSnapshot().ops[notificationId(1)]?.status).toBe('failed')
  })
})
