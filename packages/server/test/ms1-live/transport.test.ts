import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { test } from 'node:test'
import { Ms1LiveError } from '../../src/ms1-live/config.ts'
import { loopbackTransport } from '../../src/ms1-live/transport.ts'

interface Seen { method: string; url: string; host: string; body: string; headers: IncomingMessage['headers'] }
async function target(handler: (seen: Seen, respond: (status: number, body?: string, headers?: Record<string, string>) => void) => void) {
  const seen: Seen[] = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer)
    const item = { method: req.method!, url: req.url!, host: req.headers.host!, body: Buffer.concat(chunks).toString('utf8'), headers: req.headers }
    seen.push(item)
    handler(item, (status, body = '{}', headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) } }
}
const request = (path: string, init: RequestInit = {}) => new Request(`https://federation.invalid${path}`, init)

test('the transport maps the logical federation URL onto the one configured loopback origin and sends the signed request unchanged', async () => {
  const t = await target((_seen, respond) => respond(200, '{"ok":true}'))
  try {
    const transport = loopbackTransport({ base: t.base, timeoutMs: 5000 })
    const response = await transport(request('/api/federation/attempts/runtime/count?x=1', { method: 'POST', headers: { 'X-Guanxi-Node': '{"sig":1}', 'Content-Type': 'application/json' }, body: '{"content":"a"}' }))
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(t.seen.length, 1)
    assert.equal(t.seen[0]!.method, 'POST'); assert.equal(t.seen[0]!.url, '/api/federation/attempts/runtime/count?x=1')
    assert.equal(t.seen[0]!.body, '{"content":"a"}'); assert.equal(t.seen[0]!.headers['x-guanxi-node'], '{"sig":1}')
    assert.equal(t.seen[0]!.host, new URL(t.base).host, 'the Host is the forwarded loopback authority: the peer\'s own-port allowlist sees the number it listens on')
    await transport(request('/api/federation/handshake'))
    assert.equal(t.seen[1]!.method, 'GET'); assert.equal(t.seen[1]!.body, '')
  } finally { await t.close() }
})

test('the transport forwards nothing but the federation API, and never to another address', async () => {
  const t = await target((_seen, respond) => respond(200))
  try {
    const transport = loopbackTransport({ base: t.base, timeoutMs: 5000 })
    for (const path of ['/api/relay', '/api/health', '/', '/api/federationx/handshake', '//evil.example/api/federation/x']) {
      await assert.rejects(transport(request(path)), (error: unknown) => error instanceof Ms1LiveError && error.code === 'route_not_federation', path)
    }
    // A logical URL carrying another authority cannot redirect the request: only its path is used.
    await transport(new Request('https://attacker.example:9999/api/federation/handshake'))
    assert.equal(t.seen.length, 1); assert.equal(t.seen[0]!.url, '/api/federation/handshake')
    for (const base of ['http://10.1.2.3:4552', 'https://127.0.0.1:4552', 'http://fedora:4552', 'http://127.0.0.1']) {
      assert.throws(() => loopbackTransport({ base, timeoutMs: 1000 }), (error: unknown) => error instanceof Ms1LiveError, base)
    }
    assert.throws(() => loopbackTransport({ base: t.base, timeoutMs: 0 }), (error: unknown) => error instanceof Ms1LiveError && error.code === 'timeout_invalid')
  } finally { await t.close() }
})

test('a redirect is an error, a silent peer times out, and a refused connection is an error: none is retried or followed', async () => {
  const hits: string[] = []
  let base = ''
  const t = await target((seen, respond) => {
    hits.push(seen.url)
    if (seen.url.endsWith('/redirect')) respond(302, '{}', { location: `${base}/api/federation/landed` })
    else if (seen.url.endsWith('/silent')) return
    else respond(200)
  })
  base = t.base
  try {
    const transport = loopbackTransport({ base: t.base, timeoutMs: 300 })
    await assert.rejects(transport(request('/api/federation/redirect')))
    assert.deepEqual(hits, ['/api/federation/redirect'], 'the Location was not requested and the request was not repeated')
    const began = Date.now()
    await assert.rejects(transport(request('/api/federation/silent')), (error: unknown) => (error as Error).name === 'TimeoutError')
    assert.ok(Date.now() - began < 3000)
  } finally { await t.close() }
  await assert.rejects(loopbackTransport({ base: t.base, timeoutMs: 1000 })(request('/api/federation/handshake')), TypeError, 'nothing listens any more')
})

test('only observation, count and offer may take minutes: every other message has the short deadline, so a half-open forward cannot hold a renewal', async () => {
  const t = await target((seen, respond) => { if (seen.url.endsWith('/observe') || seen.url.endsWith('/offers')) setTimeout(() => respond(200, '{"slow":true}'), 600) })
  try {
    const transport = loopbackTransport({ base: t.base, timeoutMs: 5000, messageTimeoutMs: 200 })
    for (const path of ['/api/federation/handshake', '/api/federation/attempts/renew', '/api/federation/attempts/events', '/api/federation/attempts/dispatch',
      '/api/federation/attempts/runtime/pin', '/api/federation/attempts/dispatch-cancel']) {
      const began = Date.now()
      await assert.rejects(transport(request(path, { method: 'POST', body: '{}' })), (error: unknown) => (error as Error).name === 'TimeoutError', path)
      assert.ok(Date.now() - began < 2000, `${path} gave up at the short deadline`)
    }
    for (const path of ['/api/federation/attempts/runtime/observe', '/api/federation/attempts/offers']) {
      assert.deepEqual(await (await transport(request(path, { method: 'POST', body: '{}' }))).json(), { slow: true }, `${path} may take longer than a message`)
    }
    assert.throws(() => loopbackTransport({ base: t.base, timeoutMs: 1000, messageTimeoutMs: 0 }), (error: unknown) => error instanceof Ms1LiveError && error.code === 'timeout_invalid')
  } finally { await t.close() }
})
