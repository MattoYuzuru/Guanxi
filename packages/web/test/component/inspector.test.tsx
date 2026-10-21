/**
 * K2 interim inspector: timeline merge by seq, redaction markers rendered as
 * references (timeline, titles and search snippets), reasoning hidden until
 * asked (also in search), purged reasoning explained, unknown values with a
 * visible source, a quiet live region, jump-to-event from any tab, tab
 * keyboard pattern, empty, not-found and error states.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REDACTION_MARKER_CLOSE,
  REDACTION_MARKER_OPEN,
  SEARCH_MATCH_CLOSE,
  SEARCH_MATCH_OPEN,
  sessionEventSchema,
  type SessionEvent,
  type SessionSearchHit,
} from '@guanxi/contract'
import { InspectorPage } from '../../src/features/inspector/InspectorPage.tsx'
import { mergeEvents, EMPTY_TIMELINE, segmentRedactions, countByType } from '../../src/features/inspector/model.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { REASONING_TEXT, SESSION_ID, sessionSummary, sessionTrace } from '../fixtures/session-events.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A live tail that emits the given events, then stays open until the test ends. */
function stream(events: SessionEvent[] = []): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: guanxi\ndata: ${JSON.stringify(event)}\n\n`))
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

const MARKER = `${REDACTION_MARKER_OPEN}REDACTED secret://vault/openai-key${REDACTION_MARKER_CLOSE}`

function mockApi(options: {
  events?: SessionEvent[]
  live?: SessionEvent[]
  summaryStatus?: number
  pageSize?: number
  hits?: SessionSearchHit[]
  withheld?: number
  catchingUp?: number
  catchUpFailed?: number
} = {}) {
  const events = options.events ?? sessionTrace()
  const pageSize = options.pageSize ?? 500
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname + url.search)
    if (url.pathname === `/api/sessions/${SESSION_ID}`) {
      if (options.summaryStatus === 404) return json({ code: 'session_not_found', message: 'Session not found', details: null }, 404)
      if (options.summaryStatus === 500) return json({ code: 'storage_error', message: 'Session log read failed', details: null }, 500)
      if (options.summaryStatus === 503) {
        return json({ code: 'session_catching_up', message: 'This session history is still being restored from the Chat job store', details: { failure: 'writer_busy' } }, 503)
      }
      if (options.summaryStatus === 403) {
        return json({ code: 'session_withheld', message: 'This session is withheld: one of its identifiers contains a registered secret', details: null }, 403)
      }
      return json(sessionSummary(events))
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0)
      const page = events.filter((event) => event.seq > after).slice(0, pageSize)
      return json({
        sessionId: SESSION_ID,
        events: page,
        nextAfter: page.at(-1)?.seq ?? after,
        lastSeq: events.length,
        hasMore: (page.at(-1)?.seq ?? after) < events.length,
      })
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) return stream(options.live ?? [])
    if (url.pathname === `/api/sessions/${SESSION_ID}/spans`) {
      return json({
        sessionId: SESSION_ID,
        spans: [{
          id: 'job:job-k2-inspector', parentId: null, kind: 'turn', label: 'job-k2-inspector', firstSeq: 3, lastSeq: 14,
          startedAt: '2026-10-20T10:00:03.000Z', endedAt: '2026-10-20T10:00:14.000Z', eventCount: 6, status: 'completed',
          promptTokens: 40, completionTokens: 12,
        }],
      })
    }
    if (url.pathname === '/api/sessions/search') return json({ query: url.searchParams.get('q') ?? '', hits: options.hits ?? [] })
    if (url.pathname === '/api/sessions') return json({ sessions: [], withheld: options.withheld ?? 0, catchingUp: options.catchingUp ?? 0, catchUpFailed: options.catchUpFailed ?? 0 })
    return json({ code: 'internal_error', message: 'unexpected', details: null }, 500)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inspector model', () => {
  it('merges events by seq, once each, in order', () => {
    const events = sessionTrace()
    const shuffled = [events[3]!, events[0]!, events[2]!, events[1]!]
    const first = mergeEvents(EMPTY_TIMELINE, shuffled)
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    const again = mergeEvents(first, [events[2]!, events[3]!, events[4]!])
    expect(again.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5])
    expect(mergeEvents(again, [events[0]!])).toBe(again)
    expect(countByType(mergeEvents(EMPTY_TIMELINE, [...events, ...events]).events)).toEqual(countByType(events))
  })

  it('splits redaction markers into references', () => {
    expect(segmentRedactions(`a ${MARKER} b`)).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'redacted', ref: 'secret://vault/openai-key' },
      { kind: 'text', text: ' b' },
    ])
    expect(segmentRedactions('no marker')).toEqual([{ kind: 'text', text: 'no marker' }])
  })
})

