import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, ErrorState, Input, Textarea } from '@guanxi/ui'
import { Select } from '../../components/ui.tsx'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import {
  draftsEqual, failureMessage, hasErrors, validateDraft,
  type EntryDraft, type FieldErrors, type Failure, type GlossaryLanguage, type Message,
} from './model.ts'
import { ToggleButton } from './ToggleButton.tsx'
import type { ProjectChoices } from './useGlossary.ts'

const LANGUAGE_KEYS = { en: 'voiceGlossary.language.en', ru: 'voiceGlossary.language.ru', any: 'voiceGlossary.language.any' } as const satisfies Record<GlossaryLanguage, LocaleKey>
const message = (value: Message | undefined) => value ? t(value.key, value.values) : undefined

/** One labelled control with its hint and error wired through `aria-describedby`. */
function FormField({ label, hint, error, controlId, children }: {
  label: string; hint?: ReactNode; error?: string; controlId?: string
  children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}) {
  const generated = useId(), id = controlId ?? generated, hintId = `${id}-hint`, errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-14 font-heading">{label}</label>
    {children({ id, describedBy, invalid: Boolean(error) })}
    {hint && <div id={hintId} className="flex flex-col gap-1 text-12 text-secondary">{hint}</div>}
    {error && <p id={errorId} className="text-12 text-danger">{error}</p>}
  </div>
}

export interface GlossaryEntryFormProps {
  /** `null` creates; a stored name edits and fixes the scope. */
  editing: { name: string; scopeLabel: string } | null
  initial: EntryDraft
  projects: ProjectChoices
  offline: boolean
  saving: boolean
  /** Another change is in flight; saving waits for it instead of silently doing nothing. */
  blocked: boolean
  failure: Failure | null
  failureSource: string
  onSubmit: (draft: EntryDraft) => void
  onCancel: () => void
}

