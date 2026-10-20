/**
 * Interim trace inspector (K2, screen W3 in docs/design/LAYOUT_AND_SCREENS.md).
 *
 * Reads the session event log: timeline with nested spans, FTS5 search, token
 * meter and export. The timeline is rebuilt from persisted events on every
 * load and extended by a persisted-first live tail, so a reload shows exactly
 * what the live view showed. Built from the legacy primitives in
 * components/ui.tsx because @guanxi/ui (DS1-b) is not merged; U1 migrates it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  SEARCH_MATCH_CLOSE,
  SEARCH_MATCH_OPEN,
  SESSION_ROUTES,
  type SessionEvent,
  type SessionEventType,
  type SessionSearchHit,
  type SessionSpan,
  type SessionSummary,
} from '@guanxi/contract'
import { Badge, Button, Callout, CopyButton, EmptyState, Input, Skeleton, cx } from '../../components/ui.tsx'
import { ApiRequestError, errorMessage } from '../../lib/api.ts'
import { formatRelativeTime } from '../../lib/format.ts'
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

const SEARCH_LIMIT = 50

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

/** Rows whose detail is a machine value, set in the mono face. */
const MACHINE_DETAIL: ReadonlySet<SessionEventType> = new Set([
  'assistant.started',
  'job.lifecycle',
  'usage',
  'context',
  'tool.approval',
  'turn.done',
])

const SPAN_KIND_KEYS: Record<SessionSpan['kind'], LocaleKey> = {
  turn: 'inspector.span.turn',
  step: 'inspector.span.step',
  tool: 'inspector.span.tool',
}

