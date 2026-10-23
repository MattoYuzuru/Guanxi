import { useEffect, useState, type FormEvent } from 'react'
import type { AgentProgress } from '@guanxi/contract'
import { Button } from '@guanxi/ui'
import { Field, Textarea } from '../../components/ui.tsx'
import { Link, paths, navigate } from '../../lib/router.tsx'
import { translate as t, getActiveLocale } from '../../lib/locale.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { NewSessionScreen } from '../new-session/NewSessionScreen.tsx'
import { SideChatPanel } from '../side-chat/SideChatPanel.tsx'
import { nativeApi } from './api.ts'

export function NativeProgress({ progress, stop, remove }: { progress: AgentProgress; stop: () => void; remove: (id: string) => void }) {
  return <section aria-label={t('native.progress')} className="rounded-panel border border-divider bg-surface p-4">
    <h2 className="text-15">{t('native.progress')}</h2>
    <p role="status" aria-live="polite">{t(`native.${progress.status}`)}</p>
    <p className="text-muted text-12">{t('native.source', { time: new Date(progress.observedAt).toLocaleString(getActiveLocale()) })}</p>
    <p>{t(`native.${progress.mode}`)}</p>
    {progress.error && <p role="alert">{t(progress.error === 'cleanup_unconfirmed' ? 'native.cleanup_unconfirmed' : progress.error === 'process_restarted' ? 'native.process_restarted' : 'native.sessionError')}</p>}
    {progress.shellUnavailable && <p role="alert">{t(`native.${progress.shellUnavailable}`)}</p>}
    {progress.status === 'running' && <Button onClick={stop}>{t('native.stop')}</Button>}
    <h3>{t('native.plan')}</h3>
    {progress.plan.length === 0 ? <p className="text-muted">{t('native.noPlan')}</p> : <ol>{progress.plan.map((item, index) => <li key={index}>{item.text} · {t(`native.${item.status}`)}</li>)}</ol>}
    <h3>{t('native.queue')}</h3>
    {progress.queue.length === 0 ? <p className="text-muted">{t('native.noQueue')}</p> : <ul>{progress.queue.map(item => <li key={item.id}>{item.text}<Button aria-label={t('native.remove')} onClick={() => remove(item.id)}>{t('native.remove')}</Button></li>)}</ul>}
    <h3>{t('native.summary')}</h3><p className="whitespace-pre-wrap break-words">{progress.summary || t('native.noSummary')}</p>
    <Link to={paths.inspector(progress.sessionId)} className="text-accent underline">{t('native.trace')}</Link>
  </section>
}
export function NativeSessionActions({ progress, busy, remove, retain, leave }: {
  progress: AgentProgress; busy: boolean; remove(): void; retain(mode: 'keep' | 'ttl' | 'session'): void; leave(): void
}) {
  return <section aria-label={t('native.retention')} className="flex flex-col gap-2">
    {progress.retention && <>
      <p>{t(`native.retention.${progress.retention.state}`)}</p>
      <p className="text-muted">{t('native.retentionDescription')}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('native.retention')}>
        {(['keep', 'ttl', 'session'] as const).map(mode => <Button key={mode} disabled={busy || progress.retention?.state === 'deleting'}
          aria-pressed={progress.retention?.mode === mode && progress.retention.state === 'active'} onClick={() => retain(mode)}>{t(`native.retention.${mode}`)}</Button>)}
      </div>
      {progress.retention.mode === 'session' && progress.retention.state === 'active' && <Button disabled={busy} onClick={leave}>{t('native.leave')}</Button>}
    </>}
    <p id="native-delete-description" className="text-muted">{t('native.deleteDescription')}</p>
    <Button variant="danger" aria-describedby="native-delete-description" loading={busy}
      disabled={progress.status === 'running' || progress.error === 'cleanup_unconfirmed'} onClick={remove}>{t('native.delete')}</Button>
  </section>
}
/** The new-session screen (E1) lives in its own feature; this route also hosts a running session. */
export function NativeAgentPage({ sessionId }: { sessionId: string | null }) {
  return sessionId === null ? <NewSessionScreen /> : <NativeSessionPage sessionId={sessionId} />
}
function NativeSessionPage({ sessionId }: { sessionId: string }) {
  useLocale()
  const [prompt, setPrompt] = useState('')
  const [progress, setProgress] = useState<AgentProgress | null>(null)
  const [error, setError] = useState(false), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
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
    void mutate(async () => { await nativeApi.prompt(sessionId, prompt); setPrompt('') })
  }
  return <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-foreground">
    <h1 className="text-18">{t('native.progress')}</h1>
    {error && <div role="alert"><p>{t(navigator.onLine ? 'native.error' : 'native.offline')}</p><Button onClick={() => setRevision(r => r + 1)}>{t('native.retry')}</Button></div>}
    {progress && <NativeProgress progress={progress} stop={() => void mutate(() => nativeApi.stop(progress.sessionId))} remove={id => void mutate(() => nativeApi.remove(progress.sessionId, id))} />}
    {progress && <SideChatPanel sessionId={progress.sessionId} />}
    {progress && <NativeSessionActions progress={progress} busy={busy}
      remove={() => void mutate(async () => { await nativeApi.deleteSession(progress.sessionId); navigate(paths.agent()) })}
      retain={mode => void mutate(() => nativeApi.setRetention(progress.sessionId, mode))}
      leave={() => void mutate(() => nativeApi.leaveSession(progress.sessionId))} />}
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-3">
      <Field label={t('native.prompt')}><Textarea aria-label={t('native.prompt')} value={prompt} onChange={e => setPrompt(e.target.value)} required /></Field>
      <Button type="submit" disabled={busy || error || !progress}>{t(progress?.status === 'running' ? 'native.send' : 'native.continue')}</Button>
    </form>
  </div>
}
