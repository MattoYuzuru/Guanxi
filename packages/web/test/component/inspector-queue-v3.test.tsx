/**
 * Inspector queue v3: max3 requests, one bounded row per item, plural artifact
 * metadata, tail absence, EN/RU labels and no new UI primitive.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  SESSION_EVENT_VERSION_3,
  sessionEventSchema,
  type SessionEvent,
} from '@guanxi/contract'
import { InspectorPage } from '../../src/features/inspector/InspectorPage.tsx'
import { boundedPreview, queueRenderItems } from '../../src/features/inspector/model.ts'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { SESSION_ID, sessionSummary, sessionTrace } from '../fixtures/session-events.ts'

const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555'
const ARTIFACT_EXCERPT = 'ARTIFACT-EXCERPT-ONLY'
const INLINE_TAIL = 'INLINE-TAIL-MUST-NOT-REACH-THE-DOM'
const FULL_TAIL = 'FULL-ARTIFACT-TAIL-MUST-NOT-REACH-THE-DOM'

function queueEvent(): SessionEvent {
  const inline = `${'i'.repeat(INPUT_EXCERPT_BYTES + 40)}${INLINE_TAIL}`
  return sessionEventSchema.parse({
    sessionId: SESSION_ID,
    seq: sessionTrace().length + 1,
    id: '66666666-6666-4666-8666-666666666666',
    version: SESSION_EVENT_VERSION_3,
    type: 'agent.queue',
    class: 'standard',
    spanId: null,
    parentSpanId: null,
    jobId: null,
    writerEpoch: 1,
    redactions: 0,
    createdAt: '2026-10-22T10:00:20.000Z',
    data: {
      items: [
        { id: 'queue-inline', kind: 'inline', text: inline },
        {
          id: 'queue-artifact',
          kind: 'artifact',
          artifact: {
            artifactId: ARTIFACT_ID,
            checksum: `sha256:${'c'.repeat(64)}`,
            byteSize: INPUT_INLINE_BYTES + FULL_TAIL.length,
            mediaType: 'text/plain; charset=utf-8',
            excerpt: ARTIFACT_EXCERPT,
            excerptBytes: Buffer.byteLength(ARTIFACT_EXCERPT, 'utf8'),
          },
        },
      ],
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function openStream(): Response {
  return new Response(new ReadableStream({ start() { /* stays open */ } }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function mockFetch(events: SessionEvent[]): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname + url.search)
    if (url.pathname === `/api/sessions/${SESSION_ID}`) return json(sessionSummary(events))
    if (url.pathname === `/api/sessions/${SESSION_ID}/events`) {
      const after = Number(url.searchParams.get('after') ?? 0)
      const page = events.filter((event) => event.seq > after)
      return json({
        sessionId: SESSION_ID,
        events: page,
        nextAfter: page.at(-1)?.seq ?? after,
        lastSeq: events.length,
        hasMore: false,
      })
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) return openStream()
    if (url.pathname === `/api/sessions/${SESSION_ID}/spans`) return json({ sessionId: SESSION_ID, spans: [] })
    if (url.pathname === '/api/sessions/search') return json({ query: url.searchParams.get('q') ?? '', hits: [] })
    if (url.pathname === '/api/sessions') {
      return json({ sessions: [], withheld: 0, catchingUp: 0, catchUpFailed: 0 })
    }
    return json({ code: 'internal_error', message: 'unexpected', details: null }, 500)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('inspector queue v3', () => {
  it('requests max3 and renders one bounded row per item, in order, without the tails', async () => {
    setActiveLocale('en')
    const events = [...sessionTrace(), queueEvent()]
    const calls = mockFetch(events)
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    const queue = await within(timeline).findByRole('list', { name: 'Queued items' })
    const rows = within(queue).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.getAttribute('data-queue-item-id'))).toEqual(['queue-inline', 'queue-artifact'])
    expect(within(queue).getAllByText('Inline')).toHaveLength(1)
    expect(within(queue).getAllByText('Bounded input')).toHaveLength(1)
    expect(within(queue).getByText(/Preview: first .* of .* bytes/)).toBeTruthy()
    expect(within(queue).getByText(ARTIFACT_EXCERPT)).toBeTruthy()
    expect(document.body.textContent).not.toContain(INLINE_TAIL)
    expect(document.body.textContent).not.toContain(FULL_TAIL)
    expect(document.body.textContent).not.toContain(ARTIFACT_ID)
    expect(screen.getByRole('link', { name: 'Export JSON without reasoning' }).getAttribute('href'))
      .toBe(`/api/sessions/${SESSION_ID}/export?exportVersion=3`)
    expect(calls.some((call) => call.includes('/events') && call.includes('eventVersion=3'))).toBe(true)
    expect(calls.some((call) => call.includes('/stream') && call.includes('eventVersion=3'))).toBe(true)
  })

  it('renders the queue labels in Russian', async () => {
    setActiveLocale('ru')
    mockFetch([...sessionTrace(), queueEvent()])
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    const queue = await within(timeline).findByRole('list', { name: 'Элементы очереди' })
    expect(within(queue).getAllByText('Встроено')).toHaveLength(1)
    expect(within(queue).getAllByText('Ограниченный ввод')).toHaveLength(1)
    expect(within(queue).getByText(/Предпросмотр: первые/)).toBeTruthy()
  })

  it('bounds a legacy inline preview and keeps plural item order without rendering an artifact id', () => {
    setActiveLocale('en')
    const legacy = sessionEventSchema.parse({
      sessionId: SESSION_ID,
      seq: 90,
      id: '77777777-7777-4777-8777-777777777777',
      version: 1,
      type: 'agent.queue',
      class: 'standard',
      spanId: null,
      parentSpanId: null,
      jobId: null,
      writerEpoch: 1,
      redactions: 0,
      createdAt: '2026-10-22T10:00:00.000Z',
      data: {
        items: [
          { id: 'legacy-one', text: `${'l'.repeat(INPUT_EXCERPT_BYTES + 10)}LEGACY-TAIL` },
          { id: 'legacy-two', text: 'small' },
        ],
      },
    })
    if (legacy.type !== 'agent.queue') throw new Error('expected queue')
    const rows = queueRenderItems(legacy)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.id)).toEqual(['legacy-one', 'legacy-two'])
    expect(rows[0]!.text.length).toBeLessThanOrEqual(INPUT_EXCERPT_BYTES)
    expect(rows[0]!.text).not.toContain('LEGACY-TAIL')
    expect(boundedPreview(`${'x'.repeat(INPUT_EXCERPT_BYTES - 10)}⟦REDACTED secret://demo`)).not.toContain('⟦')
    const queue = queueEvent()
    if (queue.type !== 'agent.queue' || queue.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    expect(queueRenderItems(queue).map((row) => row.kind)).toEqual(['inline', 'artifact'])
  })

  it('keeps the event row count exact when a queue snapshot is present', async () => {
    setActiveLocale('en')
    const events = [...sessionTrace(), queueEvent()]
    mockFetch(events)
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    await waitFor(() => expect(screen.getByTestId('inspector-event-count').textContent).toBe(String(events.length)))
    expect(timeline.querySelectorAll('[data-event-type]')).toHaveLength(events.length)
    expect(timeline.querySelectorAll('[data-event-type="agent.queue"] [data-testid="inspector-queue-item"]')).toHaveLength(2)
    expect(screen.getByTestId('inspector-event-count').textContent).toBe(String(events.length))
  })
})
