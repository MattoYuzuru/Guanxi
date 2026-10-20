import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createKernel } from '@guanxi/kernel'
import { Hono } from 'hono'
import { createConnectionSchema, connectionSnapshotSchema } from '@guanxi/contract'
import type { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { connectionsPlugin, CONNECTIONS_SERVICE, CONNECTIONS_EGRESS_READINESS, type ConnectionsEgressReadiness } from '../../src/connections/plugin.ts'
import { temporaryEgressPlugin, EGRESS_SERVICE, type EgressScrubber } from '../../src/connections/egress.ts'
import { fixtureEgressPlugin } from './egress-fixture.ts'
import { connectionRoutes } from '../../src/connections/routes.ts'
import { ConnectionError } from '../../src/connections/errors.ts'
import { Connections } from '../../src/connections/service.ts'
import { piModels, assertApiKey } from '../../src/connections/pi.ts'
import { BALANCE_PROBES, parseBalance, probeEndpoints, type BalanceProbe } from '../../src/probes/balances.ts'
import { modelsDevFacts } from '../../src/connections/metadata.ts'
import openrouterFixture from '../../src/probes/fixtures/openrouter.json' with { type: 'json' }
import deepseekFixture from '../../src/probes/fixtures/deepseek.json' with { type: 'json' }
import type { PiTransport } from '../../src/connections/pi.ts'
import { Vault } from '../../src/vault/vault.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'

const account = 'test-owner'
const apiInput = { name: 'Test model', kind: 'model_api' as const, provider: 'deepseek' as const, auth: 'api_key' as const }
const fakeKey = () => `test_${randomBytes(32).toString('hex')}`
async function setup(t: { after(fn: () => unknown): void }, options: { transport?: typeof fetch; pi?: PiTransport; unattended?: boolean; ownerDevice?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k3-'))
  const keys = new Map<string, Buffer>()
  const keychain: VaultKeychain = { key(accountId, create, purpose) {
    const id = JSON.stringify([purpose, accountId])
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
function responseSse(content = 'ok') {
  const frames = [
    { id: 'completion-test', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id: 'completion-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
  return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

test('K3 trace: a tool prints a generated vault secret; next real pi-ai request and artifact contain zero matches', async t => {
  const secret = fakeKey()
  const requests: { body: string; auth: string | null }[] = []
  const f = await setup(t, { transport: async (_url, init) => {
    requests.push({ body: String(init?.body), auth: new Headers(init?.headers).get('authorization') })
    assert.equal(init?.redirect, 'error', 'complete must reject credential-forwarding redirects')
    return responseSse(secret)
  } })
  const s = f.service()
  const row = s.create(account, apiInput)
  await s.unlockVault(account)
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
  assert.match(JSON.stringify(result.content), /REDACTED/)
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

async function setupVault(t: { after(fn: () => unknown): void }) {
  const f = await setup(t, { unattended: true })
  const store = f.service().store
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!
  const vault = new Vault(store, f.config.keychain, scrubber, f.config.policy)
  t.after(() => vault.close())
  return { ...f, store, vault, scrubber }
}

test('vault ciphertext, wrapping, account isolation, rotation and restart registration', async t => {
  const f = await setupVault(t); const { vault, store, scrubber } = f
  const secret = fakeKey(); const rotated = fakeKey(); const row = store.create(account, apiInput)
  assert.throws(() => vault.put(account, secret), /locked/)
  await vault.unlock(account)
  const first = vault.put(account, secret)
  const second = vault.put(account, rotated); store.setSecret(account, row.id, second)
  assert.notEqual(first, second)
  const stored = JSON.stringify(store.db.prepare('SELECT * FROM vault_secrets').all())
  assert.equal(stored.includes(secret), false); assert.equal(stored.includes(rotated), false)
  assert.equal(stored.includes('ciphertext'), true)
  assert.ok(store.db.prepare('SELECT wrapped FROM vault_keys').get())
  assert.equal(scrubber.scrub(`${secret} ${rotated}`), '[REDACTED] [REDACTED]')
  vault.lock(account)
  await assert.rejects(vault.inject(account, row.id, false, async () => null), /locked/)
  await assert.rejects(vault.inject('other-owner', row.id, true, async () => null), /not found/)
  await vault.unlock(account)
  await vault.inject(account, row.id, false, async value => assert.equal(value, rotated))
  assert.equal(scrubber.scrub(secret), '[REDACTED]')
})

test('vault rejects authenticated ciphertext moved to another ref or account', async t => {
  const { vault, store } = await setupVault(t)
  await vault.unlock(account); vault.put(account, fakeKey()); vault.lock(account)
  store.db.prepare('UPDATE vault_secrets SET ref=?').run('secret://test-owner/11111111-1111-4111-8111-111111111111')
  await assert.rejects(vault.unlock(account), /could not be unlocked/)
  assert.equal(vault.unlocked(account), false)
})

test('E1/E2: forged consent cannot inject; a node-only keychain decrypts only explicitly sealed unattended credentials', async t => {
  const { vault, store, config, scrubber, kernel } = await setupVault(t)
  assert.equal(kernel.service('connections.vault'), undefined)
  const row = store.create(account, apiInput); const bg = store.create(account, apiInput)
  await vault.unlock(account)
  const interactiveSecret = fakeKey(); const backgroundSecret = fakeKey()
  const saved = store.setSecret(account, row.id, vault.put(account, interactiveSecret))
  store.setSecret(account, bg.id, vault.put(account, backgroundSecret))
  const forged = { ...saved, unattended: true }
  assert.equal(forged.unattended, true)
  await assert.rejects(vault.inject(forged.accountId, forged.id, true, async () => assert.fail('forged consent')), /disabled/)
  vault.prepareUnattended(account, bg.id, true); store.setUnattended(account, bg.id, true)
  vault.lock(account)
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM vault_node_secrets').get()!.n, 1)
  const underlying = await config.keychain(); const reads: string[] = []
  const collision = underlying.key(`node:${account}`, true, 'session')
  const nodeWrapping = underlying.key(account, false, 'node')
  assert.notDeepEqual(nodeWrapping, collision, 'node and session purposes have disjoint keychain namespaces')
  collision.fill(0); nodeWrapping.fill(0)
  const nodeOnly: VaultKeychain = { key(id, create, purpose) {
    reads.push(purpose)
    assert.equal(id, account)
    assert.equal(purpose, 'node', 'background may never request the session wrapping key')
    return underlying.key(id, create, purpose)
  } }
  const background = new Vault(store, async () => nodeOnly, scrubber, config.policy)
  t.after(() => background.close())
  scrubber.unregister(saved.secretRef as `secret://${string}`)
  await background.inject(account, bg.id, true, async value => assert.equal(value, backgroundSecret))
  assert.deepEqual(reads, ['node'])
  assert.equal(scrubber.scrub(interactiveSecret), interactiveSecret, 'background never decrypts/registers interactive-only secrets')
  assert.equal(background.unlocked(account), false)
  // Even a tampered stored flag cannot manufacture a node-encrypted credential.
  store.setUnattended(account, row.id, true)
  await assert.rejects(background.inject(account, row.id, true, async () => assert.fail('no node ciphertext')), /unavailable/)
  vault.prepareUnattended(account, bg.id, false); store.setUnattended(account, bg.id, false)
  await assert.rejects(background.inject(account, bg.id, true, async () => assert.fail('revoked')), /disabled/)
  const cloud = await setup(t, { unattended: true, ownerDevice: false })
  assert.equal(cloud.service().snapshot(account).vault.unattendedAvailable, false)
  assert.throws(() => cloud.service().setUnattended(account, bg.id, true), /not enabled/)
})

test('Anthropic OAuth cannot be enabled through schema, key aliasing, config flags or environment', async t => {
  for (const auth of ['oauth', 'anthropic_oauth', 'cli_login']) {
    assert.equal(createConnectionSchema.safeParse({ ...apiInput, provider: 'anthropic', auth }).success, false)
  }
  assert.equal(createConnectionSchema.safeParse({ ...apiInput, enableAnthropicOAuth: true }).success, false)
  assert.equal(createConnectionSchema.safeParse({ ...apiInput, provider: 'google', auth: 'oauth' }).success, false)
  const f = await setup(t); const s = f.service()
  const row = s.create(account, { ...apiInput, provider: 'anthropic' }); await s.unlockVault(account)
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

const probeFixtures: Record<BalanceProbe, { fixture: { response: unknown; recordedAt: string }; amount: number; currency: 'USD' | 'CNY' }> = {
  openrouter: { fixture: openrouterFixture, amount: 74.5, currency: 'USD' },
  deepseek: { fixture: deepseekFixture, amount: 110, currency: 'CNY' },
}
test('the probe fixture registry covers exactly every published probe', () => {
  assert.deepEqual(Object.keys(probeFixtures).sort(), [...BALANCE_PROBES].sort())
  assert.throws(() => parseBalance('new-probe' as BalanceProbe, deepseekFixture.response, deepseekFixture.recordedAt), /Unsupported balance probe/)
})
for (const provider of BALANCE_PROBES) {
  test(`${provider}: recorded-fixture contract through HTTP boundary, JIT auth and persisted provenance`, async t => {
    const { fixture, amount, currency } = probeFixtures[provider]
    const secret = fakeKey(); let calls = 0
    const f = await setup(t, { transport: async (url, init) => {
      calls++; assert.equal(String(url), probeEndpoints[provider])
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`)
      assert.equal(init?.redirect, 'error')
      return Response.json(fixture.response)
    } })
    const s = f.service(); const row = s.create(account, { ...apiInput, provider })
    await s.unlockVault(account); s.saveSecret(account, row.id, secret)
    const balance = await s.probe(account, row.id)
    assert.equal(calls, 1)
    assert.equal(balance.amount, amount)
    assert.equal(balance.currency, currency)
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
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
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
  f.config.localHost = () => '127.0.0.1:11434'
  await f.restart()
  const s = f.service(); const row = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  const secret = fakeKey(); await s.unlockVault(account); s.saveSecret(account, s.create(account, apiInput).id, secret)
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
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
  const result = s.complete(account, row.id, { messages: [] }, { model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'cancel' })
  const rejected = assert.rejects(result, error => !String(error).includes(secret) && /cancelled/.test(String(error)))
  await pending
  await f.restart(); await rejected
  assert.throws(() => s.snapshot(account), /unloaded/)
  assert.equal(f.service().snapshot(account).costs.length, 0)
})

test('HTTP API exposes references only, validates routes and blocks cross-origin mutations', async t => {
  const f = await setup(t); const routes = connectionRoutes(f.service, account)
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
  const s = f.service(); await s.unlockVault(account)
  const forbidden = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  for (const provider of ['openrouter', 'deepseek', 'google', 'anthropic'] as const) {
    const row = s.create(account, { ...apiInput, provider })
    assert.throws(() => s.saveSecret(account, row.id, forbidden), /API key/)
    // Defence in depth if a record was imported or mislabeled outside the UI.
    const imported = new Vault(s.store, f.config.keychain, f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!, f.config.policy)
    t.after(() => imported.close())
    await imported.unlock(account)
    s.store.setSecret(account, row.id, imported.put(account, forbidden))
    const model = piModels(provider).find(item => item.api === 'anthropic-messages') ?? piModels(provider)[0]!
    await assert.rejects(s.complete(account, row.id, { messages: [] }, { model: model.id, runId: 'run', requestId: `oauth-${provider}` }), error => error instanceof ConnectionError && error.code === 'validation_failed')
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
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
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
    await s.unlockVault(account); s.saveSecret(account, row.id, secret)
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
  assert.equal(s.snapshot(account).vault.unlocked, false)
  await f.restart()
  assert.throws(() => s.lockVault(account), /unloaded/)
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
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  const probe = s.probe(account, row.id)
  const rejection = assert.rejects(probe, /Balance probe failed/)
  await started; await f.restart(); await rejection
  assert.equal(f.service().snapshot(account).connections[0]!.balance, null)
})

test('configured Vite origins can mutate; mismatched origins and non-JSON requests cannot', async t => {
  const f = await setup(t)
  const routes = new Hono().route('/api/connections', connectionRoutes(f.service, account, ['http://127.0.0.1:5187']))
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
  assert.throws(() => old.unlockVault(account), /unloaded/)
  assert.equal(Object.hasOwn(old, 'vault'), false)
  assert.equal(f.service().snapshot(account).vault.unlocked, false)
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
    await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
    const controller = new AbortController()
    const result = s.complete(account, row.id, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, { model: piModels('google')[0]!.id, runId: 'run', requestId: 'google-cancel', signal: controller.signal })
    const rejection = assert.rejects(result, /cancelled/)
    await started; controller.abort(); await rejection
    assert.equal(seenSignal?.aborted, true)
    assert.equal(s.store.costs(account).length, 0)
  } finally { globalThis.fetch = originalFetch }
})


test('H3: apply registers every historical secret after restart without granting injection permission', async t => {
  const f = await setup(t); const s = f.service(); const secret = fakeKey(); const retired = fakeKey()
  const row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, retired); s.saveSecret(account, row.id, secret)
  await f.restart()
  const ready = f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!
  assert.equal(ready.ready, true); ready.assertReady()
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!
  assert.equal(scrubber.scrub(`${secret} ${retired}`).includes(secret), false)
  assert.equal(scrubber.scrub(`${secret} ${retired}`).includes(retired), false)
  assert.equal(f.service().snapshot(account).vault.unlocked, false)
  await assert.rejects(f.service().complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'still-locked',
  }), /locked/)
  f.config.keychain = async () => { throw new Error('Fixture keychain locked') }
  await f.restart()
  const failed = f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!
  assert.equal(failed.ready, false)
  assert.throws(() => failed.assertReady(), /registration incomplete/)
})


test('M2: localChat and writeArtifact fail before dispatch/write when registration is incomplete', async t => {
  let calls = 0
  const f = await setup(t, { transport: async () => { calls++; throw new Error('Unexpected dispatch') } })
  const s = f.service(); await s.unlockVault(account)
  const model = s.create(account, apiInput); s.saveSecret(account, model.id, fakeKey())
  const local = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  f.config.keychain = async () => { throw new Error('Fixture keychain locked') }
  await f.restart()
  const request = { model: 'fixture', messages: [], options: { num_ctx: 1024 } }
  await assert.rejects(f.service().localChat(account, local.id, request, { runId: 'run', requestId: 'not-ready' }), /registration incomplete/)
  const destination = join(f.dir, 'blocked.json')
  await assert.rejects(f.service().writeArtifact(account, destination, {}), /registration incomplete/)
  await assert.rejects(readFile(destination), /ENOENT/)
  assert.equal(calls, 0)
})

test('M2: production plugin defaults deny unattended localChat before runtime dispatch', async t => {
  let calls = 0
  const f = await setup(t, { transport: async () => { calls++; throw new Error('Unexpected dispatch') } })
  Reflect.deleteProperty(f.config, 'policy')
  await f.restart()
  const s = f.service()
  assert.equal(s.snapshot(account).vault.unattendedAvailable, false)
  const row = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  assert.throws(() => s.setUnattended(account, row.id, true), /not enabled/)
  await assert.rejects(s.localChat(account, row.id, { model: 'fixture', messages: [], options: { num_ctx: 1024 } }, {
    runId: 'run', requestId: 'no-consent', background: true,
  }), /Unattended access disabled/)
  // Isolate the per-connection guard from the default policy guard.
  const optedIn = await setup(t, { unattended: true, transport: async () => { calls++; throw new Error('Unexpected dispatch') } })
  const local = optedIn.service().create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  await assert.rejects(optedIn.service().localChat(account, local.id, { model: 'fixture', messages: [], options: { num_ctx: 1024 } }, {
    runId: 'run', requestId: 'no-row-consent', background: true,
  }), /Unattended access disabled/)
  assert.equal(calls, 0)
})


test('E5: mounted routes resolve the current service after reload without losing stored connections', async t => {
  const f = await setup(t)
  const routes = connectionRoutes(f.service, account)
  const create = () => routes.request('http://localhost/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(apiInput) })
  assert.equal((await create()).status, 201)
  await f.restart()
  const response = await routes.request('http://localhost/')
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { connections: unknown[] }).connections.length, 1)
  assert.equal((await create()).status, 201)
  assert.equal(f.service().snapshot(account).connections.length, 2)
})


test('M6: HTTP recovery codes distinguish missing, locked, policy, egress, provider and internal failures without error contents', async t => {
  const secret = fakeKey()
  const f = await setup(t, { transport: async () => { throw new Error(secret) } })
  const s = f.service(); const row = s.create(account, apiInput)
  const routes = connectionRoutes(f.service, account)
  const send = (path: string, body: unknown = {}, method = 'POST') => routes.request(`http://localhost${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const check = async (response: Response, status: number, code: string) => {
    assert.equal(response.status, status)
    assert.deepEqual(await response.json(), { code })
  }
  await check(await send('/missing/secret', { value: secret }, 'PUT'), 404, 'connection_not_found')
  await check(await send(`/${row.id}/secret`, { value: secret }, 'PUT'), 423, 'vault_locked')
  await check(await send(`/${row.id}`, { unattended: true }, 'PATCH'), 403, 'policy_denied')
  await check(await send('/', { invalid: secret }), 400, 'validation_failed')
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
  await check(await send(`/${row.id}/probe`), 502, 'provider_failed')
  for (const [error, status, code] of [
    [new ConnectionError('egress_unavailable', secret), 503, 'egress_unavailable'],
    [new Error(secret), 500, 'internal_error'],
  ] as const) {
    const unavailable = connectionRoutes(() => { throw error }, account)
    await check(await unavailable.request('http://localhost/'), status, code)
  }
})


test('E6: short keys cannot enter the vault or corrupt scrubbed rows; probes validate imported keys before HTTP', async t => {
  let calls = 0
  const f = await setup(t, { transport: async () => { calls++; return Response.json(deepseekFixture.response) } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account)
  for (const short of ['x', 'x'.repeat(7)]) assert.throws(() => s.saveSecret(account, row.id, short), /API key/)
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM vault_secrets').get()!.n, 0)
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!.scrub('hello'), 'hello')
  assert.equal(s.store.get(account, row.id).secretRef, null)
  const imported = new Vault(s.store, f.config.keychain, f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!, f.config.policy)
  t.after(() => imported.close()); await imported.unlock(account)
  const oauth = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  s.store.setSecret(account, row.id, imported.put(account, oauth))
  await assert.rejects(s.probe(account, row.id), error => error instanceof ConnectionError && error.code === 'validation_failed')
  assert.equal(calls, 0)
})


test('pi-ai facts carry the actual catalog observation time', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput)
  const before = Date.now(); const models = s.models(account, row.id); const after = Date.now()
  assert.ok(models.length > 0)
  for (const model of models) for (const [key, fact] of Object.entries(model.facts)) {
    if (!key.startsWith('pi-ai.')) continue
    assert.ok(Date.parse(fact.observedAt!) >= before && Date.parse(fact.observedAt!) <= after)
    assert.equal(fact.source, '@earendil-works/pi-ai@1.3.0'); assert.equal(fact.confidence, 'medium')
  }
})


test('vault database and pre-existing WAL/SHM sidecars are private after reopen', async t => {
  const f = await setup(t)
  const files = ['', '-wal', '-shm'].map(suffix => f.config.databasePath + suffix)
  for (const file of files) await chmod(file, 0o644)
  const reopened = new ConnectionStore(f.config.databasePath, f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!)
  try { for (const file of files) assert.equal((await stat(file)).mode & 0o777, 0o600) }
  finally { reopened.close() }
})


test('Google SDK mode environment overrides cannot switch an API-key connection to Vertex/Enterprise', async t => {
  const previousFetch = globalThis.fetch; let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected HTTP call') }
  t.after(() => { globalThis.fetch = previousFetch })
  const f = await setup(t); const s = f.service()
  const row = s.create(account, { ...apiInput, provider: 'google' })
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  for (const name of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE']) {
    const previous = process.env[name]; process.env[name] = 'true'
    try {
      await assert.rejects(s.complete(account, row.id, { messages: [] }, {
        model: piModels('google')[0]!.id, runId: 'run', requestId: name,
      }), error => error instanceof ConnectionError && error.code === 'policy_denied')
      assert.equal(process.env[name], 'true', 'dispatch must not mutate global environment state')
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous }
  }
  assert.equal(calls, 0); assert.equal(s.store.costs(account).length, 0)
})


test('review: unavailable session keychain yields vault_locked on the actual unlock route', async t => {
  const f = await setup(t)
  f.config.keychain = async () => { throw new Error(fakeKey()) }
  await f.restart()
  const response = await connectionRoutes(f.service, account).request('http://localhost/vault/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  assert.equal(response.status, 423)
  assert.deepEqual(await response.json(), { code: 'vault_locked' })
  assert.equal(f.service().snapshot(account).vault.unlocked, false)
})


test('review: queued localChat rechecks revoked unattended consent before dispatch and releases its lease', async t => {
  let calls = 0
  const f = await setup(t, { unattended: true, transport: async () => { calls++; throw new Error('Unexpected dispatch') } })
  const s = f.service(); const local = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  await s.unlockVault(account); s.setUnattended(account, local.id, true)
  const governor = f.kernel.service<ResourceGovernor>('governor')!
  const admission = (requestId: string) => governor.enqueue({ owner: { kind: 'operation', operationId: requestId },
    operation: 'chat', model: { provider: 'ollama', name: 'fixture' }, requestedContext: 1024, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const blocker = await governor.acquire(admission('blocker'))
  const queued = s.localChat(account, local.id, { model: 'fixture', messages: [], options: { num_ctx: 1024 } }, {
    background: true, runId: 'run', requestId: 'queued-revocation',
  })
  const rejection = assert.rejects(queued, error => error instanceof ConnectionError && error.code === 'policy_denied')
  s.setUnattended(account, local.id, false)
  blocker.release(); await rejection
  assert.equal(calls, 0)
  const next = await governor.acquire(admission('after-revocation'), { signal: AbortSignal.timeout(1000) })
  next.release()
})


test('review: pending node-key injection rejects revocation and rotation after await; keychain errors remain vault_locked', async t => {
  const { vault, store, config, scrubber } = await setupVault(t)
  const row = store.create(account, apiInput); await vault.unlock(account)
  store.setSecret(account, row.id, vault.put(account, fakeKey()))
  vault.prepareUnattended(account, row.id, true); store.setUnattended(account, row.id, true)
  let used = 0
  for (const change of ['revoke', 'rotate']) {
    let release!: () => void; let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const pending = new Vault(store, async () => { entered(); await held; return config.keychain() }, scrubber, config.policy)
    const injection = pending.inject(account, row.id, true, async () => { used++ })
    const rejected = assert.rejects(injection, error => error instanceof ConnectionError && error.code === 'policy_denied')
    await started
    if (change === 'revoke') {
      vault.prepareUnattended(account, row.id, false); store.setUnattended(account, row.id, false)
    } else {
      const ref = vault.put(account, fakeKey()); store.setSecret(account, row.id, ref)
      vault.prepareUnattended(account, row.id, true)
    }
    release(); await rejected; pending.close()
    vault.prepareUnattended(account, row.id, true); store.setUnattended(account, row.id, true)
  }
  const unavailable = new Vault(store, async () => { throw new Error(fakeKey()) }, scrubber, config.policy)
  await assert.rejects(unavailable.inject(account, row.id, true, async () => { used++ }), error => error instanceof ConnectionError && error.code === 'vault_locked')
  unavailable.close(); assert.equal(used, 0)
})

test('review: migration 2 upgrades a version-1 vault without rewriting keys, ciphertext or connections', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput); const secret = fakeKey()
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
  const before = {
    keys: s.store.db.prepare('SELECT * FROM vault_keys').all(),
    secrets: s.store.db.prepare('SELECT * FROM vault_secrets').all(),
    connections: s.store.db.prepare('SELECT * FROM connections').all(),
  }
  // Build a real on-disk version-1 fixture; this is only the throwaway test database.
  s.store.db.exec('DROP TABLE vault_node_secrets; DROP TABLE vault_node_keys; DELETE FROM k3_migrations WHERE version=2;')
  await f.restart()
  const next = f.service()
  assert.deepEqual(next.store.db.prepare('SELECT version FROM k3_migrations ORDER BY version').all().map(row => row.version), [1, 2])
  assert.deepEqual(next.store.db.prepare('SELECT * FROM vault_keys').all(), before.keys)
  assert.deepEqual(next.store.db.prepare('SELECT * FROM vault_secrets').all(), before.secrets)
  assert.deepEqual(next.store.db.prepare('SELECT * FROM connections').all(), before.connections)
  assert.equal(f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!.ready, true)
  await next.unlockVault(account)
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SERVICE)!.scrub(secret), '[REDACTED]')
})

test('review: registry grants and rotates only the current unattended credential, then revokes it atomically', async t => {
  const sent: string[] = []
  const f = await setup(t, { unattended: true, transport: async (_url, init) => {
    sent.push(new Headers(init?.headers).get('authorization')!)
    return responseSse()
  } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account)
  const first = fakeKey(); const rotated = fakeKey()
  s.saveSecret(account, row.id, first); s.setUnattended(account, row.id, true); s.lockVault(account)
  const call = (requestId: string) => s.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run', requestId, background: true,
  })
  await call('first-node-grant')
  assert.equal(s.snapshot(account).vault.unlocked, false)
  await s.unlockVault(account); const saved = s.saveSecret(account, row.id, rotated); s.lockVault(account)
  const copies = s.store.db.prepare('SELECT ref FROM vault_node_secrets WHERE connection_id=?').all(row.id)
  assert.deepEqual(copies.map(row => row.ref), [saved.secretRef])
  await call('rotated-node-grant')
  s.store.db.exec("CREATE TRIGGER fail_consent BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'fixture transaction failure'); END")
  assert.throws(() => s.setUnattended(account, row.id, false), /fixture transaction failure/)
  assert.equal(s.store.get(account, row.id).unattended, true)
  assert.deepEqual(s.store.db.prepare('SELECT ref FROM vault_node_secrets WHERE connection_id=?').all(row.id).map(row => row.ref), [saved.secretRef])
  s.store.db.exec('DROP TRIGGER fail_consent')
  s.setUnattended(account, row.id, false)
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM vault_node_secrets').get()!.n, 0)
  await assert.rejects(call('revoked-node-grant'), error => error instanceof ConnectionError && error.code === 'policy_denied')
  assert.deepEqual(sent, [`Bearer ${first}`, `Bearer ${rotated}`])
})
