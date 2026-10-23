import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { SEEN_SESSIONS_KEY, isFinishedUnseen, markSeen, readSeenSessions, writeSeenSessions } from './seen.ts'
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
    // Merge with anything still unsettled (A to B to C before a read lands, or a read that failed),
    // and keep the oldest stale read count: only a read after the first departure is final.
    leaving.current = { ids: new Set([...(leaving.current?.ids ?? []), ...viewing.current]), after: leaving.current?.after ?? reads }
    viewing.current = new Set()
    lastLocation.current = location
  }
  useEffect(() => {
    const open = new Map<string, number>(), departed = new Map<string, number>()
    const settled = leaving.current !== null && reads > leaving.current.after
    for (const session of sessions) {
      if (sessionIsOpen(session, location)) open.set(session.sessionId, session.lastSeq)
      else if (settled && leaving.current?.ids.has(session.sessionId)) departed.set(session.sessionId, session.lastSeq)
    }
    // Sessions opened since the last read stay pending until a read can name them.
    viewing.current = new Set([...viewing.current, ...open.keys()])
    if (settled) leaving.current = null
    setStore(previous => markSeen(previous, new Map([...open, ...departed])))
  }, [sessions, location, reads])
  useEffect(() => { writeSeenSessions(store) }, [store])
  // Another tab of this profile advanced its heads; take the larger head of each session.
  useEffect(() => {
    const merge = (event: StorageEvent) => {
      if (event.key !== SEEN_SESSIONS_KEY) return
      const other = readSeenSessions()
      setStore(previous => markSeen(previous, new Map(Object.entries(other.seen))))
    }
    window.addEventListener('storage', merge)
    return () => window.removeEventListener('storage', merge)
  }, [])
  // The session on screen counts as seen in the same render, so no frame paints a mark that opening it clears.
  const unseen = useMemo(() => new Set(sessions.filter(session => !sessionIsOpen(session, location) && isFinishedUnseen(session, store)).map(session => session.sessionId)), [sessions, store, location])
  return unseen
}
