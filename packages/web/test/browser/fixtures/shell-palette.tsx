import { Button, UiLocaleProvider } from '@guanxi/ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ShellPalette } from '../../../src/features/shell/ShellPalette.tsx'
import { setActiveLocale } from '../../../src/lib/locale.ts'
import { ThemeProvider } from '../../../src/lib/theme.tsx'
import { useShellController } from '../../../src/features/shell/useShellController.ts'
import '../../../src/index.css'

const locale = new URLSearchParams(location.search).get('locale') === 'ru' ? 'ru' : 'en'
setActiveLocale(locale)
document.documentElement.lang = locale
function Fixture() {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState('')
  return <UiLocaleProvider locale={locale}><main className="p-4">
    <h1>Shell palette interaction fixture</h1>
    <Button onClick={() => setOpen(true)}>Open commands</Button>
    <p role="status">{selected}</p>
    <ShellPalette open={open} onOpenChange={setOpen} commands={[
      { id: 'new', label: 'New', execute: () => setSelected('New selected') },
      { id: 'projects', label: 'Projects', execute: () => setSelected('Projects selected') },
      { id: 'move', label: 'Move block', disabled: true, reason: 'Open a workspace first.', execute: () => setSelected('Unavailable command executed') },
      { id: 'models', label: 'Models', execute: () => setSelected('Models selected') },
      { id: 'settings', label: 'Settings', execute: () => setSelected('Settings selected') },
    ]} />
  </main></UiLocaleProvider>
}
function SearchFixture() {
  const shell = useShellController()
  return <UiLocaleProvider locale={locale}><main className="p-4">
    <h1>Shell complete session search fixture</h1>
    <Button onClick={() => shell.setPaletteOpen(true)}>Open commands</Button>
    <ShellPalette open={shell.paletteOpen} onOpenChange={shell.setPaletteOpen}
      commands={shell.commands} sessionSearch={shell.sessionSearch} />
  </main></UiLocaleProvider>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(new URLSearchParams(location.search).has('search')
  ? <ThemeProvider><SearchFixture /></ThemeProvider> : <Fixture />)
