import type { RuntimeSnapshot } from '@alamo/contract'
import { useCallback, useEffect, useRef, useState } from 'react'

export const RUNTIME_ACTIVE_POLL_INTERVAL_MS = 2_000
export const RUNTIME_IDLE_POLL_INTERVAL_MS = 10_000

export interface RuntimePollingState {
  data: RuntimeSnapshot | null
  error: unknown
  loading: boolean
  refreshing: boolean
  retry: () => void
}

/**
 * Owns only the Runtime Bar's sampled HTTP subscription. Durable work and
 * resource ownership remain on the server when this hook unmounts.
 */
export function useRuntimePolling(
  loader: (signal: AbortSignal) => Promise<RuntimeSnapshot>,
): RuntimePollingState {
  const [state, setState] = useState<Omit<RuntimePollingState, 'retry'>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  })
  const loaderRef = useRef(loader)
  const dataRef = useRef<RuntimeSnapshot | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const runRef = useRef<() => void>(() => undefined)

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
        () => runRef.current(),
        active ? RUNTIME_ACTIVE_POLL_INTERVAL_MS : RUNTIME_IDLE_POLL_INTERVAL_MS,
      )
    }

    runRef.current = () => {
      clearTimer()
      if (!mounted || requestRef.current) return

      const controller = new AbortController()
      requestRef.current = controller
      const hasConfirmedSample = dataRef.current !== null
      setState((previous) => ({
        ...previous,
        error: null,
        loading: !hasConfirmedSample,
        refreshing: hasConfirmedSample,
      }))

      void loaderRef.current(controller.signal).then(
        (data) => {
          if (!mounted || controller.signal.aborted) return
          dataRef.current = data
          setState({ data, error: null, loading: false, refreshing: false })
        },
        (error: unknown) => {
          if (!mounted || controller.signal.aborted) return
          setState((previous) => ({
            data: previous.data,
            error,
            loading: false,
            refreshing: false,
          }))
        },
      ).finally(() => {
        if (requestRef.current === controller) requestRef.current = null
        schedule()
      })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer()
        return
      }
      runRef.current()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    runRef.current()

    return () => {
      mounted = false
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      requestRef.current?.abort()
      requestRef.current = null
      runRef.current = () => undefined
    }
  }, [])

  const retry = useCallback(() => runRef.current(), [])
  return { ...state, retry }
}
