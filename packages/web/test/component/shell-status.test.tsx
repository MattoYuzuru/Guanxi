import { fireEvent, render, screen } from '@testing-library/react'
import { PRODUCT_NAME } from '@guanxi/contract'
import { describe, expect, it, vi } from 'vitest'
import { ShellStatus } from '../../src/features/shell/ShellStatus.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { formatDateTime } from '../../src/lib/format.ts'
import { WORKSPACE_MODE_COMMAND } from '../../src/features/workspace/commands.ts'
import { runtimeSnapshotFixture } from '../fixtures/runtime.ts'
const workspace = { ready: false, busy: false, phone: false, mode: null, blocks: [] }

describe('shell status provenance', () => {
  it('renders the centralized product brand through English and Russian locale lookup', () => {
    setActiveLocale('en')
    const english = render(<ShellStatus breadcrumb="Projects" workspace={workspace} runtime={null} stale={false} />)
    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toBeTruthy()
    english.unmount()

    setActiveLocale('ru')
    render(<ShellStatus breadcrumb="Проекты" workspace={workspace} runtime={null} stale={false} />)
    expect(screen.getByRole('link', { name: PRODUCT_NAME })).toBeTruthy()
    setActiveLocale('en')
  })
  it('leaves unavailable machine/quota/power/inbox data unknown and explains unavailable mode actions', () => {
    setActiveLocale('en')
    const { container } = render(<ShellStatus breadcrumb="Projects" workspace={workspace} runtime={null} stale={false} />)
    expect(screen.getAllByText('No current data')).toHaveLength(5)
    expect(container.textContent).not.toMatch(/\b0\b/u)
    expect(screen.getByText('Open a workspace first.')).toBeTruthy()
    for (const name of ['Developer', 'Visual']) expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
    const group = screen.getByRole('group', { name: 'Experience mode' })
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Open a workspace first.')
  })
  it('keeps actual hardware source/time/confidence and stale state visible, and dispatches the chosen mode', () => {
    setActiveLocale('en')
    const runtime = runtimeSnapshotFixture(), changeMode = vi.fn()
    window.addEventListener(WORKSPACE_MODE_COMMAND, changeMode)
    render(<ShellStatus breadcrumb="Workspace" workspace={{ ...workspace, ready: true, mode: 'developer' }} runtime={runtime} stale />)
    expect(screen.getByText(`${runtime.host.profile.platform} · ${runtime.host.profile.arch}`)).toBeTruthy()
    expect(screen.getByText(/Local hardware observation/).textContent).toContain(formatDateTime(runtime.host.profile.observedAt))
    expect(screen.getByText(/Local hardware observation/).textContent).toContain('observed')
    expect(screen.getByText(/Local hardware observation/).textContent).toContain('Last successful observation; refresh unavailable')
    expect(screen.getByRole('button', { name: 'Developer' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }))
    expect((changeMode.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ mode: 'visual' })
    window.removeEventListener(WORKSPACE_MODE_COMMAND, changeMode)
  })
})
