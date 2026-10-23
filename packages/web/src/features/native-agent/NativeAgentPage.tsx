import { useEffect, useId, useRef, useState } from 'react'
import './native-session.css'
import type { AgentProgress } from '@guanxi/contract'
import { Badge, Button, Composer, Icon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { replaceEqualDeep } from '../../lib/stable.ts'
import { DEFAULT_ASYNC_RETRY, retryDelay } from '../../lib/useAsync.ts'
import { Link, paths, navigate } from '../../lib/router.tsx'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { NewSessionScreen } from '../new-session/NewSessionScreen.tsx'
import { SideChatPanel } from '../side-chat/SideChatPanel.tsx'
import { nativeApi } from './api.ts'
import { clearCurrentProject, publishCurrentProject } from '../../lib/current-project.ts'
import { rememberProject } from '../new-session/recent.ts'
import { NativeTimeline, useSessionHeading, useSessionTimeline } from './NativeTimeline.tsx'

const CURRENT_PROJECT_WRITER = Symbol('native-session')

const PLAN_ICON = { verification_requested: 'check', active: 'play', pending: 'unknown' } as const

/**
 * The agent's own status below the timeline: alerts, the plan and the prompt queue as flat
 * divider lists (no nested cards), and where the state was read.
 */
export function NativeProgress({ progress, remove }: { progress: AgentProgress; remove: (id: string) => void }) {
  const active = progress.plan.find(item => item.status === 'active')
  return <section aria-label={t('native.progress')} className="native-progress">
    {progress.error && <p role="alert" className="native-progress-alert">{t(progress.error === 'cleanup_unconfirmed' ? 'native.cleanup_unconfirmed' : progress.error === 'process_restarted' ? 'native.process_restarted' : 'native.sessionError')}</p>}
    {progress.shellUnavailable && <p role="alert" className="native-progress-alert">{t(`native.${progress.shellUnavailable}`)}</p>}
    <p role="status" aria-live="polite" className="native-progress-state" data-status={progress.status}>
      {progress.status === 'running' ? <><Icon name="runtime" size={14} aria-hidden="true" /><span>{active ? active.text : t('native.running')}</span></> : t(`native.${progress.status}`)}
    </p>
    <section className="native-section" aria-labelledby={`${progress.sessionId}-plan`}>
      <h2 id={`${progress.sessionId}-plan`} className="native-section-title">{t('native.plan')}</h2>
      {progress.plan.length === 0 ? <p className="native-muted">{t('native.noPlan')}</p>
        : <ol className="native-list native-plan">{progress.plan.map((item, index) => <li key={index} data-status={item.status}>
          <Icon name={PLAN_ICON[item.status]} size={14} aria-hidden="true" />
          <span>{item.text}</span><span className="sr-only">{t(`native.${item.status}`)}</span></li>)}</ol>}
    </section>
    {progress.queue.length > 0 && <section className="native-section" aria-labelledby={`${progress.sessionId}-queue`}>
      <h2 id={`${progress.sessionId}-queue`} className="native-section-title">{t('native.queue')}</h2>
      <ul className="native-list">{progress.queue.map(item => <li key={item.id}><span>{item.text}</span>
        <IconButton size="sm" label={t('native.remove')} icon={<Icon name="close" />} onClick={() => remove(item.id)} /></li>)}</ul>
    </section>}
    <p className="native-progress-source">{t('native.source', { time: formatDateTime(progress.observedAt) })}</p>
  </section>
}
export function NativeSessionActions({ progress, busy, remove, retain, leave }: {
  progress: AgentProgress; busy: boolean; remove(): void; retain(mode: 'keep' | 'ttl' | 'session'): void; leave(): void
}) {
  return <section aria-label={t('native.retention')} className="flex flex-col gap-2 text-12">
    {progress.retention && <>
      <p className="m-0 font-label">{t(`native.retention.${progress.retention.state}`)}</p>
      <p className="m-0 text-muted">{t('native.retentionDescription')}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('native.retention')}>
        {(['keep', 'ttl', 'session'] as const).map(mode => <Button key={mode} size="sm" disabled={busy || progress.retention?.state === 'deleting'}
          aria-pressed={progress.retention?.mode === mode && progress.retention.state === 'active'} onClick={() => retain(mode)}>{t(`native.retention.${mode}`)}</Button>)}
      </div>
      {progress.retention.mode === 'session' && progress.retention.state === 'active' && <Button size="sm" disabled={busy} onClick={leave}>{t('native.leave')}</Button>}
    </>}
    <p id="native-delete-description" className="m-0 text-muted">{t('native.deleteDescription')}</p>
    <Button size="sm" variant="danger" aria-describedby="native-delete-description" loading={busy}
      disabled={progress.status === 'running' || progress.error === 'cleanup_unconfirmed'} onClick={remove}>{t('native.delete')}</Button>
  </section>
}
/**
 * Consecutive failed progress reads before the offline note appears while a state is on screen.
 * One missed 500 ms poll is a blip, not news (D-203); with the 2 s → 4 s back-off the third
 * failure lands about six seconds after the node stopped answering.
 */
