import { useEffect, useState } from 'react'
import type { GlossaryHistoryResponse, StoredGlossaryEntryWire } from '@guanxi/contract'
import { Badge, Button, ErrorState } from '@guanxi/ui'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { glossaryApi } from './api.ts'
import { changedFields, classify, failureMessage, type ChangedField, type Failure } from './model.ts'

type Revision = GlossaryHistoryResponse['revisions'][number]
const OP_KEYS = {
  create: 'voiceGlossary.history.op.create', update: 'voiceGlossary.history.op.update', deactivate: 'voiceGlossary.history.op.deactivate',
  reactivate: 'voiceGlossary.history.op.reactivate', revert: 'voiceGlossary.history.op.revert',
} as const satisfies Record<Revision['op'], LocaleKey>
const SOURCE_KEYS = {
  user: 'voiceGlossary.history.source.user', import: 'voiceGlossary.history.source.import', candidate: 'voiceGlossary.history.source.candidate',
} as const satisfies Record<Revision['source'], LocaleKey>
const FIELD_KEYS = {
  canonical: 'voiceGlossary.history.field.canonical', variants: 'voiceGlossary.history.field.variants', language: 'voiceGlossary.history.field.language',
  caseSensitive: 'voiceGlossary.history.field.caseSensitive', inflect: 'voiceGlossary.history.field.inflect',
} as const satisfies Record<ChangedField, LocaleKey>
const LANGUAGE_KEYS = { en: 'voiceGlossary.language.en', ru: 'voiceGlossary.language.ru', any: 'voiceGlossary.language.any' } as const satisfies Record<'en' | 'ru' | 'any', LocaleKey>

/**
 * Revisions of one entry, newest first. It loads when opened and again whenever the entry's
 * revision moves, so an edit, a revert or a reactivation shows up without closing the panel.
 */
export function GlossaryHistory({ entry, panelId }: { entry: StoredGlossaryEntryWire; panelId: string }) {
  const [state, setState] = useState<{ revisions: Revision[] | null; failure: Failure | null; loading: boolean }>({ revisions: null, failure: null, loading: true })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setState((previous) => ({ ...previous, loading: true }))
    glossaryApi.history(entry.id, abort.signal).then(
      (response) => { if (!abort.signal.aborted) setState({ revisions: response.revisions, failure: null, loading: false }) },
      (error: unknown) => { if (!abort.signal.aborted) setState((previous) => ({ ...previous, failure: { code: classify(error), at: new Date().toISOString() }, loading: false })) },
    )
    return () => abort.abort()
  }, [entry.id, entry.revision, attempt])

  const { revisions, failure, loading } = state
  const ordered = revisions === null ? null : [...revisions].sort((a, b) => b.revision - a.revision)
  return <section id={panelId} aria-labelledby={`${panelId}-title`} aria-busy={loading} className="flex min-w-0 flex-col gap-2 rounded-control border border-divider bg-inset p-3" data-testid="glossary-history">
    <h4 id={`${panelId}-title`} className="text-14 font-heading">{t('voiceGlossary.history.title', { name: entry.entry.canonical })}</h4>
    {ordered === null && loading && <p role="status" className="text-12 text-secondary">{t('voiceGlossary.history.loading')}</p>}
    {failure && <ErrorState title={t('voiceGlossary.history.error')} source={t('voiceGlossary.source.history')} occurredAt={failure.at} timeMeaning="observed"
      details={failure.code} action={<Button size="sm" onClick={() => setAttempt((value) => value + 1)} loading={loading}>{t('voiceGlossary.retry')}</Button>} />}
    {failure && <p className="text-12 text-secondary">{t(failureMessage(failure.code, 'read'))}</p>}
    {ordered && <ol aria-labelledby={`${panelId}-title`} className="flex min-w-0 flex-col gap-2">
      {ordered.map((revision) => {
        const previous = ordered.find((candidate) => candidate.revision < revision.revision && candidate.entry !== null)
        const changed = revision.op === 'update' || revision.op === 'revert' ? changedFields(previous?.entry ?? null, revision.entry) : []
        return <li key={revision.revision} data-revision={revision.revision} className="flex min-w-0 flex-col gap-1 rounded-control border border-divider bg-surface p-2">
          <p className="flex flex-wrap items-center gap-2 text-13">
            <span className="font-heading">{t('voiceGlossary.history.revision', { revision: revision.revision })}</span>
            <span>{t(OP_KEYS[revision.op])} {t(SOURCE_KEYS[revision.source])}</span>
            {revision.revision === entry.revision && <Badge tone="accent">{t('voiceGlossary.history.current')}</Badge>}
            <time className="text-12 text-secondary" dateTime={new Date(revision.createdAt).toISOString()}>{formatDateTime(new Date(revision.createdAt).toISOString())}</time>
          </p>
          {revision.entry && <p className="break-words text-12 text-secondary">{t('voiceGlossary.history.snapshot', {
            canonical: revision.entry.canonical,
            variants: revision.entry.variants.length === 0 ? t('voiceGlossary.history.noVariants') : revision.entry.variants.join(', '),
            language: t(LANGUAGE_KEYS[revision.entry.language]) })}</p>}
          {changed.length > 0 && <p className="text-12">{t('voiceGlossary.history.changed', { fields: changed.map((field) => t(FIELD_KEYS[field])).join(', ') })}</p>}
        </li>
      })}
    </ol>}
  </section>
}
