import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { leadDelegateInputSchema } from '@guanxi/contract'
import { LEAD_DELEGATE_JSON_SCHEMA, LeadToolServer, type ToolResult } from '../../src/leads/tool-server.ts'
import { brief } from './brief.ts'
import { leadFixture } from './helpers.ts'

async function start(t: { after(fn: () => unknown): void }, handler: (input: unknown) => Promise<ToolResult> = async () => ({ kind: 'result', text: 'ok' }), maxBodyBytes?: number) {
  const server = new LeadToolServer(maxBodyBytes ? { maxBodyBytes } : {})
  t.after(() => server.close())
  const url = await server.url()
  const grant = server.grant({ runId: 'r', attemptId: 'a', wakeSeq: null }, handler)
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', [grant.header.name]: grant.header.value, ...headers } })
  return { server, url, grant, post }
}
const call = (id = 1, args: unknown = brief()) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'guanxi_delegate', arguments: args } })

test('the endpoint listens on the loopback address only and every request needs the turn capability', async t => {
  const { url, grant, server } = await start(t)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const bare = (headers: Record<string, string>) => fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), headers: { 'content-type': 'application/json', ...headers } })
  assert.equal((await bare({})).status, 401)
  assert.equal((await bare({ authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await bare({ authorization: grant.header.value.replace(/.$/, c => (c === 'A' ? 'B' : 'A')) })).status, 401)
  assert.equal((await bare({ [grant.header.name]: grant.header.value })).status, 200)
  assert.equal(server.activeGrants(), 1)
  grant.revoke()
  assert.equal((await bare({ [grant.header.name]: grant.header.value })).status, 401, 'a finished turn leaves no usable token')
  assert.equal(server.activeGrants(), 0)
})

test('a foreign Host or any Origin is refused, as are other methods, paths and media types', async t => {
  const { url, grant, post } = await start(t)
  const port = new URL(url).port
  const raw = (headers: Record<string, string>, path = '/mcp', method = 'POST', body = '{}') => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode!) })
    req.on('error', reject); req.end(body)
  })
  const auth = { [grant.header.name]: grant.header.value, 'content-type': 'application/json' }
  assert.equal(await raw({ ...auth, host: 'evil.example' }), 403, 'DNS rebinding name')
  assert.equal(await raw({ ...auth, host: `127.0.0.1:${Number(port) + 1}` }), 403)
  assert.equal(await raw({ ...auth, host: `localhost:${port}`, origin: 'http://localhost:5173' }), 403, 'a browser page')
  assert.equal(await raw({ ...auth, host: `127.0.0.1:${port}` }, '/other'), 404)
  assert.equal(await raw({ ...auth, host: `127.0.0.1:${port}` }, '/mcp?x=1'), 404)
  assert.equal(await raw({ ...auth, host: `127.0.0.1:${port}` }, '/mcp', 'GET'), 405, 'no server push stream')
  assert.equal(await raw({ ...auth, host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }), 415)
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200)
})

test('JSON-RPC handling: negotiation, tool listing, notifications, batches, bad input and size cap', async t => {
  const { post } = await start(t, undefined, 2_000)
  const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json() as any
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  const unknown = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json() as any
  assert.equal(unknown.result.protocolVersion, '2025-06-18')
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notification.status, 202)
  assert.equal(await notification.text(), '')
  const listed = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ['guanxi_delegate'])
  assert.equal((await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json() as any).error.code, -32600)
  assert.equal((await (await post('{not json')).json() as any).error.code, -32700)
  assert.equal((await (await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).json() as any).error.code, -32601)
  assert.equal((await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other' } })).json() as any).error.code, -32602)
  assert.equal((await post({ jsonrpc: '2.0', id: 5, method: 'ping', params: { pad: 'x'.repeat(3_000) } })).status, 413)
})

test('tools/list names the executors the host allows and is unchanged when none are configured', async t => {
  const description = async (server: LeadToolServer) => {
    const url = await server.url()
    const grant = server.grant({ runId: 'r', attemptId: 'a', wakeSeq: null }, async () => ({ kind: 'result', text: 'ok' }))
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', [grant.header.name]: grant.header.value } })
    grant.revoke()
    return ((await response.json()) as any).result.tools[0].description as string
  }
  const plain = new LeadToolServer()
  const one = new LeadToolServer({ executors: [{ connectionId: 'fedora', model: 'local' }] })
  const two = new LeadToolServer({ executors: [{ connectionId: 'a', model: 'x' }, { connectionId: 'b', model: 'y' }] })
  for (const server of [plain, one, two]) t.after(() => server.close())
  const base = await description(plain)
  assert.equal(base.includes('Allowed executors'), false)
  assert.equal(await description(one), `${base} Allowed executors on this node: connectionId=fedora model=local`)
  assert.equal(await description(two), `${base} Allowed executors on this node: connectionId=a model=x; connectionId=b model=y`)
})

