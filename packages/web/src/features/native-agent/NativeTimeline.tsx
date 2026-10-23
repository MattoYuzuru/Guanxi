import { useEffect, useRef, useState } from 'react'
import { promptTextOf, type SessionEvent } from '@guanxi/contract'
import { Icon, IconButton, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@guanxi/ui'
import { Markdown } from '../../components/Markdown.tsx'
import { formatDateTime } from '../../lib/format.ts'
import { translate as t } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { DEFAULT_ASYNC_RETRY, retryDelay } from '../../lib/useAsync.ts'
import { sessionLogApi } from './api.ts'

/** One turn of the W1 timeline, read from the session log (prompt and assistant.message events). */
export interface TimelineMessage {
  /** The session-log event; null for the progress summary shown before the log answers. */
  seq: number | null
  role: 'user' | 'agent'
  text: string
  at: string
}

export function messagesOf(events: readonly SessionEvent[]): TimelineMessage[] {
  return events.flatMap((event): TimelineMessage[] => {
    if (event.type === 'prompt') return [{ seq: event.seq, role: 'user', text: promptTextOf(event), at: event.createdAt }]
    if (event.type === 'assistant.message' && event.data.text.trim()) return [{ seq: event.seq, role: 'agent', text: event.data.text, at: event.createdAt }]
    return []
  })
}

/** How often a live session's log is read for new turns. */
export const TIMELINE_LIVE_MS = 1_000

/**
 * Reads the session log incrementally: only events after the last one seen, appended in order.
 * A live session is re-read quietly; a failed read keeps what is on screen and tries again with
 * the shared back-off (D-203). `null` means the first read has not finished yet.
 */
export function useSessionTimeline(sessionId: string, live: boolean, revision: number): TimelineMessage[] | null {
  const [messages, setMessages] = useState<TimelineMessage[] | null>(null)
  // The host keys this page by session id, so a different session starts from an empty cursor.
  const cursor = useRef({ after: 0 })
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const read = async () => {
      try {
        let after = cursor.current.after
        const fresh: TimelineMessage[] = []
        for (;;) {
          const page = await sessionLogApi.events(sessionId, after, abort.signal)
          fresh.push(...messagesOf(page.events))
          after = page.nextAfter
          if (!page.hasMore || page.events.length === 0) break
        }
        // Commit the cursor only for a read that still belongs to this effect, so nothing is skipped.
        if (abort.signal.aborted) return
        cursor.current.after = after
        failures = 0
        setMessages(previous => fresh.length === 0 ? previous ?? [] : [...previous ?? [], ...fresh])
        if (live) timer = setTimeout(read, TIMELINE_LIVE_MS)
      } catch {
        if (abort.signal.aborted) return
        failures += 1
        setMessages(previous => previous ?? [])
        timer = setTimeout(read, retryDelay(failures, DEFAULT_ASYNC_RETRY))
      }
    }
    void read()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId, live, revision])
  return messages
}

/** The session title from the log and the project name for the breadcrumb; both may be unknown. */
export function useSessionHeading(sessionId: string, projectId: string | null, settled: boolean) {
  const [title, setTitle] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    sessionLogApi.summary(sessionId, abort.signal).then(summary => { if (!abort.signal.aborted) setTitle(summary.title) }, () => {})
    return () => abort.abort()
  }, [sessionId, settled])
  useEffect(() => {
    const abort = new AbortController()
    sessionLogApi.projects(abort.signal).then(list => { if (!abort.signal.aborted) setProjects(list) }, () => {})
    return () => abort.abort()
  }, [])
  return { title, project: projectId === null ? null : projects?.find(project => project.id === projectId)?.name ?? null }
}

function CopyAction({ text, announce }: { text: string; announce(message: string): void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    if (!navigator.clipboard) { announce(t('native.message.copyFailed')); return }
    navigator.clipboard.writeText(text).then(() => { setCopied(true); announce(t('native.message.copied')) }, () => announce(t('native.message.copyFailed')))
  }
  return <IconButton size="sm" label={t('native.message.copy')} icon={<Icon name={copied ? 'check' : 'copy'} />} onClick={copy} />
}

function TimelineEntry({ message, sessionId, announce }: { message: TimelineMessage; sessionId: string; announce(message: string): void }) {
  const author = t(message.role === 'user' ? 'native.message.user' : 'native.message.agent')
  return <li className="native-message" data-role={message.role} data-testid="native-message">
    <p className="native-message-author"><Icon name={message.role === 'user' ? 'user' : 'agent'} size={14} aria-hidden="true" />{author}</p>
    <div className="native-message-body"><Markdown source={message.text} /></div>
    <div className="native-message-rail" role="group" aria-label={t('native.message.actions', { author })}>
      <IconButton size="sm" label={t('native.message.trace')} icon={<Icon name="trace" />} nativeButton={false} role="link" render={<Link to={paths.inspector(sessionId)} />} />
      <Popover>
        <PopoverTrigger render={<IconButton size="sm" label={t('native.message.details')} icon={<Icon name="info" />} />} />
        <PopoverContent align="start">
          <PopoverTitle>{t('native.message.details')}</PopoverTitle>
          <dl className="gx-popover-facts">
            <dt>{t('native.message.author')}</dt><dd>{author}</dd>
            <dt>{t('native.message.time')}</dt><dd><time dateTime={message.at}>{formatDateTime(message.at)}</time></dd>
            {message.seq !== null && <><dt>{t('native.message.event')}</dt><dd>{message.seq}</dd></>}
            <dt>{t('native.message.sourceLabel')}</dt><dd>{t(message.seq === null ? 'native.message.sourceSummary' : 'native.message.source')}</dd>
          </dl>
        </PopoverContent>
      </Popover>
      <CopyAction text={message.text} announce={announce} />
    </div>
  </li>
}

/**
 * W1 message timeline (D-207): each turn renders its markdown and carries an icon rail (trace,
 * details, copy) with an anchored popover instead of captions. Before the log answers, or when it
 * has no agent turn yet, the latest progress summary stands in as the agent's turn.
 */
export function NativeTimeline({ sessionId, messages, summary, observedAt }: {
  sessionId: string; messages: TimelineMessage[] | null; summary: string; observedAt: string
}) {
  const [announcement, setAnnouncement] = useState('')
  const shown = messages ?? []
  const hasAgentTurn = shown.some(message => message.role === 'agent')
  const fallback: TimelineMessage | null = !hasAgentTurn && summary.trim() ? { seq: null, role: 'agent', text: summary, at: observedAt } : null
  const entries = fallback ? [...shown, fallback] : shown
  return <section aria-label={t('native.timeline')}>
    {entries.length === 0
      ? <p className="native-muted" role="status">{t(messages === null ? 'native.timeline.loading' : 'native.noSummary')}</p>
      : <ol className="native-timeline-list">
        {entries.map(message => <TimelineEntry key={message.seq ?? 'summary'} message={message} sessionId={sessionId} announce={setAnnouncement} />)}
      </ol>}
    <p role="status" className="sr-only">{announcement}</p>
  </section>
}
