import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StoredGlossaryEntryWire } from '@guanxi/contract'
import { Button, EmptyState, ErrorState } from '@guanxi/ui'
import { Select } from '../../components/ui.tsx'
import { formatRelativeTime, formatTime } from '../../lib/format.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, paths } from '../../lib/router.tsx'
import { glossaryApi } from './api.ts'
import { GlossaryEntryCard } from './GlossaryEntryCard.tsx'
import { GlossaryEntryForm } from './GlossaryEntryForm.tsx'
import { GlossaryPreview } from './GlossaryPreview.tsx'
import { Provenance } from './Provenance.tsx'
import { ToggleButton } from './ToggleButton.tsx'
import {
  bodyFromDraft, classify, draftFromEntry, emptyDraft, failureMessage, groupEntries, inView, overriddenAccountEntryIds,
  type EntryDraft, type Failure,
} from './model.ts'
import { useGlossaryEntries, useProjectChoices } from './useGlossary.ts'

type Editor = { mode: 'create' } | { mode: 'edit'; id: string }
type Action = 'create' | 'update' | 'deactivate' | 'reactivate' | 'revert'
const SOURCE_KEYS = {
  create: 'voiceGlossary.source.create', update: 'voiceGlossary.source.update', deactivate: 'voiceGlossary.source.deactivate',
  reactivate: 'voiceGlossary.source.reactivate', revert: 'voiceGlossary.source.revert',
} as const satisfies Record<Action, LocaleKey>
const DONE_KEYS = {
  create: 'voiceGlossary.done.created', update: 'voiceGlossary.done.updated', deactivate: 'voiceGlossary.done.deactivated',
  reactivate: 'voiceGlossary.done.reactivated', revert: 'voiceGlossary.done.reverted',
} as const satisfies Record<Action, LocaleKey>

/** Looks up a focus target by its `data-focus-key`; no selector escaping is needed this way. */
function focusTarget(key: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-focus-key]')) {
    if (element.getAttribute('data-focus-key') === key) return element
  }
  return null
}

