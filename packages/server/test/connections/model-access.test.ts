import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createKernel } from '@guanxi/kernel'
import { Hono } from 'hono'
import { connectionSchema, createConnectionSchema, connectionSnapshotSchema } from '@guanxi/contract'
import type { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { connectionsPlugin, CONNECTIONS_SERVICE, CONNECTIONS_EGRESS_READINESS, type ConnectionsEgressReadiness } from '../../src/connections/plugin.ts'
import { EGRESS_SCRUBBER_SERVICE, redactionMarker, type EgressScrubber, type SecretRef } from '../../src/egress/types.ts'
import { egressScrubberPlugin } from '../../src/egress/plugin.ts'
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
import { keychainService, type VaultKeychain } from '../../src/vault/keychain.ts'

const account = 'test-owner'
const apiInput = { name: 'Test model', kind: 'model_api' as const, provider: 'deepseek' as const, auth: 'api_key' as const }
const fakeKey = () => `test_${randomBytes(32).toString('hex')}`
async function setup(t: { after(fn: () => unknown): void }, options: { transport?: typeof fetch; pi?: PiTransport; unattended?: boolean; ownerDevice?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-k3-'))
  const keys = new Map<string, Buffer>()
  let keychainReads = 0, transportReads = 0
  const counts = { keychain: () => keychainReads, transport: () => transportReads,
    reset: () => { keychainReads = 0; transportReads = 0 } }
  const keychain: VaultKeychain = { key(accountId, create, purpose) {
    keychainReads++
    const id = JSON.stringify([purpose, accountId])
    if (!keys.has(id) && create) keys.set(id, randomBytes(32))
    if (!keys.has(id)) throw new Error('No wrapping key')
    return Buffer.from(keys.get(id)!)
  } }
  const transport: typeof fetch = async (input, init) => {
    transportReads++
    return (options.transport ?? (async () => { throw new Error('Unexpected HTTP call') }))(input, init)
  }
  const kernel = createKernel()
  await kernel.plugin(resourceGovernorPlugin)
  await kernel.plugin(ollamaAdapterPlugin, { fetch: transport })
  let egress = await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
  const config = { databasePath: join(dir, 'connections.sqlite'), localHost: () => 'http://127.0.0.1:11434',
    policy: { ownerDevice: options.ownerDevice ?? true, nodeKeyOptIn: options.unattended ?? false }, keychain: async () => keychain,
    transport, pi: options.pi }
  let handle = await kernel.plugin(connectionsPlugin, config)
  const service = () => kernel.service<Connections>(CONNECTIONS_SERVICE)!
  t.after(async () => { await kernel.dispose(); for (const key of keys.values()) key.fill(0); await rm(dir, { recursive: true, force: true }) })
  return { dir, kernel, service, config, counts, async restart(freshEgress = false) {
    await handle.dispose()
    if (freshEgress) { await egress.dispose(); egress = await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] }) }
    handle = await kernel.plugin(connectionsPlugin, config)
  } }
}
function responseSse(content = 'ok') {
  const frames = [
    { id: 'completion-test', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { id: 'completion-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]
  return new Response(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}

test('plugin apply ensures exactly one Ollama connection and leaves existing connections untouched', async t => {
  const f = await setup(t)
  const first = f.service().snapshot('local').connections
  assert.deepEqual(first.map(row => [row.name, row.kind, row.provider, row.auth]), [['Ollama', 'local_runtime', 'ollama', 'none']])
  const manual = f.service().create('local', { name: 'Manual', kind: 'model_api', provider: 'deepseek', auth: 'api_key' })
  const before = f.service().snapshot('local').connections
  await f.restart()
  const after = f.service().snapshot('local').connections
  assert.equal(after.filter(row => row.kind === 'local_runtime' && row.provider === 'ollama').length, 1)
  assert.deepEqual(after.find(row => row.name === 'Ollama'), before.find(row => row.name === 'Ollama'))
  assert.deepEqual(after.find(row => row.id === manual.id), before.find(row => row.id === manual.id))
})

test('an existing unattended executor runtime does not stand in for the local Ollama connection', async t => {
  const f = await setup(t, { unattended: true })
  const s = f.service()
  // An upgraded MS1 home: its relay connection exists, but no apply has created Ollama yet.
  s.store.db.exec('DELETE FROM connections')
  s.store.create('local', { name: 'ms1-executor', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  f.counts.reset()
  await f.restart()
  const first = f.service().snapshot('local').connections
  assert.deepEqual(first.map(row => [row.name, row.unattended]).sort(), [['Ollama', false], ['ms1-executor', true]])
  const auto = first.find(row => row.name === 'Ollama')!
  assert.equal(auto.facts.origin?.value, 'local_runtime_auto')
  await f.restart()
  const after = f.service().snapshot('local').connections
  assert.equal(after.filter(row => row.name === 'Ollama').length, 1)
  assert.equal(after.filter(row => row.kind === 'local_runtime' && row.provider === 'ollama' && row.name === 'Ollama').length, 1)
  assert.deepEqual(after.find(row => row.name === 'Ollama'), auto)
  assert.equal(f.counts.keychain(), 0, 'ensureLocalOllama never reads the keychain')
  assert.equal(f.counts.transport(), 0, 'ensureLocalOllama never calls Ollama or the network')
})

test('a removed auto Ollama row stays removed across restarts until the owner re-adds it', async t => {
  const f = await setup(t)
  const auto = f.service().snapshot('local').connections.find(row => row.name === 'Ollama')!
  assert.equal(auto.facts.origin?.value, 'local_runtime_auto')
  const removed = await connectionRoutes(f.service, 'local').request(`http://localhost/${auto.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(f.service().snapshot('local').connections, [])
  const marked = f.service().store.findAutoLocalOllama('local')
  assert.equal(marked?.removed, true)
  assert.equal(marked?.connection.id, auto.id)
  await f.restart()
  assert.deepEqual(f.service().snapshot('local').connections, [], 'the apply must not recreate a removed auto row')

  const created = await connectionRoutes(f.service, 'local').request('http://localhost/', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none' }) })
  assert.equal(created.status, 201)
  const readded = connectionSchema.parse(await created.json())
  assert.equal(readded.facts.origin?.value, undefined, 'the catalog create route makes an ordinary row')
  await f.restart()
  assert.deepEqual(f.service().snapshot('local').connections.map(row => row.id), [readded.id],
    'a restart reuses the owner re-added row instead of creating another')
})

test('the Ollama connection lists installed models and returns a typed error when the runtime is down', async t => {
  const calls: string[] = []
  const f = await setup(t, { transport: async (url) => {
    calls.push(String(url))
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [
      { name: 'fixture:latest', digest: 'sha256:fixture' }, { name: 'fixture:latest' },
    ] })
    throw new Error('Unexpected HTTP call')
  } })
  const local = f.service().snapshot('local').connections.find(row => row.name === 'Ollama')!
  const installed = await connectionRoutes(f.service, 'local').request(`http://localhost/${local.id}/models`)
  assert.equal(installed.status, 200)
  const body = await installed.json() as { id: string; facts: Record<string, { source: string }> }[]
  assert.deepEqual(body.map(model => model.id), ['fixture:latest'])
  assert.equal(body[0]!.facts['ollama.installed']!.source, 'ollama:/api/tags')
  assert.equal(calls.filter(url => url.endsWith('/api/tags')).length, 1)

  const down = await setup(t)
  const downLocal = down.service().snapshot('local').connections.find(row => row.name === 'Ollama')!
  const failed = await connectionRoutes(down.service, 'local').request(`http://localhost/${downLocal.id}/models`)
  assert.equal(failed.status, 502)
  assert.deepEqual(await failed.json(), { code: 'provider_failed' })
})

test('trusted single-attempt K3 call refuses an adapter second HTTP attempt before transport', async t => {
  let requests = 0, retries: number | undefined
  const f = await setup(t, { transport: async () => { requests++; return responseSse() },
    pi: { async complete(_model, _context, options) {
      retries = options.maxRetries
      await options.fetch!('https://fixture.invalid/first')
      await options.fetch!('https://fixture.invalid/fallback')
      throw new Error('unreachable_fixture')
    } } })
  const s = f.service(), row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  await assert.rejects(s.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'single', requestId: 'one', singleAttempt: true,
  }), error => error instanceof ConnectionError && error.code === 'provider_failed')
  assert.equal(retries, 0); assert.equal(requests, 1)
})

test('concurrent single-attempt calls have independent HTTP counters', async t => {
  let requests = 0, active = 0, maximumActive = 0
  const f = await setup(t, { transport: async () => { requests++; return responseSse() },
    pi: { async complete(model, _context, options) {
      active++; maximumActive = Math.max(maximumActive, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      await options.fetch!('https://fixture.invalid/one')
      active--
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'fixture' }], timestamp: Date.now(), stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    } } })
  const s = f.service(), row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  const results = await Promise.all([0, 1].map(i => s.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'concurrent', requestId: String(i), singleAttempt: true,
  })))
  assert.equal(results.length, 2); assert.equal(requests, 2); assert.equal(maximumActive, 2)
})

test('ordinary K3 calls retain their existing adapter transport behavior', async t => {
  let requests = 0, retries: number | undefined
  const f = await setup(t, { transport: async () => { requests++; return responseSse() },
    pi: { async complete(model, _context, options) {
      retries = options.maxRetries
      await options.fetch!('https://fixture.invalid/first')
      await options.fetch!('https://fixture.invalid/second')
      return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    } } })
  const s = f.service(), row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  await s.complete(account, row.id, { messages: [] }, { model: piModels('deepseek')[0]!.id, runId: 'ordinary', requestId: 'one' })
  assert.equal(requests, 2); assert.equal(retries, 0)
})

test('single-attempt K3 refuses a wire without an injected HTTP boundary before preparation', async t => {
  const f = await setup(t)
  const s = f.service(), row = s.create(account, { ...apiInput, provider: 'google' })
  let prepared = false
  await assert.rejects(s.complete(account, row.id, { messages: [] }, {
    model: piModels('google')[0]!.id, runId: 'unsupported', requestId: 'one', singleAttempt: true,
    onPrepared: () => { prepared = true },
  }), error => error instanceof ConnectionError && error.code === 'policy_denied')
  assert.equal(prepared, false)
})

test('real pinned pi-ai transport performs one K3-visible HTTP attempt on a retryable failure', async t => {
  let requests = 0
  const f = await setup(t, { transport: async () => {
    requests++
    return new Response(JSON.stringify({ error: { message: 'fixture_unavailable', type: 'server_error' } }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'retry-after-ms': '1' } })
  } })
  const s = f.service(), row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  await assert.rejects(s.complete(account, row.id, { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] }, {
    model: piModels('deepseek')[0]!.id, runId: 'real-pi-single', requestId: 'one', singleAttempt: true,
  }), error => error instanceof ConnectionError && error.code === 'provider_failed')
  assert.equal(requests, 1)
})

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
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
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
  assert.equal(scrubber.scrub(`${secret} ${rotated}`), `${redactionMarker(first as SecretRef)} ${redactionMarker(second as SecretRef)}`)
  vault.lock(account)
  await assert.rejects(vault.inject(account, row.id, false, async () => null), /locked/)
  await assert.rejects(vault.inject('other-owner', row.id, true, async () => null), /not found/)
  await vault.unlock(account)
  await vault.inject(account, row.id, false, async value => assert.equal(value, rotated))
  assert.equal(scrubber.scrub(secret).includes(secret), false)
  assert.match(scrubber.scrub(secret), /REDACTED secret:\/\//)
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
  const secret = fakeKey()
  let marker = ''
  const f = await setup(t, { transport: async (url, init) => {
    calls++; assert.equal(new URL(String(url)).hostname, '127.0.0.1')
    if (new URL(String(url)).pathname === '/api/version') return Response.json({ version: 'fixture' })
    assert.equal(JSON.parse(String(init?.body)).messages[0].content, marker)
    return Response.json({ model: 'fixture', created_at: new Date().toISOString(), done: true,
      message: { role: 'assistant', content: `runtime echoed ${secret}` }, prompt_eval_count: 5, eval_count: 1 })
  } })
  f.config.localHost = () => '127.0.0.1:11434'
  await f.restart()
  const s = f.service(); const row = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  await s.unlockVault(account)
  marker = redactionMarker(s.saveSecret(account, s.create(account, apiInput).id, secret).secretRef as SecretRef)
  const request = { model: 'fixture', messages: [{ role: 'user' as const, content: secret }], options: { num_ctx: 1024 } }
  const result = await s.localChat(account, row.id, request, { runId: 'run', requestId: 'local-request' })
  assert.equal(result.done, true); assert.equal(calls, 2)
  assert.equal(result.message?.content, `runtime echoed ${marker}`)
  assert.equal(JSON.stringify(result).includes(secret), false)
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
  const catalog = await routes.request(`http://localhost/${row.id}/models`)
  assert.equal(catalog.status, 200)
  const listed = await catalog.json() as { id: string; facts: Record<string, { source: string }> }[]
  assert.ok(listed.length > 0)
  assert.match(listed[0]!.facts['pi-ai.context']!.source, /pi-ai/u)
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

test('mislabeled Anthropic OAuth tokens are refused for every provider before pi-ai can choose bearer auth', async t => {
  let calls = 0
  const f = await setup(t, { transport: async () => { calls++; return responseSse() } })
  const s = f.service(); await s.unlockVault(account)
  const forbidden = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  for (const provider of ['openrouter', 'deepseek', 'google', 'anthropic'] as const) {
    const row = s.create(account, { ...apiInput, provider })
    assert.throws(() => s.saveSecret(account, row.id, forbidden), /API key/)
    // Defence in depth if a record was imported or mislabeled outside the UI.
    const imported = new Vault(s.store, f.config.keychain, f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!, f.config.policy)
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
  await f.restart(true)
  const ready = f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!
  assert.equal(ready.ready, true); ready.assertReady()
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  assert.equal(scrubber.isReady(), true)
  assert.deepEqual(scrubber.pendingSources(), [])
  assert.equal(scrubber.scrub(`${secret} ${retired}`).includes(secret), false)
  assert.equal(scrubber.scrub(`${secret} ${retired}`).includes(retired), false)
  assert.equal(f.service().snapshot(account).vault.unlocked, false)
  await assert.rejects(f.service().complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'still-locked',
  }), /locked/)
  f.config.keychain = async () => { throw new Error('Fixture keychain locked') }
  await f.restart(true)
  const failed = f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!
  assert.equal(failed.ready, false)
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!.isReady(), false)
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
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!.scrub('hello'), 'hello')
  assert.equal(s.store.get(account, row.id).secretRef, null)
  const imported = new Vault(s.store, f.config.keychain, f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!, f.config.policy)
  t.after(() => imported.close()); await imported.unlock(account)
  const oauth = ['sk', 'ant', 'oat01', randomBytes(20).toString('hex')].join('-')
  s.store.setSecret(account, row.id, imported.put(account, oauth))
  await assert.rejects(s.probe(account, row.id), error => error instanceof ConnectionError && error.code === 'validation_failed')
  assert.equal(calls, 0)
})


