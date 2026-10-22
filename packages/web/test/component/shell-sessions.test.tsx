import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPageItem, SessionPageResponse } from '@guanxi/contract'
import { inspectorApi } from '../../src/features/inspector/api.ts'
import { useShellSessions } from '../../src/features/shell/useShellSessions.ts'

function session(index: number): SessionPageItem {
  return { sessionId: `shell-${index}`, kind: 'agent', threadId: null, title: `Session ${index}`,
    createdAt: '2026-10-22T10:00:00.000Z', lastSeq: 1, lastEventAt: null, execution: null,
    navigation: { kind: 'inspector', sessionId: `shell-${index}` } }
}
function page(sessions: SessionPageItem[], nextCursor: string | null = null): SessionPageResponse {
  return { sessions, nextCursor, omitted: { withheld: false, catchingUp: false } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('shell paged sessions', () => {
  it('can load beyond 200, preserves exact order and deduplicates overlapping page boundaries', async () => {
    const list = Array.from({ length: 211 }, (_, index) => session(index))
    const request = vi.spyOn(inspectorApi, 'page').mockImplementation(async cursor => {
      const start = cursor ? Number(cursor.slice(1)) : 0
      const end = Math.min(start + 50, list.length)
      return page(list.slice(Math.max(0, start - (start ? 1 : 0)), end), end < list.length ? `p${end}` : null)
    })
    const { result } = renderHook(() => useShellSessions('/agent'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(request).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 4; index++) await act(() => result.current.loadMore())
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(list.map(value => value.sessionId))
    expect(result.current.hasMore).toBe(false)
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p50', 'p100', 'p150', 'p200'])
  })

  it('rejects late responses after navigation and aborts the current request on unmount', async () => {
    const old = deferred<SessionPageResponse>(), fresh = deferred<SessionPageResponse>()
    const request = vi.spyOn(inspectorApi, 'page').mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const { result, rerender, unmount } = renderHook(({ location }) => useShellSessions(location), { initialProps: { location: '/agent/old' } })
    rerender({ location: '/agent/new' })
    expect(request.mock.calls[0]?.[1]?.aborted).toBe(true)
    await act(async () => { fresh.resolve(page([session(2)])) })
    await act(async () => { old.resolve(page([session(1)])) })
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-2'])
    expect(result.current.loading).toBe(false)
    const signal = request.mock.calls[1]?.[1]
    unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('retains loaded rows and cursor after a failed next page, exposes omissions and permits retry', async () => {
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce({ ...page([session(1)], 'p1'), omitted: { withheld: true, catchingUp: false } })
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([session(2)]))
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.loadMore())
    expect(result.current.error).toBe(true)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.sessions).toHaveLength(1)
    await act(() => result.current.loadMore())
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p1', 'p1'])
    expect(result.current.error).toBe(false)
    expect(result.current.omitted).toBe(true)
    expect(result.current.sessions).toHaveLength(2)
    expect(result.current.observedAt).not.toBeNull()
  })

  it('refuses a nonadvancing cursor and concurrent load-more calls without adding rows', async () => {
    const next = deferred<SessionPageResponse>()
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'p1')).mockReturnValueOnce(next.promise)
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let pending!: Promise<void>
    act(() => { pending = result.current.loadMore(); void result.current.loadMore() })
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { next.resolve(page([session(2)], 'p1')); await pending })
    expect(result.current.error).toBe(true)
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1'])
  })

  it('explicitly scans every remaining page past 200 with exact unique order and preserves omission warnings', async () => {
    const list = Array.from({ length: 237 }, (_, index) => session(index))
    const request = vi.spyOn(inspectorApi, 'page').mockImplementation(async cursor => {
      const start = cursor ? Number(cursor.slice(1)) : 0, end = Math.min(start + 50, list.length)
      return { ...page(list.slice(Math.max(0, start - (start ? 1 : 0)), end), end < list.length ? `p${end}` : null),
        omitted: { withheld: start === 100, catchingUp: false } }
    })
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.sessions).toHaveLength(50)
    expect(request).toHaveBeenCalledTimes(1)
    await act(() => result.current.searchAll())
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(list.map(value => value.sessionId))
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p50', 'p100', 'p150', 'p200'])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.searchingAll).toBe(false)
    expect(result.current.omitted).toBe(true)
  })

  it('cancels scanning without losing its cursor and excludes late responses from a newer retry', async () => {
    const old = deferred<SessionPageResponse>(), fresh = deferred<SessionPageResponse>()
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'p1'))
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let scan!: Promise<void>, retry!: Promise<void>
    act(() => { scan = result.current.searchAll(); void result.current.searchAll(); void result.current.loadMore() })
    expect(result.current.searchingAll).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    act(() => result.current.cancelSearch())
    expect(request.mock.calls[1]?.[1]?.aborted).toBe(true)
    expect(result.current.searchingAll).toBe(false)
    expect(result.current.hasMore).toBe(true)
    act(() => { retry = result.current.searchAll() })
    await act(async () => { old.resolve(page([session(99)])); await scan })
    expect(result.current.searchingAll).toBe(true)
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1'])
    await act(async () => { fresh.resolve(page([session(2)])); await retry })
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1', 'shell-2'])
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p1', 'p1'])
  })

  it('stops at a failed cursor and retries from it without refetching completed pages', async () => {
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'p1'))
      .mockResolvedValueOnce(page([session(2)], 'p2')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([session(3)]))
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.searchAll())
    expect(result.current.error).toBe(true)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1', 'shell-2'])
    await act(() => result.current.searchAll())
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'p1', 'p2', 'p2'])
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1', 'shell-2', 'shell-3'])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.error).toBe(false)
  })

  it('rejects a cursor cycle across multiple pages instead of scanning indefinitely', async () => {
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'p1'))
      .mockResolvedValueOnce(page([session(2)], 'p2')).mockResolvedValueOnce(page([session(3)], 'p1'))
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.searchAll())
    expect(request).toHaveBeenCalledTimes(3)
    expect(result.current.error).toBe(true)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1', 'shell-2'])
  })

  it('aborts an active complete search on route change and unmount, excluding the previous route response', async () => {
    const old = deferred<SessionPageResponse>(), last = deferred<SessionPageResponse>()
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'p1'))
      .mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([session(2)], 'p2')).mockReturnValueOnce(last.promise)
    const { result, rerender, unmount } = renderHook(({ location }) => useShellSessions(location), { initialProps: { location: '/agent/old' } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    let scan!: Promise<void>
    act(() => { scan = result.current.searchAll() })
    rerender({ location: '/agent/new' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(request.mock.calls[1]?.[1]?.aborted).toBe(true)
    await act(async () => { old.resolve(page([session(99)])); await scan })
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-2'])
    act(() => { scan = result.current.searchAll() })
    unmount()
    expect(request.mock.calls[3]?.[1]?.aborted).toBe(true)
    await act(async () => { last.resolve(page([session(100)])); await scan })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('invalidates an old tail after failed first-page refresh and only scans a successfully replaced basis', async () => {
    const request = vi.spyOn(inspectorApi, 'page').mockResolvedValueOnce(page([session(1)], 'old-tail'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([session(2)], 'new-tail'))
      .mockResolvedValueOnce(page([session(3)]))
    const { result } = renderHook(() => useShellSessions('/'))
    await waitFor(() => expect(result.current.paginationReady).toBe(true))
    act(() => { result.current.reload(); void result.current.searchAll(); void result.current.loadMore() })
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.paginationReady).toBe(false)
    expect(result.current.hasMore).toBe(false)
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-1'])
    await act(() => result.current.loadMore())
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, undefined])
    await act(() => result.current.searchAll())
    await waitFor(() => expect(result.current.paginationReady).toBe(true))
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-2'])
    await act(() => result.current.searchAll())
    expect(request.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, undefined, undefined, 'new-tail'])
    expect(result.current.sessions.map(value => value.sessionId)).toEqual(['shell-2', 'shell-3'])
    expect(result.current.error).toBe(false)
    expect(result.current.hasMore).toBe(false)
  })
})
