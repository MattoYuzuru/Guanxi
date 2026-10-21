import { useEffect, useState, type FormEvent } from 'react'
import type { AgentProgress, Connection, Project, Workspace, AccessMode } from '@guanxi/contract'
import { Button, Field, Input, Select, Textarea } from '../../components/ui.tsx'
import { api } from '../../lib/api.ts'
import { Link, paths, navigate } from '../../lib/router.tsx'
import { translate as t, getActiveLocale } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { connectionApi } from '../connections/api.ts'
import { nativeApi, agentRequest } from './api.ts'

export function NativeProgress({ progress, stop, remove }: { progress: AgentProgress; stop: () => void; remove: (id: string) => void }) {
  return <section aria-label={t('native.progress')} className="rounded-panel border border-divider bg-surface p-4">
    <h2 className="text-15">{t('native.progress')}</h2>
    <p role="status" aria-live="polite">{t(`native.${progress.status}`)}</p>
    <p className="text-muted text-12">{t('native.source', { time: new Date(progress.observedAt).toLocaleString(getActiveLocale()) })}</p>
    <p>{t(`native.${progress.mode}`)}</p>
    {progress.status === 'running' && <Button onClick={stop}>{t('native.stop')}</Button>}
    <h3>{t('native.plan')}</h3>
    {progress.plan.length === 0 ? <p className="text-muted">{t('native.noPlan')}</p> : <ol>{progress.plan.map((item, index) => <li key={index}>{item.text} · {t(`native.${item.status}`)}</li>)}</ol>}
    <h3>{t('native.queue')}</h3>
    {progress.queue.length === 0 ? <p className="text-muted">{t('native.noQueue')}</p> : <ul>{progress.queue.map(item => <li key={item.id}>{item.text}<Button aria-label={t('native.remove')} onClick={() => remove(item.id)}>{t('native.remove')}</Button></li>)}</ul>}
    <h3>{t('native.summary')}</h3><p className="whitespace-pre-wrap break-words">{progress.summary || t('native.noSummary')}</p>
    <Link to={paths.inspector(progress.sessionId)} className="text-accent underline">{t('native.trace')}</Link>
  </section>
}
export function NativeAgentPage({ sessionId }: { sessionId: string | null }) {
  useLocale()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedRoots, setRoots] = useState<string[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [projectId, setProject] = useState(''), [connectionId, setConnection] = useState(''), [model, setModel] = useState('')
  const [mode, setMode] = useState<AccessMode>('read-only'), [prompt, setPrompt] = useState(''), [domains, setDomains] = useState('')
  const [context, setContext] = useState(''), [attachments, setAttachments] = useState(''), [protectedPaths, setProtected] = useState('')
  const [progress, setProgress] = useState<AgentProgress | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(false); setProgress(null)
    void Promise.all([agentRequest('/projects', 'GET', undefined, abort.signal) as Promise<{ projects: Project[] }>, connectionApi.list(abort.signal), api.listWorkspaces(abort.signal)]).then(([p, c, w]) => {
      if (!abort.signal.aborted) { setWorkspaces(w.workspaces); setProjects(p.projects); setConnections(c.connections.filter(c => c.kind === 'model_api' || c.kind === 'local_runtime')) }
    }).catch(() => { if (!abort.signal.aborted) setError(true) }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [revision])
  useEffect(() => {
    if (!sessionId) { setProgress(null); return }
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const p = await nativeApi.progress(sessionId, abort.signal); if (!abort.signal.aborted) { setProgress(p); setError(false); if (p.status === 'running') timer = setTimeout(refresh, 500) } }
      catch { if (!abort.signal.aborted) setError(true) }
    }
    void refresh()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, revision])
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(false)
    try { await action(); setRevision(r => r + 1) } catch { setError(true) } finally { setBusy(false) }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void mutate(async () => {
      if (sessionId) await nativeApi.prompt(sessionId, prompt)
      else { const created = await nativeApi.create({ projectId, connectionId, model, mode, prompt,
        domains: domains.split(',').map(s => s.trim()).filter(Boolean), attachmentIds: attachments.split(',').map(s => s.trim()).filter(Boolean),
        protectedPaths: protectedPaths.split('\n').filter(Boolean), ...(context ? { contextTokens: Number(context) } : {}) })
        navigate(paths.agent(created.sessionId)) }
      setPrompt('')
    })
  }
  const project = projects.find(p => p.id === projectId)
  return <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-foreground">
    <h1 className="text-18">{t(sessionId ? 'native.progress' : 'native.title')}</h1>
    {loading && <p role="status">{t('native.loading')}</p>}
    {error && <div role="alert"><p>{t(navigator.onLine ? 'native.error' : 'native.offline')}</p><Button onClick={() => setRevision(r => r + 1)}>{t('native.retry')}</Button></div>}
    {!loading && (projects.length === 0 || connections.length === 0) && <p>{t('native.empty')} <Link to={paths.projects()} className="text-accent underline">{t('native.projects')}</Link></p>}
    {progress && <NativeProgress progress={progress} stop={() => void mutate(() => nativeApi.stop(progress.sessionId))} remove={id => void mutate(() => nativeApi.remove(progress.sessionId, id))} />}
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      {!sessionId && <>
        <Field label={t('native.project')}><Select ariaLabel={t('native.project')} value={projectId} onChange={id => { setProject(id); setRoots(projects.find(p => p.id === id)?.filesystemBindings.map(b => b.workspaceId) ?? []) }} options={[{ value: '', label: t('native.choose') }, ...projects.map(p => ({ value: p.id, label: p.name }))]} /></Field>
        {project && <p>{project.filesystemBindings.length ? t('native.roots', { count: project.filesystemBindings.length }) : t('native.noRoots')}</p>}
        {project && <fieldset className="rounded-control border border-divider p-3"><legend>{t('native.folders')}</legend>
          {workspaces.map(workspace => <label key={workspace.id} className="flex items-center gap-2"><Input type="checkbox" className="w-6" aria-label={workspace.name} checked={selectedRoots.includes(workspace.id)} onChange={event => setRoots(event.target.checked ? [...selectedRoots, workspace.id] : selectedRoots.filter(id => id !== workspace.id))} />{workspace.name}</label>)}
          <Button disabled={busy} onClick={() => void mutate(() => agentRequest(`/projects/${encodeURIComponent(projectId)}/roots`, 'PATCH', { workspaceIds: selectedRoots }))}>{t('native.saveFolders')}</Button>
        </fieldset>}
        <Field label={t('native.connection')}><Select ariaLabel={t('native.connection')} value={connectionId} onChange={setConnection} options={[{ value: '', label: t('native.choose') }, ...connections.map(c => ({ value: c.id, label: c.name }))]} /></Field>
        <Field label={t('native.model')}><Input aria-label={t('native.model')} value={model} onChange={e => setModel(e.target.value)} required /></Field>
        <Field label={t('native.mode')}><Select ariaLabel={t('native.mode')} value={mode} onChange={v => setMode(v as AccessMode)} options={[{ value: 'read-only', label: t('native.read-only') }, { value: 'full-access', label: t('native.full-access') }]} /></Field>
        {mode === 'full-access' && <p role="status" className="text-warning">{t('native.shellLimited')}</p>}
        <Field label={t('native.domains')}><Input aria-label={t('native.domains')} value={domains} onChange={e => setDomains(e.target.value)} /></Field>
        {connections.find(c => c.id === connectionId)?.kind === 'local_runtime' && <Field label={t('native.context')}><Input aria-label={t('native.context')} type="number" min={1} value={context} onChange={e => setContext(e.target.value)} required /></Field>}
        <Field label={t('native.attachments')}><Input aria-label={t('native.attachments')} value={attachments} onChange={e => setAttachments(e.target.value)} /></Field>
        <Field label={t('native.protected')}><Textarea aria-label={t('native.protected')} value={protectedPaths} onChange={e => setProtected(e.target.value)} /></Field>
      </>}
      <Field label={t('native.prompt')}><Textarea aria-label={t('native.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)} required /></Field>
      <Button type="submit" disabled={busy || loading || error || (!sessionId && (!projectId || !connectionId || !model))}>{t(sessionId ? 'native.send' : 'native.start')}</Button>
    </form>
  </div>
}
