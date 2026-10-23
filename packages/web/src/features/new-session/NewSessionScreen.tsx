import { useEffect, useMemo, useRef, useState } from 'react'
import { nativeAgentInputSchema, type AccessMode, type Project } from '@guanxi/contract'
import { Badge, Composer, EmptyState, ErrorState, Icon } from '@guanxi/ui'
import { api } from '../../lib/api.ts'
import { formatTime } from '../../lib/format.ts'
import { useAsync } from '../../lib/useAsync.ts'
import { translate as t, type LocaleKey } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { Link, navigate, paths, useLocation } from '../../lib/router.tsx'
import { projectFromLocation } from '../../lib/current-project.ts'
import { agentRequest, AgentRequestError, nativeApi } from '../native-agent/api.ts'
import { BrandMark } from './BrandMark.tsx'
import { ModelPicker, PermissionMenu, ProjectPicker, RunOptions, type ModelSuggestion } from './SessionPickers.tsx'
import './new-session.css'
import { readRecentProjects, rememberProject } from './recent.ts'
import { useSessionChoices } from './useSessionChoices.ts'

const START_ERRORS = ['project_not_found', 'root_busy', 'root_unavailable', 'root_overlaps_node_data', 'protected_path_invalid', 'egress_unavailable', 'validation_failed', 'unreachable'] as const
const startErrorKey = (code: string): LocaleKey => (START_ERRORS as readonly string[]).includes(code)
  ? `newSession.error.${code as (typeof START_ERRORS)[number]}` : 'newSession.error.agent_unavailable'
const loadReasonKey = (code: string): LocaleKey => code === 'egress_unavailable' ? 'newSession.error.egress_unavailable' : 'newSession.load.reason'
const rootsErrorKey = (code: string): LocaleKey => (START_ERRORS as readonly string[]).includes(code) && code !== 'unreachable' ? startErrorKey(code) : 'newSession.error.roots'
const splitList = (value: string, separator: RegExp) => value.split(separator).map(item => item.trim()).filter(Boolean)

/** The skeleton keeps the final geometry; it never animates, so reduced motion needs no rule. */
function ChoicesSkeleton() {
  return <div aria-hidden="true" className="new-session-skeleton" data-testid="new-session-skeleton">
    <span /><span />
  </div>
}

/**
 * E1 New session (D-207): an empty session is the composer, centred. The current project is
 * preselected (the routed one, else the most recent); the permission mode sits at the composer's lower left, the
 * model, connection and context at its lower right, and the run options one click away. Choices
 * stay current and recover by themselves; there is no Retry.
 */