type Live =
  | { state: 'connecting' }
  | { state: 'live'; since: string }
  | { state: 'reconnecting'; since: string }
  | { state: 'stopped'; at: string; opened: boolean }

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const LINK = 'inline-flex min-h-6 items-center text-2xs text-[var(--accent)] underline underline-offset-2'

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
        <div className="flex flex-col gap-2" role="status" aria-busy="true">
          <span className="sr-only">{translate('inspector.loading')}</span>
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-11 w-full" />)}
        </div>
      )}
      {sessions.error != null && (
        <LoadError error={sessions.error} route={SESSION_ROUTES.sessions()} onRetry={sessions.reload} title={translate('inspector.list.error')} />
      )}
      {sessions.data && sessions.data.sessions.length === 0 && (
        <EmptyState
          title={translate('inspector.list.empty.title')}
          description={translate('inspector.list.empty.description')}
          action={<Link to={paths.chat()} className={LINK}>{translate('inspector.list.empty.action')}</Link>}
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

/** What failed, where and when, with copyable details and the next action (LAYOUT §1). */
function LoadError({ error, route, onRetry, title }: { error: unknown; route: string; onRetry: () => void; title: string }) {
  const [at] = useState(() => new Date().toISOString())
  const message = errorMessage(error)
  const details = `${title}\n${message}\n${route}\n${at}`
  return (
    <div role="alert">
      <Callout
        tone="danger"
        title={title}
        action={
          <div className="flex flex-wrap items-center gap-1">
            <CopyButton text={details} label={translate('inspector.error.details')} />
            <Button size="sm" onClick={onRetry}>{translate('inspector.retry')}</Button>
          </div>
        }
      >
        <p className="text-xs">{message}</p>
        <p className="mt-1 text-2xs text-[var(--fg-subtle)]">
          {translate('inspector.error.when', { time: time(at), route })}
        </p>
      </Callout>
    </div>
  )
}

/* ─────────────────────────── One session's trace ──────────────────────── */

function SessionInspector({ sessionId }: { sessionId: string }) {
  const [timeline, setTimeline] = useState<TimelineState>(EMPTY_TIMELINE)
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [live, setLive] = useState<Live>({ state: 'connecting' })
  const [tab, setTab] = useState<'timeline' | 'spans'>('timeline')
  const [highlighted, setHighlighted] = useState<number | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [nonce, setNonce] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const followRef = useRef(true)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    setTimeline(EMPTY_TIMELINE)
    setUnseen(0)
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
        setLoadedAt(new Date().toISOString())
        setLoading(false)
        setLive({ state: 'connecting' })
        let opened = false
        try {
          const stream = inspectorApi.live(sessionId, initial.lastSeq, controller.signal, {
            onOpen: () => {
              opened = true
              setLive({ state: 'live', since: new Date().toISOString() })
            },
            onReconnect: () => setLive({ state: 'reconnecting', since: new Date().toISOString() }),
          })
          for await (const event of stream) {
            setLive((current) => (current.state === 'live' ? current : { state: 'live', since: new Date().toISOString() }))
            setTimeline((current) => {
              const next = mergeEvents(current, [event])
              if (next !== current && !followRef.current) setUnseen((count) => count + 1)
              return next
            })
          }
        } catch {
          // Reported as the stopped state below.
        }
        if (!controller.signal.aborted) setLive({ state: 'stopped', at: new Date().toISOString(), opened })
      } catch (error) {
        if (controller.signal.aborted) return
        setLoadError(error)
        setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [sessionId, nonce])

  // After a reload, focus returns to the page heading.
  useEffect(() => {
    if (!loading && !loadError && nonce > 0) headingRef.current?.focus()
  }, [loading, loadError, nonce])

  // Follow the tail while the reader is at the bottom; otherwise count what arrived below.
  useLayoutEffect(() => {
    const scroller = listRef.current?.closest('main')
    if (!scroller) return
    const onScroll = () => {
      followRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
      if (followRef.current) setUnseen(0)
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [loading])

  useLayoutEffect(() => {
    if (!followRef.current || tab !== 'timeline' || timeline.lastSeq === 0) return
    listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'end' })
  }, [timeline.lastSeq, tab])

  // A search result asks for an event: show the timeline, then focus that row.
  useEffect(() => {
    if (highlighted === null || tab !== 'timeline') return
    const row = document.getElementById(`inspector-event-${highlighted}`)
    row?.scrollIntoView?.({ block: 'center' })
    row?.focus()
  }, [highlighted, tab])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  const reveal = useCallback((seq: number) => {
    setTab('timeline')
    setHighlighted(seq)
  }, [])
  const jumpToLatest = () => {
    followRef.current = true
    setUnseen(0)
    listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'end' })
  }

  if (loading) return <InspectorSkeleton />
  if (loadError) {
    const notFound = loadError instanceof ApiRequestError && loadError.code === 'session_not_found'
    return (
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-3 py-4 sm:px-6" aria-labelledby="inspector-error-title">
        {notFound ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <h1 id="inspector-error-title" className="text-sm font-medium">{translate('inspector.notFound.title')}</h1>
            <p className="max-w-md text-xs text-[var(--fg-subtle)]">{translate('inspector.notFound.description')}</p>
            <div className="flex gap-3">
              <Link to={paths.chat(sessionId)} className={LINK}>{translate('inspector.openChat')}</Link>
              <Link to={paths.inspector()} className={LINK}>{translate('inspector.backToList')}</Link>
            </div>
          </div>
        ) : (
          <>
            <h1 id="inspector-error-title" className="sr-only">{translate('inspector.error.title')}</h1>
            <LoadError error={loadError} route={SESSION_ROUTES.session(sessionId)} onRetry={reload} title={translate('inspector.error.title')} />
          </>
        )}
      </section>
    )
  }

  const tabs = ['timeline', 'spans'] as const
  const selectTab = (value: (typeof tabs)[number], focus: boolean) => {
    setTab(value)
    if (focus) document.getElementById(`inspector-tab-${value}`)?.focus()
  }
  const onTabKey = (event: KeyboardEvent, value: (typeof tabs)[number]) => {
    const index = tabs.indexOf(value)
    const next = event.key === 'ArrowRight'
      ? tabs[(index + 1) % tabs.length]
      : event.key === 'ArrowLeft'
        ? tabs[(index - 1 + tabs.length) % tabs.length]
        : event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs[tabs.length - 1]
            : null
    if (!next) return
    event.preventDefault()
    selectTab(next, true)
  }

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-4 sm:px-6" aria-labelledby="inspector-title">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={paths.inspector()} className={cx(LINK, 'text-[var(--fg-muted)]')}>{translate('inspector.backToList')}</Link>
          <h1 id="inspector-title" ref={headingRef} tabIndex={-1} className="truncate text-sm font-semibold">
            <RedactedText text={summary?.title ?? translate('inspector.untitled')} />
          </h1>
          <LiveStatus live={live} loadedAt={loadedAt} onReconnect={reload} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {summary?.threadId && (
            <Link to={paths.chat(summary.threadId)} className={LINK}>{translate('inspector.openChat')}</Link>
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
      <SearchPanel sessionId={sessionId} onReveal={reveal} />

      <div role="tablist" aria-label={translate('inspector.views')} className="flex gap-1 border-b border-[var(--border)]">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`inspector-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`inspector-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value, false)}
            onKeyDown={(event) => onTabKey(event, value)}
            className={cx(
              '-mb-px min-h-6 border-b-2 px-2 py-1 text-xs font-medium',
              tab === value
                ? 'border-[var(--accent)] text-[var(--fg)] forced-colors:border-[Highlight]'
                : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
            )}
          >
            {translate(value === 'timeline' ? 'inspector.tab.timeline' : 'inspector.tab.spans')}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="inspector-panel-timeline" aria-labelledby="inspector-tab-timeline" tabIndex={0} hidden={tab !== 'timeline'}>
        <Timeline events={timeline.events} listRef={listRef} highlighted={highlighted} />
        {unseen > 0 && (
          <div className="sticky bottom-2 mt-2 flex justify-center">
            <Button size="sm" variant="primary" onClick={jumpToLatest}>
              {translate('inspector.timeline.newEvents', { count: unseen })}
            </Button>
          </div>
        )}
      </div>
      <div role="tabpanel" id="inspector-panel-spans" aria-labelledby="inspector-tab-spans" tabIndex={0} hidden={tab !== 'spans'}>
        {tab === 'spans' && <Spans sessionId={sessionId} lastSeq={timeline.lastSeq} />}
      </div>
    </section>
  )
}

