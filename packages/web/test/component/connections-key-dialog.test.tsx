import { useState, type ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { providerCatalog } from '@guanxi/contract'
import { ConnectionKeyDialog } from '../../src/features/connections/KeyDialog.tsx'
import type { ConnectionMutate } from '../../src/features/connections/ConnectionsPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'

// The real dialog unmounts its content on close, so a normal DOM assertion cannot see
// whether the in-memory key was cleared. Keep the popup mounted to inspect that state.
const fixture = vi.hoisted(() => ({ forceOpen: false }))
vi.mock('@guanxi/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('@guanxi/ui')>()
  const ActualDialog = actual.Dialog
  return {
    ...actual,
    Dialog: (props: ComponentProps<typeof ActualDialog>) =>
      <ActualDialog {...props} open={fixture.forceOpen || Boolean(props.open)} />,
  }
})

const entry = providerCatalog.find(item => item.provider === 'deepseek')!
const run: ConnectionMutate = async action => { await action(); return { ok: true } }

function Harness() {
  const [open, setOpen] = useState(true)
  return <ConnectionKeyDialog entry={entry} open={open} busy={false} run={run} onOpenChange={setOpen} />
}

it('clears a typed key when the dialog closes, not only when it reopens', async () => {
  setActiveLocale('en')
  fixture.forceOpen = true
  render(<Harness />)
  const dialog = await screen.findByRole('dialog')
  const field = within(dialog).getByLabelText('API key') as HTMLInputElement
  fireEvent.change(field, { target: { value: 'sk-typed-but-cancelled' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(field.value).toBe(''))
  expect(screen.getByRole('dialog')).toBe(dialog)
  fixture.forceOpen = false
})