test('pi-ai facts carry the actual catalog observation time', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput)
  const before = Date.now(); const models = await s.models(account, row.id); const after = Date.now()
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
  const reopened = new ConnectionStore(f.config.databasePath, f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!)
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

test('review: migrations 2 to 5 upgrade a version-1 vault without rewriting keys, ciphertext or connections', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput); const secret = fakeKey()
  await s.unlockVault(account); s.saveSecret(account, row.id, secret)
  const before = {
    keys: s.store.db.prepare('SELECT * FROM vault_keys').all(),
    secrets: s.store.db.prepare('SELECT * FROM vault_secrets').all(),
    connections: s.store.db.prepare('SELECT * FROM connections').all(),
  }
  // Build a real on-disk version-1 fixture; this is only the throwaway test database.
  s.store.db.exec('DROP TABLE dotenv_imports; DROP TABLE vault_node_secrets; DROP TABLE vault_node_keys; DELETE FROM k3_migrations WHERE version>=2;')
  await f.restart()
  const next = f.service()
  assert.deepEqual(next.store.db.prepare('SELECT version FROM k3_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4, 5])
  assert.equal(next.store.db.prepare('SELECT count(*) AS n FROM dotenv_imports').get()!.n, 0)
  assert.deepEqual(next.store.db.prepare('SELECT * FROM vault_keys').all(), before.keys)
  assert.deepEqual(next.store.db.prepare('SELECT * FROM vault_secrets').all(), before.secrets)
  assert.deepEqual(next.store.db.prepare('SELECT * FROM connections').all(), before.connections)
  // A version-3 mapping has no family; append-only migration 4 makes it the official OpenAI family.
  const legacy = next.store.create(account, { name: 'openai (dotenv)', kind: 'model_api', provider: 'openai', auth: 'api_key' })
  next.store.db.exec(`DROP TABLE dotenv_imports;
    CREATE TABLE dotenv_imports(account_id TEXT NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES connections(id), PRIMARY KEY(account_id,provider,endpoint));
    DELETE FROM k3_migrations WHERE version=4;`)
  next.store.db.prepare('INSERT INTO dotenv_imports VALUES(?,?,?,?)').run(account, 'openai', '', legacy.id)
  await f.restart()
  assert.deepEqual(f.service().store.db.prepare('SELECT family FROM dotenv_imports').all().map(row => row.family), ['OPENAI_API_KEY'])
  assert.equal(f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!.ready, true)
  await f.service().unlockVault(account)
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!.scrub(secret), redactionMarker(f.service().store.get(account, row.id).secretRef as SecretRef))
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

// Adapted from the Claude Review 2 scratch probe; fresh egress models a process restart.
test('N1: failed session registration blocks background complete before provider dispatch', async t => {
  let calls = 0
  const f = await setup(t, { unattended: true, transport: async () => { calls++; return responseSse() } })
  const s = f.service()
  const interactive = s.create(account, apiInput)
  const background = s.create(account, { ...apiInput, name: 'Background' })
  await s.unlockVault(account)
  const secret = fakeKey()
  s.saveSecret(account, interactive.id, secret)
  s.saveSecret(account, background.id, fakeKey())
  s.setUnattended(account, background.id, true)
  const keychain = await f.config.keychain()
  f.config.keychain = async () => ({ key(id, create, purpose) {
    if (purpose === 'session') throw new Error('Fixture session key unavailable')
    return keychain.key(id, create, purpose)
  } })
  await f.restart(true)
  await assert.rejects(f.service().complete(account, background.id, {
    messages: [{ role: 'user', content: `tool printed ${secret}`, timestamp: Date.now() }],
  }, { model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'not-ready-background', background: true }),
  error => error instanceof ConnectionError && error.code === 'egress_unavailable')
  assert.equal(calls, 0)
  assert.equal(f.service().store.costs(account).length, 0)
})

test('N2: production wrapping-key namespaces separate session, node and database identities', () => {
  const path = '/throwaway/connections.sqlite'
  const session = keychainService(path, 'session')
  const node = keychainService(path, 'node')
  assert.notEqual(node, session)
  assert.equal(keychainService(path, 'session'), session)
  assert.notEqual(keychainService('/other-throwaway/connections.sqlite', 'session'), session)
  assert.equal(node, `${session}.node`)
})

test('N4: unload and failed reload retain current and retired values in the long-lived scrubber', async t => {
  const f = await setup(t)
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account)
  const retired = fakeKey(); const current = fakeKey()
  s.saveSecret(account, row.id, retired); s.saveSecret(account, row.id, current)
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  const markers = scrubber.scrub(`${current} ${retired}`)
  assert.equal(markers.includes(current), false); assert.equal(markers.includes(retired), false)
  f.config.keychain = async () => {
    assert.equal(scrubber.scrub(`${current} ${retired}`), markers, 'retained during reload')
    throw new Error('Fixture keychain unavailable')
  }
  await f.restart()
  assert.equal(scrubber.scrub(`${current} ${retired}`), markers)
})

