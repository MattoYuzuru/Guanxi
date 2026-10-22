import { Button, EmptyState, ErrorState, Textarea, UiLocaleProvider, useUiText, type UiLocale } from '@guanxi/ui'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../src/index.css'

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
  const [value, setValue] = useState('')
  const [changes, setChanges] = useState(0)
  const [emptyActions, setEmptyActions] = useState(0)
  const [retries, setRetries] = useState(0)
  const [pending, setPending] = useState(false)
  const [details, setDetails] = useState('source=fixture-layouts\nstatus=503')
  return <main className="flex flex-col gap-4 p-4">
    <h1>{t('story.workspace.blocks')}</h1>
    <label>{t('story.textarea.label')}<Textarea data-testid="controlled" value={value}
      onChange={event => { setValue(event.target.value); setChanges(n => n + 1) }} /></label>
    <label>{t('story.input.label')}<Textarea data-testid="uncontrolled" rows={5} defaultValue={t('story.textarea.value')} /></label>
    <label>{t('story.menu.export')}<Textarea data-testid="disabled" disabled defaultValue={t('story.textarea.value')} /></label>
    <label>{t('story.input.value')}<Textarea data-testid="readonly" readOnly defaultValue={t('story.textarea.value')} /></label>
    <EmptyState title={t('story.empty.title')} icon={<svg aria-label={t('story.iconButton.settings')} viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /></svg>}
      action={<Button onClick={() => setEmptyActions(n => n + 1)}>{t('story.empty.action')}</Button>} />
    <ErrorState title={t('story.workspace.error')} source="GET /api/layouts" occurredAt="2026-10-22T12:00:00.000Z"
      timeMeaning="observed" details={details} action={<Button loading={pending} loadingLabel={t('story.error.retrying')}
        onClick={() => { setPending(true); setRetries(n => n + 1) }}>{t('story.error.retry')}</Button>} />
    <Button data-testid="change-details" onClick={() => { setDetails('source=fixture-geometry\nstatus=502'); setPending(false) }}>{t('story.button.label')}</Button>
    <output data-testid="value">{value}</output><output data-testid="changes">{changes}</output>
    <output data-testid="empty-actions">{emptyActions}</output><output data-testid="retries">{retries}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<UiLocaleProvider locale={locale}><Fixture /></UiLocaleProvider>)
