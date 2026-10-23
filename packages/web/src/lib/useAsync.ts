/** Мелкие хуки: загрузка данных, отложенное значение, локальное хранилище. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { replaceEqualDeep } from './stable.ts'

export type AsyncState<T> = {
  data: T | null
  error: unknown
  loading: boolean
  /** An explicit reload or a dependency change while data is shown; never set by quiet refreshes. */
  refreshing: boolean
}

export interface AsyncOptions {
  /**
   * Quiet revalidation (D-203): re-read on window focus and when the browser comes back online,
   * and every `intervalMs` while the page is visible. Nothing on screen changes unless the data does.
   */
  revalidate?: { onFocus?: boolean; intervalMs?: number }
  /**
   * Automatic recovery after a failed read: wait `baseMs`, doubling up to `maxMs`, while the page is
   * visible. The last data and the error stay on screen until a read succeeds. `false` disables it.
   */
  retry?: { baseMs: number; maxMs: number } | false
}

export const DEFAULT_ASYNC_RETRY = { baseMs: 2_000, maxMs: 60_000 } as const

/** Delay before retry number `failures` (1-based): base, doubling, capped. */
export function retryDelay(failures: number, retry: { baseMs: number; maxMs: number }): number {
  return Math.min(retry.maxMs, retry.baseMs * 2 ** Math.max(0, Math.min(failures - 1, 30)))
}

/**
 * Загрузка с отменой. `deps` — как у useEffect: меняются, запрос повторяется,
 * предыдущий отменяется через AbortSignal. Ошибки чинятся сами (повтор с паузой),
 * тихие перечитывания не трогают флаги загрузки, а равные данные сохраняют identity.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: AsyncOptions = {},
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  })
  const [nonce, setNonce] = useState(0)
  const hasDataRef = useRef(false)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const retry = options.retry === undefined ? DEFAULT_ASYNC_RETRY : options.retry
  const retryRef = useRef(retry)
  retryRef.current = retry
  const onFocus = options.revalidate?.onFocus ?? false
  const intervalMs = options.revalidate?.intervalMs ?? 0

  useEffect(() => {
    const controller = new AbortController()
    let current: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let stopped = false

    const schedule = () => {
      clearTimeout(timer)
      if (stopped || document.visibilityState === 'hidden') return
      const policy = retryRef.current
      if (failures > 0 && policy) timer = setTimeout(() => run(true), retryDelay(failures, policy))
      else if (failures === 0 && intervalMs > 0) timer = setTimeout(() => run(true), intervalMs)
    }

    const run = (quiet: boolean) => {
      if (stopped) return
      clearTimeout(timer)
      current?.abort()
      const request = new AbortController()
      current = request
      if (!quiet) {
        // An explicit run (mount, dependency change, reload) starts a new question: its old error goes.
        setState((previous) => {
          const loading = !hasDataRef.current, refreshing = hasDataRef.current
          return previous.loading === loading && previous.refreshing === refreshing && previous.error === null
            ? previous : { ...previous, error: null, loading, refreshing }
        })
      }
      loaderRef.current(request.signal).then(
        (data) => {
          if (stopped || request.signal.aborted) return
          hasDataRef.current = true
          failures = 0
          setState((previous) => {
            const stable = previous.data === null ? data : replaceEqualDeep(previous.data, data)
            if (stable === previous.data && previous.error === null && !previous.loading && !previous.refreshing) return previous
            return { data: stable, error: null, loading: false, refreshing: false }
          })
          schedule()
        },
        (error) => {
          if (stopped || request.signal.aborted) return
          failures += 1
          setState((previous) => ({ data: previous.data, error, loading: false, refreshing: false }))
          schedule()
        },
      )
    }

    const wake = () => { if (document.visibilityState !== 'hidden') run(true) }
    const visible = () => {
      if (document.visibilityState === 'hidden') clearTimeout(timer)
      else if (failures > 0 || onFocus) run(true)
      else schedule()
    }
    run(false)
    controller.signal.addEventListener('abort', () => { stopped = true; clearTimeout(timer); current?.abort() })
    // A failed read also recovers as soon as the browser is back online or the window regains focus.
    const recover = () => { if (failures > 0 || onFocus) wake() }
    window.addEventListener('online', recover)
    window.addEventListener('focus', recover)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.abort()
      window.removeEventListener('online', recover)
      window.removeEventListener('focus', recover)
      document.removeEventListener('visibilitychange', visible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, onFocus, intervalMs])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { ...state, reload }
}

/** Значение, отстающее на `delay` — для поля поиска, чтобы не долбить сервер. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}

export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  const update = useCallback(
    (next: T | ((previous: T) => T)) => {
      setValue((previous) => {
        const resolved =
          typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
        try {
          localStorage.setItem(key, JSON.stringify(resolved))
        } catch {
          // Переполнение или приватный режим — значение живёт только в памяти.
        }
        return resolved
      })
    },
    [key],
  )

  return [value, update]
}

/** Актуальное значение внутри долгоживущих колбэков (обработчики SSE). */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/** Таймер обратного отсчёта. Используется в модалке подтверждения. */
export function useCountdown(deadline: number | null): number {
  const [remaining, setRemaining] = useState(() =>
    deadline === null ? 0 : Math.max(0, deadline - Date.now()),
  )

  useEffect(() => {
    if (deadline === null) return
    setRemaining(Math.max(0, deadline - Date.now()))

    const tick = () => setRemaining(Math.max(0, deadline - Date.now()))
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [deadline])

  return remaining
}
