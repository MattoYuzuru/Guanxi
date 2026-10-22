import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionPageItem } from '@guanxi/contract'
import { ShellSidebar, type ShellSidebarProps } from '../../src/features/shell/ShellSidebar.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

const session = (sessionId: string, title: string, state: SessionPageItem['execution'] = null): SessionPageItem => ({
  sessionId, title, kind: 'agent', threadId: null, createdAt: new Date().toISOString(), lastSeq: 1, lastEventAt: null,
  execution: state, navigation: { kind: 'inspector', sessionId },
})
const props = (): ShellSidebarProps => ({ rail: false, location: '/', sessions: [], pinned: [], loading: false,
  loadingMore: false, error: false, omitted: false, observedAt: null, hasMore: false,
  onLoadMore: vi.fn(), onRefresh: vi.fn(), onPin: vi.fn() })

describe('shell navigation and session presentation', () => {
  it('keeps all four core destinations accessible in the rail', () => {
    setActiveLocale('en')
    render(<ShellSidebar {...props()} rail />)
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(navigation).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/agent', '/projects', '/', '/settings'])
    for (const name of ['New', 'Projects', 'Models', 'Settings']) expect(within(navigation).getByRole('link', { name })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Sessions' })).toBeNull()
  })
  it('marks the owning core destination current on nested legacy routes', () => {
    setActiveLocale('en')
    const { rerender } = render(<ShellSidebar {...props()} location="/models/fixture:latest" />)
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(navigation).getByRole('link', { name: 'Models' }).getAttribute('aria-current')).toBe('page')
    expect(within(navigation).getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBeNull()

    rerender(<ShellSidebar {...props()} location="/settings/developer/components" />)
    expect(within(navigation).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page')
    expect(within(navigation).getByRole('link', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
  })
  it('lists pinned rows once, keeps unknown distinct from zero, and names missing pages and provenance', () => {
    setActiveLocale('en')
    const values = props()
    values.sessions = [session('s1', 'First'), session('s2', 'Second', { state: 'input_required', attemptState: 'started',
      source: 'run-home', observedAt: '2026-10-22T09:00:00.000Z', confidence: 'observed' })]
    values.pinned = ['s1', 'outside']
    values.hasMore = true
    render(<ShellSidebar {...values} />)
    const sessions = screen.getByRole('region', { name: 'Sessions' })
    expect(within(sessions).getAllByRole('link')).toHaveLength(2)
    expect(within(sessions).getAllByRole('link', { name: 'First' })).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: 'Pinned' })).getByRole('link', { name: 'First' })).toBeTruthy()
    expect(within(sessions).getByText('No current data')).toBeTruthy()
    expect(within(sessions).getByText('Waiting for you')).toBeTruthy()
    expect(within(sessions).getByText(/Saved run state .* observed/)).toBeTruthy()
    expect(within(sessions).getByText('Some pinned sessions are outside the loaded pages.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unpin First' }))
    expect(values.onPin).toHaveBeenCalledExactlyOnceWith('s1')
    fireEvent.click(screen.getByRole('button', { name: 'Load more sessions' }))
    expect(values.onLoadMore).toHaveBeenCalledTimes(1)
    expect(sessions.textContent).not.toContain('0 sessions')
  })
  it('shows errors and incomplete history instead of falsely claiming an empty list', () => {
    setActiveLocale('en')
    render(<ShellSidebar {...props()} error omitted />)
    expect(screen.getByRole('alert').textContent).toContain('Sessions could not be refreshed')
    expect(screen.getByText('Some sessions are temporarily unavailable.')).toBeTruthy()
    expect(screen.queryByText('No sessions yet. Start a new session.')).toBeNull()
  })
})