describe('inspector page', () => {
  it('shows every persisted event once, with redactions as references and reasoning on demand', async () => {
    setActiveLocale('en')
    const calls = mockApi({ pageSize: 4 })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    const events = sessionTrace()
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(events.length)
    expect(screen.getByTestId('inspector-event-count').textContent).toBe(String(events.length))
    expect(calls.filter((call) => call.startsWith(`/api/sessions/${SESSION_ID}/events`))).toHaveLength(4)

    expect(document.body.textContent).not.toContain(REDACTION_MARKER_OPEN)
    expect(screen.getAllByText('secret secret://vault/demo').length).toBeGreaterThan(0)

    expect(document.body.textContent).not.toContain(REASONING_TEXT)
    const show = screen.getByRole('button', { name: /Show reasoning/ })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(show)
    expect(screen.getByText(REASONING_TEXT)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Hide reasoning/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Reasoning removed by its retention period/)).toBeTruthy()
    expect(document.body.textContent).not.toContain(REDACTION_MARKER_OPEN)

    const tokens = screen.getByText(/Sum of 1 usage reports/)
    expect(tokens.parentElement!.textContent).toContain('40 → 12')
    expect(tokens.textContent).toMatch(/As of/)
    expect(screen.getByText('52 / 4,096 (1%)')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Export JSON without reasoning' }).getAttribute('href')).toBe(`/api/sessions/${SESSION_ID}/export`)
  })

  it('renders durable run events once across persisted/live overlap and reload', async () => {
    setActiveLocale('en')
    const base = sessionTrace()
    const event = sessionEventSchema.parse({ ...base[0]!, id: '00000000-0000-4000-8000-000000000099',
      seq: base.length + 1, type: 'run.lifecycle',
      data: { runId: 'lead-r1', state: 'waiting_children', version: 3, action: 'delegated', relatedId: 'child-r1', wakeSeq: null } })
    const events = [...base, event]
    mockApi({ events, live: [event] })
    const view = render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(events.length))
    expect(within(timeline).getAllByText('Durable run')).toHaveLength(1)
    expect(within(timeline).getAllByText('lead-r1 · waiting_children · delegated')).toHaveLength(1)
    view.unmount()
    render(<InspectorPage sessionId={SESSION_ID} />)
    const replay = await screen.findByRole('list', { name: 'Session events in order' })
    await waitFor(() => expect(within(replay).getAllByRole('listitem')).toHaveLength(events.length))
    expect(within(replay).getAllByText('lead-r1 · waiting_children · delegated')).toHaveLength(1)
  })

  it('keeps the live region to the state: streamed events change the timeline, not the announcement', async () => {
    setActiveLocale('en')
    const events = sessionTrace()
    const extra = (seq: number) => ({ ...events[2]!, seq, id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` })
    // The live tail re-sends a stored event first (a reconnect overlap); it must not duplicate.
    mockApi({ live: [events.at(-1)!, extra(events.length + 1), extra(events.length + 2)] })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(events.length + 2))
    const seqs = within(timeline).getAllByRole('listitem').map((row) => row.id)
    expect(new Set(seqs).size).toBe(seqs.length)
    const status = screen.getAllByRole('status').find((element) => element.textContent?.includes('Live'))!
    expect(status.textContent).toBe('Live')
  })

  it('renders search snippets with whole references, hides reasoning text in results and jumps from the Spans tab', async () => {
    setActiveLocale('en')
    mockApi({
      hits: [
        { sessionId: SESSION_ID, seq: 3, type: 'prompt', class: 'standard', snippet: `Use my key ${MARKER} ${SEARCH_MATCH_OPEN}please${SEARCH_MATCH_CLOSE}`, createdAt: '2026-10-20T10:00:03.000Z' },
        { sessionId: SESSION_ID, seq: 7, type: 'reasoning', class: 'reasoning', snippet: `${SEARCH_MATCH_OPEN}privatewalrus${SEARCH_MATCH_CLOSE} reasoning`, createdAt: '2026-10-20T10:00:07.000Z' },
      ],
    })
    render(<InspectorPage sessionId={SESSION_ID} />)
    await screen.findByRole('list', { name: 'Session events in order' })

    fireEvent.click(screen.getByRole('tab', { name: 'Spans' }))
    expect(await screen.findByRole('list', { name: 'Turns, steps and tool calls' })).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: /Search this session/ }), { target: { value: 'please' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('search'))
    })
    const results = await screen.findByRole('region', { name: 'Search results' })
    expect(results.textContent).not.toContain(REDACTION_MARKER_OPEN)
    expect(within(results).getByText('secret secret://vault/openai-key')).toBeTruthy()
    expect(within(results).getByText('please').tagName).toBe('MARK')
    expect(results.textContent).not.toContain('privatewalrus')
    expect(within(results).getByText(/Match in reasoning/)).toBeTruthy()
    expect(screen.getAllByRole('status').some((element) => element.textContent === 'Matches: 2')).toBe(true)

    fireEvent.click(within(results).getAllByRole('button')[0]!)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true'))
    await waitFor(() => expect(document.activeElement?.id).toBe('inspector-event-3'))
    expect(document.activeElement?.getAttribute('aria-current')).toBe('true')
  })

  it('renders an unknown token meter with its reason in visible text', async () => {
    setActiveLocale('en')
    mockApi({ events: sessionTrace().filter((event) => event.type !== 'usage' && event.type !== 'context') })
    render(<InspectorPage sessionId={SESSION_ID} />)
    await screen.findByRole('list', { name: 'Session events in order' })
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
    expect(screen.getByText(/has not reported usage/)).toBeTruthy()
    expect(screen.getByText(/has not reported its context window/)).toBeTruthy()
    expect(screen.queryByText('0 → 0')).toBeNull()
  })

  it('explains a session without a trace and a failed load as an alert with time, details and a retry that returns focus', async () => {
    setActiveLocale('en')
    mockApi({ summaryStatus: 404 })
    const { unmount } = render(<InspectorPage sessionId={SESSION_ID} />)
    expect(await screen.findByRole('heading', { name: 'This session has no trace yet' })).toBeTruthy()
    unmount()

    mockApi({ summaryStatus: 500 })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('The trace could not be loaded')
    expect(alert.textContent).toMatch(/Failed at .* while reading \/api\/sessions\//)
    expect(within(alert).getByRole('button', { name: 'Copy details' })).toBeTruthy()
    mockApi()
    await act(async () => {
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    })
    expect(await screen.findByRole('list', { name: 'Session events in order' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.id).toBe('inspector-title'))
  })

  it('lists no sessions with one sentence and one action', async () => {
    setActiveLocale('ru')
    mockApi()
    render(<InspectorPage sessionId={null} />)
    expect(await screen.findByText('Трасс пока нет')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть чат' })).toBeTruthy()
  })

  it('names sessions withheld for a secret in their id instead of claiming there are none', async () => {
    setActiveLocale('en')
    mockApi({ withheld: 2 })
    const { unmount } = render(<InspectorPage sessionId={null} />)
    expect(await screen.findByText('Hidden because the session id contains a registered secret: 2')).toBeTruthy()
    expect(screen.queryByText('No session has a trace yet')).toBeNull()
    unmount()

    mockApi({ summaryStatus: 403 })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('This trace is hidden: one of its identifiers contains a value now registered as a secret.')
  })

  it('names sessions still being restored instead of claiming there are none, and explains a failed restore', async () => {
    setActiveLocale('en')
    mockApi({ catchingUp: 2, catchUpFailed: 1 })
    const { unmount } = render(<InspectorPage sessionId={null} />)
    expect(await screen.findByText('Being restored from the saved chat history: 2')).toBeTruthy()
    expect(screen.getByText('Restoring failed and is retried automatically: 1')).toBeTruthy()
    expect(screen.queryByText('No session has a trace yet')).toBeNull()
    unmount()

    mockApi({ summaryStatus: 503 })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Restoring this trace from the saved chat history failed (writer_busy).')
  })

  it('follows the tab pattern: arrows, Home and End move selection and focus, both panels stay mounted', async () => {
    setActiveLocale('en')
    mockApi()
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timelineTab = await screen.findByRole('tab', { name: 'Timeline' })
    expect(timelineTab.getAttribute('aria-selected')).toBe('true')
    timelineTab.focus()
    fireEvent.keyDown(timelineTab, { key: 'ArrowRight' })
    const spansTab = screen.getByRole('tab', { name: 'Spans' })
    expect(spansTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(spansTab)
    expect(document.getElementById('inspector-panel-timeline')).toBeTruthy()
    expect(document.getElementById('inspector-panel-timeline')!.hidden).toBe(true)
    fireEvent.keyDown(spansTab, { key: 'Home' })
    expect(document.activeElement).toBe(timelineTab)
    fireEvent.keyDown(timelineTab, { key: 'End' })
    expect(document.activeElement).toBe(spansTab)
    expect(await screen.findByRole('list', { name: 'Turns, steps and tool calls' })).toBeTruthy()
    for (const tab of screen.getAllByRole('tab')) {
      expect(document.getElementById(tab.getAttribute('aria-controls')!)).toBeTruthy()
    }
  })
})
