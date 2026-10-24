import { act, fireEvent, render, screen } from '@testing-library/react'
import type { RuntimeSnapshot } from '@guanxi/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_ACTIVE_POLL_INTERVAL_MS,
  RUNTIME_IDLE_POLL_INTERVAL_MS,
  useRuntimePolling,
} from '../../src/features/health/useRuntimePolling.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'
import { QUIET_FAILURES_BEFORE_ERROR } from '../../src/lib/useAsync.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function PollHarness({
  loader,
}: {
  loader: (signal: AbortSignal) => Promise<RuntimeSnapshot>
}) {
  const runtime = useRuntimePolling(loader)
  return (
    <div>
      <button type="button" onClick={runtime.retry}>Retry fixture</button>
      <span data-testid="state">
        {runtime.loading
          ? 'loading'
          : runtime.refreshing
            ? 'refreshing'
            : runtime.error
              ? 'error'
              : runtime.data?.governor.activeLease
                ? 'active'
                : 'idle'}
      </span>
      <span data-testid="sample">{runtime.data?.observedAt ?? 'none'}</span>
    </div>
  )
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Runtime Bar adaptive polling', () => {
  it('starts once, uses the active interval, and never overlaps requests', async () => {
    const first = deferred<RuntimeSnapshot>()
    const second = deferred<RuntimeSnapshot>()
    const loader = vi
      .fn<(signal: AbortSignal) => Promise<RuntimeSnapshot>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    render(<PollHarness loader={loader} />)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('state').textContent).toBe('loading')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_ACTIVE_POLL_INTERVAL_MS * 3)
    })
    expect(loader).toHaveBeenCalledTimes(1)

    await act(async () => first.resolve(runtimeSnapshotFixture()))
    expect(screen.getByTestId('state').textContent).toBe('active')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_ACTIVE_POLL_INTERVAL_MS - 1)
    })
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(loader).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_ACTIVE_POLL_INTERVAL_MS * 2)
    })
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve(runtimeSnapshotFixture()))
  })

  it('uses the idle interval, pauses hidden polling, and refreshes immediately when visible', async () => {
    const idle = runtimeSnapshotFixture((snapshot) => {
      snapshot.governor.activeLease = null
      snapshot.governor.queued = []
    })
    const loader = vi.fn(async () => idle)
    render(<PollHarness loader={loader} />)
    await act(async () => Promise.resolve())
    expect(loader).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS - 1)
    })
    expect(loader).toHaveBeenCalledTimes(1)

    act(() => setVisibility('hidden'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS * 2)
    })
    expect(loader).toHaveBeenCalledTimes(1)

    act(() => setVisibility('visible'))
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => Promise.resolve())
  })

  it('a quiet poll failure while a sample is shown is not stale until three consecutive failures (P3)', async () => {
    let fail = false
    const idle = () => runtimeSnapshotFixture((snapshot) => { snapshot.governor.activeLease = null; snapshot.governor.queued = [] })
    const loader = vi.fn(async () => { if (fail) throw new Error('blip'); return idle() })
    render(<PollHarness loader={loader} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('state').textContent).toBe('idle')
    fail = true
    for (let failure = 1; failure < QUIET_FAILURES_BEFORE_ERROR; failure++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS) })
      expect(loader).toHaveBeenCalledTimes(1 + failure)
      expect(screen.getByTestId('state').textContent).toBe('idle')
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS) })
    expect(screen.getByTestId('state').textContent).toBe('error')
    expect(screen.getByTestId('sample').textContent).not.toBe('none')
    // A success clears the count: one more blip is quiet again.
    fail = false
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS) })
    expect(screen.getByTestId('state').textContent).toBe('idle')
    fail = true
    await act(async () => { await vi.advanceTimersByTimeAsync(RUNTIME_IDLE_POLL_INTERVAL_MS) })
    expect(screen.getByTestId('state').textContent).toBe('idle')
  })

  it('bounds manual retry, preserves a confirmed sample on failure, and cleans up its own wait', async () => {
    const first = deferred<RuntimeSnapshot>()
    const second = deferred<RuntimeSnapshot>()
    const signals: AbortSignal[] = []
    const loader = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : second.promise
    })
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const view = render(<PollHarness loader={loader} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry fixture' }))
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve(runtimeSnapshotFixture()))
    expect(screen.getByTestId('sample').textContent).not.toBe('none')

    fireEvent.click(screen.getByRole('button', { name: 'Retry fixture' }))
    expect(loader).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Retry fixture' }))
    expect(loader).toHaveBeenCalledTimes(2)
    await act(async () => second.reject(new Error('fixture refresh failed')))
    expect(screen.getByTestId('state').textContent).toBe('error')
    expect(screen.getByTestId('sample').textContent).not.toBe('none')

    const pending = deferred<RuntimeSnapshot>()
    loader.mockImplementationOnce((signal) => {
      signals.push(signal)
      return pending.promise
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry fixture' }))
    expect(loader).toHaveBeenCalledTimes(3)
    view.unmount()

    expect(signals.at(-1)?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(addListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})
