/**
 * Interim trace inspector (K2, screen W3 in docs/design/LAYOUT_AND_SCREENS.md).
 *
 * Reads the session event log: timeline with nested spans, FTS5 search, token
 * meter and export. The timeline is rebuilt from persisted events on every
 * load and extended by a persisted-first live tail, so a reload shows exactly
 * what the live view showed. Built from the legacy primitives in
 * components/ui.tsx because @guanxi/ui (DS1) is not merged; U1 migrates it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  SEARCH_MATCH_CLOSE,
  SEARCH_MATCH_OPEN,
  type SessionEvent,
  type SessionEventType,
  type SessionSearchHit,
  type SessionSpan,
  type SessionSummary,
} from '@guanxi/contract'
import { Badge, Button, Callout, EmptyState, Input, Skeleton, Stat, cx } from '../../components/ui.tsx'
import { ApiRequestError, errorMessage } from '../../lib/api.ts'
import { useLocale } from '../../lib/locale-context.tsx'
import { translate, type LocaleKey } from '../../lib/locale.ts'
import { Link, paths } from '../../lib/router.tsx'
import { useAsync } from '../../lib/useAsync.ts'
import { inspectorApi } from './api.ts'
import {
  EMPTY_TIMELINE,
  countByType,
  eventDetail,
  mergeEvents,
  segmentRedactions,
  spanDepth,
  type TimelineState,
} from './model.ts'

const TYPE_KEYS: Record<SessionEventType, LocaleKey> = {
  'session.created': 'inspector.type.sessionCreated',
  'writer.acquired': 'inspector.type.writerAcquired',
  prompt: 'inspector.type.prompt',
  'assistant.started': 'inspector.type.assistantStarted',
  'assistant.message': 'inspector.type.assistantMessage',
  reasoning: 'inspector.type.reasoning',
  'tool.call': 'inspector.type.toolCall',
  'tool.approval': 'inspector.type.toolApproval',
  'tool.result': 'inspector.type.toolResult',
  usage: 'inspector.type.usage',
  context: 'inspector.type.context',
  'job.lifecycle': 'inspector.type.jobLifecycle',
  intervention: 'inspector.type.intervention',
  error: 'inspector.type.error',
  'turn.done': 'inspector.type.turnDone',
}

const SPAN_KIND_KEYS: Record<SessionSpan['kind'], LocaleKey> = {
  turn: 'inspector.span.turn',
  step: 'inspector.span.step',
  tool: 'inspector.span.tool',
}

type LiveState = 'connecting' | 'live' | 'reconnecting' | 'offline'

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function InspectorPage({ sessionId }: { sessionId: string | null }) {
  useLocale()
  return sessionId ? <SessionInspector key={sessionId} sessionId={sessionId} /> : <SessionList />
}

/* ───────────────────────────── Session list ───────────────────────────── */

