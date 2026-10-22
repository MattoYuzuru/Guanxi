import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Hono } from 'hono'
import { INPUT_EXCERPT_BYTES } from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog } from '../src/session-log/log.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { openDb } from '../src/store/db.ts'
import { SessionInputStore, utf8Excerpt } from '../src/session-log/input-artifacts.ts'

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
function fixture(t: { after(fn: () => unknown): void }, withoutCapability = false) {
  const db = openDb(':memory:'), scrubber = new SecretScrubber()
  const { scrubTruncatedPrefix: _capability, ...older } = scrubber.facade()
  const log = new SessionLog({ db, scrubber: withoutCapability ? older : scrubber })
  const handles = new Map<string, ReturnType<SessionLog['open']>>()
  t.after(() => { log.close(); db.close() })
  const app = new Hono().route('/api/sessions', sessionLogRoutes(() => log))
  function append(sessionId: string, text: string, type: 'prompt' | 'tool.call' = 'prompt') {
    const handle = handles.get(sessionId) ?? log.open(sessionId, { kind: 'agent' })
    handles.set(sessionId, handle)
    return handle.append(type === 'prompt'
      ? { type, data: { origin: 'typed', messageId: 'm', attachmentCount: 0 } }
      : { type, data: { toolCallId: 't', name: 'fixture', source: 'builtin', parsedFrom: 'native', diffPath: null } },
    { eventVersion: 2, inputArtifact: { checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      byteSize: Buffer.byteLength(text), mediaType: type === 'prompt' ? 'text/plain; charset=utf-8' : 'application/json', excerpt: utf8Excerpt(text) } })
  }
  return { db, scrubber, log, app, append }
}

test('late long secret cannot survive the v2 excerpt boundary into an old-list or summary title', async t => {
  const f = fixture(t)
  const secret = `SYNTHETIC_LONG_LATE_CANARY_${'z'.repeat(17000)}`
  f.append('late-long', secret)
  f.scrubber.register('secret://fixture/late-long', secret)
  const title = f.log.list().sessions.find(s => s.sessionId === 'late-long')!.title
  assert.equal(title?.includes('SYNTHETIC_LONG_LATE_CANARY_'), false)
  assert.match(title!, /REDACTED/)
  assert.equal(f.log.session('late-long')!.title, title)
  const summary = await f.app.request('/api/sessions/late-long', {}, LOOPBACK)
  assert.equal(summary.status, 200)
  assert.equal((await summary.json() as { title: string }).title, title)
  const event = f.log.readAll('late-long', 'person').find(e => e.type === 'prompt')!
  assert.equal(JSON.stringify(event).includes('SYNTHETIC_LONG_LATE_CANARY_'), false)
  assert.equal(f.log.search('SYNTHETIC_LONG_LATE_CANARY', { audience: 'person' }).length, 0)
  assert.equal(INPUT_EXCERPT_BYTES, 8192)
})