export function NewSessionScreen() {
  useLocale()
  const choices = useSessionChoices()
  const routedProject = projectFromLocation(useLocation())
  const [recent, setRecent] = useState(readRecentProjects)
  const [projectId, setProjectId] = useState(''), [connectionId, setConnectionId] = useState(''), [model, setModel] = useState('')
  const [mode, setMode] = useState<AccessMode>('read-only'), [prompt, setPrompt] = useState('')
  const [domains, setDomains] = useState(''), [context, setContext] = useState(''), [attachments, setAttachments] = useState('')
  const [protectedPaths, setProtectedPaths] = useState('')
  const [roots, setRoots] = useState<string[] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'starting'>('idle')
  const [startFailure, setStartFailure] = useState<{ code: string; at: string } | null>(null)
  const [rootsBusy, setRootsBusy] = useState(false), [rootsFailure, setRootsFailure] = useState<string | null>(null)
  const submitting = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const failureRef = useRef<HTMLDivElement>(null)
  const data = choices.choices
  // A new session opens in the current project: the one the route names (the shell passes the open
  // session's or routed project), else the most recent one that still exists, else the only one.
  useEffect(() => {
    if (!data || projectId) return
    const exists = (id: string | null): id is string => id !== null && data.projects.some(project => project.id === id)
    const current = (exists(routedProject) ? routedProject : undefined)
      ?? recent.find(exists) ?? (data.projects.length === 1 ? data.projects[0]!.id : '')
    if (current) setProjectId(current)
  }, [data, projectId, recent, routedProject])
  // One connection needs no choice.
  useEffect(() => { if (data && !connectionId && data.connections.length === 1) setConnectionId(data.connections[0]!.id) }, [data, connectionId])
  const project: Project | undefined = data?.projects.find(item => item.id === projectId)
  const connection = data?.connections.find(item => item.id === connectionId)
  const savedRoots = useMemo(() => project?.filesystemBindings.map(binding => binding.workspaceId) ?? [], [project])
  const selectedRoots = roots ?? savedRoots
  const rootsDirty = project !== undefined && (selectedRoots.length !== savedRoots.length || selectedRoots.some(id => !savedRoots.includes(id)))
  // Only an unanswered request says the node is unreachable; the browser's own connectivity flag says nothing about a loopback node.
  const unreachable = choices.failure !== null && choices.failure.kind === 'unreachable'
  useEffect(() => { if (startFailure) failureRef.current?.focus() }, [startFailure])

  const contextRequired = connection?.kind === 'local_runtime'
  // Installed models are suggestions for a local runtime; any connection still accepts a typed ID.
  const installed = useAsync(signal => contextRequired ? api.listModels(undefined, signal) : Promise.resolve({ models: [] }), [contextRequired])
  const suggestions: ModelSuggestion[] = (installed.data?.models ?? []).map(item => ({ id: item.name, label: item.name }))

  const domainList = splitList(domains, /,/), protectedList = splitList(protectedPaths, /\n/), attachmentList = splitList(attachments, /,/)
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
    if (rootsDirty) needs.push('newSession.need.roots')
    if (domainsInvalid || contextInvalid) needs.push('newSession.need.valid')
    if (unreachable) needs.push('newSession.need.online')
  }
  const canStart = needs.length === 0 && phase === 'idle'

  // Only non-default options show, as quiet chips above the prompt (PRINCIPLES 3).
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
      // The user may have navigated elsewhere while the node worked; the session exists either way.
      if (mounted.current) navigate(paths.agent(created.sessionId))
    } catch (error) {
      // No answer at all means the outcome is unknown, which is not the same as a refusal.
      setStartFailure({ code: error instanceof AgentRequestError ? error.code : 'unreachable', at: new Date().toISOString() })
    } finally { submitting.current = false; setPhase('idle') }
  }
  const saveRoots = async () => {
    if (!project) return
    setRootsBusy(true); setRootsFailure(null)
    try { await agentRequest(`/projects/${encodeURIComponent(project.id)}/roots`, 'PATCH', { workspaceIds: selectedRoots }); setRoots(null); choices.reload() }
    catch (error) { setRootsFailure(error instanceof AgentRequestError ? error.code : 'unreachable') } finally { setRootsBusy(false) }
  }

  const noProjects = data !== null && data.projects.length === 0
  const noConnections = data !== null && data.connections.length === 0
  // An absolute time only: a relative age would go stale on screen (D-203).
  const age = choices.observedAt ? t('newSession.asOf', { time: formatTime(choices.observedAt) }) : null
  const hint = phase === 'starting' ? t('newSession.starting') : needs.length > 0 ? t(needs[0]!) : t('newSession.ready')

  return <div className="new-session" data-layout="centered">
    <div className="new-session-stage">
      <header className="new-session-header">
        <BrandMark className="new-session-mark" />
        <h1 className="new-session-title">{t('newSession.heading')}</h1>
        <p className="sr-only">{t('newSession.title')}</p>
      </header>

      {choices.status === 'loading' && <>
        <p role="status" className="sr-only">{t('native.loading')}</p>
        <ChoicesSkeleton />
      </>}

      {data !== null && (noProjects || noConnections) && <EmptyState icon={<Icon name={noProjects ? 'projects' : 'relay'} />}
        title={t(noProjects ? 'newSession.empty.projects' : 'newSession.empty.connections')}
        action={<Link to={noProjects ? paths.projects() : paths.settings()} className="new-session-link">
          {t(noProjects ? 'native.projects' : 'newSession.empty.openSettings')}</Link>} />}

      {choices.status !== 'loading' && !noProjects && !noConnections && <section aria-label={t('newSession.form')} className="new-session-composer">
        {data && <div className="new-session-scope">
          <ProjectPicker projects={data.projects} recent={recent} value={projectId} onChange={id => { setProjectId(id); setRoots(null) }} />
          {project && <Badge>{project.filesystemBindings.length ? t('native.roots', { count: project.filesystemBindings.length }) : t('native.noRoots')}</Badge>}
        </div>}
        <Composer layout="centered" label={t('native.prompt')} placeholder={t('newSession.placeholder')} value={prompt} onValueChange={setPrompt}
          onSend={() => void start()} sendDisabled={!canStart} describedBy="new-session-needs" sendLabel={t('native.start')} autoFocus
          header={chips.length > 0 ? <ul aria-label={t('newSession.chips')} className="new-session-chips">
            {chips.map(chip => <li key={chip}><Badge tone="accent">{chip}</Badge></li>)}</ul> : undefined}
          leading={<>
            <PermissionMenu mode={mode} onChange={setMode} />
            {data && <RunOptions project={project} workspaces={data.workspaces} selectedRoots={selectedRoots} onRoots={setRoots}
              rootsDirty={rootsDirty} rootsBusy={rootsBusy} rootsFailure={rootsFailure ? t(rootsErrorKey(rootsFailure)) : null} onSaveRoots={() => void saveRoots()}
              unreachable={unreachable} domains={domains} onDomains={setDomains} domainsInvalid={domainsInvalid}
              attachments={attachments} onAttachments={setAttachments} protectedPaths={protectedPaths} onProtectedPaths={setProtectedPaths} />}
          </>}
          trailing={data ? <ModelPicker connections={data.connections} connectionId={connectionId} onConnection={setConnectionId}
            model={model} onModel={setModel} suggestions={suggestions} contextRequired={contextRequired}
            context={context} onContext={setContext} contextInvalid={contextInvalid} /> : undefined} />
        <p id="new-session-needs" role="status" className="new-session-hint">{hint}</p>
        {mode === 'full-access' && <p className="new-session-hint">{t('native.shellLimited')}</p>}
      </section>}

      {unreachable && <p role="status" className="new-session-note" data-state="node_unreachable">
        <Icon name="offline" />{t('newSession.offline.recovering')}{age ? ` ${age}` : ''}</p>}
      {!unreachable && choices.failure && <ErrorState
        title={`${t('newSession.load.error')}. ${t(loadReasonKey(choices.failure.code))}`}
        source={t(choices.failure.source === 'projects' ? 'newSession.load.sourceProjects' : 'newSession.load.sourceConnections')}
        occurredAt={choices.failure.at} timeMeaning="observed" details={choices.failure.code} />}

      {startFailure && <div ref={failureRef} tabIndex={-1} className="focus-visible:outline-focus">
        <ErrorState title={`${t('newSession.start.error')}. ${t(startErrorKey(startFailure.code))}`} source={t('newSession.start.source')} occurredAt={startFailure.at} timeMeaning="observed"
          details={startFailure.code} />
      </div>}
    </div>
  </div>
}
