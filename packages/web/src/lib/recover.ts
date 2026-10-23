import { useEffect, useRef } from 'react'
import { DEFAULT_ASYNC_RETRY, retryDelay } from './useAsync.ts'

/**
 * Automatic recovery for a failed read that is not driven by useAsync (D-203). While `failure`
 * is set (any truthy value, typically the error), `retry` runs after a growing pause (2 s
 * doubling to 60 s) while the page is visible, keeps trying until the failure clears, and runs
 * at once when the window regains focus or the browser comes back online. Callers keep their
 * error text; there is no Retry button.
 */
export function useAutoRecover(failure: unknown, retry: () => void, policy: { baseMs: number; maxMs: number } = DEFAULT_ASYNC_RETRY): void {
  const retryRef = useRef(retry)
  retryRef.current = retry
  const policyRef = useRef(policy)
  policyRef.current = policy
  const failures = useRef(0)
  const failed = Boolean(failure)
  useEffect(() => {
    if (!failed) { failures.current = 0; return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (document.visibilityState === 'hidden') return
      failures.current += 1
      timer = setTimeout(run, retryDelay(failures.current, policyRef.current))
    }
    const run = () => { clearTimeout(timer); retryRef.current(); schedule() }
    const visible = () => { if (document.visibilityState === 'hidden') clearTimeout(timer); else run() }
    schedule()
    window.addEventListener('online', run)
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('online', run)
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [failed])
}