for (const kind of ['raw', 'JSON', 'URI'] as const) test(`late ${kind} form is protected in direct read, old list, export and search without changing stored rows`, async t => {
  const f = fixture(t)
  let artifactReads = 0
  t.mock.method(SessionInputStore.prototype, 'read', () => { artifactReads++; throw new Error('artifact_io_forbidden') })
  const secret = `VISIBLEPREFIX_${'q"\\/é'.repeat(4000)}`
  const form = kind === 'raw' ? secret : kind === 'JSON' ? JSON.stringify(secret).slice(1, -1) : encodeURIComponent(secret)
  const prefix = 'ordinary-visible-token '
  const appended = f.append(`form-${kind}`, prefix + form)
  const changesBefore = f.db.prepare('SELECT total_changes() AS n').get()!.n
  const before = JSON.stringify({ events: f.db.prepare('SELECT * FROM session_events ORDER BY row_id').all(),
    fts: f.db.prepare('SELECT rowid, * FROM session_events_fts').all() })
  const previouslyRead = f.log.readAll(`form-${kind}`, 'person').find(e => e.seq === appended.event.seq)!
  assert.ok(JSON.stringify(previouslyRead).includes('VISIBLEPREFIX_'), 'late registration follows a real prior page read')
  f.scrubber.register('secret://fixture/form', secret)
  const current = f.log.readAll(`form-${kind}`, 'person').find(e => e.seq === appended.event.seq)!
  const serialized = JSON.stringify(current)
  assert.equal(serialized.includes('VISIBLEPREFIX_'), false)
  assert.match(serialized, /REDACTED/)
  assert.equal(f.log.session(`form-${kind}`)!.title?.includes('VISIBLEPREFIX_'), false, 'redaction precedes the60-character title clip')
  assert.equal(current.id, appended.event.id); assert.equal(current.seq, appended.event.seq); assert.equal(current.version, 2)
  assert.equal('text' in current.data!, false)
  assert.equal(JSON.stringify(f.log.outward(`form-${kind}`, previouslyRead)).includes('VISIBLEPREFIX_'), false)
  assert.equal(f.log.search('VISIBLEPREFIX', { audience: 'person' }).length, 0)
  const ordinary = f.log.search('ordinary-visible-token', { audience: 'person' })
  assert.equal(ordinary.length, 1); assert.match(ordinary[0]!.snippet, /ordinary/)
  const exported = await f.app.request(`/api/sessions/form-${kind}/export?exportVersion=2`, {}, LOOPBACK)
  assert.equal(exported.status, 200)
  const body = await exported.text()
  assert.equal(body.includes('VISIBLEPREFIX_'), false); assert.match(body, /ordinary-visible-token/)
  const after = JSON.stringify({ events: f.db.prepare('SELECT * FROM session_events ORDER BY row_id').all(),
    fts: f.db.prepare('SELECT rowid, * FROM session_events_fts').all() })
  assert.equal(after, before, 'all reads preserve payload/hash/FTS/id/version/sequence byte-for-byte')
  assert.equal(artifactReads, 0, 'no full artifact is rehydrated on any projection')
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, changesBefore, 'read paths execute zero durable writes')
})

