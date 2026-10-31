import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import { probeService } from '../../src/service/probe.ts'

const HEALTH = JSON.stringify({ ok: true, appVersion: '1.2.3', application: { state: 'reachable', source: 'application_http', observedAt: 'x' } })
const UI = '<!doctype html><html><body><div id="root"></div></body></html>'
const API_ONLY = 'Guanxi 1.2.3\n\nСборка фронта не найдена (/x).\n'

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
  closers.push(() => new Promise((accept) => { server.closeAllConnections(); server.close(() => accept()) }))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

const guanxi = (page: string, health = HEALTH) => (request: IncomingMessage, response: ServerResponse) => {
  response.setHeader('content-type', request.url === '/api/health' ? 'application/json' : 'text/html')
  response.end(request.url === '/api/health' ? health : page)
}

describe('probeService', () => {
  it('ready: Guanxi health document and a UI document', async () => {
    const origin = await serve(guanxi(UI))
    assert.deepEqual(await probeService(origin, { timeoutMs: 1000 }), { kind: 'ready', version: '1.2.3' })
  })

  it('does not depend on the document title (the built UI sets it at runtime)', async () => {
    const origin = await serve(guanxi('<html><head><title></title></head><body><div id="root"></div></body></html>'))
    assert.equal((await probeService(origin, { timeoutMs: 1000 })).kind, 'ready')
  })

  it('ui_missing: the API answers but the node serves its "no UI build" page', async () => {
    const origin = await serve(guanxi(API_ONLY))
    assert.deepEqual(await probeService(origin, { timeoutMs: 1000 }), { kind: 'ui_missing', version: '1.2.3' })
  })

  it('closed: connection refused', async () => {
    const origin = await serve(guanxi(UI))
    await closers.pop()!()
    assert.deepEqual(await probeService(origin, { timeoutMs: 1000 }), { kind: 'closed' })
  })

  it('foreign: another HTTP server, a health document of the wrong shape, an error status', async () => {
    assert.equal((await probeService(await serve((_q, r) => r.end('hello')), { timeoutMs: 1000 })).kind, 'foreign')
    for (const body of [JSON.stringify({ ok: true }), JSON.stringify({ ok: true, appVersion: '1', application: { source: 'other' } }), JSON.stringify({ ok: false, appVersion: '1', application: { source: 'application_http' } }), '[]', 'null']) {
      assert.equal((await probeService(await serve(guanxi(UI, body)), { timeoutMs: 1000 })).kind, 'foreign', body)
    }
    assert.equal((await probeService(await serve((_q, r) => { r.statusCode = 503; r.end(HEALTH) }), { timeoutMs: 1000 })).kind, 'foreign')
  })

  it('foreign: a non-HTTP listener that closes the connection', async () => {
    const server = createTcpServer((socket) => socket.destroy())
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept))
    closers.push(() => new Promise((accept) => server.close(() => accept())))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    assert.equal((await probeService(`http://127.0.0.1:${port}`, { timeoutMs: 1000 })).kind, 'foreign')
  })

  it('hung: the port accepts and never answers inside the timeout', async () => {
    const origin = await serve(() => undefined)
    const started = Date.now()
    assert.deepEqual(await probeService(origin, { timeoutMs: 200 }), { kind: 'hung' })
    assert.ok(Date.now() - started < 2000)
  })

  it('hung: a body that never ends is cut by the timeout, not read forever', async () => {
    const origin = await serve((request, response) => {
      if (request.url === '/api/health') {
        response.setHeader('content-type', 'application/json')
        response.write('{"ok":')
        return
      }
      response.end(UI)
    })
    const started = Date.now()
    assert.deepEqual(await probeService(origin, { timeoutMs: 300 }), { kind: 'hung' })
    assert.ok(Date.now() - started < 3000)
  })
})
