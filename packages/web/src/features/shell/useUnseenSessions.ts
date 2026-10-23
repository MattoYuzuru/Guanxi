import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionPageItem } from '@guanxi/contract'
import { SEEN_SESSIONS_KEY, isFinishedUnseen, markSeen, pruneSeen, readSeenSessions, writeSeenSessions } from './seen.ts'
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
 * until they left; the first page read after leaving carries its final head). No timers. When a read
 * covered every session (`complete`), heads of sessions it did not return are forgotten, so the
 * per-browser store follows the node's list instead of growing without end.
 */
export function useUnseenSessions(sessions: readonly SessionPageItem[], location: string, reads: number, complete = false) {
  const [store, setStore] = useState(readSeenSessions)
  const viewing = useRef<ReadonlySet<string>>(new Set())
  const leaving = useRef<{ ids: ReadonlySet<string>; after: number } | null>(null)
  const removed = useRef(new Set<string>())
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
    setStore(previous => {
      const marked = markSeen(previous, new Map([...open, ...departed]))
      // Only a successful, complete read says a session is gone; a partial page says nothing about the rest.
      if (!complete || reads === 0) return marked
      const pruned = pruneSeen(marked, sessions.map(session => session.sessionId))
      if (pruned !== marked) for (const id of Object.keys(marked.seen)) if (!(id in pruned.seen)) removed.current.add(id)
      return pruned
    })
  }, [sessions, location, reads, complete])
  useEffect(() => { writeSeenSessions(store, [...removed.current]); removed.current.clear() }, [store])
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