test('one-character boundary fragments are protected while complete unrelated v2 text and v1 stay useful', t => {
  const f = fixture(t)
  const secret = 'Zunique-secret-value'
  f.append('one-character', 'a'.repeat(INPUT_EXCERPT_BYTES - 1) + secret)
  f.append('complete-safe', 'ordinary safe Z')
  const v1 = f.log.open('v1-safe', { kind: 'agent' }).append({ type: 'prompt', data: { origin: 'typed', messageId: 'v1', text: 'ordinary safe Z', attachmentCount: 0 } }).event
  f.scrubber.register('secret://fixture/one-character', secret)
  const partial = f.log.readAll('one-character', 'person').find(e => e.type === 'prompt')!
  const artifact = (partial.data as { artifact: { excerpt: string; excerptBytes: number } }).artifact
  assert.equal(artifact.excerpt.includes('Z'), false)
  assert.equal(artifact.excerpt.includes('⟦') && !artifact.excerpt.includes('⟧'), false, 'expanded marker cannot be clipped in half')
  assert.equal(artifact.excerptBytes, Buffer.byteLength(artifact.excerpt))
  assert.ok(artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
  assert.equal(f.log.session('complete-safe')!.title, 'ordinary safe Z')
  assert.equal((f.log.readAll('v1-safe', 'person').find(e => e.seq === v1.seq)!.data as { text: string }).text, 'ordinary safe Z')
})

test('UTF-8 byte clipping preserves whole markers after expanding exact redactions, including the original truncation decision', t => {
  const f = fixture(t)
  const secret = 'Zlate-secret-value', complete = 'early-secret-value'
  // Replacement of the complete occurrence expands the original excerpt, while
  // the final one-character Z still crosses the ORIGINAL artifact boundary.
  const prefix = '😀'.repeat(2025) + complete + 'a'.repeat(INPUT_EXCERPT_BYTES - 8100 - complete.length - 1)
  const full = prefix + secret
  f.append('utf8', full)
  f.scrubber.register('secret://fixture/long-reference-for-expansion', complete)
  f.scrubber.register('secret://fixture/boundary', secret)
  assert.ok(Buffer.byteLength(f.scrubber.scrub(utf8Excerpt(full))) > Buffer.byteLength(full),
    'new replacement expansion defeats a truncation check made after redaction')
  const protect = f.scrubber.scrubTruncatedPrefix.bind(f.scrubber)
  let protectedOriginal = false
  t.mock.method(f.scrubber, 'scrubTruncatedPrefix', (text: string) => {
    protectedOriginal ||= text === utf8Excerpt(full) && text.endsWith('Z')
    return protect(text)
  })
  const event = f.log.readAll('utf8', 'person').find(e => e.type === 'prompt')!
  const artifact = (event.data as { artifact: { excerpt: string; excerptBytes: number } }).artifact
  assert.equal(artifact.excerpt.includes('Z'), false)
  assert.equal(artifact.excerpt.includes('\ufffd'), false)
  assert.equal(artifact.excerptBytes, Buffer.byteLength(artifact.excerpt))
  assert.ok(artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
  assert.equal((artifact.excerpt.match(/⟦/gu) ?? []).length, (artifact.excerpt.match(/⟧/gu) ?? []).length)
  assert.match(artifact.excerpt, /REDACTED/)
  assert.equal(protectedOriginal, true, 'known truncation is established using the original stored bytes')
})

test('tool.call v2 search filters protected prefixes before building snippets while retaining safe tool terms', t => {
  const f = fixture(t), secret = `toolsecretprefix${'p'.repeat(17000)}`
  f.append('tool', secret, 'tool.call')
  f.scrubber.register('secret://fixture/tool', secret)
  assert.equal(f.log.search('toolsecretprefix', { audience: 'person' }).length, 0)
  const safe = f.log.search('fixture', { audience: 'person' })
  assert.equal(safe.length, 1); assert.equal(safe[0]!.type, 'tool.call')
  assert.equal(safe[0]!.snippet.includes('toolsecretprefix'), false)
  const event = f.log.readAll('tool', 'person').find(e => e.type === 'tool.call')!
  assert.equal('arguments' in event.data!, false)
})

test('an older scrubber without the capability withholds only truncated excerpts', t => {
  const f = fixture(t, true)
  f.append('unprotected-long', 'CANARY_NOT_RETURNABLE_' + 'x'.repeat(17000))
  f.append('complete-ordinary', 'useful ordinary title')
  assert.equal(f.log.session('unprotected-long')!.title, null)
  const data = f.log.readAll('unprotected-long', 'person').find(e => e.type === 'prompt')!.data as { artifact: { excerpt: string; excerptBytes: number } }
  assert.equal(data.artifact.excerpt, ''); assert.equal(data.artifact.excerptBytes, 0)
  assert.equal(f.log.session('complete-ordinary')!.title, 'useful ordinary title')
  assert.equal(f.log.list().sessions.length, 2)
})

for (const live of [false, true]) test(`${live ? 'live' : 'resumed'} SSE uses the current registry after its earlier page read and immediately before serialization`, async t => {
  const f = fixture(t), id = live ? 'live-egress' : 'resumed-egress'
  const first = f.append(id, 'safe initial prompt')
  const secret = `STREAM_PREFIX_CANARY_${'s'.repeat(17000)}`
  const target = live ? null : f.append(id, secret).event
  const after = live ? first.event.seq : target!.seq - 1
  let expected = target
  let priorPageWasUnprotected = false
  const subscribe = f.log.subscribe.bind(f.log)
  t.mock.method(f.log, 'subscribe', async function* (...args: Parameters<SessionLog['subscribe']>) {
    for await (const event of subscribe(...args)) {
      if (event.seq === expected?.seq) {
        priorPageWasUnprotected = JSON.stringify(event).includes('STREAM_PREFIX_CANARY_')
        // The route awaits this iterator, then MUST reread before serializing.
        f.scrubber.register('secret://fixture/stream', secret)
      }
      yield event
    }
  })
  const response = await f.app.request(`/api/sessions/${id}/stream?eventVersion=2`, { headers: { 'Last-Event-ID': String(after) } }, LOOPBACK)
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const pending = reader.read()
  if (live) expected = f.append(id, secret).event
  try {
    const chunk = await pending
    assert.equal(chunk.done, false)
    const wire = new TextDecoder().decode(chunk.value)
    assert.equal(priorPageWasUnprotected, true)
    assert.equal(wire.includes('STREAM_PREFIX_CANARY_'), false)
    assert.match(wire, /REDACTED/)
    assert.equal(wire.split('event: guanxi\n').length - 1, 1, 'one frame, no duplicate or skipped data event')
    assert.ok(wire.startsWith(`id: ${expected!.seq}\n`))
    const frame = JSON.parse(wire.split('\ndata: ')[1]!.trim()) as { id: string; seq: number; version: number }
    assert.equal(frame.id, expected!.id); assert.equal(frame.seq, expected!.seq); assert.equal(frame.version, 2)
  } finally { await reader.cancel() }
})

test('complete v1 and v2 late-secret controls retain ordinary exact-match behavior', t => {
  const f = fixture(t), secret = 'COMPLETE_SECRET_CONTROL'
  const v1 = f.log.open('complete-v1', { kind: 'agent' }).append({ type: 'prompt', data: {
    origin: 'typed', messageId: 'm', text: `${secret} ordinary visible`, attachmentCount: 0,
  } }).event
  const v2 = f.append('complete-v2', `${secret} ordinary visible`).event
  f.scrubber.register('secret://fixture/complete', secret)
  t.mock.method(f.scrubber, 'scrubTruncatedPrefix', () => { throw new Error('complete_text_must_not_use_prefix_semantics') })
  for (const [id, original] of [['complete-v1', v1], ['complete-v2', v2]] as const) {
    const event = f.log.readAll(id, 'person').find(e => e.seq === original.seq)!
    assert.equal(JSON.stringify(event).includes(secret), false)
    assert.match(JSON.stringify(event), /ordinary visible/)
    assert.match(f.log.session(id)!.title!, /REDACTED/)
    assert.equal(event.id, original.id); assert.equal(event.version, original.version)
  }
})

for (const type of ['prompt', 'tool.call'] as const) test(`append-time marker expansion cannot hide an originally truncated short ${type} descriptor`, t => {
  const f = fixture(t), early = 'EARLY_SYNTHETIC', late = 'XY_LATE_SYNTHETIC'
  f.scrubber.register('secret://fixture/e', early)
  const full = early + late, excerpt = early + late.slice(0, 2)
  const id = `append-expansion-${type}`, handle = f.log.open(id, { kind: 'agent' })
  const input = type === 'prompt'
    ? { type, data: { origin: 'typed' as const, messageId: 'm', attachmentCount: 0 } }
    : { type, data: { toolCallId: 't', name: 'ordinarytool', source: 'builtin' as const, parsedFrom: 'native' as const, diffPath: null } }
  const appended = handle.append(input, { eventVersion: 2, inputArtifact: {
    checksum: `sha256:${createHash('sha256').update(full).digest('hex')}`, byteSize: Buffer.byteLength(full),
    mediaType: type === 'prompt' ? 'text/plain; charset=utf-8' : 'application/json', excerpt,
  } }).event
  const stored = f.db.prepare('SELECT payload FROM session_events WHERE id=?').get(appended.id)!.payload as string
  const original = JSON.parse(stored).artifact as { excerpt: string; excerptBytes: number; byteSize: number }
  assert.ok(original.excerptBytes > original.byteSize, 'append-time marker expansion has erased the byte comparison proof')
  assert.ok(original.excerpt.endsWith('XY'), 'valid source still contains an unregistered boundary fragment')
  f.scrubber.register('secret://fixture/late', late)
  const current = f.log.readAll(id, 'person').find(e => e.seq === appended.seq)!
  const output = (current.data as { artifact: { excerpt: string } }).artifact.excerpt
  assert.equal(output.endsWith('XY'), false)
  assert.match(output, /secret:\/\/fixture\/late/)
  assert.equal(f.log.search('XY', { audience: 'person', sessionId: id }).length, 0)
  if (type === 'prompt') assert.equal(f.log.session(id)!.title?.endsWith('XY'), false)
  else assert.equal(f.log.search('ordinarytool', { audience: 'person', sessionId: id }).length, 1)
  assert.equal(f.db.prepare('SELECT payload FROM session_events WHERE id=?').get(appended.id)!.payload, stored)
})
