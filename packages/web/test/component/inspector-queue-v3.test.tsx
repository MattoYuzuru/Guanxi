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
const COPY = {
  en: {
    timeline: 'Session events in order',
    preview: 'Preview: first 8 KB of 8 KB. The rest of the inline text is not shown here.',
    artifact: 'First 21 B of 16 KB are stored in this event. The full input stays in the local session store; it is not included in this event or export.',
  },
  ru: {
    timeline: 'События сессии по порядку',
    preview: 'Предпросмотр: первые 8 КБ из 8 КБ. Остальная часть встроенного текста здесь не показана.',
    artifact: 'В этом событии сохранены первые 21 Б из 16 КБ. Полный ввод остаётся в локальном хранилище сессии и не входит в это событие или экспорт.',
  },
} as const

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
            excerptBytes: new TextEncoder().encode(ARTIFACT_EXCERPT).byteLength,
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
    expect(within(queue).getByText(COPY.en.preview, { exact: true })).toBeTruthy()
    expect(within(queue).getByText(COPY.en.artifact, { exact: true })).toBeTruthy()
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
    const timeline = await screen.findByRole('list', { name: 'События сессии по порядку' })
    const queue = await within(timeline).findByRole('list', { name: 'Элементы очереди' })
    expect(within(queue).getAllByText('Встроено')).toHaveLength(1)
    expect(within(queue).getAllByText('Ограниченный ввод')).toHaveLength(1)
    expect(within(queue).getByText(COPY.ru.preview, { exact: true })).toBeTruthy()
    expect(within(queue).getByText(COPY.ru.artifact, { exact: true })).toBeTruthy()
  })

  it.each(['en', 'ru'] as const)('bounds a legacy inline preview and explains its omitted remainder (%s)', async (locale) => {
    setActiveLocale(locale)
    const legacy = sessionEventSchema.parse({
      sessionId: SESSION_ID,
      seq: sessionTrace().length + 1,
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
    expect(boundedPreview(`${'x'.repeat(INPUT_EXCERPT_BYTES - 10)}⟦REDACTED secret://demo⟧tail`)).not.toContain('⟦')
    const queue = queueEvent()
    if (queue.type !== 'agent.queue' || queue.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    expect(queueRenderItems(queue).map((row) => row.kind)).toEqual(['inline', 'artifact'])
    mockFetch([...sessionTrace(), legacy])
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: COPY[locale].timeline })
    const renderedQueue = timeline.querySelector('[data-event-type="agent.queue"]')
    expect(renderedQueue).not.toBeNull()
    const itemRows = renderedQueue!.querySelectorAll('[data-testid="inspector-queue-item"]')
    expect(Array.from(itemRows, row => row.getAttribute('data-queue-item-id'))).toEqual(['legacy-one', 'legacy-two'])
    expect(within(renderedQueue as HTMLElement).getByText(COPY[locale].preview, { exact: true })).toBeTruthy()
    expect(renderedQueue!.textContent).not.toContain('LEGACY-TAIL')
    expect(renderedQueue!.textContent).not.toContain(ARTIFACT_ID)
  })

  it('bounds ordinary brackets and genuine marker cuts without discarding legitimate text', () => {
    setActiveLocale('en')
    const max = INPUT_EXCERPT_BYTES
    const bytes = (value: string) => new TextEncoder().encode(value)
    const exactPrefix = (value: string) => new TextDecoder().decode(bytes(value).subarray(0, max))

    const ordinary = `prefix ⟦ ordinary ${'x'.repeat(9000)}`
    const ordinaryPreview = boundedPreview(ordinary)
    expect(ordinaryPreview).toBe(exactPrefix(ordinary))
    expect(bytes(ordinaryPreview).byteLength).toBe(max)

    // A multibyte character cut by the byte bound is removed whole, never replaced.
    const unicodeCut = `${'x'.repeat(max - 2)}🙂tail`
    const unicodePreview = boundedPreview(unicodeCut)
    expect(unicodePreview).toBe('x'.repeat(max - 2))
    expect(unicodePreview).not.toContain('\uFFFD')
    expect(bytes(unicodePreview).byteLength).toBe(max - 2)

    // The clip cuts inside the visible genuine prefix: only the partial marker goes.
    const cutInsidePrefix = `${'x'.repeat(max - 4)}⟦REDACTED secret://demo⟧tail`
    expect(boundedPreview(cutInsidePrefix)).toBe('x'.repeat(max - 4))

    // The clip cuts inside the marker body after the full prefix.
    const cutInsideMarker = `${'x'.repeat(max - 12)}⟦REDACTED secret://demo⟧tail`
    expect(boundedPreview(cutInsideMarker)).toBe('x'.repeat(max - 12))

    // A complete marker well inside the bound is preserved as text.
    const complete = 'before ⟦REDACTED secret://demo⟧ after'
    expect(boundedPreview(complete)).toBe(complete)

    // A bare prefix without a closing marker is not genuine marker syntax.
    const unclosed = `${'x'.repeat(max - 10)}⟦REDACTED but no close`
    expect(boundedPreview(unclosed)).toBe(exactPrefix(unclosed))
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
