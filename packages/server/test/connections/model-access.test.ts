import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createKernel } from '@guanxi/kernel'
import { Hono } from 'hono'
import { createConnectionSchema, connectionSnapshotSchema } from '@guanxi/contract'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { connectionsPlugin, CONNECTIONS_SERVICE } from '../../src/connections/plugin.ts'
import { temporaryEgressPlugin, EGRESS_SERVICE, type EgressScrubber } from '../../src/connections/egress.ts'
import { fixtureEgressPlugin } from './egress-fixture.ts'
import { connectionRoutes } from '../../src/connections/routes.ts'
import { Connections } from '../../src/connections/service.ts'
import { piModels, assertApiKey } from '../../src/connections/pi.ts'
import { BALANCE_PROBES, parseBalance, probeEndpoints } from '../../src/probes/balances.ts'
import { modelsDevFacts } from '../../src/connections/metadata.ts'
import openrouterFixture from '../../src/probes/fixtures/openrouter.json' with { type: 'json' }
import deepseekFixture from '../../src/probes/fixtures/deepseek.json' with { type: 'json' }
import type { PiTransport } from '../../src/connections/pi.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'

const account = 'test-owner'
const apiInput = { name: 'Test model', kind: 'model_api' as const, provider: 'deepseek' as const, auth: 'api_key' as const }
const fakeKey = () => `test_${randomBytes(32).toString('hex')}`
async function setup(t: { after(fn: () => unknown): void }, options: { transport?: typeof fetch; pi?: PiTransport; unattended?: boolean; ownerDevice?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k3-'))
  const keys = new Map<string, Buffer>()
  const keychain: VaultKeychain = { key(id, create) {
    if (!keys.has(id) && create) keys.set(id, randomBytes(32))
    if (!keys.has(id)) throw new Error('No wrapping key')
    return Buffer.from(keys.get(id)!)
  } }
  const kernel = createKernel()
  await kernel.plugin(resourceGovernorPlugin)
  await kernel.plugin(ollamaAdapterPlugin, { fetch: options.transport ?? (async () => { throw new Error('Unexpected HTTP call') }) })
  await kernel.plugin(fixtureEgressPlugin)
  const config = { databasePath: join(dir, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434',
    policy: { ownerDevice: options.ownerDevice ?? true, nodeKeyOptIn: options.unattended ?? false }, keychain: async () => keychain,
    transport: options.transport ?? (async () => { throw new Error('Unexpected HTTP call') }), pi: options.pi }
  let handle = await kernel.plugin(connectionsPlugin, config)
  const service = () => kernel.service<Connections>(CONNECTIONS_SERVICE)!
  t.after(async () => { await kernel.dispose(); for (const key of keys.values()) key.fill(0); await rm(dir, { recursive: true, force: true }) })
  return { dir, kernel, service, config, async restart() { await handle.dispose(); handle = await kernel.plugin(connectionsPlugin, config) } }
}
function responseSse() {
  const frames = [
    { id: 'completion-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'completion-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
  return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

test('K3 trace: a tool prints a generated vault secret; next real pi-ai request and artifact contain zero matches', async t => {
  const secret = fakeKey()
  const requests: { body: string; auth: string | null }[] = []
  const f = await setup(t, { transport: async (_url, init) => {
    requests.push({ body: String(init?.body), auth: new Headers(init?.headers).get('authorization') })
    return responseSse()
  } })
  const s = f.service()
  const row = s.create(account, apiInput)
  await s.vault.unlock(account)
  const saved = s.saveSecret(account, row.id, secret)
  assert.match(saved.secretRef!, /^secret:\/\/test-owner\//)
  const toolOutput = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(process.env.TEST_CREDENTIAL);process.exitCode=1'], {
      env: { PATH: process.env.PATH, TEST_CREDENTIAL: secret }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''; child.stdout.on('data', data => { stdout += data })
    child.on('error', reject); child.on('exit', code => code === 1 ? resolve(stdout) : reject(new Error('Tool did not fail as expected')))
  })
  assert.equal(toolOutput, secret)
  const result = await s.complete(account, row.id, { messages: [{ role: 'toolResult', toolCallId: 'test-call', toolName: 'failing-test', content: [{ type: 'text', text: toolOutput }], isError: true, timestamp: Date.now() }] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run-trace', requestId: 'request-trace',
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.auth, `Bearer ${secret}`)
  assert.equal(requests[0]!.body.includes(secret), false)
  assert.match(requests[0]!.body, /REDACTED/)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(JSON.stringify(s.snapshot(account)).includes(secret), false)
  assert.equal(s.snapshot(account).costs.length, 1)
  const destination = join(f.dir, 'handoff.json')
  const digest = await s.writeArtifact(account, destination, { toolOutput, ledger: s.snapshot(account).costs })
  const bytes = await readFile(destination)
  assert.equal(bytes.toString().includes(secret), false)
  assert.match(bytes.toString(), /REDACTED/)
  assert.equal(digest.sha256, createHash('sha256').update(bytes).digest('hex'))
  await assert.rejects(s.writeArtifact(account, destination, {}), /EEXIST/)
})

test('all connection kinds persist; unattended is explicitly false by default after reload', async t => {
  const f = await setup(t)
  for (const input of [apiInput,
    { name: 'Subscription', kind: 'agent', provider: 'claude-code', auth: 'cli_login' },
    { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' },
    { name: 'Search', kind: 'service', provider: 'brave', auth: 'api_key' },
    { name: 'Speech', kind: 'service', provider: 'openai-stt', auth: 'api_key' },
  ] as const) assert.equal(f.service().create(account, input).unattended, false)
  await f.restart()
  const snapshot = connectionSnapshotSchema.parse(f.service().snapshot(account))
  assert.equal(snapshot.connections.length, 5)
  assert.equal(snapshot.connections.filter(row => row.unattended).length, 0)
  assert.equal(snapshot.vault.unlocked, false)
  assert.throws(() => f.service().setUnattended(account, snapshot.connections[0]!.id, true), /not enabled/)
})

test('vault ciphertext, wrapping, account isolation, rotation and restart registration', async t => {
  const f = await setup(t)
  const s = f.service(); const secret = fakeKey(); const rotated = fakeKey()
  const row = s.create(account, apiInput)
  assert.throws(() => s.saveSecret(account, row.id, secret), /locked/)
  await s.vault.unlock(account)
  const first = s.saveSecret(account, row.id, secret)
  const second = s.saveSecret(account, row.id, rotated)
  assert.notEqual(first.secretRef, second.secretRef)
  const stored = JSON.stringify(s.store.db.prepare('SELECT * FROM vault_secrets').all())
  assert.equal(stored.includes(secret), false)
  assert.equal(stored.includes(rotated), false)
  assert.equal(stored.includes('ciphertext'), true)
  assert.ok(s.store.db.prepare('SELECT wrapped FROM vault_keys').get())
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!.scrub(`${secret} ${rotated}`), '[REDACTED] [REDACTED]')
  s.vault.lock(account)
  await assert.rejects(s.vault.inject(second, false, async () => null), /locked/)
  assert.throws(() => s.store.get('other-owner', row.id), /not found/)
  await assert.rejects(s.vault.inject({ ...second, accountId: 'other-owner' }, true, async () => null), /unavailable/)
  await f.restart()
  assert.throws(() => f.service().vault.assertScrubbingReady(account), /Unlock/)
  await f.service().vault.unlock(account)
  await f.service().vault.inject(second, false, async value => assert.equal(value, rotated))
  // Retired credentials remain registered for old tool outputs and traces.
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!.scrub(secret), '[REDACTED]')
})

test('vault rejects authenticated ciphertext moved to another ref or account', async t => {
  const f = await setup(t); const s = f.service()
  const row = s.create(account, apiInput); await s.vault.unlock(account)
  s.saveSecret(account, row.id, fakeKey())
  s.vault.lock(account)
  s.store.db.prepare('UPDATE vault_secrets SET ref=?').run('secret://test-owner/11111111-1111-4111-8111-111111111111')
  await assert.rejects(s.vault.unlock(account), /could not be unlocked/)
  assert.equal(s.vault.unlocked(account), false)
})

test('unattended needs both per-connection consent and owner-device node-key opt-in', async t => {
  const f = await setup(t, { unattended: true }); const s = f.service()
  const row = s.create(account, apiInput); await s.vault.unlock(account)
  const saved = s.saveSecret(account, row.id, fakeKey())
  await assert.rejects(s.vault.inject(saved, true, async () => null), /disabled/)
  const enabled = s.setUnattended(account, row.id, true)
  s.vault.lock(account)
  await s.vault.inject(enabled, true, async key => assert.ok(key.length > 32))
  assert.equal(s.vault.unlocked(account), false)
  const cloud = await setup(t, { unattended: true, ownerDevice: false })
  assert.equal(cloud.service().vault.unattendedAvailable, false)
  assert.throws(() => cloud.service().setUnattended(account, enabled.id, true), /not enabled/)
})

test('Anthropic OAuth cannot be enabled through schema, key aliasing, config flags or environment', async t => {
  for (const auth of ['oauth', 'anthropic_oauth', 'cli_login']) {
    assert.equal(createConnectionSchema.safeParse({ ...apiInput, provider: 'anthropic', auth }).success, false)
  }
  assert.equal(createConnectionSchema.safeParse({ ...apiInput, enableAnthropicOAuth: true }).success, false)
  assert.equal(createConnectionSchema.safeParse({ ...apiInput, provider: 'google', auth: 'oauth' }).success, false)
  const f = await setup(t); const s = f.service()
  const row = s.create(account, { ...apiInput, provider: 'anthropic' }); await s.vault.unlock(account)
  const forbidden = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  assert.throws(() => s.saveSecret(account, row.id, forbidden), /API key is required/)
  assert.equal(s.store.get(account, row.id).secretRef, null)
  assert.throws(() => assertApiKey('anthropic', forbidden), /API key/)
  const secret = `sk-ant-api03-${randomBytes(24).toString('hex')}`
  s.saveSecret(account, row.id, secret)
  assert.equal(s.snapshot(account).connections[0]!.auth, 'api_key')
  assert.equal(Object.keys(s).some(key => /oauth|login/i.test(key)), false)
  const source = await readFile(new URL('../../src/connections/pi.ts', import.meta.url), 'utf8')
  assert.equal(/from ['"][^'"]*\/(?:oauth|providers\/anthropic)['"]/.test(source), false)
})

for (const provider of BALANCE_PROBES) {
  test(`${provider}: recorded-fixture contract through HTTP boundary, JIT auth and persisted provenance`, async t => {
    const fixture = provider === 'openrouter' ? openrouterFixture : deepseekFixture
    const secret = fakeKey(); let calls = 0
    const f = await setup(t, { transport: async (url, init) => {
      calls++; assert.equal(String(url), probeEndpoints[provider])
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
      assert.equal(init?.redirect, 'error')
      return Response.json(fixture.response)
    } })
    const s = f.service(); const row = s.create(account, { ...apiInput, provider })
    await s.vault.unlock(account); s.saveSecret(account, row.id, secret)
    const balance = await s.probe(account, row.id)
    assert.equal(calls, 1)
    assert.equal(balance.amount, provider === 'openrouter' ? 74.5 : 110)
    assert.equal(balance.currency, provider === 'openrouter' ? 'USD' : 'CNY')
    assert.equal(balance.source, probeEndpoints[provider]); assert.ok(Date.parse(balance.observedAt!))
    assert.deepEqual(s.snapshot(account).connections[0]!.balance, balance)
    assert.throws(() => parseBalance(provider, { data: { limit_remaining: 'not-a-number' } }, fixture.recordedAt))
    assert.throws(() => parseBalance(provider, fixture.response, ''))
  })
}

test('unlimited and unavailable balance observations stay unknown; malformed probes never overwrite prior evidence', async t => {
  assert.equal(parseBalance('openrouter', { data: { limit_remaining: null } }, openrouterFixture.recordedAt).amount, null)
  assert.equal(parseBalance('deepseek', { is_available: false, balance_infos: [] }, deepseekFixture.recordedAt).confidence, 'unknown')
  const secret = fakeKey()
  const f = await setup(t, { transport: async () => { throw new Error(secret) } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.vault.unlock(account); s.saveSecret(account, row.id, secret)
  const prior = parseBalance('deepseek', deepseekFixture.response, deepseekFixture.recordedAt)
  s.store.observe(account, row.id, {}, prior)
  await assert.rejects(s.probe(account, row.id), error => !String(error).includes(secret))
  assert.deepEqual(s.store.get(account, row.id).balance, prior)
})

test('cost ledger is append-only, idempotent per connection receipt and isolated per account after restart', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput)
  const receipt = { accountId: account, connectionId: row.id, runId: 'run', requestId: 'receipt', inputTokens: 100, outputTokens: 10,
    costUsd: 0.001, source: 'fixture', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'medium' as const }
  const first = s.store.record(receipt)
  assert.deepEqual(s.store.record(receipt), first)
  assert.equal(s.store.costs(account).length, 1)
  assert.throws(() => s.store.record({ ...receipt, costUsd: 0.1 }), /Conflicting/)
  assert.equal(s.store.costs(account).length, 1)
  assert.equal(s.store.costs('other-owner').length, 0)
  await f.restart()
  assert.deepEqual(f.service().store.costs(account), [first])
})

test('local runtime uses K1 adapter and governor; fixture response is scrubbed and cost remains unknown', async t => {
  let calls = 0
  const f = await setup(t, { transport: async (url, init) => {
    calls++; assert.equal(new URL(String(url)).hostname, '127.0.0.1')
    if (new URL(String(url)).pathname === '/api/version') return Response.json({ version: 'fixture' })
    assert.equal(JSON.parse(String(init?.body)).messages[0].content, '[REDACTED]')
    return Response.json({ model: 'fixture', created_at: new Date().toISOString(), done: true,
      message: { role: 'assistant', content: 'ok' }, prompt_eval_count: 5, eval_count: 1 })
  } })
  const s = f.service(); const row = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  const secret = fakeKey(); await s.vault.unlock(account); s.vault.put(account, secret)
  const request = { model: 'fixture', messages: [{ role: 'user' as const, content: secret }], options: { num_ctx: 1024 } }
  const result = await s.localChat(account, row.id, request, { runId: 'run', requestId: 'local-request' })
  assert.equal(result.done, true); assert.equal(calls, 2)
  assert.equal(s.store.costs(account)[0]!.costUsd, null)
  await assert.rejects(s.localChat(account, row.id, { ...request, options: {} }, { runId: 'run', requestId: 'invalid' }), /context/)
})

test('provider error messages never leak credentials; unload aborts in-flight requests and stale service calls', async t => {
  const secret = fakeKey(); let started!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const f = await setup(t, { transport: async (_url, init) => {
    started()
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(secret)), { once: true }))
    return responseSse()
  } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.vault.unlock(account); s.saveSecret(account, row.id, secret)
  const result = s.complete(account, row.id, { messages: [] }, { model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'cancel' })
  const rejected = assert.rejects(result, error => !String(error).includes(secret) && /cancelled/.test(String(error)))
  await pending
  await f.restart(); await rejected
  assert.throws(() => s.snapshot(account), /unloaded/)
  assert.equal(f.service().snapshot(account).costs.length, 0)
})

test('HTTP API exposes references only, validates routes and blocks cross-origin mutations', async t => {
  const f = await setup(t); const routes = connectionRoutes(f.service(), account)
  const send = (path: string, body: unknown, method = 'POST', headers = {}) => routes.request(`http://localhost${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  let response = await send('/', apiInput)
  assert.equal(response.status, 201)
  const row = await response.json() as { id: string; unattended: boolean }
  assert.equal(row.unattended, false)
  assert.equal((await send('/vault/unlock', {})).status, 200)
  const secret = fakeKey()
  response = await send(`/${row.id}/secret`, { value: secret }, 'PUT')
  assert.equal(response.status, 200); assert.equal((await response.text()).includes(secret), false)
  assert.equal((await send('/', apiInput, 'POST', { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await send('/', { ...apiInput, auth: 'oauth' })).status, 400)
  const snapshot = await (await routes.request('http://localhost/')).text()
  assert.equal(snapshot.includes(secret), false); assert.match(snapshot, /secret:\/\//)
})

test('models.dev evidence retains its own source, observation time and confidence', () => {
  const facts = modelsDevFacts('deepseek', 'deepseek-v4-flash')
  assert.equal(facts['models.dev.context']!.value, 1048576)
  assert.match(facts['models.dev.context']!.source, /f51a64b/)
  assert.ok(facts['models.dev.context']!.observedAt)
  assert.equal(facts['models.dev.context']!.confidence, 'medium')
  assert.deepEqual(modelsDevFacts('unknown', 'unknown'), {})
})

test('the pre-K2 production stub refuses all egress instead of claiming protection', async () => {
  const kernel = createKernel()
  await kernel.plugin(temporaryEgressPlugin)
  const scrubber = kernel.service<EgressScrubber>(EGRESS_SERVICE)!
  assert.throws(() => scrubber.scrub({ content: 'any content' }), /not available/)
  await kernel.dispose()
})

test('mislabeled Anthropic OAuth tokens are refused for every provider before pi-ai can choose bearer auth', async t => {
  let calls = 0
  const f = await setup(t, { transport: async () => { calls++; return responseSse() } })
  const s = f.service(); await s.vault.unlock(account)
  const forbidden = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  for (const provider of ['openrouter', 'deepseek', 'google', 'anthropic'] as const) {
    const row = s.create(account, { ...apiInput, provider })
    assert.throws(() => s.saveSecret(account, row.id, forbidden), /API key/)
    // Defence in depth if a record was imported or mislabeled outside the UI.
    s.store.setSecret(account, row.id, s.vault.put(account, forbidden))
    const model = piModels(provider).find(item => item.api === 'anthropic-messages') ?? piModels(provider)[0]!
    await assert.rejects(s.complete(account, row.id, { messages: [] }, { model: model.id, runId: 'run', requestId: `oauth-${provider}` }), /Model request failed/)
  }
  assert.equal(calls, 0)
})

test('Anthropic API dispatch uses only the vault key even when OAuth environment variables exist', async t => {
  const variables = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const
  const previous = variables.map(name => process.env[name])
  const fakeEnv = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  for (const name of variables) process.env[name] = fakeEnv
  t.after(() => variables.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i] }))
  const secret = `sk-ant-api03-${randomBytes(24).toString('hex')}`
  let calls = 0
  const f = await setup(t, { transport: async (_url, init) => {
    calls++
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-api-key'), secret)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('anthropic-beta')?.includes('oauth-'), false)
    assert.equal(String(init?.body).includes(fakeEnv), false)
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'fixture-message', role: 'assistant', type: 'message', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ]
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const s = f.service(); const row = s.create(account, { ...apiInput, provider: 'anthropic' })
  await s.vault.unlock(account); s.saveSecret(account, row.id, secret)
  const result = await s.complete(account, row.id, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, { model: piModels('anthropic')[0]!.id, runId: 'run', requestId: 'api-key-only' })
  assert.equal(calls, 1); assert.equal(result.stopReason, 'stop')
})

test('Google dispatch serializes a scrubbed body and uses its explicit vault key through the SDK transport', async t => {
  const originalFetch = globalThis.fetch
  const secret = fakeKey(); let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    const request = new Request(input, init)
    assert.equal(new URL(request.url).hostname, 'generativelanguage.googleapis.com')
    assert.equal(request.headers.get('x-goog-api-key'), secret)
    assert.equal(request.signal.aborted, false)
    const body = await request.text()
    assert.equal(body.includes(secret), false); assert.match(body, /REDACTED/)
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const f = await setup(t)
    const s = f.service(); const row = s.create(account, { ...apiInput, provider: 'google' })
    await s.vault.unlock(account); s.saveSecret(account, row.id, secret)
    const result = await s.complete(account, row.id, { messages: [{ role: 'user', content: secret, timestamp: Date.now() }] }, { model: piModels('google')[0]!.id, runId: 'run', requestId: 'google-fixture' })
    assert.equal(result.stopReason, 'stop'); assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})

test('late vault unlock cannot override an explicit lock or outlive plugin unload', async t => {
  const f = await setup(t)
  const keychain = f.config.keychain
  let release!: () => void
  let entered!: () => void
  const enteredKeychain = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  f.config.keychain = async () => { entered(); await held; return keychain() }
  await f.restart()
  const s = f.service()
  const unlocking = s.unlockVault(account)
  await enteredKeychain
  s.lockVault(account)
  release()
  await assert.rejects(unlocking, /could not be unlocked/)
  assert.equal(s.vault.unlocked(account), false)
  const oldVault = s.vault
  await f.restart()
  await assert.rejects(oldVault.unlock(account), /closed/)
})

test('in-flight balance probes are cancelled before the plugin database closes', async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const f = await setup(t, { transport: async (_url, init) => {
    entered()
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    return Response.json(deepseekFixture.response)
  } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.vault.unlock(account); s.saveSecret(account, row.id, fakeKey())
  const probe = s.probe(account, row.id)
  const rejection = assert.rejects(probe, /Balance probe failed/)
  await started; await f.restart(); await rejection
  assert.equal(f.service().snapshot(account).connections[0]!.balance, null)
})

test('configured Vite origins can mutate; mismatched origins and non-JSON requests cannot', async t => {
  const f = await setup(t)
  const routes = new Hono().route('/api/connections', connectionRoutes(f.service(), account, ['http://127.0.0.1:5187']))
  const request = (origin: string, type = 'application/json') => routes.request('http://127.0.0.1:4387/api/connections', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': type }, body: JSON.stringify(apiInput),
  })
  assert.equal((await request('http://127.0.0.1:5187')).status, 201)
  assert.equal((await request('https://127.0.0.1:4387')).status, 403)
  assert.equal((await request('http://127.0.0.1:4387', 'text/plain')).status, 415)
})

test('unload cancels a pending keychain unlock and late completion cannot revive the old vault', async t => {
  const f = await setup(t)
  const keychain = f.config.keychain
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  f.config.keychain = async () => { entered(); await held; return keychain() }
  await f.restart()
  const old = f.service()
  const unlocking = old.unlockVault(account)
  const rejected = assert.rejects(unlocking, /closed/)
  await started
  await f.restart()
  await rejected
  release()
  await Promise.resolve()
  assert.equal(old.vault.unlocked(account), false)
  assert.equal(f.service().vault.unlocked(account), false)
})

test('Google SDK transport observes cancellation and records no completed usage after abort', async t => {
  const originalFetch = globalThis.fetch
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let seenSignal: AbortSignal | undefined
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seenSignal = request.signal
    entered()
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  }
  try {
    const f = await setup(t)
    const s = f.service(); const row = s.create(account, { ...apiInput, provider: 'google' })
    await s.vault.unlock(account); s.saveSecret(account, row.id, fakeKey())
    const controller = new AbortController()
    const result = s.complete(account, row.id, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, { model: piModels('google')[0]!.id, runId: 'run', requestId: 'google-cancel', signal: controller.signal })
    const rejection = assert.rejects(result, /cancelled/)
    await started; controller.abort(); await rejection
    assert.equal(seenSignal?.aborted, true)
    assert.equal(s.store.costs(account).length, 0)
  } finally { globalThis.fetch = originalFetch }
})