function InspectorSkeleton() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-3 py-4 sm:px-6" role="status" aria-busy="true">
      <span className="sr-only">{translate('inspector.loading')}</span>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-48 w-full sm:h-28" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-7 w-40" />
      {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
    </section>
  )
}

/** The live state only; counts stay out of the live region so a stream does not announce every event. */
function LiveStatus({ live, loadedAt, onReconnect }: { live: Live; loadedAt: string | null; onReconnect: () => void }) {
  const label = live.state === 'live'
    ? translate('inspector.live.on')
    : live.state === 'connecting'
      ? translate('inspector.live.connecting')
      : live.state === 'reconnecting'
        ? translate('inspector.live.reconnecting', { time: time(live.since) })
        : live.opened
          ? translate('inspector.live.offline', { time: time(live.at), age: formatRelativeTime(live.at) })
          : translate('inspector.live.failed', { time: time(loadedAt ?? live.at) })
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-2xs text-[var(--fg-subtle)]">
        <span aria-hidden className={cx('inline-block size-2 rounded-full', live.state === 'live' ? 'bg-[var(--color-fit-green)]' : 'bg-[var(--color-fit-unknown)]')} />
        {label}
      </p>
      {live.state === 'stopped' && (
        <Button size="sm" onClick={onReconnect}>{translate('inspector.live.reconnect')}</Button>
      )}
    </div>
  )
}

