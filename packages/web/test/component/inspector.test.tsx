/**
 * K2 interim inspector: timeline merge by seq, redaction markers rendered as
 * references, reasoning hidden until asked and purged reasoning explained,
 * unknown token meter, empty, not-found and error states.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REDACTION_MARKER_OPEN, type SessionEvent } from '@guanxi/contract'
import { InspectorPage } from '../../src/features/inspector/InspectorPage.tsx'
import { mergeEvents, EMPTY_TIMELINE, segmentRedactions, countByType } from '../../src/features/inspector/model.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { REASONING_TEXT, SESSION_ID, sessionSummary, sessionTrace } from '../fixtures/session-events.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A stream that stays open until the test ends, like a live tail with nothing new. */
function openStream(): Response {
  return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
}

function mockApi(options: { events?: SessionEvent[]; summaryStatus?: number; pageSize?: number } = {}) {
  const events = options.events ?? sessionTrace()
  const pageSize = options.pageSize ?? 500
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname + url.search)
    if (url.pathname === `/api/sessions/${SESSION_ID}`) {
      if (options.summaryStatus === 404) return json({ code: 'session_not_found', message: 'Session not found', details: null }, 404)
      if (options.summaryStatus === 500) return json({ code: 'storage_error', message: 'Session log read failed', details: null }, 500)
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
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) return openStream()
    if (url.pathname === '/api/sessions') return json({ sessions: [] })
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
    expect(segmentRedactions(`a ${REDACTION_MARKER_OPEN}REDACTED secret://vault/x⟧ b`)).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'redacted', ref: 'secret://vault/x' },
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
    expect(screen.getAllByText('hidden secret://vault/demo').length).toBeGreaterThan(0)

    expect(document.body.textContent).not.toContain(REASONING_TEXT)
    const show = screen.getByRole('button', { name: /Show reasoning/ })
    expect(show.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(show)
    expect(screen.getByText(REASONING_TEXT)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Hide reasoning/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/Reasoning removed by its retention period/)).toBeTruthy()

    expect(screen.getByTitle(/Sum of 1 usage reports/).textContent).toContain('40 → 12')
    expect(screen.getByText('52 / 4096 (1%)')).toBeTruthy()
    const status = screen.getByRole('status')
    await waitFor(() => expect(status.textContent).toContain(`Live, ${events.length} events`))
    expect(screen.getByRole('link', { name: 'Export JSON without reasoning' }).getAttribute('href')).toBe(`/api/sessions/${SESSION_ID}/export`)
  })

  it('renders an unknown token meter when the runtime reported no usage', async () => {
    setActiveLocale('en')
    mockApi({ events: sessionTrace().filter((event) => event.type !== 'usage' && event.type !== 'context') })
    render(<InspectorPage sessionId={SESSION_ID} />)
    await screen.findByRole('list', { name: 'Session events in order' })
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
    expect(screen.queryByText('0 → 0')).toBeNull()
  })

  it('explains a session without a trace and a failed load with a retry', async () => {
    setActiveLocale('en')
    mockApi({ summaryStatus: 404 })
    const { unmount } = render(<InspectorPage sessionId={SESSION_ID} />)
    expect(await screen.findByText('This session has no trace yet')).toBeTruthy()
    unmount()

    mockApi({ summaryStatus: 500 })
    render(<InspectorPage sessionId={SESSION_ID} />)
    expect(await screen.findByText('The trace could not be loaded')).toBeTruthy()
    mockApi()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(await screen.findByRole('list', { name: 'Session events in order' })).toBeTruthy()
  })

  it('lists no sessions with one sentence and one action', async () => {
    setActiveLocale('ru')
    mockApi()
    render(<InspectorPage sessionId={null} />)
    expect(await screen.findByText('Трасс пока нет')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Открыть чат' })).toBeTruthy()
  })

  it('switches views with the arrow keys and keeps tab semantics', async () => {
    setActiveLocale('en')
    mockApi()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/spans')) {
        return json({
          sessionId: SESSION_ID,
          spans: [{
            id: 'job:job-k2-inspector', parentId: null, kind: 'turn', label: 'job-k2-inspector', firstSeq: 3, lastSeq: 14,
            startedAt: '2026-10-20T10:00:03.000Z', endedAt: '2026-10-20T10:00:14.000Z', eventCount: 6, status: 'completed',
            promptTokens: 40, completionTokens: 12,
          }],
        })
      }
      const events = sessionTrace()
      if (url.pathname === `/api/sessions/${SESSION_ID}`) return json(sessionSummary(events))
      if (url.pathname.endsWith('/events')) return json({ sessionId: SESSION_ID, events, nextAfter: events.length, lastSeq: events.length, hasMore: false })
      return openStream()
    }))
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timelineTab = await screen.findByRole('tab', { name: 'Timeline' })
    expect(timelineTab.getAttribute('aria-selected')).toBe('true')
    timelineTab.focus()
    fireEvent.keyDown(timelineTab, { key: 'ArrowRight' })
    const spansTab = screen.getByRole('tab', { name: 'Spans' })
    expect(spansTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(spansTab)
    expect(await screen.findByRole('list', { name: 'Turns, steps and tool calls' })).toBeTruthy()
    expect(screen.getByText('completed')).toBeTruthy()
  })
})
