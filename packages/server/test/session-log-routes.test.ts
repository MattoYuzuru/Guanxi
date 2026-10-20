/**
 * K2 inspector routes: strict queries, typed not-found and unavailable
 * states, paging cursors, SSE resume by Last-Event-ID, and the export shape.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  apiErrorSchema,
  listSessionsResponse,
  sessionEventSchema,
  sessionEventsResponse,
  sessionExportSchema,
  sessionSearchResponse,
  sessionSpansResponse,
  sessionSummarySchema,
  type SessionEvent,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog } from '../src/session-log/log.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb } from '../src/store/db.ts'

/** The Node server's request bindings with a loopback peer; the session routes refuse any other peer. */
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

function fixture() {
  const db = openDb(':memory:')
  const log = new SessionLog({ db, scrubber: new SecretScrubber() })
  const handle = log.open('s-routes', { kind: 'agent' })
  for (let index = 0; index < 4; index++) {
    handle.append({ type: 'prompt', data: { origin: 'typed', messageId: `m-${index}`, text: `routes prompt ${index}`, attachmentCount: 0 } })
  }
  handle.append({ type: 'reasoning', data: { messageId: 'm-0', step: 0, text: 'routes reasoning' } })
  const app = new Hono()
  let available = true
  app.route('/api/sessions', sessionLogRoutes(() => (available ? log : undefined)))
  return { app, log, handle, setAvailable: (value: boolean) => { available = value } }
}

async function readFrames(response: Response, count: number): Promise<SessionEvent[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: SessionEvent[] = []
  while (events.length < count) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const id = frame.split('\n').find((line) => line.startsWith('id: '))
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (data) {
        const event = sessionEventSchema.parse(JSON.parse(data.slice(6)))
        assert.equal(id, `id: ${event.seq}`, 'the SSE id is the seq')
        events.push(event)
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  await reader.cancel()
  return events
}

describe('session log routes', () => {
  it('serves the list, summary, pages, spans, search and export by their contract schemas', async () => {
    const { app } = fixture()
    listSessionsResponse.parse(await (await app.request('/api/sessions', {}, LOOPBACK)).json())
    const summary = sessionSummarySchema.parse(await (await app.request('/api/sessions/s-routes', {}, LOOPBACK)).json())
    assert.equal(summary.eventCount, 7)
    assert.equal(summary.counts.prompt, 4)
    assert.equal(summary.tokens.samples, 0)
    assert.equal(summary.tokens.context, null)

    const first = sessionEventsResponse.parse(await (await app.request('/api/sessions/s-routes/events?after=0&limit=3', {}, LOOPBACK)).json())
    assert.deepEqual(first.events.map((event) => event.seq), [1, 2, 3])
    assert.equal(first.nextAfter, 3)
    assert.equal(first.hasMore, true)
    const last = sessionEventsResponse.parse(await (await app.request('/api/sessions/s-routes/events?after=6&limit=3', {}, LOOPBACK)).json())
    assert.deepEqual(last.events.map((event) => event.seq), [7])
    assert.equal(last.hasMore, false)
    const beyond = sessionEventsResponse.parse(await (await app.request('/api/sessions/s-routes/events?after=7', {}, LOOPBACK)).json())
    assert.deepEqual(beyond.events, [])
    assert.equal(beyond.nextAfter, 7)

    sessionSpansResponse.parse(await (await app.request('/api/sessions/s-routes/spans', {}, LOOPBACK)).json())
    const search = sessionSearchResponse.parse(await (await app.request('/api/sessions/search?q=routes&sessionId=s-routes', {}, LOOPBACK)).json())
    assert.deepEqual(search.hits.map((hit) => hit.type).sort(), ['prompt', 'prompt', 'prompt', 'prompt', 'reasoning'])

    const exported = await app.request('/api/sessions/s-routes/export', {}, LOOPBACK)
    assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="session-s-routes\.json"/)
    const body = sessionExportSchema.parse(await exported.json())
    assert.equal(body.excluded.reasoning, 1)
    assert.equal(body.events.length, 6)
    assert.equal(body.lastSeq, 7)
  })

  it('refuses unknown, repeated and malformed query values before reading', async () => {
    const { app } = fixture()
    for (const path of [
      '/api/sessions?limit=0',
      '/api/sessions?limit=201',
      '/api/sessions?extra=1',
      '/api/sessions/s-routes?x=1',
      '/api/sessions/s-routes/events?after=-1',
      '/api/sessions/s-routes/events?after=1.5',
      '/api/sessions/s-routes/events?limit=501',
      '/api/sessions/s-routes/events?after=1&after=2',
      '/api/sessions/s-routes/spans?x=1',
      '/api/sessions/s-routes/export?x=1',
      '/api/sessions/search',
      '/api/sessions/search?q=%20%20',
      `/api/sessions/search?q=${'x'.repeat(201)}`,
      '/api/sessions/s-routes/stream?after=x',
      `/api/sessions/${'x'.repeat(201)}/events`,
    ]) {
      const response = await app.request(path, {}, LOOPBACK)
      assert.equal(response.status, 400, path)
      assert.equal(apiErrorSchema.parse(await response.json()).code, 'validation_failed', path)
    }
    const badResume = await app.request('/api/sessions/s-routes/stream', { headers: { 'Last-Event-ID': 'abc' } }, LOOPBACK)
    assert.equal(badResume.status, 400)
  })

  it('answers session_not_found for an unknown session and storage_error when the log is unavailable', async () => {
    const { app, setAvailable } = fixture()
    for (const suffix of ['', '/events', '/spans', '/export', '/stream']) {
      const response = await app.request(`/api/sessions/missing${suffix}`, {}, LOOPBACK)
      assert.equal(response.status, 404, suffix)
      assert.equal(apiErrorSchema.parse(await response.json()).code, 'session_not_found')
    }
    setAvailable(false)
    for (const path of ['/api/sessions', '/api/sessions/s-routes', '/api/sessions/s-routes/stream', '/api/sessions/search?q=x']) {
      const response = await app.request(path, {}, LOOPBACK)
      assert.equal(response.status, 500, path)
      assert.equal(apiErrorSchema.parse(await response.json()).code, 'storage_error')
    }
  })

  it('replays persisted events, then streams new ones, and resumes after Last-Event-ID', async () => {
    const { app, handle } = fixture()
    const response = await app.request('/api/sessions/s-routes/stream?after=5', {}, LOOPBACK)
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const reading = readFrames(response, 3)
    await new Promise((resolve) => setTimeout(resolve, 10))
    handle.append({ type: 'prompt', data: { origin: 'typed', messageId: 'm-live', text: 'live prompt', attachmentCount: 0 } })
    const events = await reading
    assert.deepEqual(events.map((event) => event.seq), [6, 7, 8])

    const resumed = await app.request('/api/sessions/s-routes/stream?after=0', { headers: { 'Last-Event-ID': '7' } }, LOOPBACK)
    assert.deepEqual((await readFrames(resumed, 1)).map((event) => event.seq), [8], 'Last-Event-ID wins over after')
  })
})
