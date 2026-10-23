import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { nativeAgentInputSchema, type AccessMode, type Project } from '@guanxi/contract'
import { Button, EmptyState, ErrorState, Input, Textarea } from '@guanxi/ui'
import { Select } from '../../components/ui.tsx'
import { PRODUCT_NAME } from '../../lib/brand.ts'
import { formatRelativeTime, formatTime } from '../../lib/format.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, navigate, paths } from '../../lib/router.tsx'
import { agentRequest, AgentRequestError, nativeApi } from '../native-agent/api.ts'
import { BrandMark } from './BrandMark.tsx'
import { readRecentProjects, rememberProject } from './recent.ts'
import { useBrowserOnline, useSessionChoices } from './useSessionChoices.ts'

const START_ERRORS = ['project_not_found', 'root_busy', 'root_unavailable', 'root_overlaps_node_data', 'protected_path_invalid', 'egress_unavailable', 'validation_failed'] as const
const startErrorKey = (code: string): LocaleKey => (START_ERRORS as readonly string[]).includes(code)
  ? `newSession.error.${code as (typeof START_ERRORS)[number]}` : 'newSession.error.agent_unavailable'
const splitList = (value: string, separator: RegExp) => value.split(separator).map(item => item.trim()).filter(Boolean)

/** One labelled control with its hint and error wired through `aria-describedby`. */
function FormField({ label, hint, error, children }: {
  label: string; hint?: string; error?: string; children: (control: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode
}) {
  const id = useId(), hintId = `${id}-hint`, errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return <div className="flex min-w-0 flex-col gap-1">
    <label htmlFor={id} className="text-14 font-heading">{label}</label>
    {children({ id, describedBy, invalid: Boolean(error) })}
    {hint && <p id={hintId} className="text-12 text-secondary">{hint}</p>}
    {error && <p id={errorId} className="text-12 text-danger">{error}</p>}
  </div>
}

/** The skeleton keeps the final geometry; it never animates, so reduced motion needs no rule. */
function ChoicesSkeleton() {
  return <div aria-hidden="true" className="flex flex-col gap-4" data-testid="new-session-skeleton">
    {[0, 1, 2].map(index => <div key={index} className="h-9 rounded-control bg-inset" />)}
    <div className="h-28 rounded-control bg-inset" />
  </div>
}

export function NewSessionScreen() {
  useLocale()
  const choices = useSessionChoices()
  const online = useBrowserOnline()
  const [projectId, setProjectId] = useState(''), [connectionId, setConnectionId] = useState(''), [model, setModel] = useState('')
  const [mode, setMode] = useState<AccessMode>('read-only'), [prompt, setPrompt] = useState('')
  const [domains, setDomains] = useState(''), [context, setContext] = useState(''), [attachments, setAttachments] = useState('')
  const [protectedPaths, setProtectedPaths] = useState('')
  const [roots, setRoots] = useState<string[] | null>(null)
  const [recent, setRecent] = useState(readRecentProjects)
  const [phase, setPhase] = useState<'idle' | 'starting'>('idle')
  const [startFailure, setStartFailure] = useState<{ code: string; at: string } | null>(null)
  const [rootsBusy, setRootsBusy] = useState(false), [rootsFailure, setRootsFailure] = useState(false)
  const submitting = useRef(false)
  const failureRef = useRef<HTMLDivElement>(null)
  const data = choices.choices
  const project: Project | undefined = data?.projects.find(item => item.id === projectId)
  const connection = data?.connections.find(item => item.id === connectionId)
  const savedRoots = useMemo(() => project?.filesystemBindings.map(binding => binding.workspaceId) ?? [], [project])
  const selectedRoots = roots ?? savedRoots
  const rootsDirty = project !== undefined && (selectedRoots.length !== savedRoots.length || selectedRoots.some(id => !savedRoots.includes(id)))
  const unreachable = !online || (choices.failure !== null && choices.failure.kind === 'unreachable')
  // Back online: reload once so the screen does not keep describing an unreachable node.
  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) choices.reload()
    wasOnline.current = online
  }, [online, choices.reload])
  useEffect(() => { if (startFailure) failureRef.current?.focus() }, [startFailure])

  const domainList = splitList(domains, /,/), protectedList = splitList(protectedPaths, /\n/), attachmentList = splitList(attachments, /,/)
  const contextRequired = connection?.kind === 'local_runtime'
  const contextValue = Number(context)
  const contextInvalid = context.trim() !== '' && !(Number.isInteger(contextValue) && contextValue > 0)
  const domainsInvalid = useMemo(() => {
    const parsed = nativeAgentInputSchema.safeParse({ projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p', domains: domainList })
    return !parsed.success && parsed.error.issues.some(issue => issue.path[0] === 'domains')
  }, [domains])

  const needs: LocaleKey[] = []
  if (choices.status === 'loading') needs.push('newSession.need.choices')
  else if (data === null) needs.push('newSession.need.reload')
  else {
    if (!projectId) needs.push('newSession.need.project')
    if (!connectionId) needs.push('newSession.need.connection')
    if (!model.trim()) needs.push('newSession.need.model')
    if (!prompt.trim()) needs.push('newSession.need.prompt')
    if (contextRequired && !context.trim()) needs.push('newSession.need.context')
    if (domainsInvalid || contextInvalid) needs.push('newSession.need.valid')
    if (unreachable) needs.push('newSession.need.online')
  }
  const canStart = needs.length === 0 && phase === 'idle'

  const chips: string[] = []
  if (mode !== 'read-only') chips.push(t('newSession.chip.mode', { mode: t(`native.${mode}`) }))
  if (domainList.length) chips.push(t('newSession.chip.domains', { count: domainList.length }))
  if (protectedList.length) chips.push(t('newSession.chip.protected', { count: protectedList.length }))
  if (attachmentList.length) chips.push(t('newSession.chip.attachments', { count: attachmentList.length }))
  if (context.trim()) chips.push(t('newSession.chip.context', { tokens: context.trim() }))
  if (rootsDirty) chips.push(t('newSession.chip.roots', { count: selectedRoots.length }))

  const start = async () => {
    if (!canStart || submitting.current || !project) return
    submitting.current = true
    setPhase('starting'); setStartFailure(null)
    try {
      const created = await nativeApi.create({ projectId, connectionId, model: model.trim(), mode, prompt, retention: 'ttl',
        domains: domainList, attachmentIds: attachmentList, protectedPaths: protectedList, ...(context.trim() ? { contextTokens: contextValue } : {}) })
      if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new AgentRequestError(502, 'agent_unavailable')
      setRecent(rememberProject(projectId))
      navigate(paths.agent(created.sessionId))
    } catch (error) {
      setStartFailure({ code: error instanceof AgentRequestError ? error.code : 'agent_unavailable', at: new Date().toISOString() })
    } finally { submitting.current = false; setPhase('idle') }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void start() }
  const promptKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !canStart) return
    event.preventDefault(); void start()
  }
  const saveRoots = async () => {
    if (!project) return
    setRootsBusy(true); setRootsFailure(false)
    try { await agentRequest(`/projects/${encodeURIComponent(project.id)}/roots`, 'PATCH', { workspaceIds: selectedRoots }); setRoots(null); choices.reload() }
    catch { setRootsFailure(true) } finally { setRootsBusy(false) }
  }

  const noProjects = data !== null && data.projects.length === 0
  const noConnections = data !== null && data.connections.length === 0
  const recentProjects = data ? recent.flatMap(id => data.projects.filter(item => item.id === id)) : []
  const age = choices.observedAt ? t('newSession.asOf', { time: formatTime(choices.observedAt), age: formatRelativeTime(choices.observedAt) }) : null

  const startBar = <div className="flex flex-col gap-2">
    {needs.length > 0
      ? <div id="new-session-needs" className="text-12 text-secondary"><p>{t('newSession.need')}</p>
        <ul className="list-disc pl-5">{needs.map(key => <li key={key}>{t(key)}</li>)}</ul></div>
      : <p id="new-session-needs" className="text-12 text-secondary">{t('newSession.ready')}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="primary" disabled={!canStart} loading={phase === 'starting'} aria-describedby="new-session-needs">{t('native.start')}</Button>
      <p role="status" className="text-12 text-secondary">{phase === 'starting' ? t('newSession.starting') : ''}</p>
    </div>
  </div>

  return <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 p-4 text-foreground">
    <header className="flex items-center gap-3">
      <BrandMark className="h-10 w-10 shrink-0" />
      <div className="min-w-0">
        <p className="text-13 text-secondary">{t('shell.brand', { product: PRODUCT_NAME })}</p>
        <h1 className="text-22 font-heading">{t('newSession.title')}</h1>
      </div>
    </header>
    <p className="text-secondary">{t('newSession.subtitle')}</p>

    {unreachable && <div role="alert" className="flex flex-col gap-2 rounded-panel border border-danger bg-surface p-3" data-state="node_unreachable">
      <p className="font-heading">{t('newSession.offline.title')} · <span className="font-mono">{t('newSession.offline.state')}</span></p>
      <p>{t('newSession.offline.body')}</p>
      <p className="text-12 text-secondary">{age ?? t('newSession.offline.never')}</p>
      <div><Button onClick={choices.reload} loading={choices.refreshing}>{t('newSession.retry')}</Button></div>
    </div>}
    {!unreachable && choices.failure && <ErrorState
      title={t('newSession.load.error')}
      source={t(choices.failure.source === 'projects' ? 'newSession.load.sourceProjects' : 'newSession.load.sourceConnections')}
      occurredAt={choices.failure.at} timeMeaning="observed" details={choices.failure.code}
      action={<Button onClick={choices.reload} loading={choices.refreshing}>{t('newSession.retry')}</Button>} />}

    {choices.status === 'loading' && <>
      <p role="status">{t('native.loading')}</p>
      <ChoicesSkeleton />
    </>}

    {data === null && choices.status === 'failed' && <form aria-label={t('newSession.form')} onSubmit={submit} noValidate>{startBar}</form>}

    {data !== null && (noProjects || noConnections) && <EmptyState
      title={t(noProjects ? 'newSession.empty.projects' : 'newSession.empty.connections')}
      action={<Link to={noProjects ? paths.projects() : paths.settings()} className="inline-flex min-h-8 items-center rounded-control border border-control px-3 text-14 hover:bg-inset focus-visible:outline-focus">
        {t(noProjects ? 'native.projects' : 'newSession.empty.openSettings')}</Link>} />}

    {data !== null && !noProjects && !noConnections && <>
      {recentProjects.length > 0 && <section aria-labelledby="new-session-recent" className="flex flex-col gap-2">
        <h2 id="new-session-recent" className="text-14 font-heading">{t('newSession.recent')}</h2>
        <ul className="flex flex-wrap gap-2">
          {recentProjects.map(item => <li key={item.id}><Button size="sm" aria-pressed={item.id === projectId}
            onClick={() => { setProjectId(item.id); setRoots(null) }}>{item.name}</Button></li>)}
        </ul>
      </section>}
      <form aria-label={t('newSession.form')} onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
        <FormField label={t('native.project')} hint={t('newSession.project.hint')}>
          {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={projectId} onChange={value => { setProjectId(value); setRoots(null) }}
            options={[{ value: '', label: t('native.choose') }, ...data.projects.map(item => ({ value: item.id,
              label: item.filesystemBindings.length ? t('newSession.project.folders', { name: item.name, count: item.filesystemBindings.length }) : t('newSession.project.noFolder', { name: item.name }) }))]} />}
        </FormField>
        {project && <p>{project.filesystemBindings.length ? t('native.roots', { count: project.filesystemBindings.length }) : t('native.noRoots')}</p>}
        <FormField label={t('native.prompt')} hint={t('newSession.prompt.hint')}>
          {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={promptKey} />}
        </FormField>
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('native.connection')} hint={t('newSession.connection.hint')}>
            {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={connectionId} onChange={setConnectionId}
              options={[{ value: '', label: t('native.choose') }, ...data.connections.map(item => ({ value: item.id, label: item.name }))]} />}
          </FormField>
          <FormField label={t('native.model')} hint={t('newSession.model.hint')}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={model} onChange={event => setModel(event.target.value)} />}
          </FormField>
        </div>
        <FormField label={t('native.mode')} hint={t('newSession.mode.hint')}>
          {({ id, describedBy }) => <Select id={id} describedBy={describedBy} value={mode} onChange={value => setMode(value as AccessMode)}
            options={[{ value: 'read-only', label: t('native.read-only') }, { value: 'full-access', label: t('native.full-access') }]} />}
        </FormField>
        {mode === 'full-access' && <p className="text-secondary">{t('native.shellLimited')}</p>}

        <details className="rounded-panel border border-divider bg-surface p-3">
          <summary className="min-h-6 cursor-pointer text-14 font-heading focus-visible:outline-focus">{t('newSession.options')}</summary>
          <div className="mt-3 flex min-w-0 flex-col gap-4">
            <p className="text-12 text-secondary">{t('newSession.options.hint')}</p>
            {project && (data.workspaces === null
              ? <p role="status" className="text-12 text-secondary">{t('newSession.folders.unavailable')}</p>
              : <fieldset className="flex min-w-0 flex-col gap-2 rounded-control border border-divider p-3">
                <legend className="px-1 text-14">{t('native.folders')}</legend>
                {data.workspaces.length === 0 && <p className="text-12 text-secondary">{t('newSession.folders.none')}</p>}
                <ul className="flex flex-wrap gap-2">
                  {data.workspaces.map(workspace => {
                    const included = selectedRoots.includes(workspace.id)
                    return <li key={workspace.id}><Button size="sm" variant={included ? 'primary' : 'secondary'} aria-pressed={included}
                      onClick={() => setRoots(included ? selectedRoots.filter(rootId => rootId !== workspace.id) : [...selectedRoots, workspace.id])}>
                      <span aria-hidden="true">{included ? '✓ ' : ''}</span>{workspace.exists ? workspace.name : t('newSession.folders.missing', { name: workspace.name })}</Button></li>
                  })}
                </ul>
                <p className="text-12 text-secondary">{t('newSession.folders.hint')}</p>
                <div><Button disabled={!rootsDirty || rootsBusy || unreachable} loading={rootsBusy} onClick={() => void saveRoots()}>{t('native.saveFolders')}</Button></div>
                {rootsFailure && <p role="alert" className="text-12 text-danger">{t('newSession.error.agent_unavailable')}</p>}
              </fieldset>)}
            <FormField label={t('native.domains')} hint={t('native.domainsHint')} error={domainsInvalid ? t('newSession.domains.invalid') : undefined}>
              {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={domains} onChange={event => setDomains(event.target.value)} />}
            </FormField>
            {contextRequired && <FormField label={t('native.context')} error={contextInvalid ? t('newSession.context.invalid') : undefined}>
              {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="numeric" value={context} onChange={event => setContext(event.target.value)} />}
            </FormField>}
            <FormField label={t('native.attachments')}>
              {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={attachments} onChange={event => setAttachments(event.target.value)} />}
            </FormField>
            <FormField label={t('native.protected')}>
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={protectedPaths} onChange={event => setProtectedPaths(event.target.value)} />}
            </FormField>
          </div>
        </details>

        {chips.length > 0 && <ul aria-label={t('newSession.chips')} className="flex flex-wrap gap-2">
          {chips.map(chip => <li key={chip} className="rounded-control border border-divider bg-inset px-2 py-1 text-12">{chip}</li>)}
        </ul>}

        {startFailure && <div ref={failureRef} tabIndex={-1} className="focus-visible:outline-focus">
          <ErrorState title={`${t('newSession.start.error')}. ${t(startErrorKey(startFailure.code))}`} source={t('newSession.start.source')} occurredAt={startFailure.at} timeMeaning="observed"
            details={startFailure.code} />
        </div>}

        {startBar}
      </form>
    </>}
  </div>
}
