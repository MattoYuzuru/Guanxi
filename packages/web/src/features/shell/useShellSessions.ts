import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { inspectorApi } from '../inspector/api.ts'

/** One protocol page at a time; there is no client ceiling on the session list. */
export function useShellSessions(location: string) {
  const [sessions, setSessions] = useState<SessionPageItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [omitted, setOmitted] = useState(false)
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [searchingAll, setSearchingAll] = useState(false)
  const [error, setError] = useState(false), [observedAt, setObservedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const epoch = useRef(0), pending = useRef<AbortController | null>(null), busy = useRef(false)
  const nextCursor = useRef<string | null>(null), consumedCursors = useRef(new Set<string>())
  const scanning = useRef(false)
  const cancelSearch = useCallback(() => {
    if (!scanning.current) return
    pending.current?.abort(); epoch.current++; scanning.current = false; busy.current = false
    setSearchingAll(false); setLoadingMore(false)
  }, [])
  useEffect(() => {
    const current = ++epoch.current, abort = new AbortController()
    pending.current?.abort(); pending.current = abort; busy.current = true
    scanning.current = false; setLoading(true); setLoadingMore(false); setSearchingAll(false); setError(false)
    void inspectorApi.page(undefined, abort.signal).then(page => {
      if (current !== epoch.current || abort.signal.aborted) return
      setSessions(page.sessions); setCursor(page.nextCursor); nextCursor.current = page.nextCursor
      consumedCursors.current.clear()
      setOmitted(page.omitted.withheld || page.omitted.catchingUp)
      setObservedAt(new Date().toISOString())
    }).catch(() => { if (current === epoch.current && !abort.signal.aborted) setError(true) })
      .finally(() => { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; setLoading(false) } })
    return () => { abort.abort(); pending.current?.abort(); epoch.current++; busy.current = false }
  }, [location, revision])
  async function loadPages(all: boolean) {
    if (!nextCursor.current || busy.current) return
    const current = epoch.current, abort = new AbortController()
    let requested: string | null = nextCursor.current
    pending.current = abort; busy.current = true; scanning.current = all
    setLoadingMore(true); setSearchingAll(all); setError(false)
    try {
      do {
        const page = await inspectorApi.page(requested, abort.signal)
        if (current !== epoch.current || abort.signal.aborted) return
        if (page.nextCursor === requested || (page.nextCursor && consumedCursors.current.has(page.nextCursor))) throw new Error('session_page_not_advanced')
        consumedCursors.current.add(requested)
        setSessions(previous => [...new Map([...previous, ...page.sessions].map(session => [session.sessionId, session])).values()])
        nextCursor.current = page.nextCursor; setCursor(page.nextCursor)
        setOmitted(previous => previous || page.omitted.withheld || page.omitted.catchingUp)
        setObservedAt(new Date().toISOString())
        requested = page.nextCursor
      } while (all && requested)
    } catch { if (current === epoch.current && !abort.signal.aborted) setError(true) }
    finally { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; scanning.current = false; setLoadingMore(false); setSearchingAll(false) } }
  }
  return { sessions, loading, loadingMore, searchingAll, error, omitted, observedAt, hasMore: Boolean(cursor),
    loadMore: () => loadPages(false), searchAll: () => loadPages(true), cancelSearch,
    reload: () => setRevision(value => value + 1) }
}
