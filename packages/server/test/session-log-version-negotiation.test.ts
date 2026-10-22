/**
 * Explicit session event/export version negotiation (K2/K4 input slice).
 * A v1 parser receives only v1 bytes and a content-free 406 instead of a cursor
 * advancing past an event it cannot parse.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  INPUT_INLINE_BYTES,
  apiErrorSchema,
  sessionEventSchema,
  sessionEventsResponse,
  sessionExportSchema,
  type SessionEvent,
} from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog, type SessionHandle } from '../src/session-log/log.ts'
import { SessionInputStore, utf8Excerpt } from '../src/session-log/input-artifacts.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb } from '../src/store/db.ts'

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }

interface Fixture {
  app: Hono
  log: SessionLog
  db: ReturnType<typeof openDb>
  store: SessionInputStore
  sessionId: string
  handle: SessionHandle
}

async function fixture(test: { after(fn: () => unknown): void }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-version-negotiation-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'guanxi.db'))
  test.after(() => db.close())
  const log = new SessionLog({ db, scrubber: new SecretScrubber() })
  const store = new SessionInputStore({ dataDir: join(root, 'data'), db })
  const sessionId = 's-version'
  const handle = log.open(sessionId, { kind: 'agent' })
  test.after(() => { try { handle.close() } catch { /* closed */ } })
  for (let index = 0; index < 3; index++) {
    handle.append({ type: 'prompt', data: { origin: 'typed', messageId: `m-${index}`, text: `v1 prompt ${index}`, attachmentCount: 0 } })
  }
  const app = new Hono()
  app.route('/api/sessions', sessionLogRoutes(() => log))
  return { app, log, db, store, sessionId, handle }
}

async function appendV2(f: Fixture, text: string, messageId = 'm-v2'): Promise<SessionEvent> {
  const written = await f.store.write(f.sessionId, text, 'text/plain; charset=utf-8')
  return f.handle.append(
    { type: 'prompt', data: { origin: 'typed', messageId, attachmentCount: 0 } },
    {
      eventVersion: 2,
      inputArtifact: {
        checksum: written.checksum,
        byteSize: written.byteSize,
        mediaType: 'text/plain; charset=utf-8',
        excerpt: utf8Excerpt(text),
      },
    },
  ).event
}

interface Frame {
  id: string | null
  event: string | null
  data: string
}