/** A label, a value and a visible note (source and age), so the note reaches keyboard, touch and screen readers. */
function Fact({ label, value, note, mono = true, testId }: { label: string; value: ReactNode; note?: string; mono?: boolean; testId?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-2xs text-[var(--fg-subtle)]">{label}</div>
      <div className={cx('text-xs font-medium', mono && 'font-mono tabular-nums')} data-testid={testId}>{value}</div>
      {note && <div className="text-2xs text-[var(--fg-subtle)]">{note}</div>}
    </div>
  )
}

function Overview({ timeline, summary }: { timeline: TimelineState; summary: SessionSummary | null }) {
  const counts = useMemo(() => countByType(timeline.events), [timeline.events])
  const meter = useMemo(() => {
    let prompt = 0
    let completion = 0
    let cached = 0
    let samples = 0
    let lastUsageAt: string | null = null
    let context: { data: Extract<SessionEvent, { type: 'context' }>['data']; at: string } | null = null
    for (const event of timeline.events) {
      if (event.type === 'usage') {
        prompt += event.data.promptTokens
        completion += event.data.evalTokens
        cached += event.data.cachedTokens
        samples += 1
        lastUsageAt = event.createdAt
      } else if (event.type === 'context') {
        context = { data: event.data, at: event.createdAt }
      }
    }
    return { prompt, completion, cached, samples, lastUsageAt, context }
  }, [timeline.events])
  const purged = timeline.events.filter((event) => event.type === 'reasoning' && event.purgedAt !== null).length

  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)] p-3 sm:grid-cols-4">
      <Fact label={translate('inspector.stat.events')} value={timeline.events.length} testId="inspector-event-count" />
      <Fact label={translate('inspector.stat.prompts')} value={counts.prompt ?? 0} />
      <Fact label={translate('inspector.stat.toolCalls')} value={counts['tool.call'] ?? 0} />
      <Fact
        label={translate('inspector.stat.redactions')}
        value={summary?.redactions ?? translate('inspector.unknown')}
        note={translate('inspector.stat.redactionsHint')}
      />
      {meter.samples === 0 || meter.lastUsageAt === null ? (
        <Fact label={translate('inspector.stat.tokens')} value={translate('inspector.unknown')} note={translate('inspector.stat.tokensUnknown')} mono={false} />
      ) : (
        <Fact
          label={translate('inspector.stat.tokens')}
          value={`${meter.prompt.toLocaleString()} → ${meter.completion.toLocaleString()}`}
          note={`${translate('inspector.stat.tokensSource', { count: meter.samples, cached: meter.cached.toLocaleString() })} ${translate('inspector.stat.asOf', { time: time(meter.lastUsageAt) })}`}
        />
      )}
      {meter.context ? (
        <Fact
          label={translate('inspector.stat.context')}
          value={`${meter.context.data.usedTokens.toLocaleString()} / ${meter.context.data.allocatedTokens.toLocaleString()} (${Math.round(meter.context.data.percent)}%)`}
          note={`${translate('inspector.stat.contextSource')} ${translate('inspector.stat.asOf', { time: time(meter.context.at) })}`}
        />
      ) : (
        <Fact label={translate('inspector.stat.context')} value={translate('inspector.unknown')} note={translate('inspector.stat.contextUnknown')} mono={false} />
      )}
      <Fact label={translate('inspector.stat.reasoning')} value={counts.reasoning ?? 0} note={translate('inspector.stat.reasoningHint')} />
      <Fact label={translate('inspector.stat.purged')} value={purged} note={translate('inspector.stat.purgedHint')} />
    </div>
  )
}

/* ───────────────────────────────── Search ─────────────────────────────── */

