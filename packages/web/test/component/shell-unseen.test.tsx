import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPageItem } from '@guanxi/contract'
import { ShellSidebar, type ShellSidebarProps } from '../../src/features/shell/ShellSidebar.tsx'
import { SEEN_SESSIONS_KEY, writeSeenSessions } from '../../src/features/shell/seen.ts'
import { useUnseenSessions } from '../../src/features/shell/useUnseenSessions.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const BASELINE = '2026-10-23T08:00:00.000Z', LATER = '2026-10-23T10:00:00.000Z'
const session = (sessionId: string, state: 'working' | 'completed' | 'failed', lastSeq: number, observedAt = LATER): SessionPageItem => ({
  sessionId, kind: 'agent', threadId: null, title: `Title ${sessionId}`, createdAt: '2026-10-23T09:00:00.000Z', lastSeq, lastEventAt: observedAt,
  execution: { state, attemptState: null, source: 'run-home', observedAt, confidence: 'observed' }, navigation: { kind: 'native', sessionId },
})
function Probe({ sessions, location, reads }: { sessions: SessionPageItem[]; location: string; reads: number }) {
  const unseen = useUnseenSessions(sessions, location, reads)
  return <output data-testid="unseen">{[...unseen].sort().join(',')}</output>
}
const unseen = () => screen.getByTestId('unseen').textContent
beforeEach(() => {
  setActiveLocale('en')
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
  writeSeenSessions({ baselineAt: BASELINE, seen: {} })
})
afterEach(() => { vi.unstubAllGlobals(); setActiveLocale('ru') })

describe('useUnseenSessions', () => {
  it('flags exactly the finished sessions never opened, and clears one when it is opened', () => {
    const list = [session('a', 'completed', 4), session('b', 'working', 2), session('c', 'failed', 3), session('d', 'completed', 6)]
    const view = render(<Probe sessions={list} location="/projects" reads={1} />)
    expect(unseen()).toBe('a,d')
    view.rerender(<Probe sessions={list} location="/agent/a" reads={1} />)
    expect(unseen()).toBe('d')
    view.rerender(<Probe sessions={list} location="/projects" reads={2} />)
    expect(unseen()).toBe('d') // opened once, stays cleared at the same head
    view.rerender(<Probe sessions={list} location="/inspector/d" reads={2} />)
    expect(unseen()).toBe('')
  })
  it('does not flag history older than the profile baseline', () => {
    render(<Probe sessions={[session('old', 'completed', 9, '2026-10-22T12:00:00.000Z')]} location="/projects" reads={1} />)
    expect(unseen()).toBe('')
  })
  it('does not flag a session the user watched finish, but flags one that finished while elsewhere', () => {
    const running = [session('a', 'working', 5), session('b', 'working', 5)]
    const view = render(<Probe sessions={running} location="/agent/a" reads={1} />)
    expect(unseen()).toBe('')
    // Navigating away keeps the stale list until the fresh read arrives: nothing flagged yet.
    view.rerender(<Probe sessions={running} location="/projects" reads={1} />)
    expect(unseen()).toBe('')
    view.rerender(<Probe sessions={[session('a', 'completed', 9), session('b', 'completed', 9)]} location="/projects" reads={2} />)
    expect(unseen()).toBe('b')
  })
  it('flags a session again when it finishes again, then clears it when opened', () => {
    const view = render(<Probe sessions={[session('a', 'completed', 4)]} location="/agent/a" reads={1} />)
    view.rerender(<Probe sessions={[session('a', 'completed', 4)]} location="/projects" reads={1} />)
    view.rerender(<Probe sessions={[session('a', 'completed', 4)]} location="/projects" reads={2} />)
    expect(unseen()).toBe('')
    view.rerender(<Probe sessions={[session('a', 'completed', 8)]} location="/projects" reads={3} />)
    expect(unseen()).toBe('a')
    view.rerender(<Probe sessions={[session('a', 'completed', 8)]} location="/agent/a" reads={3} />)
    expect(unseen()).toBe('')
  })
  it('persists the shown heads across a remount', () => {
    const list = [session('a', 'completed', 4)]
    const first = render(<Probe sessions={list} location="/agent/a" reads={1} />)
    first.unmount()
    expect(JSON.parse(window.localStorage.getItem(SEEN_SESSIONS_KEY)!).seen).toEqual({ a: 4 })
    render(<Probe sessions={list} location="/projects" reads={1} />)
    expect(unseen()).toBe('')
  })
})

const sidebarProps = (sessions: SessionPageItem[], unseenIds: string[], extra: Partial<ShellSidebarProps> = {}): ShellSidebarProps => ({
  rail: false, location: '/projects', sessions, pinned: [], unseen: new Set(unseenIds), loading: false, loadingMore: false, error: false,
  omitted: false, observedAt: null, hasMore: false, onLoadMore: vi.fn(), onRefresh: vi.fn(), onPin: vi.fn(), ...extra,
})
describe('sidebar indicator', () => {
  const sessions = [session('a', 'completed', 4), session('b', 'completed', 5), session('c', 'working', 2)]
  it('marks exactly the unseen rows, names the count and marks no row without an unseen session', () => {
    const view = render(<ShellSidebar {...sidebarProps(sessions, ['a', 'b'])} />)
    const region = screen.getByRole('region', { name: 'Sessions' })
    expect(region.querySelectorAll('[data-unseen="true"]')).toHaveLength(2)
    expect(within(region).getAllByText('Finished, not yet opened')).toHaveLength(2)
    expect(screen.getByTestId('shell-unseen-count').textContent).toBe('Finished, not yet opened: 2')
    expect(screen.queryByTestId('shell-unseen-rail')).toBeNull()
    view.rerender(<ShellSidebar {...sidebarProps(sessions, [])} />)
    expect(region.querySelectorAll('[data-unseen="true"]')).toHaveLength(0)
    expect(screen.queryByTestId('shell-unseen-count')).toBeNull()
  })
  it('says "at least" while older pages are not loaded', () => {
    render(<ShellSidebar {...sidebarProps(sessions, ['a'], { hasMore: true })} />)
    expect(screen.getByTestId('shell-unseen-count').textContent).toBe('Finished, not yet opened: at least 1 (more sessions are not loaded)')
  })
  it('keeps the count reachable in the rail with an accessible name', () => {
    render(<ShellSidebar {...sidebarProps(sessions, ['a', 'b'], { rail: true })} />)
    const rail = screen.getByTestId('shell-unseen-rail')
    expect(rail.textContent).toContain('Finished, not yet opened: 2')
    expect(rail.getAttribute('title')).toBe('Finished, not yet opened: 2')
  })
  it('renders in Russian', () => {
    setActiveLocale('ru')
    render(<ShellSidebar {...sidebarProps(sessions, ['a'])} />)
    expect(screen.getByTestId('shell-unseen-count').textContent).toBe('Завершено, ещё не открыто: 1')
    expect(screen.getByText('Завершена, ещё не открыта')).toBeTruthy()
  })
})