export function GlossaryEntryForm({ editing, initial, projects, offline, saving, blocked, failure, failureSource, onSubmit, onCancel }: GlossaryEntryFormProps) {
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [showSummary, setShowSummary] = useState(false)
  const canonicalRef = useRef<HTMLInputElement>(null)
  const variantsRef = useRef<HTMLTextAreaElement>(null)
  const failureRef = useRef<HTMLDivElement>(null)
  const titleId = useId(), cancelHintId = useId(), offlineId = useId(), projectId = `${titleId}-project`
  const dirty = !draftsEqual(draft, initial)
  const projectRequired = editing === null && draft.scope === 'project'
  const set = <K extends keyof EntryDraft>(key: K, value: EntryDraft[K]) => setDraft((previous) => ({ ...previous, [key]: value }))
  // The first field takes focus when the form opens, so keyboard users start typing at once.
  useEffect(() => { canonicalRef.current?.focus() }, [])
  useEffect(() => { if (failure) failureRef.current?.focus() }, [failure])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (saving || offline || blocked) return
    const found = validateDraft(draft, projectRequired)
    setErrors(found)
    setShowSummary(hasErrors(found))
    if (hasErrors(found)) {
      const target = found.project ? document.getElementById(projectId) : found.canonical ? canonicalRef.current : variantsRef.current
      target?.focus()
      return
    }
    onSubmit(draft)
  }
  const inflectAvailable = draft.language === 'en' && !draft.caseSensitive
  const inflectNote: LocaleKey | null = draft.language !== 'en' ? 'voiceGlossary.field.inflect.notEnglish' : draft.caseSensitive ? 'voiceGlossary.field.inflect.caseSensitive' : null
  const scopeOptions = [{ value: 'account', label: t('voiceGlossary.scope.account') }, { value: 'project', label: t('voiceGlossary.scope.project') }]
  const projectUnavailable = projects.status === 'unavailable'

  return <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3 rounded-panel border border-control bg-surface p-3" data-testid="glossary-form">
    <h2 id={titleId} className="text-18 font-heading">{editing ? t('voiceGlossary.form.edit', { name: editing.name }) : t('voiceGlossary.form.create')}</h2>
    <form aria-labelledby={titleId} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
      {editing === null
        ? <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('voiceGlossary.field.scope')}>
            {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={draft.scope} options={scopeOptions}
              onChange={(value) => setDraft((previous) => ({ ...previous, scope: value === 'project' ? 'project' : 'account', projectId: value === 'project' ? previous.projectId : '' }))} />}
          </FormField>
          {draft.scope === 'project' && <FormField label={t('voiceGlossary.field.project')} error={message(errors.project)} controlId={projectId}
            hint={projectUnavailable ? <p>{t('voiceGlossary.project.unavailable')}</p> : undefined}>
            {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={draft.projectId} disabled={projectUnavailable} onChange={(value) => set('projectId', value)}
              options={[{ value: '', label: t('voiceGlossary.project.choose') }, ...projects.projects.map((project) => ({ value: project.id, label: project.name }))]} />}
          </FormField>}
        </div>
        : <p className="text-14">{t('voiceGlossary.form.scopeFixed', { scope: editing.scopeLabel })}</p>}

      <FormField label={t('voiceGlossary.field.canonical')} hint={<p>{t('voiceGlossary.field.canonical.hint')}</p>} error={message(errors.canonical)}>
        {({ id, describedBy, invalid }) => <Input ref={canonicalRef} id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="off" spellCheck={false}
          value={draft.canonical} onChange={(event) => set('canonical', event.target.value)} />}
      </FormField>
      <FormField label={t('voiceGlossary.field.variants')} error={message(errors.variants)}
        hint={<><p>{t('voiceGlossary.field.variants.hint')}</p><p>{t('voiceGlossary.field.variants.example')}</p></>}>
        {({ id, describedBy, invalid }) => <Textarea ref={variantsRef} id={id} aria-describedby={describedBy} invalid={invalid} rows={4} autoComplete="off" spellCheck={false}
          value={draft.variants} onChange={(event) => set('variants', event.target.value)} />}
      </FormField>
      <FormField label={t('voiceGlossary.field.language')} hint={<p>{t('voiceGlossary.field.language.hint')}</p>}>
        {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={draft.language}
          options={(['en', 'ru', 'any'] as const).map((value) => ({ value, label: t(LANGUAGE_KEYS[value]) }))}
          onChange={(value) => set('language', value === 'ru' ? 'ru' : value === 'any' ? 'any' : 'en')} />}
      </FormField>
      <div className="flex min-w-0 flex-col gap-2">
        <ToggleButton pressed={draft.caseSensitive} describedBy={`${titleId}-case`} onPressedChange={(next) => set('caseSensitive', next)}>{t('voiceGlossary.field.caseSensitive')}</ToggleButton>
        <p id={`${titleId}-case`} className="text-12 text-secondary">{t('voiceGlossary.field.caseSensitive.hint')}</p>
        <ToggleButton pressed={draft.inflect && inflectAvailable} disabled={!inflectAvailable} describedBy={inflectNote ? `${titleId}-inflect` : undefined}
          onPressedChange={(next) => set('inflect', next)}>{t('voiceGlossary.field.inflect')}</ToggleButton>
        {inflectNote && <p id={`${titleId}-inflect`} className="text-12 text-secondary">{t(inflectNote)}</p>}
      </div>

      {showSummary && <p role="alert" className="text-12 text-danger">{t('voiceGlossary.form.fix')}</p>}
      {failure && <div ref={failureRef} tabIndex={-1} className="focus-visible:outline-focus">
        <ErrorState title={`${t('voiceGlossary.form.failed')}. ${t(failureMessage(failure.code, 'write'))}`} source={failureSource} occurredAt={failure.at} timeMeaning="observed" details={failure.code} />
      </div>}
      {offline && <p id={offlineId} className="text-12 text-secondary">{t('voiceGlossary.offline.reason')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={saving} loadingLabel={t('voiceGlossary.form.saving')} disabled={offline || blocked} aria-describedby={offline ? offlineId : undefined}>
          {editing ? t('voiceGlossary.form.save') : t('voiceGlossary.form.create.submit')}
        </Button>
        <Button onClick={onCancel} disabled={saving} aria-describedby={cancelHintId}>{t('voiceGlossary.form.cancel')}</Button>
        <p id={cancelHintId} className="text-12 text-secondary" data-dirty={dirty || undefined}>{t('voiceGlossary.form.cancel.hint')}</p>
      </div>
    </form>
  </section>
}
