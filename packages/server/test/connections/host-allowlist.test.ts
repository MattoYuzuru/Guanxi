import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/app.ts'
import type { AppContext } from '../../src/context.ts'
import { start } from '../../src/index.ts'

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
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-host-'))
  const server = await start({ port: 0, host: '127.0.0.1', dataDir: dir, webDir: dir, devOrigins: ['http://127.0.0.1:5187'] })
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }) })
  const send = (path: string, host: string, method = 'GET') => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.port, path, method,
      headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode!))
    })
    req.on('error', reject); req.end(method === 'GET' ? undefined : '{}')
  })
  for (const [path, method] of [['/api/connections', 'POST'], ['/api/connections/vault/unlock', 'POST'], ['/api/settings', 'GET'], ['/settings', 'GET']]) {
    assert.equal(await send(path!, `evil.example:${server.port}`, method), 403, path)
  }
  assert.equal(await send('/api/settings', `127.0.0.1:${server.port}`), 200)
})
