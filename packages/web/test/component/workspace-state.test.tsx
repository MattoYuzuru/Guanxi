import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../../src/features/workspace/Workspace.tsx'
import type { WorkspaceLayoutHandle } from '../../src/features/workspace/WorkspaceLayout/index.tsx'
import type { LayoutDocument } from '@guanxi/contract'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'

const control = vi.hoisted(() => ({ failSnapshot: false }))
vi.mock('../../src/lib/locale-context.tsx', () => ({ useLocale: () => ({ locale: 'en', setLocale() {} }) }))
vi.mock('../../src/lib/theme.tsx', () => ({ useTheme: () => ({ resolved: 'light' }) }))
vi.mock('../../src/kernel/runtime.ts', () => {
  const entries: unknown[] = []
  return { webKernelReady: Promise.resolve(), webKernel: { slots: { list: () => entries, subscribe: () => () => {} } } }
})
vi.mock('../../src/lib/api.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/lib/api.ts')>()
  return { ...actual, api: { ...actual.api, layoutContext: vi.fn(), layouts: vi.fn(), layoutGeometry: vi.fn(), saveLayout: vi.fn() } }
})
vi.mock('../../src/features/workspace/WorkspaceLayout/index.tsx', () => ({
  WorkspaceLayout: ({ handleRef, document }: { handleRef: React.Ref<WorkspaceLayoutHandle>; document: LayoutDocument }) => {
    useImperativeHandle(handleRef, () => ({ snapshot: () => {
      if (control.failSnapshot) throw new Error('private-snapshot-sentinel')
      return { engineState: document.engineState, hidden: document.hidden, geometry: {} }
    } } as WorkspaceLayoutHandle), [document])
    return <div data-testid="adapter-boundary" data-account={document.scope.account} />
  },
}))

beforeEach(() => {
  setActiveLocale('en')
  control.failSnapshot = false
  vi.mocked(api.layoutContext).mockReset().mockResolvedValue({ account: 'local', replication: false })
  vi.mocked(api.layouts).mockReset().mockResolvedValue({ documents: [], active: [] })
  vi.mocked(api.layoutGeometry).mockReset().mockResolvedValue({ geometry: {} })
  vi.mocked(api.saveLayout).mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('Workspace actual failure boundaries with a controlled docking adapter', () => {
  it('captures a rejected actual snapshot locally without issuing a layout PUT or exposing its message', async () => {
    render(<Workspace><p>Chat content</p></Workspace>)
    await screen.findByTestId('adapter-boundary')
    control.failSnapshot = true
    fireEvent.click(screen.getByRole('button', { name: 'Save layout' }))
    const error = await screen.findByRole('alert')
    expect(error.querySelector('.gx-error-state-source')?.textContent).toBe('snapshot-layout')
    expect(error.textContent).toContain('could not be prepared in this browser')
    expect(error.textContent).not.toContain('private-snapshot-sentinel')
    expect(api.saveLayout).not.toHaveBeenCalled()
  })

  it('aborts the old load and ignores its delayed rejection after a newer account has loaded', async () => {
    let rejectOld!: (error: Error) => void
    vi.mocked(api.layoutGeometry).mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
    const view = render(<Workspace account="first"><p>Chat content</p></Workspace>)
    await waitFor(() => expect(api.layoutGeometry).toHaveBeenCalledTimes(1))
    const oldSignal = vi.mocked(api.layoutGeometry).mock.calls[0]![3]!
    view.rerender(<Workspace account="second"><p>Chat content</p></Workspace>)
    await waitFor(() => expect(screen.getByTestId('adapter-boundary').getAttribute('data-account')).toBe('second'))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => { rejectOld(new Error('private-stale-sentinel')); await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('adapter-boundary').getAttribute('data-account')).toBe('second')
  })

  it('retains one busy Retry during a pending load and replaces its observed record only on a new failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'))
    let rejectRetry!: (error: Error) => void
    vi.mocked(api.layoutContext).mockRejectedValueOnce(new Error('private-first-sentinel'))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectRetry = reject }))
    render(<Workspace><p>Chat content</p></Workspace>)
    const error = await screen.findByRole('alert')
    const first = error.querySelector('time')!.getAttribute('datetime')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const busy = await screen.findByRole('button', { name: 'Retrying…' })
    expect(busy.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(busy)
    expect(api.layoutContext).toHaveBeenCalledTimes(2)
    expect(error.querySelector('time')!.getAttribute('datetime')).toBe(first)
    vi.setSystemTime(new Date('2026-10-22T13:00:00.000Z'))
    await act(async () => { rejectRetry(new Error('private-second-sentinel')); await Promise.resolve() })
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(error.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-22T13:00:00.000Z')
    expect(error.textContent).not.toContain('private-')
  })
})