test('N4: readiness is pushed only after every account is registered, including recovery by unlock', async t => {
  const f = await setup(t)
  const s = f.service()
  const second = 'second-owner'
  const firstSecret = fakeKey(); const secondSecret = fakeKey()
  await s.unlockVault(account); s.saveSecret(account, s.create(account, apiInput).id, firstSecret)
  await s.unlockVault(second); s.saveSecret(second, s.create(second, apiInput).id, secondSecret)
  const keychain = await f.config.keychain()
  let blocked = true
  f.config.keychain = async () => {
    if (blocked) throw new Error('Fixture keychain unavailable')
    return keychain
  }
  await f.restart(true)
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  assert.equal(scrubber.isReady(), false)
  assert.deepEqual(scrubber.pendingSources(), ['vault'])
  let readyCalls = 0
  const whenReady = scrubber.whenReady().then(() => {
    readyCalls++
    assert.equal(scrubber.scrub(`${firstSecret} ${secondSecret}`).includes(firstSecret), false)
    assert.equal(scrubber.scrub(`${firstSecret} ${secondSecret}`).includes(secondSecret), false)
  })
  blocked = false
  await f.service().unlockVault(account)
  assert.equal(readyCalls, 0); assert.equal(scrubber.isReady(), false)
  await f.service().unlockVault(second)
  assert.equal(scrubber.isReady(), true)
  await whenReady
  assert.equal(readyCalls, 1)
})

