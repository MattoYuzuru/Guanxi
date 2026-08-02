/** Мелкие хуки: загрузка данных, отложенное значение, локальное хранилище. */
import { useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> = {
  data: T | null
  error: unknown
  loading: boolean
  /** Перезагрузка при уже показанных данных — чтобы не мигать скелетоном. */
  refreshing: boolean
}

/**
 * Загрузка с отменой. `deps` — как у useEffect: меняются, запрос повторяется,
 * предыдущий отменяется через AbortSignal.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: true,
    refreshing: false,
  })
  const [nonce, setNonce] = useState(0)
  const hasDataRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()

    setState((previous) => ({
      ...previous,
      loading: !hasDataRef.current,
      refreshing: hasDataRef.current,
      error: null,
    }))

    loader(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return
        hasDataRef.current = true
        setState({ data, error: null, loading: false, refreshing: false })
      },
      (error) => {
        if (controller.signal.aborted) return
        setState((previous) => ({
          data: previous.data,
          error,
          loading: false,
          refreshing: false,
        }))
      },
    )

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

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
