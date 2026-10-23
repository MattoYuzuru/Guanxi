import { act, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { api } from '../../src/lib/api.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { ThemeProvider } from '../../src/lib/theme.tsx'
import { inspectorApi } from '../../src/features/inspector/api.ts'
import { useShellController } from '../../src/features/shell/useShellController.ts'
import { SHELL_PREFERENCES_KEY } from '../../src/features/shell/preferences.ts'
import { clearWorkspaceShellState, publishWorkspaceShellState } from '../../src/features/workspace/shell-state.ts'
import { MOVE_BLOCK_COMMAND, REVEAL_BLOCK_COMMAND } from '../../src/features/workspace/commands.ts'
const writer = Symbol('shell-test')
const wrapper = ({ children }: PropsWithChildren) => <ThemeProvider>{children}</ThemeProvider>

beforeEach(() => {
  setActiveLocale('en')
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  vi.spyOn(inspectorApi, 'page').mockResolvedValue({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } })
  vi.spyOn(api, 'listModels').mockResolvedValue({ models: [] })
})
afterEach(() => { clearWorkspaceShellState(writer); vi.unstubAllGlobals() })

describe('shell host commands', () => {
  it('retains the four core palette commands while hidden, persists preferences and fetches models only after explicit open', async () => {
    const { result } = renderHook(useShellController, { wrapper })
    await waitFor(() => expect(result.current.sessions.loading).toBe(false))
    expect(api.listModels).not.toHaveBeenCalled()
    act(() => result.current.commands.find(command => command.id === 'sidebar:hidden')!.execute())
    expect(result.current.preferences.visibility).toBe('hidden')
    expect(result.current.commands.filter(command => ['new', 'projects', 'models', 'settings'].includes(command.id)).map(command => [command.id, command.disabled ?? false]))
      .toEqual([['new', false], ['projects', false], ['models', false], ['settings', false]])
    expect(JSON.parse(window.localStorage.getItem(SHELL_PREFERENCES_KEY)!).visibility).toBe('hidden')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(result.current.paletteOpen).toBe(true))
    await waitFor(() => expect(api.listModels).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    expect(result.current.paletteOpen).toBe(false)
  })
  it('exposes block commands (and no Developer/Visual mode command) through the engine-free presentation state and explains unavailable moves', async () => {
    const reveal = vi.fn(), move = vi.fn()
    window.addEventListener(REVEAL_BLOCK_COMMAND, reveal)
    window.addEventListener(MOVE_BLOCK_COMMAND, move)
    const { result } = renderHook(useShellController, { wrapper })
    await waitFor(() => expect(result.current.sessions.loading).toBe(false))
    // D-204: one interface; the palette has no experience-mode commands at all.
    expect(result.current.commands.filter(command => command.id.startsWith('mode:'))).toHaveLength(0)
    act(() => publishWorkspaceShellState(writer, { ready: true, busy: false, phone: false, mode: 'developer',
      blocks: [{ id: 'first', label: 'Context', hidden: false }, { id: 'second', label: 'Plan', hidden: true }] }))
    const hiddenMove = result.current.commands.find(command => command.id === 'move:second')!
    expect(hiddenMove.disabled).toBe(true)
    expect(hiddenMove.reason).toBe('Show this block before moving it.')
    act(() => result.current.commands.find(command => command.id === 'block:second')!.execute())
    expect((reveal.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ instanceId: 'second' })
    act(() => result.current.commands.find(command => command.id === 'move:first')!.execute())
    expect((move.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ instanceId: 'first' })
    act(() => publishWorkspaceShellState(writer, { ready: true, busy: false, phone: true, mode: 'developer', blocks: [{ id: 'first', label: 'Context', hidden: false }] }))
    expect(result.current.commands.find(command => command.id === 'move:first')?.disabled).toBe(true)
    expect(result.current.commands.find(command => command.id === 'move:first')?.reason).toContain('ordered block tabs')
    window.removeEventListener(REVEAL_BLOCK_COMMAND, reveal)
    window.removeEventListener(MOVE_BLOCK_COMMAND, move)
  })
  it('recovers a failed session read by itself and offers no refresh command (D-203)', async () => {
    vi.mocked(inspectorApi.page).mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(useShellController, { wrapper })
    await waitFor(() => expect(result.current.sessions.error).toBe(true))
    expect(result.current.commands.filter(command => /refresh|retry/u.test(command.id))).toHaveLength(0)
    // A focus event (or the backoff timer) reads again without any user command.
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(result.current.sessions.error).toBe(false))
    await waitFor(() => expect(result.current.sessions.loading).toBe(false))
    expect(result.current.sessions.sessions).toEqual([])
  })

  it('cancels complete search synchronously on palette close and offers retry after the initial page fails', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof inspectorApi.page>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof inspectorApi.page>>>(done => { resolve = done })
    vi.mocked(inspectorApi.page).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessions: [], nextCursor: 'p1', omitted: { withheld: false, catchingUp: false } })
      .mockReturnValueOnce(pending)
    const { result } = renderHook(useShellController, { wrapper })
    await waitFor(() => expect(result.current.sessionSearch.error).toBe(true))
    expect(result.current.sessionSearch.hasMore).toBe(false)
    act(() => result.current.sessionSearch.search())
    await waitFor(() => expect(result.current.sessions.loading).toBe(false))
    expect(result.current.sessionSearch.hasMore).toBe(true)
    act(() => result.current.setPaletteOpen(true))
    act(() => result.current.sessionSearch.search())
    expect(result.current.sessionSearch.searching).toBe(true)
    act(() => result.current.setPaletteOpen(false))
    expect(vi.mocked(inspectorApi.page).mock.calls[2]?.[1]?.aborted).toBe(true)
    expect(result.current.sessionSearch.searching).toBe(false)
    await act(async () => { resolve({ sessions: [], nextCursor: null, omitted: { withheld: false, catchingUp: false } }); await pending })
    expect(result.current.sessionSearch.hasMore).toBe(true)
  })

})
