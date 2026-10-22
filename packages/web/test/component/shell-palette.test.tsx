import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ShellPalette, type ShellCommand } from '../../src/features/shell/ShellPalette.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
})

function Host({ commands }: { commands: ShellCommand[] }) {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Open commands</button>
    <ShellPalette commands={commands} open={open} onOpenChange={setOpen} /></>
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
})