function SearchPanel({ sessionId, onReveal }: { sessionId: string; onReveal: (seq: number) => void }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text || busy) return
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

  // One always-mounted status announces the outcome; the list itself is not a live region.
  const status = busy
    ? translate('inspector.search.status.searching')
    : error !== null
      ? `${translate('inspector.search.error')}: ${errorMessage(error)}`
      : hits === null
        ? ''
        : hits.length === 0
          ? translate('inspector.search.none')
          : translate('inspector.search.status.count', { count: hits.length })

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
            aria-describedby="inspector-search-hint"
          />
          <span id="inspector-search-hint" className="text-2xs text-[var(--fg-subtle)]">{translate('inspector.search.hint')}</span>
        </label>
        <Button type="submit" size="sm" aria-busy={busy}>
          {translate('inspector.search.submit')}
        </Button>
      </form>
      <p role="status" aria-live="polite" className="sr-only">{status}</p>
      {error !== null && <Callout tone="danger" title={translate('inspector.search.error')}>{errorMessage(error)}</Callout>}
      {hits !== null && (
        <section aria-label={translate('inspector.search.results')}>
          {hits.length === 0 ? (
            <p className="text-2xs text-[var(--fg-subtle)]">{translate('inspector.search.none')}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {hits.map((hit) => (
                  <li key={`${hit.sessionId}:${hit.seq}`}>
                    <button
                      type="button"
                      onClick={() => onReveal(hit.seq)}
                      className="flex min-h-6 w-full flex-wrap items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[var(--bg-subtle)]"
                    >
                      <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">#{hit.seq}</span>
                      <Badge tone={hit.class === 'reasoning' ? 'yellow' : 'neutral'}>{translate(TYPE_KEYS[hit.type])}</Badge>
                      <span className="min-w-0 break-words">
                        {hit.class === 'reasoning'
                          ? <span className="text-[var(--fg-muted)]">{translate('inspector.search.reasoningMatch')}</span>
                          : <Snippet text={hit.snippet} />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {hits.length >= SEARCH_LIMIT && (
                <p className="mt-1 text-2xs text-[var(--fg-subtle)]">{translate('inspector.search.limit', { count: SEARCH_LIMIT })}</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

/** Redaction markers are segmented first, over the whole snippet; highlights apply only to plain text. */
function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let key = 0
  for (const segment of segmentRedactions(text)) {
    if (segment.kind === 'redacted') {
      parts.push(<RedactedRef key={key++} reference={segment.ref} />)
      continue
    }
    const value = segment.text
    let cursor = 0
    while (cursor < value.length) {
      const open = value.indexOf(SEARCH_MATCH_OPEN, cursor)
      if (open < 0) break
      const close = value.indexOf(SEARCH_MATCH_CLOSE, open)
      if (close < 0) break
      parts.push(<span key={key++}>{value.slice(cursor, open)}</span>)
      parts.push(
        <mark key={key++} className="rounded-sm bg-[var(--accent-subtle)] text-[var(--fg)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]">
          {value.slice(open + 1, close)}
        </mark>,
      )
      cursor = close + 1
    }
    const rest = value.slice(cursor).replaceAll(SEARCH_MATCH_OPEN, '').replaceAll(SEARCH_MATCH_CLOSE, '')
    if (rest) parts.push(<span key={key++}>{rest}</span>)
  }
  return <>{parts}</>
}

/* ──────────────────────────────── Timeline ────────────────────────────── */

function Timeline({
  events,
  listRef,
  highlighted,
}: {
  events: readonly SessionEvent[]
  listRef: RefObject<HTMLOListElement | null>
  highlighted: number | null
}) {
  if (events.length === 0) {
    return <EmptyState title={translate('inspector.timeline.empty')} />
  }
  return (
    <ol ref={listRef} className="flex flex-col gap-0.5" aria-label={translate('inspector.timeline.label')}>
      {events.map((event) => <TimelineRow key={event.seq} event={event} highlighted={event.seq === highlighted} />)}
    </ol>
  )
}

function TimelineRow({ event, highlighted }: { event: SessionEvent; highlighted: boolean }) {
  const detail = eventDetail(event)
  const depth = spanDepth(event.spanId)
  return (
    <li
      id={`inspector-event-${event.seq}`}
      tabIndex={-1}
      data-event-type={event.type}
      aria-current={highlighted ? 'true' : undefined}
      className={cx(
        'flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-[var(--bg-subtle)]',
        depth === 2 && 'ml-4 border-l-2 border-[var(--border)] pl-2 sm:ml-8',
        depth === 1 && 'ml-2 border-l-2 border-[var(--border)] pl-2 sm:ml-4',
        highlighted && 'bg-[var(--accent-subtle)] outline outline-1 outline-[var(--accent)]',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-2xs text-[var(--fg-subtle)]">
        <span className="font-mono tabular-nums">#{event.seq}</span>
        <time dateTime={event.createdAt} className="font-mono tabular-nums">{time(event.createdAt)}</time>
        <Badge tone={event.class === 'reasoning' ? 'yellow' : event.type === 'error' ? 'red' : 'neutral'}>
          {translate(TYPE_KEYS[event.type])}
        </Badge>
        {depth > 0 && (
          <span className="sr-only">{translate(depth === 2 ? 'inspector.row.inTool' : 'inspector.row.inStep')}</span>
        )}
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
          <p className={cx('max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]', MACHINE_DETAIL.has(event.type) && 'font-mono')}>
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
        className="inline-flex min-h-6 items-center self-start text-left text-2xs font-medium text-[var(--fg-muted)] underline underline-offset-2 hover:text-[var(--fg)]"
      >
        {translate(open ? 'inspector.reasoning.hide' : 'inspector.reasoning.show', { time: dateTime(event.expiresAt) })}
      </button>
      {open && (
        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-[var(--border-strong)] pl-2 text-xs text-[var(--fg-muted)] [overflow-wrap:anywhere]">
          <RedactedText text={event.data.text} />
        </p>
      )}
    </div>
  )
}

function RedactedRef({ reference }: { reference: string }) {
  return (
    <span
      className="mx-0.5 rounded-sm border border-[var(--border-strong)] px-1 font-mono text-2xs text-[var(--fg-muted)] [overflow-wrap:anywhere]"
      title={translate('inspector.redactedHint')}
    >
      {translate('inspector.redacted', { ref: reference })}
    </span>
  )
}

/** Scrubbed text with each `⟦REDACTED secret://…⟧` marker shown as a reference, never as raw brackets. */
function RedactedText({ text }: { text: string }) {
  return (
    <>
      {segmentRedactions(text).map((segment, index) =>
        segment.kind === 'text'
          ? <span key={index}>{segment.text}</span>
          : <RedactedRef key={index} reference={segment.ref} />,
      )}
    </>
  )
}

/* ────────────────────────────────── Spans ─────────────────────────────── */

function Spans({ sessionId, lastSeq }: { sessionId: string; lastSeq: number }) {
  // Refetch at most twice a second while events stream in.
  const [debounced, setDebounced] = useState(lastSeq)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(lastSeq), 500)
    return () => clearTimeout(timer)
  }, [lastSeq])
  const spans = useAsync((signal) => inspectorApi.spans(sessionId, signal), [sessionId, debounced])
  if (spans.loading) return <Skeleton className="h-24 w-full" />
  if (spans.error != null) {
    return <LoadError error={spans.error} route={SESSION_ROUTES.spans(sessionId)} onRetry={spans.reload} title={translate('inspector.spans.error')} />
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
          <li key={span.id} className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge>{translate(SPAN_KIND_KEYS[span.kind])}</Badge>
              <span className="min-w-0 break-all font-mono text-2xs">{span.label}</span>
              {span.status && <span className="font-mono text-2xs">{span.status}</span>}
              <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">
                {translate('inspector.spans.detail', {
                  first: span.firstSeq,
                  last: span.lastSeq,
                  count: span.eventCount,
                  seconds: (Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt)) / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }),
                })}
              </span>
              {(span.promptTokens > 0 || span.completionTokens > 0) && (
                <span className="font-mono text-2xs tabular-nums text-[var(--fg-subtle)]">
                  {span.promptTokens.toLocaleString()} → {span.completionTokens.toLocaleString()}
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
