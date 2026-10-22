import {
  Button, Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger,
  IconButton, Menu, MenuContent, MenuItem, MenuTrigger, UiLocaleProvider, useUiText,
  type UiLocale,
} from '@guanxi/ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'

// The normal public components receive the same regime attributes as a catalog frame.
// No app shell, API fixture, controlled-open popup or replacement interaction engine is used.
const params = new URLSearchParams(location.search)
const locale: UiLocale = params.get('locale') === 'ru' ? 'ru' : params.get('locale') === 'pseudo' ? 'pseudo' : 'en'
const root = document.documentElement
root.lang = locale === 'pseudo' ? 'en-XA' : locale
root.dataset.theme = params.get('theme') ?? 'light'
root.dataset.density = params.get('density') ?? 'compact'
root.dataset.material = params.get('glass') ?? 'glass'
root.dataset.motion = 'reduced'
if (params.get('transparency') === 'reduced') root.dataset.reduceTransparency = ''

function Fixture() {
  const t = useUiText()
  const [menuActions, setMenuActions] = useState(0)
  const [disabledActions, setDisabledActions] = useState(0)
  const [iconActions, setIconActions] = useState(0)
  const [toggleActions, setToggleActions] = useState(0)
  const [pressed, setPressed] = useState(true)
  // A synthetic glyph keeps this fixture independent of any third-party icon import.
  const glyph = <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" /></svg>
  return <main className="flex flex-col items-start gap-4 p-4">
    <h1>{t('story.menu.group')}</h1>
    <Menu modal={false}>
      <MenuTrigger render={<Button variant="secondary" size="sm" />} data-testid="menu-trigger">
        {t('story.menu.trigger')}
      </MenuTrigger>
      <MenuContent>
        <MenuItem onClick={() => setMenuActions(n => n + 1)}>{t('story.menu.rename')}</MenuItem>
        <MenuItem onClick={() => setMenuActions(n => n + 1)}>{t('story.menu.duplicate')}</MenuItem>
        <MenuItem disabled onClick={() => setDisabledActions(n => n + 1)}>{t('story.menu.export')}</MenuItem>
        <MenuItem variant="danger" onClick={() => setMenuActions(n => n + 1)}>{t('story.menu.delete')}</MenuItem>
      </MenuContent>
    </Menu>
    <IconButton data-testid="icon" label={t('story.iconButton.settings')} icon={glyph}
      size="sm" onClick={() => setIconActions(n => n + 1)} />
    <IconButton data-testid="disabled-icon" label={t('story.menu.export')} icon={glyph}
      size="sm" disabled onClick={() => setDisabledActions(n => n + 1)} />
    <IconButton data-testid="toggle" label={t('story.iconButton.pin')} icon={glyph}
      size="sm" pressed={pressed} onClick={() => { setToggleActions(n => n + 1); setPressed(value => !value) }} />
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" size="sm" />} data-testid="dialog-trigger">
        {t('story.dialog.trigger')}
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{t('story.dialog.infoTitle')}</DialogTitle>
        <DialogDescription>{t('story.dialog.infoBody')}</DialogDescription>
      </DialogContent>
    </Dialog>
    <output data-testid="menu-actions">{menuActions}</output>
    <output data-testid="disabled-actions">{disabledActions}</output>
    <output data-testid="icon-actions">{iconActions}</output>
    <output data-testid="toggle-actions">{toggleActions}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider locale={locale}><Fixture /></UiLocaleProvider>)
