import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ShellPalette, type ShellCommand, type ShellSessionSearch } from '../../src/features/shell/ShellPalette.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
})

function Host({ commands, sessionSearch }: { commands: ShellCommand[]; sessionSearch?: ShellSessionSearch }) {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Open commands</button>
    <ShellPalette commands={commands} sessionSearch={sessionSearch} open={open} onOpenChange={setOpen} /></>
}

describe('shell palette', () => {
  it('searches navigation, skips unavailable commands by keyboard and executes only the chosen action', async () => {
    setActiveLocale('en')
    const model = vi.fn(), missing = vi.fn(), settings = vi.fn()
    render(<Host commands={[
      { id: 'model', label: 'Model Llama', keywords: 'local models', execute: model },
      { id: 'missing', label: 'Move block', disabled: true, reason: 'Open a workspace first', execute: missing },
      { id: 'settings', label: 'Settings', execute: settings },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open commands' }))
    const search = await screen.findByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(screen.getByRole('option', { name: 'Move block' }).getAttribute('aria-disabled') ?? screen.getByRole('option', { name: 'Move block' }).hasAttribute('disabled')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(search, { key: 'Home' })
    fireEvent.change(search, { target: { value: 'local models' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'Model Llama' })).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(model).toHaveBeenCalledTimes(1))
    expect(settings).not.toHaveBeenCalled()
    expect(missing).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains unavailable actions, announces no matches and clears the search when reopened', async () => {
    setActiveLocale('en')
    render(<Host commands={[{ id: 'move', label: 'Move block', execute: vi.fn(), disabled: true, reason: 'Open a workspace first' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open commands' }))
    const search = await screen.findByRole('combobox')
    expect(screen.getByText('Open a workspace first')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'no matching text' } })
    expect(screen.getByText('No matching commands. Try another search.')).toBeTruthy()
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Open commands' }))
    expect((await screen.findByRole('combobox') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('option', { name: 'Move block' })).toBeTruthy()
  })

  it.each(['en', 'ru'] as const)('makes partial/failure/available search coverage explicit in %s without closing the query', async locale => {
    setActiveLocale(locale)
    const search = vi.fn(), cancel = vi.fn()
    const state: ShellSessionSearch = { loaded: 50, loading: false, hasMore: true, searching: false, error: false, omitted: false, search, cancel }
    const { rerender } = render(<Host commands={[]} sessionSearch={state} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open commands' }))
    const input = await screen.findByRole('combobox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'older matching session' } })
    const availableCopy = locale === 'en' ? 'Searching all 237 sessions available from the loaded pages.' : 'Поиск среди всех сессий, доступных на загруженных страницах: 237.'
    expect(screen.queryByText(availableCopy)).toBeNull()
    expect(screen.getByText(locale === 'en' ? 'Searching 50 loaded sessions. Older sessions are not loaded yet.' : 'Поиск среди загруженных сессий: 50. Более старые сессии ещё не загружены.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Search all available sessions' : 'Искать во всех доступных сессиях' }))
    expect(search).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(input.value).toBe('older matching session')
    rerender(<Host commands={[]} sessionSearch={{ ...state, searching: true, loaded: 100 }} />)
    expect(screen.queryByText(availableCopy)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Stop loading sessions' : 'Остановить загрузку сессий' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    rerender(<Host commands={[]} sessionSearch={{ ...state, error: true, loaded: 100 }} />)
    expect(screen.getByText(locale === 'en' ? 'Could not load all sessions. Searching 100 loaded sessions; search all again to load the rest.' : 'Не удалось загрузить все сессии. Поиск среди загруженных: 100; запустите поиск по всем снова, чтобы загрузить остальные.')).toBeTruthy()
    expect(screen.queryByText(availableCopy)).toBeNull()
    // D-203: no Retry; the user action keeps its own label.
    expect(screen.queryAllByRole('button', { name: /retry|повторить/iu })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Search all available sessions' : 'Искать во всех доступных сессиях' }))
    expect(search).toHaveBeenCalledTimes(2)
    rerender(<Host commands={[]} sessionSearch={{ ...state, error: true, refreshFailed: true, hasMore: false, loaded: 100 }} />)
    expect(screen.getByText(locale === 'en' ? 'Could not refresh sessions. Searching 100 previously loaded sessions; the list recovers by itself.' : 'Не удалось обновить сессии. Поиск среди ранее загруженных: 100; список восстановится сам.')).toBeTruthy()
    expect(screen.queryByText(availableCopy)).toBeNull()
    expect(screen.queryAllByRole('button', { name: /retry|повторить/iu })).toHaveLength(0)
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Search all available sessions' : 'Искать во всех доступных сессиях' })).toBeTruthy()
    rerender(<Host commands={[]} sessionSearch={{ ...state, hasMore: false, loaded: 237, omitted: true }} />)
    expect(screen.getByText(availableCopy)).toBeTruthy()
    expect(screen.getByText(locale === 'en' ? 'Some sessions are temporarily unavailable.' : 'Некоторые сессии временно недоступны.')).toBeTruthy()
    expect(input.value).toBe('older matching session')
    expect(screen.queryByRole('button', { name: locale === 'en' ? 'Search all available sessions' : 'Искать во всех доступных сессиях' })).toBeNull()
  })
})
