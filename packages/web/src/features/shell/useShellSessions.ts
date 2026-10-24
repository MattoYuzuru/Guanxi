import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { replaceEqualDeep } from '../../lib/stable.ts'
import { DEFAULT_ASYNC_RETRY, retryDelay } from '../../lib/useAsync.ts'
import { inspectorApi } from '../inspector/api.ts'
import { sessionStatus } from './sessionPresentation.ts'

/** Quiet head refresh while the page is visible: faster while a session is active (D-203). */
export const SESSIONS_ACTIVE_REFRESH_MS = 5_000
export const SESSIONS_IDLE_REFRESH_MS = 15_000
const isActive = (session: SessionPageItem) => ['running', 'queued'].includes(sessionStatus(session))

/**
 * One protocol page at a time; there is no client ceiling on the session list. The list stays
 * current by itself: the first page is re-read quietly (merged with any loaded tail pages, equal
 * rows keep their identity), a failed read recovers with a growing pause, and loading is shown
 * only before the first page.
 */
export function useShellSessions(location: string) {
  const [sessions, setSessions] = useState<SessionPageItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [omitted, setOmitted] = useState(false)
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [searchingAll, setSearchingAll] = useState(false)
  const [paginationReady, setPaginationReady] = useState(false)
  const [error, setError] = useState(false), [observedAt, setObservedAt] = useState<string | null>(null)
  // Counts successful page reads so consumers can tell a fresh read from a stale one.
  const [reads, setReads] = useState(0)
  const [revision, setRevision] = useState(0)
  const epoch = useRef(0), pending = useRef<AbortController | null>(null), busy = useRef(false)
  const nextCursor = useRef<string | null>(null), consumedCursors = useRef(new Set<string>())
  const scanning = useRef(false)
  const hasData = useRef(false), tailLoaded = useRef(false), failures = useRef(0)
  const headRequest = useRef<AbortController | null>(null)
  const reschedule = useRef<() => void>(() => undefined)
  const sessionsRef = useRef<SessionPageItem[]>([])
  sessionsRef.current = sessions
  // A quiet read that changes nothing sets no state, so the shell does not re-render for it (P2).
  // The read counter still moves for the first read after a navigation: leaving a session settles
  // it at the head that read returns (useUnseenSessions).
  const locationRef = useRef(location)
  locationRef.current = location
  const readLocation = useRef<string | null>(null)
  const cursorRef = useRef<string | null>(null), omittedRef = useRef(false), errorRef = useRef(false)
  cursorRef.current = cursor; omittedRef.current = omitted; errorRef.current = error
  const cancelSearch = useCallback(() => {
    if (!scanning.current) return
    pending.current?.abort(); epoch.current++; scanning.current = false; busy.current = false
    setSearchingAll(false); setLoadingMore(false)
  }, [])
  useEffect(() => {
    const current = ++epoch.current, abort = new AbortController()
    pending.current?.abort(); pending.current = abort; busy.current = true
    // Cached rows may remain visible, but a refresh invalidates their pagination basis.
    // Only a successful first page may admit a tail cursor for this revision/location.
    nextCursor.current = null; setCursor(null); setPaginationReady(false); tailLoaded.current = false
    headRequest.current?.abort()
    // Rows already on screen stay; only the very first read shows a loading state.
    scanning.current = false; setLoading(!hasData.current); setLoadingMore(false); setSearchingAll(false)
    void inspectorApi.page(undefined, abort.signal).then(page => {
      if (current !== epoch.current || abort.signal.aborted) return
      hasData.current = true; failures.current = 0; setError(false)
      setSessions(previous => replaceEqualDeep(previous, page.sessions)); setCursor(page.nextCursor); nextCursor.current = page.nextCursor
      setPaginationReady(true)
      consumedCursors.current.clear()
      setOmitted(page.omitted.withheld || page.omitted.catchingUp)
      setObservedAt(new Date().toISOString()); setReads(value => value + 1); readLocation.current = location
    }).catch(() => { if (current === epoch.current && !abort.signal.aborted) { setError(true); failures.current += 1; reschedule.current() } })
      .finally(() => { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; setLoading(false) } })
    return () => { abort.abort(); pending.current?.abort(); epoch.current++; busy.current = false }
  }, [location, revision])
  // Quiet head refresh: never touches loading flags; merges the first page over loaded tail pages.
  const refreshHead = useCallback(async () => {
    if (busy.current || !hasData.current && failures.current === 0) return
    if (!hasData.current) { setRevision(value => value + 1); return } // never loaded: a full read
    const current = epoch.current, abort = new AbortController()
    headRequest.current?.abort(); headRequest.current = abort
    try {
      const page = await inspectorApi.page(undefined, abort.signal)
      if (current !== epoch.current || abort.signal.aborted || busy.current) return
      failures.current = 0
      const previous = sessionsRef.current
      const ids = new Set(page.sessions.map(session => session.sessionId))
      const tail = tailLoaded.current ? previous.filter(session => !ids.has(session.sessionId)) : []
      const next = replaceEqualDeep(previous, [...page.sessions, ...tail])
      const changed = next !== previous
      if (changed) { sessionsRef.current = next; setSessions(next) }
      if (!tailLoaded.current) {
        nextCursor.current = page.nextCursor
        if (cursorRef.current !== page.nextCursor) setCursor(page.nextCursor)
      }
      const omittedNext = (tailLoaded.current && omittedRef.current) || page.omitted.withheld || page.omitted.catchingUp
      if (omittedNext !== omittedRef.current) setOmitted(omittedNext)
      if (errorRef.current) setError(false)
      if (changed) setObservedAt(new Date().toISOString())
      if (changed || readLocation.current !== locationRef.current) { readLocation.current = locationRef.current; setReads(value => value + 1) }
    } catch {
      if (current === epoch.current && !abort.signal.aborted) { failures.current += 1; setError(true) }
    }
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false
    const delay = () => failures.current > 0 ? retryDelay(failures.current, DEFAULT_ASYNC_RETRY)
      : sessionsRef.current.some(isActive) ? SESSIONS_ACTIVE_REFRESH_MS : SESSIONS_IDLE_REFRESH_MS
    const schedule = () => {
      clearTimeout(timer)
      if (!stopped && document.visibilityState !== 'hidden') timer = setTimeout(() => { void refreshHead().then(schedule) }, delay())
    }
    const wake = () => { if (!stopped && document.visibilityState !== 'hidden') void refreshHead().then(schedule) }
    reschedule.current = schedule
    schedule()
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      stopped = true; clearTimeout(timer); headRequest.current?.abort(); reschedule.current = () => undefined
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [refreshHead])
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
        tailLoaded.current = true
        setSessions(previous => [...new Map([...previous, ...page.sessions].map(session => [session.sessionId, session])).values()])
        nextCursor.current = page.nextCursor; setCursor(page.nextCursor)
        setOmitted(previous => previous || page.omitted.withheld || page.omitted.catchingUp)
        setObservedAt(new Date().toISOString()); setReads(value => value + 1)
        requested = page.nextCursor
      } while (all && requested)
    } catch { if (current === epoch.current && !abort.signal.aborted) setError(true) }
    finally { if (current === epoch.current && !abort.signal.aborted) { busy.current = false; scanning.current = false; setLoadingMore(false); setSearchingAll(false) } }
  }
  function reload() {
    pending.current?.abort(); epoch.current++; nextCursor.current = null; busy.current = true; scanning.current = false
    setCursor(null); setPaginationReady(false); setLoading(true); setLoadingMore(false); setSearchingAll(false); setError(false)
    setRevision(value => value + 1)
  }
  return { sessions, loading, loadingMore, searchingAll, paginationReady, error, omitted, observedAt, reads, hasMore: Boolean(cursor),
    loadMore: () => loadPages(false), searchAll: () => {
      if (!paginationReady && !busy.current) { reload(); return Promise.resolve() }
      return loadPages(true)
    }, cancelSearch,
    reload }
}