test('N5: stalled startup keychain is bounded, stays pending and cannot publish late readiness', async t => {
  const f = await setup(t)
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account)
  const secret = fakeKey(); s.saveSecret(account, row.id, secret)
  const keychain = await f.config.keychain()
  let release!: (value: VaultKeychain) => void
  let stalled = true; let keyReads = 0
  const tracked: VaultKeychain = { key(...args) { keyReads++; return keychain.key(...args) } }
  f.config.keychain = () => stalled ? new Promise(resolve => { release = resolve }) : Promise.resolve(tracked)
  const started = Date.now()
  await f.restart(true)
  assert.ok(Date.now() - started < 3000, 'registration has its own bound below the kernel step bound')
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  assert.equal(scrubber.isReady(), false)
  assert.equal(f.kernel.service<ConnectionsEgressReadiness>(CONNECTIONS_EGRESS_READINESS)!.ready, false)
  release(tracked)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(keyReads, 0, 'timed-out registration never resumes key access')
  assert.equal(scrubber.isReady(), false)
  stalled = false
  await f.service().unlockVault(account)
  assert.equal(scrubber.isReady(), true)
  assert.equal(scrubber.scrub(secret).includes(secret), false)
  assert.match(scrubber.scrub(secret), /REDACTED secret:\/\//)
})

