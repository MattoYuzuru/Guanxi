import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPageItem } from '@guanxi/contract'
import { SEEN_SESSIONS_KEY, isFinishedUnseen, markSeen, pruneSeen, readSeenSessions, writeSeenSessions } from '../../src/features/shell/seen.ts'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
})
afterEach(() => vi.unstubAllGlobals())

const session = (sessionId: string, state: 'working' | 'completed' | 'failed' | null, lastSeq: number, observedAt = '2026-10-23T10:00:00.000Z'): SessionPageItem => ({
  sessionId, kind: 'agent', threadId: null, title: sessionId, createdAt: '2026-10-23T09:00:00.000Z', lastSeq, lastEventAt: observedAt,
  execution: state ? { state, attemptState: null, source: 'run-home', observedAt, confidence: 'observed' } : null,
  navigation: { kind: 'native', sessionId },
})
const BASE = '2026-10-23T08:00:00.000Z'
const baseline = { baselineAt: '2026-10-23T08:00:00.000Z', seen: {} }

describe('finished-unseen derivation', () => {
  it('flags only a finished session beyond the shown head', () => {
    expect(isFinishedUnseen(session('a', 'completed', 4), baseline)).toBe(true)
    for (const state of ['working', 'failed', null] as const) expect(isFinishedUnseen(session('a', state, 4), baseline), String(state)).toBe(false)
    expect(isFinishedUnseen(session('a', 'completed', 4), { ...baseline, seen: { a: 4 } })).toBe(false)
    expect(isFinishedUnseen(session('a', 'completed', 5), { ...baseline, seen: { a: 4 } })).toBe(true)
  })
  it('treats a session observed before the profile baseline as seen, and one at the baseline as seen', () => {
    expect(isFinishedUnseen(session('a', 'completed', 4, '2026-10-23T07:59:59.000Z'), baseline)).toBe(false)
    expect(isFinishedUnseen(session('a', 'completed', 4, '2026-10-23T08:00:00.000Z'), baseline)).toBe(false)
    expect(isFinishedUnseen(session('a', 'completed', 4, '2026-10-23T08:00:01.000Z'), baseline)).toBe(true)
  })
  it('only ever raises a seen head and returns the same object when nothing changes', () => {
    const first = markSeen(baseline, new Map([['a', 3]]))
    expect(first.seen).toEqual({ a: 3 })
    expect(markSeen(first, new Map([['a', 3]]))).toBe(first)
    expect(markSeen(first, new Map([['a', 1]]))).toBe(first)
    expect(markSeen(first, new Map([['a', 7], ['b', 0]])).seen).toEqual({ a: 7, b: 0 })
  })
})

describe('seen store', () => {
  it('creates a baseline at first use, round-trips opaque ids and normalizes corruption', () => {
    const now = new Date('2026-10-23T12:00:00.000Z')
    expect(readSeenSessions(now)).toEqual({ baselineAt: now.toISOString(), seen: {} })
    writeSeenSessions({ baselineAt: now.toISOString(), seen: { a: 3 } })
    expect(readSeenSessions(new Date())).toEqual({ baselineAt: now.toISOString(), seen: { a: 3 } })
    expect(Object.keys(JSON.parse(window.localStorage.getItem(SEEN_SESSIONS_KEY)!))).toEqual(['baselineAt', 'seen'])
    window.localStorage.setItem(SEEN_SESSIONS_KEY, JSON.stringify({ baselineAt: now.toISOString(), seen: { a: 3, b: -1, c: 1.5, d: 'x', '': 2 } }))
    expect(readSeenSessions().seen).toEqual({ a: 3 })
    window.localStorage.setItem(SEEN_SESSIONS_KEY, '{broken')
    expect(readSeenSessions(now).seen).toEqual({})
    window.localStorage.setItem(SEEN_SESSIONS_KEY, JSON.stringify({ baselineAt: 'not a date', seen: { a: 1 } }))
    expect(readSeenSessions(now)).toEqual({ baselineAt: now.toISOString(), seen: {} })
  })
  it('writes the larger head of each session so one tab never lowers another tab\'s record', () => {
    writeSeenSessions({ baselineAt: '2026-10-23T08:00:00.000Z', seen: { a: 5, b: 2 } })
    writeSeenSessions({ baselineAt: '2026-10-23T08:00:00.000Z', seen: { a: 3, c: 1 } })
    expect(readSeenSessions().seen).toEqual({ a: 5, b: 2, c: 1 })
  })
  it('prunes heads of sessions that are absent from a complete list, and keeps every other', () => {
    const store = { baselineAt: BASE, seen: { a: 1, b: 2, gone: 3 } }
    const pruned = pruneSeen(store, ['a', 'b', 'new'])
    expect(pruned.seen).toEqual({ a: 1, b: 2 })
    expect(pruneSeen(pruned, ['a', 'b'])).toBe(pruned)
    expect(pruneSeen(store, [])).toEqual({ baselineAt: BASE, seen: {} })
  })
  it('a prune is persisted even though writes merge with the stored heads', () => {
    writeSeenSessions({ baselineAt: BASE, seen: { a: 1, gone: 3 } })
    writeSeenSessions({ baselineAt: BASE, seen: { a: 1 } }, ['gone'])
    expect(readSeenSessions().seen).toEqual({ a: 1 })
    writeSeenSessions({ baselineAt: BASE, seen: { a: 2 } })
    expect(readSeenSessions().seen).toEqual({ a: 2 })
  })
  it('stays usable when storage is blocked', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readSeenSessions().seen).toEqual({})
    expect(() => writeSeenSessions({ baselineAt: new Date().toISOString(), seen: {} })).not.toThrow()
  })
})
