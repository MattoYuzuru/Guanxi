import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { LOCAL_ACCOUNT_ID, LOCAL_BODY_MAX_BYTES, ResponseShapeError, commonFailure, localGuard, wire } from '../src/http/local-guard.ts'
import type { NotificationInbox } from '../src/notifications/inbox.ts'
import { notificationRoutes } from '../src/notifications/routes.ts'
import type { VoiceGlossary } from '../src/voice/plugin.ts'
import { glossaryRoutes } from '../src/voice/routes.ts'
import type { WorkLedger } from '../src/work/ledger.ts'
import { workRoutes } from '../src/work/routes.ts'
import { call } from './ms2-fixture.ts'

test('a response that breaks its own contract is an internal_error, never a caller error', async () => {
  const inbox = { list: () => ({ items: [{ id: 'bad' }], nextCursor: null }) } as unknown as NotificationInbox
  const voice = { store: { list: () => [{ id: 'bad' }] } } as unknown as VoiceGlossary
  const ledger = { latest: () => ({ projectId: 'p1', revision: -1, createdAt: 'x', author: 'user', items: [] }) } as unknown as WorkLedger
  const app = new Hono()
    .route('/n', notificationRoutes(() => inbox, 'local'))
    .route('/v', glossaryRoutes(() => voice, 'local'))
    .route('/w', workRoutes(() => ledger, 'local'))
  for (const path of ['/n', '/v', '/w/projects/p1/revision']) {
    const response = await call(app, path)
    assert.equal(response.status, 500, path)
    assert.deepEqual(response.json, { code: 'internal_error' }, path)
  }
})

test('wire() reports a mismatch as ResponseShapeError without quoting the value', () => {
  assert.equal(wire(z.object({ a: z.number() }), { a: 1 }).a, 1)
  assert.throws(() => wire(z.object({ a: z.number() }), { a: 'SECRET' }), (error: unknown) => error instanceof ResponseShapeError && !String(error.message).includes('SECRET'))
  assert.equal(commonFailure(new ResponseShapeError()), null)
  assert.deepEqual(commonFailure(new ZodError([])), { code: 'validation_failed', status: 400 })
  assert.deepEqual(commonFailure(new SyntaxError('x')), { code: 'validation_failed', status: 400 })
  assert.equal(commonFailure(new Error('x')), null)
})

test('the guard applies to every method and sets the shared constants', async () => {
  assert.equal(LOCAL_ACCOUNT_ID, 'local')
  assert.equal(LOCAL_BODY_MAX_BYTES, 2 * 1024 * 1024)
  const app = new Hono().use('*', localGuard([])).all('/x', (c) => c.json({ ok: true }))
  const peer = { incoming: { socket: { remoteAddress: '::1' } } }
  assert.equal((await app.request('/x', { method: 'GET' }, peer)).status, 200, 'IPv6 loopback is a loopback peer')
  assert.equal((await app.request('/x', { method: 'GET' }, { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } } })).status, 200)
  for (const method of ['PUT', 'PATCH', 'POST', 'DELETE']) {
    assert.equal((await app.request('/x', { method, body: '{}', headers: { 'content-type': 'text/plain' } }, peer)).status, 415, method)
    assert.equal((await app.request('/x', { method, body: '{}', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } }, peer)).status, 403, method)
    assert.equal((await app.request('/x', { method, body: '{}', headers: { 'content-type': 'application/json' } }, { incoming: { socket: { remoteAddress: '10.0.0.5' } } })).status, 403, method)
    assert.equal((await app.request('/x', { method, body: '{}', headers: { 'content-type': 'application/json' } }, peer)).status, 200, method)
  }
  const stream = new Request('http://localhost/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LOCAL_BODY_MAX_BYTES + 1)); controller.close() } }),
  } as RequestInit)
  assert.equal((await app.request(stream, undefined, peer)).status, 413, 'a body without content-length is bounded too')
})