export function GlossaryPage() {
  useLocale()
  const [projectId, setProjectId] = useState('')
  const [showInactive, setShowInactive] = useState(true)
  const list = useGlossaryEntries(projectId, showInactive)
  const projects = useProjectChoices()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [formFailure, setFormFailure] = useState<Failure | null>(null)
  const [actionFailure, setActionFailure] = useState<(Failure & { action: Action }) | null>(null)
  const [pending, setPending] = useState<{ id: string | null; action: Action } | null>(null)
  const [announcement, setAnnouncement] = useState<string>('')
  const [historyOpen, setHistoryOpen] = useState<ReadonlySet<string>>(new Set())
  const [version, setVersion] = useState(0)
  const [previewScope, setPreviewScope] = useState('')
  const [focusRequest, setFocusRequest] = useState<{ key: string; token: number } | null>(null)
  const busy = useRef(false)
  const mounted = useRef(true)
  // The view as it is now: an answer that arrives later must be judged against this, not against the click.
  const view = useRef({ projectId, showInactive })
  view.current = { projectId, showInactive }
  const actionFailureRef = useRef<HTMLDivElement>(null)
  const entriesHeadingRef = useRef<HTMLHeadingElement>(null)
  const offlineId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // A browser that regains a network asks the node again instead of describing a stale picture.
  useEffect(() => {
    window.addEventListener('online', list.reload)
    return () => window.removeEventListener('online', list.reload)
  }, [list.reload])
  useEffect(() => { if (actionFailure) actionFailureRef.current?.focus() }, [actionFailure])
  // The preview follows the selected view: choosing a project there previews that project's glossary.
  useEffect(() => { setPreviewScope(projectId) }, [projectId])

  // An entry that disappeared (reverted away, deleted elsewhere) cannot stay open for editing.
  useEffect(() => {
    if (editor?.mode === 'edit' && list.entries !== null && !list.entries.some((entry) => entry.id === editor.id)) setEditor(null)
  }, [editor, list.entries])

  const requestFocus = useCallback((key: string) => setFocusRequest((previous) => ({ key, token: (previous?.token ?? 0) + 1 })), [])
  // Move focus on deliberately once the control it names exists; fall back to the list heading.
  useEffect(() => {
    if (!focusRequest) return
    // A failed read ends the request: focus must not jump later, when some other read succeeds.
    if (list.failure) { setFocusRequest(null); return }
    const target = focusTarget(focusRequest.key)
    if (target && !(target as HTMLButtonElement).disabled) { target.focus(); setFocusRequest(null) }
    else if (list.status === 'ready' && !list.refreshing) { entriesHeadingRef.current?.focus(); setFocusRequest(null) }
  }, [focusRequest, list.entries, list.status, list.refreshing, list.failure])

  const unreachable = list.failure?.code === 'unreachable'
  const entries = list.entries
  const names = projects.names
  const projectName = useCallback((id: string | null) => id === null ? '' : names.get(id) ?? id, [names])
  const groups = useMemo(() => groupEntries(entries ?? [], names), [entries, names])
  const overridden = useMemo(() => projectId === '' || entries === null ? new Set<string>() : overriddenAccountEntryIds(entries, projectId), [entries, projectId])
  const activeCount = entries?.filter((entry) => entry.active).length ?? 0
  const editing = editor?.mode === 'edit' ? entries?.find((entry) => entry.id === editor.id) ?? null : null
  const scopeLabel = (stored: StoredGlossaryEntryWire) => stored.scope === 'account' ? t('voiceGlossary.scope.account') : t('voiceGlossary.section.project', { name: projectName(stored.projectId) })

  const run = async (action: Action, id: string | null, request: () => Promise<StoredGlossaryEntryWire>, after: (stored: StoredGlossaryEntryWire) => void) => {
    if (busy.current) return
    busy.current = true
    setPending({ id, action }); setActionFailure(null); setFormFailure(null); setAnnouncement(t('voiceGlossary.working'))
    try {
      const stored = await request()
      if (!mounted.current) return
      setVersion((value) => value + 1)
      after(stored)
    } catch (error) {
      if (!mounted.current) return
      const failure = { code: classify(error), at: new Date().toISOString() }
      setAnnouncement('')
      if (action === 'create' || action === 'update') setFormFailure(failure)
      else setActionFailure({ ...failure, action })
      // Read the list again after any failed action, so what is shown is current without a
      // Reload button (D-203); a node that is really gone becomes the named offline state.
      list.reload()
    } finally { busy.current = false; if (mounted.current) setPending(null) }
  }
  const done = (action: Action, stored: StoredGlossaryEntryWire, key: LocaleKey = DONE_KEYS[action]) =>
    setAnnouncement(t(key, { name: stored.entry.canonical, revision: stored.revision }))

  const submitForm = (draft: EntryDraft) => {
    const body = bodyFromDraft(draft)
    if (editor?.mode === 'edit') {
      const id = editor.id
      void run('update', id, () => glossaryApi.update(id, { entry: body }), (stored) => {
        list.patch(stored, inView(stored, view.current.projectId, view.current.showInactive)); setEditor(null); done('update', stored); requestFocus(`edit:${id}`)
      })
      return
    }
    void run('create', null, () => glossaryApi.create({ scope: draft.scope, ...(draft.scope === 'project' ? { projectId: draft.projectId } : {}), entry: body }), (stored) => {
      setEditor(null)
      const visible = inView(stored, view.current.projectId, view.current.showInactive)
      // The new entry may belong to a view that the current filter hides; the full view always shows it.
      list.patch(stored, visible)
      if (!visible) setProjectId('')
      done('create', stored, visible ? 'voiceGlossary.done.created' : 'voiceGlossary.done.created.elsewhere')
      requestFocus(`card:${stored.id}`)
    })
  }
  const mutate = (action: 'deactivate' | 'reactivate' | 'revert', stored: StoredGlossaryEntryWire) => {
    const key = action === 'revert' ? `revert:${stored.id}` : `toggle:${stored.id}`
    void run(action, stored.id, () => glossaryApi[action](stored.id), (next) => {
      list.patch(next, inView(next, view.current.projectId, view.current.showInactive))
      done(action, next); requestFocus(key)
    })
  }
  const toggleHistory = (id: string) => setHistoryOpen((previous) => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const openEditor = (next: Editor) => { setFormFailure(null); setEditor(next) }
  const closeEditor = () => {
    const key = editor?.mode === 'edit' ? `edit:${editor.id}` : 'new'
    setEditor(null); setFormFailure(null); requestFocus(key)
  }

  const viewLocked = pending !== null || editor !== null
  const age = list.observedAt ? t('voiceGlossary.asOf', { time: formatTime(list.observedAt), age: formatRelativeTime(list.observedAt) }) : null
  const emptyKey: LocaleKey = !showInactive ? 'voiceGlossary.empty.activeOnly' : projectId !== '' ? 'voiceGlossary.empty.view' : 'voiceGlossary.empty'
  const emptyView = list.status === 'ready' && entries !== null && entries.length === 0
  const newButton = <Button variant="primary" data-focus-key="new" disabled={unreachable || pending !== null || editor !== null} aria-describedby={unreachable ? offlineId : undefined}
    onClick={() => openEditor({ mode: 'create' })}>{t('voiceGlossary.new')}</Button>
  const filterOptions = [{ value: '', label: t('voiceGlossary.filter.all') },
    ...projects.projects.map((project) => ({ value: project.id, label: t('voiceGlossary.filter.project', { name: project.name }) }))]
  if (projectId !== '' && !names.has(projectId)) filterOptions.push({ value: projectId, label: t('voiceGlossary.filter.project', { name: projectId }) })
  const formInitial = useMemo(() => editing ? draftFromEntry(editing) : emptyDraft(projectId), [editing, projectId])

  // `wrap-anywhere` is inherited: machine names inside shared patterns (sources, details, hashes) may break instead of widening the page.
  return <div data-testid="glossary-page" className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 p-4 text-foreground wrap-anywhere">
    <header className="flex min-w-0 flex-col gap-1">
      <Link to={paths.settings()} className="inline-flex min-h-6 w-fit items-center text-13 text-secondary underline underline-offset-2 focus-visible:outline-focus">{t('voiceGlossary.backToSettings')}</Link>
      <h1 className="text-22 font-heading">{t('voiceGlossary.title')}</h1>
      <p className="text-secondary">{t('voiceGlossary.subtitle')}</p>
    </header>

    {/* One persistent live region announces every outcome, so nothing is read twice. */}
    <p role="status" className="min-h-4 text-13" data-testid="glossary-announcement">{announcement}</p>

    {unreachable && <div role="alert" className="flex flex-col gap-2 rounded-panel border border-danger bg-surface p-3" data-state="node_unreachable">
      <p className="font-heading">{t('voiceGlossary.offline.title')} <span className="font-mono font-normal text-secondary">({t('voiceGlossary.offline.state')})</span></p>
      <p id={offlineId}>{t(entries === null ? 'voiceGlossary.offline.bodyNone' : 'voiceGlossary.offline.body')}</p>
      <p className="text-12 text-secondary">{age ?? t('voiceGlossary.offline.never')}</p>
      <p className="text-12 text-secondary">{t('voiceGlossary.recovering')}</p>
    </div>}
    {list.failure && !unreachable && <div className="flex min-w-0 flex-col gap-2">
      <ErrorState title={`${t('voiceGlossary.load.error')}. ${t(failureMessage(list.failure.code, 'read'))}`} source={t('voiceGlossary.source.list')} occurredAt={list.failure.at}
        timeMeaning="observed" details={list.failure.code} />
      <p className="text-12 text-secondary">{t('voiceGlossary.recovering')}</p>
      {entries !== null && <p className="text-12 text-secondary">{t('voiceGlossary.stale.note')}</p>}
    </div>}
    {actionFailure && <div ref={actionFailureRef} tabIndex={-1} className="focus-visible:outline-focus">
      <ErrorState title={`${t('voiceGlossary.action.failed')}. ${t(failureMessage(actionFailure.code, 'write'))}`} source={t(SOURCE_KEYS[actionFailure.action])}
        occurredAt={actionFailure.at} timeMeaning="observed" details={actionFailure.code} />
    </div>}

    <div role="group" aria-label={t('voiceGlossary.toolbar')} className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="glossary-filter" className="text-14 font-heading">{t('voiceGlossary.filter.label')}</label>
        <Select id="glossary-filter" value={projectId} onChange={setProjectId} options={filterOptions} disabled={viewLocked}
          describedBy={[projects.status === 'unavailable' ? 'glossary-filter-hint' : '', editor !== null ? 'glossary-view-locked' : ''].filter(Boolean).join(' ') || undefined} />
        {projects.status === 'unavailable' && <p id="glossary-filter-hint" className="text-12 text-secondary">{t('voiceGlossary.filter.projectsUnavailable')}</p>}
      </div>
      <ToggleButton pressed={showInactive} onPressedChange={setShowInactive} disabled={viewLocked} describedBy={editor !== null ? 'glossary-view-locked' : undefined}>{t('voiceGlossary.showInactive')}</ToggleButton>
      {editor !== null && <p id="glossary-view-locked" className="text-12 text-secondary">{t('voiceGlossary.view.locked')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {!emptyView && newButton}
        {entries !== null && <p className="text-12 text-secondary" data-testid="glossary-count">{t('voiceGlossary.count', { count: entries.length, active: activeCount })}</p>}
        {list.observedAt && <Provenance source={t('voiceGlossary.source.list')} observedAt={list.observedAt} />}
      </div>
    </div>

    {editor && (editor.mode === 'create' || editing) && <GlossaryEntryForm key={editor.mode === 'edit' ? editor.id : 'create'}
      editing={editing ? { name: editing.entry.canonical, scopeLabel: scopeLabel(editing) } : null} initial={formInitial} projects={projects}
      offline={unreachable} saving={pending?.action === 'create' || pending?.action === 'update'} blocked={pending !== null && pending.action !== 'create' && pending.action !== 'update'} failure={formFailure}
      failureSource={t(editor.mode === 'edit' ? 'voiceGlossary.source.update' : 'voiceGlossary.source.create')} onSubmit={submitForm} onCancel={closeEditor} />}

    <section aria-labelledby="glossary-entries" className="flex min-w-0 flex-col gap-3" ><h2 id="glossary-entries" ref={entriesHeadingRef} tabIndex={-1} className="text-18 font-heading focus-visible:outline-focus">{t('voiceGlossary.entries')}</h2>
      {list.status === 'loading' && <>
        <p role="status">{t('voiceGlossary.loading')}</p>
        <div aria-hidden="true" className="flex flex-col gap-3" data-testid="glossary-skeleton">
          {[0, 1, 2].map((index) => <div key={index} className="h-24 rounded-panel bg-inset" />)}
        </div>
      </>}
      {emptyView && <EmptyState title={t(emptyKey)} action={newButton} />}
      {groups.map((group) => {
        const headingId = `glossary-group-${group.key}`
        return <section key={group.key} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-group={group.key}>
          <h3 id={headingId} className="break-words text-14 font-heading text-secondary">
            {group.scope === 'account' ? t('voiceGlossary.section.account')
              : names.has(group.projectId ?? '') ? t('voiceGlossary.section.project', { name: projectName(group.projectId) })
                // "Missing from the list" is a claim: make it only once the list is known.
                : t(projects.status === 'ready' ? 'voiceGlossary.section.projectUnknown' : 'voiceGlossary.section.projectId', { id: group.projectId ?? '' })}
          </h3>
          <ul className="flex min-w-0 flex-col gap-2">
            {group.entries.map((stored) => <li key={stored.id} className="min-w-0">
              <GlossaryEntryCard stored={stored} overridden={overridden.has(stored.id)} offline={unreachable} offlineReasonId={offlineId}
                busy={pending !== null} historyOpen={historyOpen.has(stored.id)} onToggleHistory={() => toggleHistory(stored.id)}
                onEdit={() => openEditor({ mode: 'edit', id: stored.id })}
                onToggleActive={() => mutate(stored.active ? 'deactivate' : 'reactivate', stored)}
                onRevert={() => mutate('revert', stored)} />
            </li>)}
          </ul>
        </section>
      })}
    </section>

    <GlossaryPreview projects={projects} scopeProjectId={previewScope} onScopeChange={setPreviewScope} version={version} />
  </div>
}
