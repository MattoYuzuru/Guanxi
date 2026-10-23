import { useId } from 'react'
import type { StoredGlossaryEntryWire } from '@guanxi/contract'
import { Badge, Button } from '@guanxi/ui'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { GlossaryHistory } from './GlossaryHistory.tsx'
import type { GlossaryLanguage } from './model.ts'

const LANGUAGE_KEYS = { en: 'voiceGlossary.language.en', ru: 'voiceGlossary.language.ru', any: 'voiceGlossary.language.any' } as const satisfies Record<GlossaryLanguage, LocaleKey>

export interface GlossaryEntryCardProps {
  stored: StoredGlossaryEntryWire
  overridden: boolean
  /** Every network action is off, with the reason named by `offlineReasonId`. */
  offline: boolean
  offlineReasonId: string
  /** A change to this entry is in flight. */
  busy: boolean
  historyOpen: boolean
  onToggleHistory: () => void
  onEdit: () => void
  onToggleActive: () => void
  onRevert: () => void
}

export function GlossaryEntryCard({ stored, overridden, offline, offlineReasonId, busy, historyOpen, onToggleHistory, onEdit, onToggleActive, onRevert }: GlossaryEntryCardProps) {
  const id = useId()
  const { entry } = stored
  const name = entry.canonical
  const blocked = offline || busy
  const reason = offline ? offlineReasonId : undefined
  const toggleKey = stored.active ? 'deactivate' : 'reactivate'
  const revertHint = stored.revision === 1 ? 'voiceGlossary.action.revert.first' : 'voiceGlossary.action.revert.hint'
  const updatedAt = new Date(stored.updatedAt).toISOString()
  return <article aria-labelledby={`${id}-name`} aria-busy={busy} data-entry-id={stored.id} data-active={stored.active} className="flex min-w-0 flex-col gap-2 rounded-panel border border-divider bg-surface p-3">
    <header className="flex min-w-0 flex-wrap items-center gap-2">
      <h3 id={`${id}-name`} tabIndex={-1} data-focus-key={`card:${stored.id}`} className="min-w-0 break-words text-16 font-heading focus-visible:outline-focus">{name}</h3>
      <Badge>{t('voiceGlossary.entry.language', { language: t(LANGUAGE_KEYS[entry.language]) })}</Badge>
      {!stored.active && <Badge tone="warning">{t('voiceGlossary.entry.inactive')}</Badge>}
      {overridden && <Badge tone="info" aria-describedby={`${id}-override`}>{t('voiceGlossary.entry.overridden')}</Badge>}
    </header>
    {overridden && <p id={`${id}-override`} className="text-12 text-secondary">{t('voiceGlossary.entry.overridden.hint')}</p>}
    {entry.variants.length > 0
      ? <ul aria-label={t('voiceGlossary.entry.variants')} className="flex min-w-0 flex-wrap gap-1">
        {entry.variants.map((variant, index) => <li key={`${index}:${variant}`} className="max-w-full break-words rounded-control border border-divider bg-inset px-2 py-0.5 text-12">{variant}</li>)}
      </ul>
      : <p className="text-12 text-secondary">{t('voiceGlossary.entry.noVariants')}</p>}
    {(entry.caseSensitive === true || entry.inflect === false) && <ul className="flex flex-wrap gap-1 text-12 text-secondary">
      {entry.caseSensitive === true && <li>{t('voiceGlossary.entry.caseSensitive')}</li>}
      {entry.inflect === false && <li>{t('voiceGlossary.entry.noInflect')}</li>}
    </ul>}
    <p className="text-12 text-secondary">{t('voiceGlossary.entry.meta', { revision: stored.revision, time: formatDateTime(updatedAt) })}</p>

    <div className="flex min-w-0 flex-wrap gap-2">
      <Button size="sm" data-focus-key={`edit:${stored.id}`} disabled={blocked || !stored.active} aria-label={t('voiceGlossary.action.edit.aria', { name })} aria-describedby={reason}
        onClick={onEdit}>{t('voiceGlossary.action.edit')}</Button>
      <Button size="sm" data-focus-key={`toggle:${stored.id}`} disabled={blocked} aria-label={t(`voiceGlossary.action.${toggleKey}.aria`, { name })}
        aria-describedby={[reason, `${id}-toggle`].filter(Boolean).join(' ')} title={t(`voiceGlossary.action.${toggleKey}.hint`)} onClick={onToggleActive}>
        {t(`voiceGlossary.action.${toggleKey}`)}</Button>
      <Button size="sm" data-focus-key={`revert:${stored.id}`} disabled={blocked} aria-label={t('voiceGlossary.action.revert.aria', { name })}
        aria-describedby={[reason, `${id}-revert`].filter(Boolean).join(' ')} title={t(revertHint)} onClick={onRevert}>{t('voiceGlossary.action.revert')}</Button>
      <Button size="sm" variant="ghost" data-focus-key={`history:${stored.id}`} aria-expanded={historyOpen} aria-controls={historyOpen ? `${id}-history` : undefined}
        aria-label={t('voiceGlossary.action.history.aria', { name })} onClick={onToggleHistory}>{t('voiceGlossary.action.history')}</Button>
    </div>
    <span id={`${id}-toggle`} className="sr-only">{t(`voiceGlossary.action.${toggleKey}.hint`)}</span>
    <span id={`${id}-revert`} className="sr-only">{t(revertHint)}</span>
    {!stored.active && <p className="text-12 text-secondary">{t('voiceGlossary.action.edit.inactive')}</p>}
    {historyOpen && <GlossaryHistory entry={stored} panelId={`${id}-history`} />}
  </article>
}
