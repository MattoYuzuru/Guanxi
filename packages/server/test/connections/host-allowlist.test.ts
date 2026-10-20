import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { serve } from '@hono/node-server'
import { connectionRoutes } from '../../src/connections/routes.ts'
import type { Connections } from '../../src/connections/service.ts'
import { createApp } from '../../src/app.ts'
import type { AppContext } from '../../src/context.ts'

const context = { settings: { get: () => ({}) } } as AppContext

test('whole-server Host allowlist covers loopback, configured authority and Vite hosts with exact ports', async () => {
  const app = createApp(context, { host: 'node.example', port: 4387, devOrigins: ['http://localhost:5187'] })
  for (const host of ['localhost:4387', '127.0.0.1:4387', '[::1]:4387', 'node.example:4387', 'localhost:5187']) {
    assert.equal((await app.request('http://localhost/api/settings', { headers: { Host: host } })).status, 200, host)
  }
  for (const host of ['evil.example:4387', 'localhost:4388', 'localhost:5188', '127.0.0.1.evil:4387', 'localhost.:4387', 'localhost:4387,evil.example', 'evil@localhost:4387']) {
    assert.equal((await app.request('http://localhost/api/settings', { headers: { Host: host, Origin: `http://${host}` } })).status, 403, host)
  }
})

test('E4: a real listener denies rebinding for Connections, unlock, a legacy route and the SPA', async t => {
  let port = 0; let mutations = 0
  const app = createApp(context, { host: '127.0.0.1', port: () => port, devOrigins: ['http://127.0.0.1:5187'] })
  // Even if the guard regresses, a rebinding experiment must never open the OS keychain.
  const fixture = { create() { mutations++; return {} }, unlockVault: async () => { mutations++ } } as unknown as Connections
  app.route('/api/connections', connectionRoutes(() => fixture, 'local'))
  app.get('/settings', c => c.text('Fixture SPA'))
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, address => { port = address.port })
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const send = (path: string, host: string, method = 'GET') => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!))
    })
    req.on('error', reject); req.end(method === 'GET' ? undefined : '{}')
  })
  for (const [path, method] of [['/api/connections', 'POST'], ['/api/connections/vault/unlock', 'POST'], ['/api/settings', 'GET'], ['/settings', 'GET']]) {
    assert.equal(await send(path!, `evil.example:${port}`, method), 403, path)
  }
  assert.equal(await send('/api/settings', `127.0.0.1:${port}`), 200)
  assert.equal(mutations, 0)
})
