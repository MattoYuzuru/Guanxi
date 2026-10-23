import type { SessionPageItem } from '@guanxi/contract'
import { PRODUCT_FILE_PREFIX } from '../../lib/brand.ts'
import { sessionStatus } from './sessionPresentation.ts'

/**
 * "Finished, not yet opened" is derived, never timed: a session is unseen when its durable run
 * state says finished and its log head (`lastSeq`) is beyond the head this browser profile last
 * showed the user. The store holds only opaque session ids and integers. Sessions whose last
 * observation predates the first use of the indicator in this profile are treated as already
 * seen, so a new profile does not start with the whole history flagged.
 */
export const SEEN_SESSIONS_KEY = `${PRODUCT_FILE_PREFIX}.shell.seen.v1`
export interface SeenSessions { baselineAt: string; seen: Record<string, number> }

export function readSeenSessions(now = new Date()): SeenSessions {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(SEEN_SESSIONS_KEY) ?? 'null')
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const value = data as Record<string, unknown>
      const baselineAt = typeof value.baselineAt === 'string' && !Number.isNaN(Date.parse(value.baselineAt)) ? value.baselineAt : null
      const seen: Record<string, number> = {}
      if (value.seen && typeof value.seen === 'object' && !Array.isArray(value.seen)) {
        for (const [id, head] of Object.entries(value.seen)) if (id && typeof head === 'number' && Number.isInteger(head) && head >= 0) seen[id] = head
      }
      if (baselineAt) return { baselineAt, seen }
    }
  } catch { /* A blocked or corrupt store starts a fresh baseline. */ }
  return { baselineAt: now.toISOString(), seen: {} }
}
/** Drops heads of sessions that are not in `present` (deleted or retired); the same object when none is dropped. */
export function pruneSeen(store: SeenSessions, present: Iterable<string>): SeenSessions {
  const keep = new Set(present)
  const stale = Object.keys(store.seen).filter(id => !keep.has(id))
  if (stale.length === 0) return store
  return { ...store, seen: Object.fromEntries(Object.entries(store.seen).filter(([id]) => keep.has(id))) }
}

/**
 * Writes the larger head of each session, so a tab never lowers what another tab recorded. Ids in
 * `removed` (pruned as deleted) are dropped from the merged result instead of being merged back.
 */
export function writeSeenSessions(value: SeenSessions, removed: readonly string[] = []): void {
  try {
    const stored = readSeenSessions(new Date(value.baselineAt))
    const merged = markSeen({ baselineAt: value.baselineAt, seen: stored.seen }, new Map(Object.entries(value.seen)))
    for (const id of removed) delete merged.seen[id]
    window.localStorage.setItem(SEEN_SESSIONS_KEY, JSON.stringify(merged))
  } catch { /* Remain usable without storage. */ }
}

export function isFinishedUnseen(session: SessionPageItem, store: SeenSessions): boolean {
  if (sessionStatus(session) !== 'finished' || !session.execution) return false
  const known = store.seen[session.sessionId]
  if (known !== undefined) return session.lastSeq > known
  return Date.parse(session.execution.observedAt) > Date.parse(store.baselineAt)
}

/** Raises the shown head of each given session; returns the same object when nothing changed. */
export function markSeen(store: SeenSessions, heads: ReadonlyMap<string, number>): SeenSessions {
  let seen: Record<string, number> | null = null
  for (const [id, head] of heads) {
    if ((store.seen[id] ?? -1) >= head) continue
    seen ??= { ...store.seen }
    seen[id] = head
  }
  return seen ? { ...store, seen } : store
}
