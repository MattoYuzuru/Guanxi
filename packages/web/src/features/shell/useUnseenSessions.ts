import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { isFinishedUnseen, markSeen, readSeenSessions, writeSeenSessions } from './seen.ts'
import { sessionNavigationPath } from './sessionNavigation.ts'

const pathOf = (location: string) => location.split('?')[0] ?? '/'
/** A session is open when the location is its navigation target or its inspector page. */
export function sessionIsOpen(session: SessionPageItem, location: string): boolean {
  const target = sessionNavigationPath(session.navigation)
  return target === location || (!target.includes('?') && pathOf(target) === pathOf(location))
    || pathOf(location) === `/inspector/${encodeURIComponent(session.sessionId)}`
}

/**
 * Derives the finished-unseen set from the loaded session pages. Whatever the user is looking at
 * counts as seen at the head just read, and so does the session they just left (they watched it
 * until they left; the first page read after leaving carries its final head). No timers.
 */
export function useUnseenSessions(sessions: readonly SessionPageItem[], location: string, reads: number) {
  const [store, setStore] = useState(readSeenSessions)
  const viewing = useRef<ReadonlySet<string>>(new Set())
  const leaving = useRef<{ ids: ReadonlySet<string>; after: number } | null>(null)
  const lastLocation = useRef(location)
  if (lastLocation.current !== location) {
    // Remember what was open and which page read is already stale; only a later read is final.
    leaving.current = { ids: viewing.current, after: reads }
    lastLocation.current = location
  }
  useEffect(() => {
    const open = new Map<string, number>(), departed = new Map<string, number>()
    const settled = leaving.current !== null && reads > leaving.current.after
    for (const session of sessions) {
      if (sessionIsOpen(session, location)) open.set(session.sessionId, session.lastSeq)
      else if (settled && leaving.current?.ids.has(session.sessionId)) departed.set(session.sessionId, session.lastSeq)
    }
    viewing.current = new Set(open.keys())
    if (settled) leaving.current = null
    setStore(previous => markSeen(previous, new Map([...open, ...departed])))
  }, [sessions, location, reads])
  useEffect(() => { writeSeenSessions(store) }, [store])
  const unseen = useMemo(() => new Set(sessions.filter(session => isFinishedUnseen(session, store)).map(session => session.sessionId)), [sessions, store])
  return unseen
}