test('N6: neither the registry nor its probe service exposes a runtime vault property', async t => {
  const f = await setup(t)
  const service = f.service()
  assert.equal('vault' in service, false)
  const probes = (service as unknown as { probes: object }).probes
  assert.ok(probes)
  assert.equal('vault' in probes, false)
  assert.equal(Object.values(probes).some(value => value instanceof Vault), false)
})

test('N7: a secret-less local runtime can opt in while locked on an authorized node', async t => {
  const f = await setup(t, { unattended: true })
  const s = f.service()
  const row = s.create(account, { name: 'Local', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  assert.equal(s.snapshot(account).vault.unlocked, false)
  assert.equal(s.setUnattended(account, row.id, true).unattended, true)
  assert.equal(s.snapshot(account).vault.unlocked, false)
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM vault_node_keys').get()!.n, 0)
})

test('N7: interactive rotation succeeds after node opt-in is disabled and removes the stale node copy', async t => {
  let calls = 0
  const f = await setup(t, { unattended: true, transport: async () => { calls++; return responseSse() } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey()); s.setUnattended(account, row.id, true)
  f.config.policy = { ownerDevice: true, nodeKeyOptIn: false }
  await f.restart()
  const next = f.service()
  await next.unlockVault(account)
  const rotated = fakeKey(); const saved = next.saveSecret(account, row.id, rotated)
  assert.equal(saved.unattended, true, 'stored preference does not override node policy')
  assert.equal(next.store.db.prepare('SELECT count(*) AS n FROM vault_node_secrets').get()!.n, 0)
  assert.equal(f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!.scrub(rotated), redactionMarker(f.service().store.get(account, row.id).secretRef as SecretRef))
  await next.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'interactive-rotation',
  })
  next.lockVault(account)
  await assert.rejects(next.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'run', requestId: 'policy-off-background', background: true,
  }), error => error instanceof ConnectionError && error.code === 'policy_denied')
  assert.equal(calls, 1)
})