export const OFFLINE_AFTER_FAILURES = 3
/** The new-session screen (E1) lives in its own feature; this route also hosts a running session. */
export function NativeAgentPage({ sessionId }: { sessionId: string | null }) {
  return sessionId === null ? <NewSessionScreen /> : <NativeSessionPage key={sessionId} sessionId={sessionId} />
}
const STATUS_TONE = { running: 'accent', completed: 'success', failed: 'danger' } as const
/**
 * W1 session (D-207): the session title with its project as the header, the conversation as a
 * message timeline, the agent's plan and queue below it, and the composer docked at the bottom
 * with Stop beside Send. Side chat is a side panel toggled from the header; it stays mounted while
 * hidden, so closing it never drops an unsaved conversation. Progress refreshes quietly and keeps
 * equal data identical; a failed read keeps the last state and retries by itself (D-203).
 */
function NativeSessionPage({ sessionId }: { sessionId: string }) {
  useLocale()
  // A route change moves focus to the page heading, so keyboard and screen-reader users land on the session they just opened.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const [prompt, setPrompt] = useState('')
  const [progress, setProgress] = useState<AgentProgress | null>(null)
  const [offline, setOffline] = useState(false), [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [sideOpen, setSideOpen] = useState(false)
  const panelId = useId(), toggle = useRef<HTMLButtonElement>(null), aside = useRef<HTMLElement>(null)
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0; let hasData = false
    const refresh = async () => {
      try {
        const next = await nativeApi.progress(sessionId, abort.signal)
        if (abort.signal.aborted) return
        failures = 0; hasData = true
        setProgress(previous => previous === null ? next : replaceEqualDeep(previous, next)); setOffline(false)
        if (next.status === 'running') timer = setTimeout(refresh, 500)
      } catch {
        if (abort.signal.aborted) return
        failures += 1
        // Without a state on screen, or with the browser offline, say so at once; otherwise wait out blips.
        if (!hasData || !navigator.onLine || failures >= OFFLINE_AFTER_FAILURES) setOffline(true)
        timer = setTimeout(refresh, retryDelay(failures, DEFAULT_ASYNC_RETRY))
      }
    }
    void refresh()
    const wake = () => { clearTimeout(timer); void refresh() }
    window.addEventListener('online', wake)
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('online', wake) }
  }, [sessionId, revision])
  const running = progress?.status === 'running'
  // Opening a session makes its project the current one (D-207): the shell's New session goes
  // there, and it becomes the most recent project for the next visit.
  const sessionProject = progress?.projectId ?? null
  useEffect(() => {
    if (!sessionProject) return
    rememberProject(sessionProject)
    publishCurrentProject(CURRENT_PROJECT_WRITER, sessionProject)
    return () => clearCurrentProject(CURRENT_PROJECT_WRITER)
  }, [sessionProject])
  const messages = useSessionTimeline(sessionId, running, revision)
  const { title, project } = useSessionHeading(sessionId, progress?.projectId ?? null, progress !== null && !running)
  useEffect(() => { if (sideOpen) aside.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus() }, [sideOpen])
  const closeSide = () => { setSideOpen(false); requestAnimationFrame(() => toggle.current?.focus()) }
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError(false)
    try { await action(); setRevision(r => r + 1) } catch { setActionError(true) } finally { setBusy(false) }
  }
  const send = () => { void mutate(async () => { await nativeApi.prompt(sessionId, prompt); setPrompt('') }) }
  const firstPrompt = messages?.find(message => message.role === 'user')?.text.split('\n')[0]
  return <div className="native-session" data-side-chat={sideOpen ? 'open' : 'closed'}>
    <div className="native-session-layout">
      <div className="native-session-main">
        <header className="native-session-header">
          <div className="native-session-heading">
            <nav aria-label={t('native.breadcrumb')} className="native-session-crumbs">
              <Link to={paths.projects()} className="native-session-crumb">{project ?? t('native.project')}</Link>
            </nav>
            <Icon name="chevron-right" size={14} aria-hidden="true" className="native-session-crumb-separator" />
            <h1 ref={heading} tabIndex={-1} className="native-session-title">{title ?? firstPrompt ?? t('native.untitled')}</h1>
          </div>
          {progress && <Badge tone={STATUS_TONE[progress.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{t(`native.${progress.status}`)}</Badge>}
          {/* A persistent slot: the note fills it in place, so nothing below moves when the node drops. */}
          <p role="status" data-testid="native-connection" className="native-session-connection">
            {offline && <><Icon name="offline" aria-hidden="true" /><span>{t('native.offline')}</span></>}
          </p>
          <div className="native-session-actions">
            {progress && <IconButton ref={toggle} label={t('native.sideChat')} icon={<Icon name="chat" />} pressed={sideOpen}
              aria-controls={panelId} onClick={() => (sideOpen ? closeSide() : setSideOpen(true))} />}
            {progress && <IconButton label={t('native.trace')} icon={<Icon name="trace" />} nativeButton={false} role="link" render={<Link to={paths.inspector(progress.sessionId)} />} />}
            {progress && <Popover>
              <PopoverTrigger render={<IconButton label={t('native.info')} icon={<Icon name="info" />} />} />
              <PopoverContent align="end" className="w-sm">
                <PopoverTitle>{t('native.info')}</PopoverTitle>
                <NativeSessionActions progress={progress} busy={busy}
                  remove={() => void mutate(async () => { await nativeApi.deleteSession(progress.sessionId); navigate(paths.agent()) })}
                  retain={mode => void mutate(() => nativeApi.setRetention(progress.sessionId, mode))}
                  leave={() => void mutate(() => nativeApi.leaveSession(progress.sessionId))} />
              </PopoverContent>
            </Popover>}
          </div>
        </header>
        <div className="native-session-scroll">
          <div className="native-session-column">
            {actionError && <p role="alert" className="native-session-note">{t('native.error')}</p>}
            {progress && <NativeTimeline sessionId={sessionId} messages={messages} summary={progress.summary} observedAt={progress.observedAt} />}
            {progress && <NativeProgress progress={progress} remove={id => void mutate(() => nativeApi.remove(progress.sessionId, id))} />}
            {!progress && !offline && <p className="native-muted" role="status">{t('native.timeline.loading')}</p>}
          </div>
        </div>
        <div className="native-session-dock">
          <Composer label={t('native.prompt')} placeholder={t(running ? 'native.send' : 'native.continue')} value={prompt} onValueChange={setPrompt}
            onSend={send} sendDisabled={busy || !progress} disabled={!progress && !offline} sendLabel={t(running ? 'native.send' : 'native.continue')}
            leading={progress ? <Badge>{t(`native.${progress.mode}`)}</Badge> : undefined}
            trailing={running && progress ? <IconButton className="native-stop" variant="secondary" label={t('native.stop')} icon={<Icon name="stop" />}
              disabled={busy} onClick={() => void mutate(() => nativeApi.stop(progress.sessionId))} /> : undefined} />
        </div>
      </div>
      {progress && <aside ref={aside} id={panelId} className="native-session-aside" hidden={!sideOpen} aria-label={t('sideChat.title')}
        onKeyDown={event => {
          // Escape from a popover inside the panel bubbles here through the portal; only the panel's own DOM closes it.
          if (event.key !== 'Escape' || event.defaultPrevented || !aside.current?.contains(event.target as Node)) return
          event.stopPropagation(); closeSide()
        }}>
        <SideChatPanel sessionId={progress.sessionId} onSent={() => setRevision(r => r + 1)} onClose={closeSide} />
      </aside>}
    </div>
  </div>
}
