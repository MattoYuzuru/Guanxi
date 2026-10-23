import type { RuntimeSnapshot } from '@guanxi/contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import { replaceEqualDeep } from '../../lib/stable.ts'

export const RUNTIME_ACTIVE_POLL_INTERVAL_MS = 2_000
export const RUNTIME_IDLE_POLL_INTERVAL_MS = 10_000

export interface RuntimePollingState {
  data: RuntimeSnapshot | null
  error: unknown
  loading: boolean
  refreshing: boolean
  retry: () => void
  refresh: (signal?: AbortSignal, requireNewSample?: boolean) => Promise<RuntimeSnapshot>
}

/**
 * Owns only the Runtime Bar's sampled HTTP subscription. Durable work and
 * resource ownership remain on the server when this hook unmounts.
 */
export function useRuntimePolling(
  loader: (signal: AbortSignal) => Promise<RuntimeSnapshot>,
): RuntimePollingState {
  const [state, setState] = useState<Omit<RuntimePollingState, 'retry' | 'refresh'>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  })
  const loaderRef = useRef(loader)
  const dataRef = useRef<RuntimeSnapshot | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const pendingRef = useRef<Promise<RuntimeSnapshot> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runRef = useRef<() => Promise<RuntimeSnapshot>>(() =>
    Promise.reject(new DOMException('Runtime polling is not mounted', 'AbortError')),
  )

  loaderRef.current = loader

  useEffect(() => {
    let mounted = true

    const clearTimer = () => {
      if (timerRef.current === null) return
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const schedule = () => {
      clearTimer()
      if (!mounted || document.visibilityState === 'hidden') return
      const snapshot = dataRef.current
      const active = Boolean(
        snapshot?.governor.activeLease || snapshot?.governor.queued.length,
      )
      timerRef.current = setTimeout(
        () => void runRef.current().catch(() => undefined),
        active ? RUNTIME_ACTIVE_POLL_INTERVAL_MS : RUNTIME_IDLE_POLL_INTERVAL_MS,
      )
    }

    runRef.current = () => {
      clearTimer()
      if (!mounted) {
        return Promise.reject(
          new DOMException('Runtime polling is not mounted', 'AbortError'),
        )
      }
      if (pendingRef.current) return pendingRef.current

      const controller = new AbortController()
      requestRef.current = controller
      // Quiet sampling (D-203): once a sample is on screen, a new read changes nothing visible
      // until it lands; the last error stays until a sample replaces it, so nothing flickers.
      if (dataRef.current === null) {
        setState((previous) => (previous.loading ? previous : { ...previous, loading: true }))
      }

      const pending = loaderRef.current(controller.signal).then(
        (data) => {
          if (!mounted || controller.signal.aborted) {
            throw new DOMException('Runtime refresh was aborted', 'AbortError')
          }
          const stable = dataRef.current === null ? data : replaceEqualDeep(dataRef.current, data)
          dataRef.current = stable
          setState((previous) =>
            previous.data === stable && previous.error === null && !previous.loading && !previous.refreshing
              ? previous
              : { data: stable, error: null, loading: false, refreshing: false })
          return stable
        },
        (error: unknown) => {
          if (!mounted || controller.signal.aborted) throw error
          setState((previous) => ({
            data: previous.data,
            error,
            loading: false,
            refreshing: false,
          }))
          throw error
        },
      ).finally(() => {
        if (requestRef.current === controller) requestRef.current = null
        if (pendingRef.current === pending) pendingRef.current = null
        schedule()
      })
      pendingRef.current = pending
      // Timers and the Runtime Bar Retry intentionally do not await failures.
      // Attaching a handler here prevents an unhandled rejection while callers
      // still receive the original rejected Promise from `refresh`.
      void pending.catch(() => undefined)
      return pending
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer()
        return
      }
      void runRef.current().catch(() => undefined)
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    void runRef.current().catch(() => undefined)

    return () => {
      mounted = false
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      requestRef.current?.abort()
      requestRef.current = null
      pendingRef.current = null
      runRef.current = () =>
        Promise.reject(new DOMException('Runtime polling is not mounted', 'AbortError'))
    }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal, requireNewSample = false) => {
    const sharedPending = pendingRef.current
    if (requireNewSample && sharedPending) {
      try {
        if (signal) await waitForCaller(sharedPending, signal)
        else await sharedPending
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        // A failed older sample must not prevent this explicit fresh query.
      }
    }

    const pending = runRef.current()
    return signal ? waitForCaller(pending, signal) : pending
  }, [])
  const retry = useCallback(() => {
    void refresh().catch(() => undefined)
  }, [refresh])
  return { ...state, retry, refresh }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError'),
  )
}

function waitForCaller(
  pending: Promise<RuntimeSnapshot>,
  signal: AbortSignal,
): Promise<RuntimeSnapshot> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Runtime refresh wait was aborted', 'AbortError'))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Runtime refresh wait was aborted', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (snapshot) => {
        cleanup()
        resolve(snapshot)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}