function SessionList() {
  const sessions = useAsync((signal) => inspectorApi.sessions(signal), [])
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-3 py-4 sm:px-6" aria-labelledby="inspector-list-title">
      <header className="flex flex-col gap-1">
        <h1 id="inspector-list-title" className="text-sm font-semibold">{translate('inspector.list.title')}</h1>
        <p className="text-xs text-[var(--fg-muted)]">{translate('inspector.list.description')}</p>
      </header>
      {sessions.loading && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={translate('inspector.loading')}>
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-11 w-full" />)}
        </div>
      )}
      {sessions.error != null && (
        <Callout
          tone="danger"
          title={translate('inspector.list.error')}
          action={<Button size="sm" onClick={sessions.reload}>{translate('inspector.retry')}</Button>}
        >
          {errorMessage(sessions.error)}
        </Callout>
      )}
      {sessions.data && sessions.data.sessions.length === 0 && (
        <EmptyState
          title={translate('inspector.list.empty.title')}
          description={translate('inspector.list.empty.description')}
          action={
            <Link to={paths.chat()} className="text-xs text-[var(--accent)] underline underline-offset-2">
              {translate('inspector.list.empty.action')}
            </Link>
          }
        />
      )}
      {sessions.data && sessions.data.sessions.length > 0 && (
        <ul className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]" aria-label={translate('inspector.list.label')}>
          {sessions.data.sessions.map((session) => (
            <li key={session.sessionId}>
              <Link
                to={paths.inspector(session.sessionId)}
                className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 hover:bg-[var(--bg-subtle)]"
              >
                <span className="min-w-0 truncate text-xs font-medium">
                  <RedactedText text={session.title ?? translate('inspector.untitled')} />
                </span>
                <span className="flex items-center gap-2 text-2xs text-[var(--fg-subtle)]">
                  <Badge>{translate(session.kind === 'chat' ? 'inspector.kind.chat' : 'inspector.kind.agent')}</Badge>
                  <span className="font-mono tabular-nums">{translate('inspector.list.events', { count: session.lastSeq })}</span>
                  {session.lastEventAt && <time dateTime={session.lastEventAt}>{dateTime(session.lastEventAt)}</time>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ─────────────────────────── One session's trace ──────────────────────── */

function SessionInspector({ sessionId }: { sessionId: string }) {
  const [timeline, setTimeline] = useState<TimelineState>(EMPTY_TIMELINE)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState<LiveState>('connecting')
  const [liveSince, setLiveSince] = useState<string | null>(null)
  const [tab, setTab] = useState<'timeline' | 'spans'>('timeline')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setTimeline(EMPTY_TIMELINE)
    void (async () => {
      try {
        const [head, events] = await Promise.all([
          inspectorApi.summary(sessionId, controller.signal),
          inspectorApi.allEvents(sessionId, controller.signal),
        ])
        if (controller.signal.aborted) return
        setSummary(head)
        const initial = mergeEvents(EMPTY_TIMELINE, events)
        setTimeline(initial)
        setLoading(false)
        setLive('connecting')
        try {
          const stream = inspectorApi.live(sessionId, initial.lastSeq, controller.signal, {
            onOpen: () => {
              setLive('live')
              setLiveSince(new Date().toISOString())
            },
            onReconnect: () => setLive('reconnecting'),
          })
          for await (const event of stream) {
            setLive('live')
            setLiveSince(new Date().toISOString())
            setTimeline((current) => mergeEvents(current, [event]))
          }
          if (!controller.signal.aborted) setLive('offline')
        } catch {
          if (!controller.signal.aborted) setLive('offline')
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setLoadError(error)
        setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [sessionId, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  if (loading) return <InspectorSkeleton />
  if (loadError) {
    const notFound = loadError instanceof ApiRequestError && loadError.code === 'session_not_found'
    return (
      <section className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-6">
        {notFound ? (
          <EmptyState
            title={translate('inspector.notFound.title')}
            description={translate('inspector.notFound.description')}
            action={<Link to={paths.inspector()} className="text-xs text-[var(--accent)] underline underline-offset-2">{translate('inspector.backToList')}</Link>}
          />
        ) : (
          <Callout
            tone="danger"
            title={translate('inspector.error.title')}
            action={<Button size="sm" onClick={reload}>{translate('inspector.retry')}</Button>}
          >
            {errorMessage(loadError)}
          </Callout>
        )}
      </section>
    )
  }

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-4 sm:px-6" aria-labelledby="inspector-title">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={paths.inspector()} className="text-2xs text-[var(--fg-muted)] underline underline-offset-2">
            {translate('inspector.backToList')}
          </Link>
          <h1 id="inspector-title" className="truncate text-sm font-semibold">
            <RedactedText text={summary?.title ?? translate('inspector.untitled')} />
          </h1>
          <LiveStatus state={live} since={liveSince} count={timeline.events.length} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {summary?.threadId && (
            <Link to={paths.chat(summary.threadId)} className="text-2xs text-[var(--accent)] underline underline-offset-2">
              {translate('inspector.openChat')}
            </Link>
          )}
          <a
            href={inspectorApi.exportUrl(sessionId)}
            download={`session-${sessionId}.json`}
            className="inline-flex h-6 items-center rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2 text-2xs font-medium hover:bg-[var(--bg-subtle)]"
          >
            {translate('inspector.export')}
          </a>
        </div>
      </header>

      <Overview timeline={timeline} summary={summary} />
      <SearchPanel sessionId={sessionId} />

      <div role="tablist" aria-label={translate('inspector.views')} className="flex gap-1 border-b border-[var(--border)]">
        {(['timeline', 'spans'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`inspector-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`inspector-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                const next = value === 'timeline' ? 'spans' : 'timeline'
                setTab(next)
                document.getElementById(`inspector-tab-${next}`)?.focus()
              }
            }}
            className={cx(
              'min-h-6 rounded-t-md px-2 py-1 text-xs font-medium',
              tab === value ? 'bg-[var(--bg-inset)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {translate(value === 'timeline' ? 'inspector.tab.timeline' : 'inspector.tab.spans')}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`inspector-panel-${tab}`}
        aria-labelledby={`inspector-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'timeline' ? (
          <Timeline events={timeline.events} />
        ) : (
          <Spans sessionId={sessionId} lastSeq={timeline.lastSeq} />
        )}
      </div>
    </section>
  )
}

function InspectorSkeleton() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-4 sm:px-6" aria-busy="true" aria-label={translate('inspector.loading')}>
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-8 w-full" />
      {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
    </section>
  )
}

function LiveStatus({ state, since, count }: { state: LiveState; since: string | null; count: number }) {
  const label = state === 'live'
    ? translate('inspector.live.on', { count })
    : state === 'connecting'
      ? translate('inspector.live.connecting')
      : state === 'reconnecting'
        ? translate('inspector.live.reconnecting')
        : translate('inspector.live.offline', { time: since ? time(since) : translate('inspector.live.never') })
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-2xs text-[var(--fg-subtle)]">
      <span aria-hidden className={cx('inline-block size-2 rounded-full', state === 'live' ? 'bg-[var(--color-fit-green)]' : 'bg-[var(--color-fit-unknown)]')} />
      {label}
    </p>
  )
}

function Overview({ timeline, summary }: { timeline: TimelineState; summary: SessionSummary | null }) {
  const counts = useMemo(() => countByType(timeline.events), [timeline.events])
  const meter = useMemo(() => {
    let prompt = 0
    let completion = 0
    let cached = 0
    let samples = 0
    let context: Extract<SessionEvent, { type: 'context' }>['data'] | null = null
    for (const event of timeline.events) {
      if (event.type === 'usage') {
        prompt += event.data.promptTokens
        completion += event.data.evalTokens
        cached += event.data.cachedTokens
        samples += 1
      } else if (event.type === 'context') {
        context = event.data
      }
    }
    return { prompt, completion, cached, samples, context }
  }, [timeline.events])
  const purged = timeline.events.filter((event) => event.type === 'reasoning' && event.purgedAt !== null).length

  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-3 sm:grid-cols-4">
      <Stat label={translate('inspector.stat.events')} value={<span data-testid="inspector-event-count">{timeline.events.length}</span>} />
      <Stat label={translate('inspector.stat.prompts')} value={counts.prompt ?? 0} />
      <Stat label={translate('inspector.stat.toolCalls')} value={counts['tool.call'] ?? 0} />
      <Stat
        label={translate('inspector.stat.redactions')}
        value={summary?.redactions ?? translate('inspector.unknown')}
        hint={translate('inspector.stat.redactionsHint')}
      />
      {meter.samples === 0 ? (
        <Stat
          label={translate('inspector.stat.tokens')}
          value={translate('inspector.unknown')}
          hint={translate('inspector.stat.tokensUnknown')}
          mono={false}
        />
      ) : (
        <Stat
          label={translate('inspector.stat.tokens')}
          value={`${meter.prompt} → ${meter.completion}`}
          hint={translate('inspector.stat.tokensSource', { count: meter.samples, cached: meter.cached })}
        />
      )}
      <Stat
        label={translate('inspector.stat.context')}
        value={meter.context
          ? `${meter.context.usedTokens} / ${meter.context.allocatedTokens} (${Math.round(meter.context.percent)}%)`
          : translate('inspector.unknown')}
        hint={meter.context ? translate('inspector.stat.contextSource') : translate('inspector.stat.contextUnknown')}
        mono={meter.context !== null}
      />
      <Stat label={translate('inspector.stat.reasoning')} value={counts.reasoning ?? 0} hint={translate('inspector.stat.reasoningHint')} />
      <Stat label={translate('inspector.stat.purged')} value={purged} hint={translate('inspector.stat.purgedHint')} />
    </div>
  )
}

/* ───────────────────────────────── Search ─────────────────────────────── */

function SearchPanel({ sessionId }: { sessionId: string }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setBusy(true)
    setError(null)
    try {
      const result = await inspectorApi.search(sessionId, text, current.signal)
      if (!current.signal.aborted) setHits(result.hits)
    } catch (failure) {
      if (!current.signal.aborted) setError(failure)
    } finally {
      if (!current.signal.aborted) setBusy(false)
    }
  }

  const reveal = (seq: number) => {
    const row = document.getElementById(`inspector-event-${seq}`)
    row?.scrollIntoView({ block: 'center' })
    row?.focus()
  }

  return (
    <div className="flex flex-col gap-2">
      <form role="search" onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-[var(--fg-muted)]">
          {translate('inspector.search.label')}
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('inspector.search.placeholder')}
            maxLength={200}
          />
        </label>
        <Button type="submit" size="sm" loading={busy} disabled={query.trim().length === 0}>
          {translate('inspector.search.submit')}
        </Button>
      </form>
      {error !== null && <Callout tone="danger" title={translate('inspector.search.error')}>{errorMessage(error)}</Callout>}
      {hits !== null && (
        <div role="region" aria-live="polite" aria-label={translate('inspector.search.results')}>
          {hits.length === 0 ? (
            <p className="text-2xs text-[var(--fg-subtle)]">{translate('inspector.search.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {hits.map((hit) => (
                <li key={`${hit.sessionId}:${hit.seq}`}>
                  <button
                    type="button"
                    onClick={() => reveal(hit.seq)}
                    className="flex min-h-6 w-full flex-wrap items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[var(--bg-subtle)]"
                  >
                    <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">#{hit.seq}</span>
                    <Badge tone={hit.class === 'reasoning' ? 'yellow' : 'neutral'}>{translate(TYPE_KEYS[hit.type])}</Badge>
                    <span className="min-w-0 break-words"><Snippet text={hit.snippet} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let cursor = 0
  let key = 0
  while (cursor < text.length) {
    const open = text.indexOf(SEARCH_MATCH_OPEN, cursor)
    if (open < 0) break
    const close = text.indexOf(SEARCH_MATCH_CLOSE, open)
    if (close < 0) break
    parts.push(<RedactedText key={key++} text={text.slice(cursor, open)} />)
    parts.push(<mark key={key++} className="rounded-sm bg-[var(--accent-subtle)] text-[var(--fg)]">{text.slice(open + 1, close)}</mark>)
    cursor = close + 1
  }
  parts.push(<RedactedText key={key++} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/* ──────────────────────────────── Timeline ────────────────────────────── */

function Timeline({ events }: { events: readonly SessionEvent[] }) {
  if (events.length === 0) {
    return <EmptyState title={translate('inspector.timeline.empty')} />
  }
  return (
    <ol className="flex flex-col gap-0.5" aria-label={translate('inspector.timeline.label')}>
      {events.map((event) => <TimelineRow key={event.seq} event={event} />)}
    </ol>
  )
}

function TimelineRow({ event }: { event: SessionEvent }) {
  const detail = eventDetail(event)
  const depth = spanDepth(event.spanId)
  const indent = depth === 2 ? 'sm:pl-10' : depth === 1 ? 'sm:pl-5' : ''
  return (
    <li
      id={`inspector-event-${event.seq}`}
      tabIndex={-1}
      data-event-type={event.type}
      className={cx('flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-[var(--bg-subtle)]', indent)}
    >
      <div className="flex flex-wrap items-center gap-2 text-2xs text-[var(--fg-subtle)]">
        <span className="font-mono tabular-nums">#{event.seq}</span>
        <time dateTime={event.createdAt} className="font-mono tabular-nums">{time(event.createdAt)}</time>
        <Badge tone={event.class === 'reasoning' ? 'yellow' : event.type === 'error' ? 'red' : 'neutral'}>
          {translate(TYPE_KEYS[event.type])}
        </Badge>
        {event.redactions > 0 && (
          <Badge tone="outline" title={translate('inspector.redactedHint')}>
            {translate('inspector.redactedCount', { count: event.redactions })}
          </Badge>
        )}
      </div>
      {event.type === 'reasoning' ? (
        <ReasoningBody event={event} />
      ) : (
        detail !== null && detail.length > 0 && (
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs">
            <RedactedText text={detail} />
          </p>
        )
      )}
    </li>
  )
}

function ReasoningBody({ event }: { event: Extract<SessionEvent, { type: 'reasoning' }> }) {
  const [open, setOpen] = useState(false)
  if (event.data === null) {
    return (
      <p className="text-2xs text-[var(--fg-subtle)]">
        {translate('inspector.reasoning.purged', { time: dateTime(event.purgedAt ?? event.expiresAt) })}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="min-h-6 self-start text-2xs font-medium text-[var(--fg-muted)] underline underline-offset-2 hover:text-[var(--fg)]"
      >
        {translate(open ? 'inspector.reasoning.hide' : 'inspector.reasoning.show', { time: dateTime(event.expiresAt) })}
      </button>
      {open && (
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-[var(--border-strong)] pl-2 text-xs text-[var(--fg-muted)]">
          <RedactedText text={event.data.text} />
        </p>
      )}
    </div>
  )
}

/** Scrubbed text with each `⟦REDACTED secret://…⟧` marker shown as a badge naming the reference. */
function RedactedText({ text }: { text: string }) {
  return (
    <>
      {segmentRedactions(text).map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            className="mx-0.5 rounded-sm border border-[var(--border-strong)] px-1 font-mono text-2xs text-[var(--fg-muted)]"
            title={translate('inspector.redactedHint')}
          >
            {translate('inspector.redacted', { ref: segment.ref })}
          </span>
        ),
      )}
    </>
  )
}

/* ────────────────────────────────── Spans ─────────────────────────────── */

function Spans({ sessionId, lastSeq }: { sessionId: string; lastSeq: number }) {
  const spans = useAsync((signal) => inspectorApi.spans(sessionId, signal), [sessionId, lastSeq])
  if (spans.loading) return <Skeleton className="h-24 w-full" />
  if (spans.error) {
    return (
      <Callout tone="danger" title={translate('inspector.spans.error')} action={<Button size="sm" onClick={spans.reload}>{translate('inspector.retry')}</Button>}>
        {errorMessage(spans.error)}
      </Callout>
    )
  }
  const list = spans.data?.spans ?? []
  if (list.length === 0) return <EmptyState title={translate('inspector.spans.empty')} />
  const children = new Map<string | null, SessionSpan[]>()
  for (const span of list) {
    const parent = span.parentId && list.some((candidate) => candidate.id === span.parentId) ? span.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), span])
  }
  const render = (parent: string | null, level: number): ReactNode => {
    const items = children.get(parent)
    if (!items) return null
    return (
      <ul className={cx('flex flex-col gap-1', level > 0 && 'border-l border-[var(--border)] pl-3')} aria-label={level === 0 ? translate('inspector.spans.label') : undefined}>
        {items.map((span) => (
          <li key={span.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge>{translate(SPAN_KIND_KEYS[span.kind])}</Badge>
              <span className="min-w-0 truncate font-mono text-2xs">{span.label}</span>
              {span.status && <Badge tone={span.status === 'completed' || span.status === 'ok' ? 'green' : span.status === 'failed' || span.status === 'error' ? 'red' : 'neutral'}>{span.status}</Badge>}
              <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">
                {translate('inspector.spans.detail', {
                  first: span.firstSeq,
                  last: span.lastSeq,
                  count: span.eventCount,
                  ms: Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt)),
                })}
              </span>
              {(span.promptTokens > 0 || span.completionTokens > 0) && (
                <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">
                  {span.promptTokens} → {span.completionTokens}
                </span>
              )}
            </div>
            {render(span.id, level + 1)}
          </li>
        ))}
      </ul>
    )
  }
  return render(null, 0)
}
