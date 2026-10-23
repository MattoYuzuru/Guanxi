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
function Probe({ sessions, location, reads, complete = false }: { sessions: SessionPageItem[]; location: string; reads: number; complete?: boolean }) {
  const unseen = useUnseenSessions(sessions, location, reads, complete)
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
  it('does not flag a watched session after two quick navigations or when the read after leaving failed', () => {
    const running = [session('a', 'working', 5), session('b', 'working', 5)]
    const view = render(<Probe sessions={running} location="/agent/a" reads={1} />)
    // A to /projects to /settings before any read lands: the first departure is not forgotten.
    view.rerender(<Probe sessions={running} location="/projects" reads={1} />)
    view.rerender(<Probe sessions={running} location="/settings" reads={1} />)
    view.rerender(<Probe sessions={[session('a', 'completed', 9), session('b', 'completed', 9)]} location="/settings" reads={2} />)
    expect(unseen()).toBe('b')
  })
  it('keeps a departed session pending across a failed read and settles it with the next successful one', () => {
    const view = render(<Probe sessions={[session('a', 'working', 5)]} location="/agent/a" reads={1} />)
    view.rerender(<Probe sessions={[session('a', 'working', 5)]} location="/projects" reads={1} />)
    // The read for /projects failed: the same stale list and read count, then another navigation.
    view.rerender(<Probe sessions={[session('a', 'working', 5)]} location="/models" reads={1} />)
    expect(unseen()).toBe('')
    view.rerender(<Probe sessions={[session('a', 'completed', 8)]} location="/models" reads={2} />)
    expect(unseen()).toBe('')
  })
  it('never paints the session on screen as unseen, even before its head is recorded', () => {
    render(<Probe sessions={[session('a', 'completed', 4)]} location="/agent/a" reads={1} />)
    expect(unseen()).toBe('')
  })
  it('takes the larger head from another tab and never lowers one it recorded', () => {
    const view = render(<Probe sessions={[session('a', 'completed', 4)]} location="/projects" reads={1} />)
    expect(unseen()).toBe('a')
    act(() => {
      writeSeenSessions({ baselineAt: BASELINE, seen: { a: 4 } })
      window.dispatchEvent(new StorageEvent('storage', { key: SEEN_SESSIONS_KEY }))
    })
    expect(unseen()).toBe('')
    writeSeenSessions({ baselineAt: BASELINE, seen: { a: 1 } })
    expect(JSON.parse(window.localStorage.getItem(SEEN_SESSIONS_KEY)!).seen).toEqual({ a: 4 })
    view.unmount()
  })
  it('forgets heads of deleted sessions only from a complete list read', () => {
    const heads = () => JSON.parse(window.localStorage.getItem(SEEN_SESSIONS_KEY)!).seen
    const both = [session('a', 'completed', 4), session('b', 'completed', 5)]
    const view = render(<Probe sessions={both} location="/agent/a" reads={1} />)
    view.rerender(<Probe sessions={both} location="/agent/b" reads={1} />)
    expect(heads()).toEqual({ a: 4, b: 5 })
    // A partial list (more pages exist) says nothing about the sessions it does not show.
    view.rerender(<Probe sessions={[session('a', 'completed', 4)]} location="/agent/a" reads={2} complete={false} />)
    expect(heads()).toEqual({ a: 4, b: 5 })
    // Before any read there is nothing to compare against.
    view.rerender(<Probe sessions={[]} location="/agent/a" reads={0} complete />)
    expect(heads()).toEqual({ a: 4, b: 5 })
    view.rerender(<Probe sessions={[session('a', 'completed', 4)]} location="/agent/a" reads={3} complete />)
    expect(heads()).toEqual({ a: 4 })
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
    expect(screen.getByTestId('shell-unseen-count').textContent).toBe('Finished, not yet opened: at least 1 (some sessions are not loaded or not available)')
  })
  it('says "at least" while some sessions are withheld or catching up, even with every page loaded', () => {
    render(<ShellSidebar {...sidebarProps(sessions, ['a'], { omitted: true })} />)
    expect(screen.getByTestId('shell-unseen-count').textContent).toContain('at least 1')
  })
  it('keeps the count reachable in the rail with an accessible name', () => {
    render(<ShellSidebar {...sidebarProps(sessions, ['a', 'b'], { rail: true })} />)
    const rail = screen.getByTestId('shell-unseen-rail')
    expect(rail.textContent).toContain('Finished, not yet opened: 2')
    expect(rail.getAttribute('title')).toBeNull() // the name is announced once, through the hidden text
  })
  it('renders in Russian', () => {
    setActiveLocale('ru')
    render(<ShellSidebar {...sidebarProps(sessions, ['a'])} />)
    expect(screen.getByTestId('shell-unseen-count').textContent).toBe('Завершено, ещё не открыто: 1')
    expect(screen.getByText('Завершена, ещё не открыта')).toBeTruthy()
  })
})
