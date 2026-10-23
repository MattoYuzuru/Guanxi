import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createConnectionSchema } from '@guanxi/contract'
import { endpointFetch } from '../../src/connections/endpoint.ts'

test('HTTP connection creation refuses endpoint and network-policy overrides', async () => {
  const { Hono } = await import('hono')
  const { connectionRoutes } = await import('../../src/connections/routes.ts')
  const app = new Hono().route('/connections', connectionRoutes(() => ({
    create: () => assert.fail('HTTP override reached the registry'),
  }) as unknown as import('../../src/connections/service.ts').Connections, 'local'))
  const row = { name: 'x', kind: 'model_api', provider: 'openai', auth: 'api_key' }
  for (const extra of [{ baseUrl: 'https://10.0.0.1/v1' }, { allowPrivate: true }]) {
    assert.equal(createConnectionSchema.safeParse({ ...row, ...extra }).success, false)
    const response = await app.request('/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, ...extra }) })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { code: 'validation_failed' })
  }
})

test('dispatch refuses all link-local addresses, including IPv4 mapped IPv6, even with opt-in', async () => {
  for (const address of ['169.254.169.254', 'fe80::1', 'febf::1', '::ffff:169.254.1.2']) {
    let calls = 0
    await assert.rejects(endpointFetch('https://provider.invalid/v1/models', {}, true,
      async () => { calls++; return Response.json({}) }, async () => [{ address, family: address.includes(':') ? 6 : 4 }]))
    assert.equal(calls, 0)
  }
})

test('private/loopback DNS results require persisted owner opt-in; public HTTP is refused', async () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', 'fc00::1', 'fdff::1', '127.0.0.1', '::1', '::ffff:10.1.2.3']) {
    let calls = 0
    const transport: typeof fetch = async () => { calls++; return Response.json({}) }
    const resolve = async () => [{ address, family: address.includes(':') ? 6 : 4 }]
    await assert.rejects(endpointFetch('https://provider.invalid/v1/models', {}, false, transport, resolve))
    assert.equal(calls, 0)
    await endpointFetch('https://provider.invalid/v1/models', {}, true, transport, resolve)
    assert.equal(calls, 1)
  }
  await assert.rejects(endpointFetch('http://provider.invalid/v1/models', {}, true,
    async () => { assert.fail('public HTTP dispatched') }, async () => [{ address: '8.8.8.8', family: 4 }]))
})

test('dispatch pins the validated DNS result and preserves Host without a second lookup', async t => {
  const server = createServer((req, res) => { assert.match(req.headers.host!, /^provider.invalid:/); res.end('pinned') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address() as { port: number }
  let lookups = 0
  const result = await endpointFetch(`http://provider.invalid:${address.port}/v1/models`, {}, true, globalThis.fetch,
    async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }] })
  assert.equal(await result.text(), 'pinned'); assert.equal(lookups, 1)
})


test('trusted dotenv records owner opt-in; HTTP cannot set it', async () => {
  const { parseProviderKeys } = await import('../../src/connections/dotenv.ts')
  const text = 'OPENAI_API_KEY=test_fixture_key_123456789\nOPENAI_API_URL=http://192.168.1.2/v1'
  assert.equal(parseProviderKeys(text)[0]!.allowPrivate, false)
  assert.equal(parseProviderKeys(text + '\nGUANXI_PROVIDER_ALLOW_PRIVATE=1')[0]!.allowPrivate, true)
})

test('LAN HTTP needs owner consent and a mixed public/private DNS set is refused', async () => {
  const lan = async () => [{ address: '192.168.1.2', family: 4 }]
  let calls = 0
  const transport: typeof fetch = async () => { calls++; return Response.json({}) }
  await assert.rejects(endpointFetch('http://provider.invalid/v1/models', {}, false, transport, lan))
  await endpointFetch('http://provider.invalid/v1/models', {}, true, transport, lan)
  assert.equal(calls, 1)
  await assert.rejects(endpointFetch('https://provider.invalid/v1/models', {}, false, transport,
    async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]))
  assert.equal(calls, 1)
})