test('the lead service passes its configured executors to tools/list', async t => {
  const f = await leadFixture(t, { plugin: { executors: [{ connectionId: 'fedora', model: 'local' }] } })
  const url = await f.tools.url()
  const grant = f.tools.grant({ runId: 'r', attemptId: 'a', wakeSeq: null }, async () => ({ kind: 'result', text: 'ok' }))
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', [grant.header.name]: grant.header.value } })
    const tool = ((await response.json()) as any).result.tools[0]
    assert.equal(tool.description.endsWith(' Allowed executors on this node: connectionId=fedora model=local'), true)
  } finally { grant.revoke() }
})

test('an injected tool server keeps the executors it was built with when the service has no list', async t => {
  const tools = new LeadToolServer({ executors: [{ connectionId: 'fedora', model: 'local' }] })
  t.after(() => tools.close())
  await leadFixture(t, { plugin: { tools } })
  const url = await tools.url()
  const grant = tools.grant({ runId: 'r', attemptId: 'a', wakeSeq: null }, async () => ({ kind: 'result', text: 'ok' }))
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      headers: { 'content-type': 'application/json', [grant.header.name]: grant.header.value } })
    const tool = ((await response.json()) as any).result.tools[0]
    assert.equal(tool.description.endsWith(' Allowed executors on this node: connectionId=fedora model=local'), true)
  } finally { grant.revoke() }
})

test('the tool schema matches the contract schema field by field', () => {
  const shape = (leadDelegateInputSchema as unknown as { _def: { schema: { shape: Record<string, { isOptional(): boolean }> } } })._def.schema.shape
  const optional = Object.entries(shape).filter(([, field]) => field.isOptional()).map(([key]) => key)
  assert.deepEqual(Object.keys(LEAD_DELEGATE_JSON_SCHEMA.properties).sort(), Object.keys(shape).sort())
  // Fields with a default are optional in the contract and absent from `required`.
  assert.deepEqual([...LEAD_DELEGATE_JSON_SCHEMA.required].sort(), Object.keys(shape).filter(key => !optional.includes(key)).sort())
  assert.ok(leadDelegateInputSchema.safeParse(brief()).success)
  const plan = LEAD_DELEGATE_JSON_SCHEMA.properties.plan
  const planShape = (leadDelegateInputSchema as any)._def.schema.shape.plan._def.schema.shape
  assert.deepEqual(Object.keys(plan.properties).sort(), Object.keys(planShape).sort())
})

test('a held call is never answered and its socket is destroyed on revocation; a throwing handler leaks nothing', async t => {
  let calls = 0
  const held = await start(t, async () => { calls++; return { kind: 'hold' } })
  const pending = held.post(call()).then(() => 'answered', () => 'closed')
  for (let i = 0; i < 100 && calls === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(calls, 1)
  assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still open'), 150))]), 'still open')
  held.grant.revoke()
  assert.equal(await pending, 'closed')
  const throwing = await start(t, async () => { throw new Error('PRIVATE_DETAIL') })
  const body = await (await throwing.post(call())).json() as any
  assert.deepEqual([body.result.isError, body.result.content[0].text], [true, 'lead_tool_failed'])
})

test('the grant context reaches the handler and close() destroys held calls and refuses new endpoints', async t => {
  const contexts: unknown[] = []
  const server = new LeadToolServer()
  const url = await server.url()
  const grant = server.grant({ runId: 'run-1', attemptId: 'att-1', wakeSeq: 7 }, async (_input, context) => { contexts.push(context); return { kind: 'hold' } })
  const pending = fetch(url, { method: 'POST', body: JSON.stringify(call()), headers: { 'content-type': 'application/json', [grant.header.name]: grant.header.value } }).then(() => 'answered', () => 'closed')
  for (let i = 0; i < 100 && contexts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(contexts, [{ runId: 'run-1', attemptId: 'att-1', wakeSeq: 7 }])
  await server.close()
  assert.equal(await pending, 'closed')
  await assert.rejects(server.url(), /lead_tools_closed/)
})

test('a listen failure is reported and a later attempt can still succeed', async t => {
  const first = new LeadToolServer()
  t.after(() => first.close())
  await first.url()
  const taken = first.address()!.port
  const second = new LeadToolServer({ port: taken })
  t.after(() => second.close())
  await assert.rejects(second.url(), /EADDRINUSE/)
  await first.close()
  assert.match(await second.url(), new RegExp(`:${taken}/mcp$`), 'the failure was not cached')
})
