import { useEffect, useRef, useState } from 'react'
import './native-session.css'
import type { AgentProgress } from '@guanxi/contract'
import { Badge, Button, Composer, Icon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { replaceEqualDeep } from '../../lib/stable.ts'
import { DEFAULT_ASYNC_RETRY, retryDelay } from '../../lib/useAsync.ts'
import { Link, paths, navigate } from '../../lib/router.tsx'
import { translate as t, getActiveLocale } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { NewSessionScreen } from '../new-session/NewSessionScreen.tsx'
import { SideChatPanel } from '../side-chat/SideChatPanel.tsx'
import { nativeApi } from './api.ts'

export function NativeProgress({ progress, stop, remove }: { progress: AgentProgress; stop: () => void; remove: (id: string) => void }) {
  return <section aria-label={t('native.progress')} className="native-progress">
    <div className="native-progress-status">
      <p role="status" aria-live="polite" className="native-progress-state">{t(`native.${progress.status}`)}</p>
      <p className="native-progress-source">{t('native.source', { time: new Date(progress.observedAt).toLocaleString(getActiveLocale()) })}</p>
      {progress.status === 'running' && <Button size="sm" onClick={stop}><Icon name="stop" />{t('native.stop')}</Button>}
    </div>
    {progress.error && <p role="alert" className="native-progress-alert">{t(progress.error === 'cleanup_unconfirmed' ? 'native.cleanup_unconfirmed' : progress.error === 'process_restarted' ? 'native.process_restarted' : 'native.sessionError')}</p>}
    {progress.shellUnavailable && <p role="alert" className="native-progress-alert">{t(`native.${progress.shellUnavailable}`)}</p>}
    <section className="native-card">
      <h2 className="native-card-title">{t('native.plan')}</h2>
      {progress.plan.length === 0 ? <p className="native-muted">{t('native.noPlan')}</p>
        : <ol className="native-plan">{progress.plan.map((item, index) => <li key={index} data-status={item.status}>
          <Icon name={item.status === 'verification_requested' ? 'check' : item.status === 'active' ? 'play' : 'unknown'} size={14} />
          <span>{item.text}</span><span className="sr-only">{t(`native.${item.status}`)}</span></li>)}</ol>}
    </section>
    <section className="native-card">
      <h2 className="native-card-title">{t('native.queue')}</h2>
      {progress.queue.length === 0 ? <p className="native-muted">{t('native.noQueue')}</p>
        : <ul className="native-queue">{progress.queue.map(item => <li key={item.id}><span>{item.text}</span>
          <IconButton size="sm" label={t('native.remove')} icon={<Icon name="close" />} onClick={() => remove(item.id)} /></li>)}</ul>}
    </section>
    <section className="native-response">
      <h2 className="native-card-title">{t('native.summary')}</h2>
      <p className="native-response-text">{progress.summary || t('native.noSummary')}</p>
    </section>
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
/** The new-session screen (E1) lives in its own feature; this route also hosts a running session. */
export function NativeAgentPage({ sessionId }: { sessionId: string | null }) {
  return sessionId === null ? <NewSessionScreen /> : <NativeSessionPage sessionId={sessionId} />
}
/**
 * W1 session (D-207): after the first prompt the composer docks at the bottom; the transcript
 * column scrolls above it. Progress refreshes quietly while the run is active and keeps equal
 * data identical, so nothing re-renders visibly; a failed read keeps the last state and retries
 * by itself (D-203). Trace and session info are icon buttons with anchored popovers.
 */
function NativeSessionPage({ sessionId }: { sessionId: string }) {
  useLocale()
  // A route change moves focus to the page heading, so keyboard and screen-reader users land on the session they just opened.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const [prompt, setPrompt] = useState('')
  const [progress, setProgress] = useState<AgentProgress | null>(null)
  const [error, setError] = useState(false), [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0
    const refresh = async () => {
      try {
        const next = await nativeApi.progress(sessionId, abort.signal)
        if (abort.signal.aborted) return
        failures = 0
        setProgress(previous => previous === null ? next : replaceEqualDeep(previous, next)); setError(false)
        if (next.status === 'running') timer = setTimeout(refresh, 500)
      } catch {
        if (abort.signal.aborted) return
        failures += 1; setError(true)
        timer = setTimeout(refresh, retryDelay(failures, DEFAULT_ASYNC_RETRY))
      }
    }
    void refresh()
    const wake = () => { clearTimeout(timer); void refresh() }
    window.addEventListener('online', wake)
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('online', wake) }
  }, [sessionId, revision])
  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true); setActionError(false)
    try { await action(); setRevision(r => r + 1) } catch { setActionError(true) } finally { setBusy(false) }
  }
  const send = () => { void mutate(async () => { await nativeApi.prompt(sessionId, prompt); setPrompt('') }) }
  const running = progress?.status === 'running'
  return <div className="native-session">
    <header className="native-session-header">
      <h1 ref={heading} tabIndex={-1} className="native-session-title">{t('native.progress')}</h1>
      {progress && <Badge tone={progress.status === 'running' ? 'accent' : progress.status === 'completed' ? 'success' : progress.status === 'failed' ? 'danger' : 'neutral'}>
        {t(`native.${progress.status}`)}</Badge>}
      <div className="native-session-actions">
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
        {error && <p role="status" className="native-session-note"><Icon name="offline" />{t(navigator.onLine ? 'native.offline' : 'native.offline')}</p>}
        {actionError && <p role="alert" className="native-session-note">{t('native.error')}</p>}
        {progress && <NativeProgress progress={progress} stop={() => void mutate(() => nativeApi.stop(progress.sessionId))} remove={id => void mutate(() => nativeApi.remove(progress.sessionId, id))} />}
        {progress && <SideChatPanel sessionId={progress.sessionId} onSent={() => setRevision(r => r + 1)} />}
      </div>
    </div>
    <div className="native-session-dock">
      <Composer label={t('native.prompt')} placeholder={t(running ? 'native.send' : 'native.continue')} value={prompt} onValueChange={setPrompt}
        onSend={send} sendDisabled={busy || !progress} disabled={!progress && !error} sendLabel={t(running ? 'native.send' : 'native.continue')}
        leading={progress ? <Badge>{t(`native.${progress.mode}`)}</Badge> : undefined} />
    </div>
  </div>
}