async function readFrames(response: Response, stopOnError = false): Promise<Frame[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Frame[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const frame: Frame = { id: null, event: null, data: '' }
      for (const line of raw.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4)
        else if (line.startsWith('event: ')) frame.event = line.slice(7)
        else if (line.startsWith('data: ')) frame.data = line.slice(6)
      }
      if (frame.data) frames.push(frame)
      if (stopOnError && frame.event === 'guanxi-error') {
        await reader.cancel()
        return frames
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return frames
}

describe('session event version negotiation', () => {
  it('returns 406 with zero events and no cursor when a max-1 page contains v2', async (test) => {
    const f = await fixture(test)
    const tail = `NEG-TAIL-${randomBytes(8).toString('hex')}`
    const v2 = await appendV2(f, `${'n'.repeat(INPUT_INLINE_BYTES)}${tail}`)
    const response = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&limit=500&eventVersion=1`, {}, LOOPBACK)
    assert.equal(response.status, 406)
    const body = apiErrorSchema.parse(await response.json())
    assert.equal(body.code, 'session_event_version_unsupported')
    assert.deepEqual(body.details, { seq: v2.seq, supported: 1, required: 2 })
    assert.equal('events' in body, false)
    assert.equal('nextAfter' in body, false)
    assert.equal(JSON.stringify(body).includes(tail), false)

    const implicit = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0`, {}, LOOPBACK)
    assert.equal(implicit.status, 406, 'omitting the parameter means max 1')

    const over = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&eventVersion=3`, {}, LOOPBACK)
    assert.equal(over.status, 400)
  })

  it('serves v1 events before the first v2 boundary and all events to a max-2 client', async (test) => {
    const f = await fixture(test)
    const v2 = await appendV2(f, `${'m'.repeat(INPUT_INLINE_BYTES)}`)
    const v1 = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&limit=3&eventVersion=1`, {}, LOOPBACK)
    assert.equal(v1.status, 200)
    const page = sessionEventsResponse.parse(await v1.json())
    assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 3])
    assert.equal(page.nextAfter, 3)

    const blocked = await f.app.request(`/api/sessions/${f.sessionId}/events?after=3&eventVersion=1`, {}, LOOPBACK)
    assert.equal(blocked.status, 406)
    assert.equal(apiErrorSchema.parse(await blocked.json()).details?.['seq'], v2.seq)

    const current = await f.app.request(`/api/sessions/${f.sessionId}/events?after=0&limit=500&eventVersion=2`, {}, LOOPBACK)
    assert.equal(current.status, 200)
    const all = sessionEventsResponse.parse(await current.json())
    assert.equal(all.events.at(-1)?.seq, v2.seq)
    for (const event of all.events) sessionEventSchema.parse(event)
    assert.equal(all.events.some((event) => event.version === 2), true)
  })

  it('refuses a max-1 export of a v2 session with no body, and keeps a v1-only export identical', async (test) => {
    const f = await fixture(test)
    const v1First = sessionExportSchema.parse(await (await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=1`, {}, LOOPBACK)).json())
    const v1Second = sessionExportSchema.parse(await (await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=2`, {}, LOOPBACK)).json())
    assert.equal(v1First.exportVersion, 1)
    assert.equal(v1Second.exportVersion, 1)
    assert.deepEqual(v1First.events, v1Second.events)

    const tail = `EXPORT-TAIL-${randomBytes(8).toString('hex')}`
    await appendV2(f, `${'e'.repeat(INPUT_INLINE_BYTES)}${tail}`)
    const refused = await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=1`, {}, LOOPBACK)
    assert.equal(refused.status, 406)
    const error = apiErrorSchema.parse(await refused.json())
    assert.equal(error.code, 'session_event_version_unsupported')
    assert.equal(JSON.stringify(error).includes(tail), false)
    assert.equal(refused.headers.get('content-disposition'), null)

    const current = await f.app.request(`/api/sessions/${f.sessionId}/export?exportVersion=2`, {}, LOOPBACK)
    assert.equal(current.status, 200)
    const exported = sessionExportSchema.parse(await current.json())
    assert.equal(exported.exportVersion, 2)
    assert.equal(JSON.stringify(exported).includes(tail), false)
    assert.equal(exported.events.some((event) => event.version === 2), true)
  })

  it('closes an open max-1 stream at the first v2 event without an id and without retrying', async (test) => {
    const f = await fixture(test)
    const response = await f.app.request(`/api/sessions/${f.sessionId}/stream?after=0&eventVersion=1`, {}, LOOPBACK)
    assert.equal(response.status, 200)
    const reading = readFrames(response, true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const v2 = await appendV2(f, `${'s'.repeat(INPUT_INLINE_BYTES)}`)
    const frames = await reading
    const errorFrame = frames.find((frame) => frame.event === 'guanxi-error')
    assert.ok(errorFrame)
    assert.equal(errorFrame!.id, null)
    assert.equal(apiErrorSchema.parse(JSON.parse(errorFrame!.data)).code, 'session_event_version_unsupported')
    const lastV1 = frames.filter((frame) => frame.event === 'guanxi' && frame.id !== null).at(-1)
    assert.equal(lastV1?.id, '5', 'the last emitted id is the last v1 seq')
    const lastData = frames.filter((frame) => frame.event === 'guanxi').at(-1)
    assert.equal(sessionEventSchema.parse(JSON.parse(lastData!.data)).version, 1)

    // A reconnect with the captured cursor refuses before opening the stream.
    const reconnect = await f.app.request(`/api/sessions/${f.sessionId}/stream?eventVersion=1`, {
      headers: { 'Last-Event-ID': lastV1!.id! },
    }, LOOPBACK)
    assert.equal(reconnect.status, 406)
    const body = apiErrorSchema.parse(await reconnect.json())
    assert.equal(body.code, 'session_event_version_unsupported')
    assert.equal(body.details?.['seq'], v2.seq)
  })

  it('refuses a max-1 stream before opening when its first unread event is v2', async (test) => {
    const f = await fixture(test)
    const after = f.log.session(f.sessionId)!.lastSeq
    const v2 = await appendV2(f, `${'b'.repeat(INPUT_INLINE_BYTES)}`)
    const response = await f.app.request(`/api/sessions/${f.sessionId}/stream?after=${after}&eventVersion=1`, {}, LOOPBACK)
    assert.equal(response.status, 406)
    assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true)
    assert.equal(apiErrorSchema.parse(await response.json()).details?.['seq'], v2.seq)
  })

  it('keeps v1 stream frames unchanged when no v2 event exists', async (test) => {
    const f = await fixture(test)
    const response = await f.app.request(`/api/sessions/${f.sessionId}/stream?after=0`, {}, LOOPBACK)
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const chunk = await reader.read()
    await reader.cancel()
    const text = new TextDecoder().decode(chunk.value)
    assert.match(text, /id: 1\nevent: guanxi\n/u)
    assert.equal(text.includes('guanxi-error'), false)
    assert.equal(text.split('event: guanxi').length - 1 >= 1, true)
  })
})
