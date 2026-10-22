import { useEffect, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { inspectorApi } from '../inspector/api.ts'

/** One protocol page at a time; there is no client ceiling on the session list. */
export function useShellSessions(location: string) {
  const [sessions, setSessions] = useState<SessionPageItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [omitted, setOmitted] = useState(false)
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false), [observedAt, setObservedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const epoch = useRef(0), pending = useRef<AbortController | null>(null), busy = useRef(false)
  useEffect(() => {
    const current = ++epoch.current, abort = new AbortController()
    pending.current?.abort(); pending.current = abort; busy.current = true
    setLoading(true); setLoadingMore(false); setError(false)
    void inspectorApi.page(undefined, abort.signal).then(page => {
      if (current !== epoch.current || abort.signal.aborted) return
      setSessions(page.sessions); setCursor(page.nextCursor)
      setOmitted(page.omitted.withheld || page.omitted.catchingUp)
      setObservedAt(new Date().toISOString())
    }).catch(() => { if (current === epoch.current && !abort.signal.aborted) setError(true) })
      .finally(() => { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; setLoading(false) } })
    return () => { abort.abort(); pending.current?.abort(); epoch.current++; busy.current = false }
  }, [location, revision])
  async function loadMore() {
    if (!cursor || busy.current) return
    const current = epoch.current, abort = new AbortController(), requested = cursor
    pending.current = abort; busy.current = true; setLoadingMore(true); setError(false)
    try {
      const page = await inspectorApi.page(requested, abort.signal)
      if (current !== epoch.current || abort.signal.aborted) return
      if (page.nextCursor === requested) throw new Error('session_page_not_advanced')
      setSessions(previous => [...new Map([...previous, ...page.sessions].map(session => [session.sessionId, session])).values()])
      setCursor(page.nextCursor); setOmitted(previous => previous || page.omitted.withheld || page.omitted.catchingUp)
      setObservedAt(new Date().toISOString())
    } catch { if (current === epoch.current && !abort.signal.aborted) setError(true) }
    finally { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; setLoadingMore(false) } }
  }
  return { sessions, loading, loadingMore, error, omitted, observedAt, hasMore: Boolean(cursor),
    loadMore, reload: () => setRevision(value => value + 1) }
}
