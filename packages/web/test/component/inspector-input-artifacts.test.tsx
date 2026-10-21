/**
 * Inspector support for bounded v2 inputs and the typed incompatible state.
 * A v2 row renders only the excerpt and an explicit local-only label; the full
 * tail never reaches the DOM. A max-1 client refuses the boundary instead of
 * silently retrying or advancing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  apiErrorSchema,
  sessionEventSchema,
  type SessionEvent,
} from '@guanxi/contract'
import { InspectorPage } from '../../src/features/inspector/InspectorPage.tsx'
import { setActiveLocale } from '../../src/lib/locale.ts'
import { REASONING_TEXT, SESSION_ID, sessionSummary, sessionTrace } from '../fixtures/session-events.ts'

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const EXCERPT_MARKER = 'EXCERPT-ONLY-MARKER'
const FULL_TAIL = 'FULL-TAIL-MUST-NOT-REACH-THE-DOM'

function v2Prompt(): SessionEvent {
  const excerpt = `${EXCERPT_MARKER}${'e'.repeat(64)}`
  return sessionEventSchema.parse({
    sessionId: SESSION_ID,
    seq: 40,
    id: '22222222-2222-4222-8222-222222222222',
    version: 2,
    type: 'prompt',
    class: 'standard',
    spanId: null,
    parentSpanId: null,
    jobId: null,
    writerEpoch: 1,
    redactions: 0,
    createdAt: '2026-10-22T10:00:00.000Z',
    data: {
      origin: 'typed',
      messageId: 'message-v2-user',
      attachmentCount: 0,
      artifact: {
        artifactId: ARTIFACT_ID,
        checksum: `sha256:${'a'.repeat(64)}`,
        byteSize: INPUT_INLINE_BYTES + FULL_TAIL.length,
        mediaType: 'text/plain; charset=utf-8',
        excerpt,
        excerptBytes: new TextEncoder().encode(excerpt).byteLength,
      },
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function incompatible(supported = 1): Response {
  return json({
    code: 'session_event_version_unsupported',
    message: 'The next event needs a newer trace format',
    details: { seq: 41, supported, required: 2 },
  }, 406)
}

function stream(frames: string): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(frames))
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

function mockFetch(options: {
  events?: SessionEvent[]
  eventsStatus?: () => Response | null
  streamStatus?: () => Response | null
  liveFrames?: string
} = {}): string[] {
  const events = options.events ?? sessionTrace()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url.pathname + url.search)
    if (url.pathname === `/api/sessions/${SESSION_ID}`) return json(sessionSummary(events))
    if (url.pathname === `/api/sessions/${SESSION_ID}/events`) {
      const blocked = options.eventsStatus?.()
      if (blocked) return blocked
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
    if (url.pathname === `/api/sessions/${SESSION_ID}/stream`) {
      const blocked = options.streamStatus?.()
      if (blocked) return blocked
      return stream(options.liveFrames ?? '')
    }
    if (url.pathname === `/api/sessions/${SESSION_ID}/spans`) {
      return json({ sessionId: SESSION_ID, spans: [] })
    }
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

describe('inspector bounded input artifacts', () => {
  it('shows the excerpt and an explicit local-only label, never the full tail', async () => {
    setActiveLocale('en')
    const events = [...sessionTrace(), v2Prompt()]
    mockFetch({ events })
    render(<InspectorPage sessionId={SESSION_ID} />)
    const timeline = await screen.findByRole('list', { name: 'Session events in order' })
    expect(await screen.findByText(EXCERPT_MARKER, { exact: false })).toBeTruthy()
    expect(timeline.textContent).toContain('Bounded input')
    expect(timeline.textContent).toContain('full input stays in the local session store')
    expect(document.body.textContent).not.toContain(FULL_TAIL)
    expect(document.body.textContent).not.toContain(ARTIFACT_ID)
    expect(screen.getByRole('link', { name: 'Export JSON without reasoning' }).getAttribute('href'))
      .toBe(`/api/sessions/${SESSION_ID}/export?exportVersion=2`)
  })

  it('does not find text beyond the excerpt and reports no hits honestly', async () => {
    setActiveLocale('en')
    const events = [...sessionTrace(), v2Prompt()]
    mockFetch({ events })
    render(<InspectorPage sessionId={SESSION_ID} />)
    await screen.findByRole('list', { name: 'Session events in order' })
    const search = screen.getByRole('textbox', { name: /Search this session/ })
    fireEvent.change(search, { target: { value: FULL_TAIL } })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(screen.getAllByText('No event matches these words.').length).toBeGreaterThan(0))
    expect(document.body.textContent).not.toContain(FULL_TAIL)
  })

  it('preserves a typed incompatible state instead of a retry loop on the REST boundary', async () => {
    setActiveLocale('en')
    const calls = mockFetch({ eventsStatus: () => incompatible(1) })
    render(<InspectorPage sessionId={SESSION_ID} />)
    expect((await screen.findAllByText('This trace uses a newer event format')).length).toBeGreaterThan(0)
    expect(screen.getByText(/Update Guanxi to continue/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    expect(calls.filter((call) => call.includes('/events'))).toHaveLength(1)
  })

  it('parses the SSE error frame as a typed incompatible state and does not reconnect', async () => {
    setActiveLocale('en')
    const error = apiErrorSchema.parse({
      code: 'session_event_version_unsupported',
      message: 'The next event needs a newer trace format',
      details: { seq: 41, supported: 1, required: 2 },
    })
    const calls = mockFetch({
      liveFrames: `event: guanxi-error\ndata: ${JSON.stringify(error)}\n\n`,
    })
    render(<InspectorPage sessionId={SESSION_ID} />)
    expect(await screen.findByText('Live updates stopped: the next event needs a newer trace format')).toBeTruthy()
    await waitFor(() => expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull()
    expect(document.body.textContent).not.toContain(REASONING_TEXT)
  })

  it('treats a pre-open 406 on the live tail as a typed incompatible state', async () => {
    setActiveLocale('en')
    const calls = mockFetch({ streamStatus: () => incompatible(2) })
    render(<InspectorPage sessionId={SESSION_ID} />)
    expect(await screen.findByText('Live updates stopped: the next event needs a newer trace format')).toBeTruthy()
    await waitFor(() => expect(calls.filter((call) => call.includes('/stream'))).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull()
  })

  it('keeps the excerpt bound under the byte limit for a multi-byte excerpt', async () => {
    setActiveLocale('en')
    const event = v2Prompt()
    if (event.type !== 'prompt' || event.version !== 2) throw new Error('expected v2 prompt')
    expect(event.data.artifact.excerptBytes).toBeLessThanOrEqual(INPUT_EXCERPT_BYTES)
    expect(event.data.artifact.byteSize).toBeGreaterThan(INPUT_INLINE_BYTES)
  })
})
