/**
 * D-203 live data: structural sharing keeps equal reads identical (no re-render), quiet refreshes
 * never toggle loading flags, and a failed read recovers by itself with a growing pause.
 */
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { memo, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { replaceEqualDeep } from '../../src/lib/stable.ts'
import { DEFAULT_ASYNC_RETRY, retryDelay, useAsync } from '../../src/lib/useAsync.ts'
import { APPEARANCE_KEY, applyAppearance, readAppearance } from '../../src/lib/appearance.tsx'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('replaceEqualDeep', () => {
  it('returns the previous object for an equal read and keeps unchanged subtrees', () => {
    const previous = { a: { x: 1 }, list: [{ id: 1 }, { id: 2 }], when: 't1' }
    expect(replaceEqualDeep(previous, structuredClone(previous))).toBe(previous)
    const next = replaceEqualDeep(previous, { a: { x: 1 }, list: [{ id: 1 }, { id: 3 }], when: 't2' })
    expect(next).not.toBe(previous)
    expect(next.a).toBe(previous.a)
    expect(next.list[0]).toBe(previous.list[0])
    expect(next.list[1]).not.toBe(previous.list[1])
    expect(next.when).toBe('t2')
  })
  it('treats added, removed and reordered entries as changes', () => {
    const previous = { list: [1, 2], keep: true } as { list: number[]; keep?: boolean; extra?: number }
    expect(replaceEqualDeep(previous, { list: [1, 2] })).not.toBe(previous)
    expect(replaceEqualDeep(previous, { list: [2, 1], keep: true })).not.toBe(previous)
    expect(replaceEqualDeep(previous, { list: [1, 2], keep: true, extra: 1 })).not.toBe(previous)
  })
})

describe('retryDelay', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 10].map(failures => retryDelay(failures, DEFAULT_ASYNC_RETRY))).toEqual([2_000, 4_000, 8_000, 16_000, 60_000])
  })
})

describe('useAsync', () => {
  it('does not re-render a memoised row when a quiet refresh returns equal data', async () => {
    let renders = 0
    const Row = memo(function Row({ value }: { value: { name: string } }) { renders += 1; return <span>{value.name}</span> })
    function View() {
      const query = useAsync(async () => ({ row: { name: 'stable' } }), [], { revalidate: { onFocus: true } })
      const flags = useRef<string[]>([])
      flags.current.push(`${query.loading}/${query.refreshing}`)
      return <>{query.data && <Row value={query.data.row} />}<output data-testid="flags">{flags.current.join(',')}</output></>
    }
    const view = render(<View />)
    await waitFor(() => expect(renders).toBe(1))
    const flagsBefore = view.getByTestId('flags').textContent
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await Promise.resolve() })
    expect(renders).toBe(1)
    // A quiet refresh never shows loading or refreshing.
    expect(view.getByTestId('flags').textContent!.split(',').slice(flagsBefore!.split(',').length)).not.toContain('false/true')
  })

  it('keeps the last data and error on screen, then recovers by itself after the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let fail = true
    const loader = vi.fn(async () => { if (fail) throw new Error('offline'); return { ok: 1 } })
    const { result } = renderHook(() => useAsync(loader, []))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.loading).toBe(false)
    expect(loader).toHaveBeenCalledTimes(1)
    fail = false
    await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_ASYNC_RETRY.baseMs) })
    expect(loader).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual({ ok: 1 })
  })

  it('retries at once when the browser comes back online', async () => {
    let fail = true
    const loader = vi.fn(async () => { if (fail) throw new Error('offline'); return 'ok' })
    const { result } = renderHook(() => useAsync(loader, []))
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    fail = false
    await act(async () => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(result.current.data).toBe('ok'))
    expect(result.current.error).toBeNull()
  })

  it('can be told not to retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const loader = vi.fn(async () => { throw new Error('no') })
    renderHook(() => useAsync(loader, [], { retry: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(loader).toHaveBeenCalledTimes(1)
  })
})

describe('appearance', () => {
  it('defaults to comfortable density, static graphics and system motion, and survives corrupt storage', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
    localStorage.setItem(APPEARANCE_KEY, '{nope')
    expect(readAppearance()).toEqual({ density: 'comfortable', graphics: 'static', motion: 'system' })
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ density: 'compact', graphics: 'max', motion: 'reduced' }))
    expect(readAppearance()).toEqual({ density: 'compact', graphics: 'max', motion: 'reduced' })
    localStorage.removeItem(APPEARANCE_KEY)
    expect(readAppearance().graphics).toBe('static')
    vi.unstubAllGlobals()
  })
  it('writes the root attributes and removes data-motion for system', () => {
    const root = document.createElement('div')
    applyAppearance({ density: 'compact', graphics: 'max', motion: 'full' }, root)
    expect([root.dataset.density, root.dataset.graphics, root.dataset.motion]).toEqual(['compact', 'max', 'full'])
    applyAppearance({ density: 'comfortable', graphics: 'static', motion: 'system' }, root)
    expect(root.dataset.motion).toBeUndefined()
    expect(root.dataset.graphics).toBe('static')
  })
})
