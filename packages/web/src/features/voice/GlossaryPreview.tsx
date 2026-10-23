import { useEffect, useId, useMemo, useState } from 'react'
import type { GlossaryPreviewResponse } from '@guanxi/contract'
import { Button, ErrorState, Textarea } from '@guanxi/ui'
import { Select } from '../../components/ui.tsx'
import { translate as t } from '../../lib/locale.ts'
import { useDebounced } from '../../lib/useAsync.ts'
import { glossaryApi } from './api.ts'
import { Provenance } from './Provenance.tsx'
import { classify, failureMessage, previewSegments, previewTooLong, PREVIEW_LIMIT, type Failure } from './model.ts'
import type { ProjectChoices } from './useGlossary.ts'

export const PREVIEW_DELAY_MS = 300

type Phase =
  | { kind: 'idle' }
  | { kind: 'ready'; result: GlossaryPreviewResponse; observedAt: string }
  | { kind: 'failed'; failure: Failure }

/**
 * Live preview of `apply-preview`. The request follows the text after a short pause, the
 * previous request is cancelled, and a result is only shown for the text it was computed for.
 * `version` changes whenever the glossary was edited, so the preview never describes a glossary
 * that no longer exists.
 */
export function GlossaryPreview({ projects, scopeProjectId, onScopeChange, version }: {
  projects: ProjectChoices
  scopeProjectId: string
  onScopeChange: (projectId: string) => void
  version: number
}) {
  const [text, setText] = useState('')
  const delayed = useDebounced(text, PREVIEW_DELAY_MS)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // What the shown result was computed for. It is only current while all three still match.
  const [computedFor, setComputedFor] = useState<{ text: string; scope: string; version: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const id = useId()
  const tooLong = previewTooLong(delayed)
  const blank = delayed.trim() === ''

  useEffect(() => {
    if (blank || tooLong) { setPhase({ kind: 'idle' }); setComputedFor(null); setPending(false); return }
    const abort = new AbortController()
    setPending(true)
    glossaryApi.preview({ text: delayed, projectId: scopeProjectId === '' ? null : scopeProjectId }, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return
        setPhase({ kind: 'ready', result, observedAt: new Date().toISOString() })
        setComputedFor({ text: delayed, scope: scopeProjectId, version })
        setPending(false)
      },
      (error: unknown) => {
        if (abort.signal.aborted) return
        setPhase({ kind: 'failed', failure: { code: classify(error), at: new Date().toISOString() } })
        setComputedFor(null)
        setPending(false)
      },
    )
    return () => abort.abort()
  }, [delayed, scopeProjectId, version, attempt, blank, tooLong])

  const typing = text !== delayed
  const current = computedFor !== null && computedFor.text === delayed && computedFor.scope === scopeProjectId && computedFor.version === version
  const stale = phase.kind === 'ready' && (typing || !current)
  const shown = phase.kind === 'ready' ? phase.result : null
  const view = useMemo(() => shown ? previewSegments(shown) : null, [shown])
  const scopeOptions = [{ value: '', label: t('voiceGlossary.preview.scope.account') },
    ...projects.projects.map((project) => ({ value: project.id, label: t('voiceGlossary.preview.scope.project', { name: project.name }) }))]
  // A project id that the list no longer knows stays selectable, so the scope shown is the scope used.
  if (scopeProjectId !== '' && !projects.names.has(scopeProjectId)) scopeOptions.push({ value: scopeProjectId, label: t('voiceGlossary.preview.scope.project', { name: scopeProjectId }) })

  return <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-3 rounded-panel border border-divider bg-surface p-3" data-testid="glossary-preview">
    <h2 id={`${id}-title`} className="text-18 font-heading">{t('voiceGlossary.preview.title')}</h2>
    <p className="text-12 text-secondary">{t('voiceGlossary.preview.description')}</p>
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-text`} className="text-14 font-heading">{t('voiceGlossary.preview.text')}</label>
      <Textarea id={`${id}-text`} rows={3} value={text} spellCheck={false} aria-describedby={tooLong ? `${id}-long` : undefined} invalid={tooLong}
        onChange={(event) => setText(event.target.value)} />
      {tooLong && <p id={`${id}-long`} className="text-12 text-danger">{t('voiceGlossary.preview.tooLong', { limit: PREVIEW_LIMIT })}</p>}
    </div>
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`${id}-scope`} className="text-14 font-heading">{t('voiceGlossary.preview.scope')}</label>
      <Select id={`${id}-scope`} value={scopeProjectId} onChange={onScopeChange} options={scopeOptions} />
    </div>

    {/* One persistent live region for the outcome. It stays empty while the result is stale, so a
        count is only ever announced for the text, scope and glossary that produced it. */}
    <p role="status" className="min-h-4 text-13" data-testid="glossary-preview-count">
      {shown && !stale ? (shown.replacements.length === 0 ? t('voiceGlossary.preview.none') : t('voiceGlossary.preview.count', { count: shown.replacements.length })) : ''}
    </p>
    <div className="flex min-w-0 flex-col gap-2" data-testid="glossary-preview-result" data-stale={stale || undefined}>
      {phase.kind === 'idle' && !tooLong && <p className="text-12 text-secondary">{blank ? t('voiceGlossary.preview.idle') : t('voiceGlossary.preview.loading')}</p>}
      {phase.kind === 'failed' && <>
        <ErrorState title={`${t('voiceGlossary.preview.error')}. ${t(failureMessage(phase.failure.code, 'read'))}`} source={t('voiceGlossary.source.preview')}
          occurredAt={phase.failure.at} timeMeaning="observed" details={phase.failure.code}
          action={<Button size="sm" onClick={() => setAttempt((value) => value + 1)} loading={pending}>{t('voiceGlossary.retry')}</Button>} />
      </>}
      {shown && view && <>
        {stale && <p className="text-12 text-secondary" data-testid="glossary-preview-stale">{t('voiceGlossary.preview.stale')}</p>}
        <h3 className="text-14 font-heading">{t('voiceGlossary.preview.result')}</h3>
        <p className="min-w-0 whitespace-pre-wrap break-words rounded-control border border-divider bg-inset p-2 text-14" data-testid="glossary-preview-output">
          {view.segments.map((segment, index) => segment.replaced
            ? <mark key={index} data-replaced="" className="rounded-control bg-accent px-1 text-accent-foreground underline decoration-2 underline-offset-2">{segment.text}</mark>
            : <span key={index}>{segment.text}</span>)}
        </p>
        {shown.replacements.length > 0 && <>
          <h3 className="text-14 font-heading">{t('voiceGlossary.preview.replacements')}</h3>
          <ul className="flex min-w-0 flex-col gap-1">
            {shown.replacements.map((replacement, index) => <li key={`${replacement.start}:${index}`} className="break-words text-13">
              {t('voiceGlossary.preview.replacement', { original: replacement.original, replacement: replacement.replacement })}
            </li>)}
          </ul>
        </>}
        <div className="flex min-w-0 flex-col gap-1 text-12 text-secondary">
          <p>{t('voiceGlossary.preview.entryCount', { count: shown.entryCount })}</p>
          <p className="min-w-0"><span>{t('voiceGlossary.preview.revision')}</span> <code className="break-all font-mono" data-testid="glossary-revision">{shown.glossaryRevision}</code></p>
          {phase.kind === 'ready' && <Provenance source={t('voiceGlossary.source.preview')} observedAt={phase.observedAt} />}
        </div>
      </>}
    </div>
  </section>
}