test('DELETE hides a connection, drops its dotenv identity and keeps the retired secret redacted', async t => {
  const f = await setup(t); const s = f.service(); const routes = connectionRoutes(f.service, account)
  const secret = fakeKey()
  const imported = await s.importKeys(account, [{ provider: 'deepseek', value: secret }])
  const row = s.store.get(account, imported.imported[0]!.connectionId)
  const ref = row.secretRef as SecretRef
  const scrubber = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  assert.equal(scrubber.scrub(secret), redactionMarker(ref))
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM dotenv_imports WHERE connection_id=?').get(row.id)!.n, 1)

  const removed = await routes.request(`http://localhost/${row.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { id: row.id })
  assert.deepEqual(f.service().snapshot(account).connections, [])
  assert.throws(() => f.service().store.get(account, row.id), /not found/)
  const listed = await (await routes.request('http://localhost/')).json() as { connections: unknown[] }
  assert.deepEqual(listed.connections, [])
  assert.equal(f.service().store.db.prepare('SELECT count(*) AS n FROM dotenv_imports WHERE connection_id=?').get(row.id)!.n, 0)
  // The node-key copy is gone; the vault record stays for the long-lived scrubber.
  assert.equal(f.service().store.db.prepare('SELECT count(*) AS n FROM vault_node_secrets WHERE connection_id=?').get(row.id)!.n, 0)
  assert.equal(f.service().store.db.prepare('SELECT count(*) AS n FROM vault_secrets WHERE ref=?').get(ref)!.n, 1)
  assert.equal(scrubber.scrub(secret), redactionMarker(ref))

  // A fresh activation re-registers the retained vault record for redaction.
  await f.restart(true)
  const restarted = f.kernel.service<EgressScrubber>(EGRESS_SCRUBBER_SERVICE)!
  assert.equal(restarted.scrub(secret), redactionMarker(ref))
  // No mapping survives, so the next trusted import creates a new identity instead of reviving the old one.
  const again = await f.service().importKeys(account, [{ provider: 'deepseek', value: secret }])
  assert.equal(again.imported[0]!.action, 'created')
  assert.notEqual(again.imported[0]!.connectionId, row.id)
  assert.deepEqual(f.service().snapshot(account).connections.map(item => item.id), [again.imported[0]!.connectionId])
})

test('a DELETE between import preparation and its transaction cannot leave a mapping to the removed row', async t => {
  const f = await setup(t); const s = f.service(); const key = fakeKey()
  const first = await s.importKeys(account, [{ provider: 'deepseek', value: key }])
  const removedId = first.imported[0]!.connectionId
  // The row is read during preparation; remove it after the secret comparison and before BEGIN IMMEDIATE.
  const originalMatches = Vault.prototype.matches
  let removed = false
  Vault.prototype.matches = async function (accountId, connectionId, value) {
    const result = await originalMatches.call(this, accountId, connectionId, value)
    if (!removed && connectionId === removedId) { removed = true; s.store.remove(accountId, connectionId) }
    return result
  }
  try {
    const again = await s.importKeys(account, [{ provider: 'deepseek', value: key }])
    assert.equal(removed, true)
    assert.equal(again.imported[0]!.action, 'created')
    assert.notEqual(again.imported[0]!.connectionId, removedId)
    const mapped = s.store.db.prepare('SELECT connection_id FROM dotenv_imports WHERE account_id=? AND provider=?')
      .get(account, 'deepseek')!
    assert.equal(String(mapped.connection_id), again.imported[0]!.connectionId)
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM removed_connections WHERE connection_id=?').get(removedId)!.n, 1)
    assert.ok(s.store.get(account, again.imported[0]!.connectionId).secretRef)
  } finally { Vault.prototype.matches = originalMatches }
})

test('DELETE refuses with connection_in_use while a model call still runs, then succeeds', async t => {
  let started!: () => void; let release!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const f = await setup(t, { pi: { async complete(model) {
    started()
    await held
    return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'fixture' }], timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
  } } })
  const s = f.service(); const row = s.create(account, apiInput)
  await s.unlockVault(account); s.saveSecret(account, row.id, fakeKey())
  const call = s.complete(account, row.id, { messages: [] }, {
    model: piModels('deepseek')[0]!.id, runId: 'delete-running', requestId: 'delete-running',
  })
  await running
  const routes = connectionRoutes(f.service, account)
  const refused = await routes.request(`http://localhost/${row.id}`, { method: 'DELETE' })
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { code: 'connection_in_use' })
  assert.equal(f.service().snapshot(account).connections.length, 1)
  release()
  await call
  const removed = await routes.request(`http://localhost/${row.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(f.service().snapshot(account).connections, [])
})

test('DELETE hides a removed connection from costs while the append-only ledger row stays', async t => {
  const f = await setup(t); const s = f.service(); const row = s.create(account, apiInput)
  s.store.record({ accountId: account, connectionId: row.id, runId: 'cost-run', requestId: 'cost-request',
    inputTokens: 1, outputTokens: 1, costUsd: 0.5, source: 'fixture', observedAt: new Date().toISOString(), confidence: 'medium' })
  assert.equal(s.snapshot(account).costs.length, 1)
  await connectionRoutes(f.service, account).request(`http://localhost/${row.id}`, { method: 'DELETE' })
  assert.equal(f.service().snapshot(account).costs.length, 0)
  assert.equal(f.service().store.db.prepare('SELECT count(*) AS n FROM costs WHERE connection_id=?').get(row.id)!.n, 1)
})
