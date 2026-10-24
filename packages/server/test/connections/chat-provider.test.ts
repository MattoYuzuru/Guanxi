import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { PRODUCT_NAME, ROUTES, contextStateSchema, connectionBaseUrlSchema, createConnectionSchema, chatModelSelection, chatModelsResponse } from '@guanxi/contract'
import { parseProviderKeys, importProviderKeysFile } from '../../src/connections/dotenv.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import type { EndpointResolver } from '../../src/connections/endpoint.ts'
import { Connections } from '../../src/connections/service.ts'
import { piModels, piTransport, type PiTransport } from '../../src/connections/pi.ts'
import { Vault } from '../../src/vault/vault.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { SafeTextStream } from '../../src/connections/safe-stream.ts'
import { providerChatGroups } from '../../src/connections/chat.ts'
import { harnessSystemPrompt } from '../../src/agent/harness-prompt.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { openDb } from '../../src/store/db.ts'
import { ThreadStore } from '../../src/store/threads.ts'
import { JobStore } from '../../src/store/jobs.ts'
import { JobService } from '../../src/jobs/service.ts'
import { SettingsStore } from '../../src/store/settings.ts'
import { WorkspaceStore } from '../../src/store/workspaces.ts'
import { ChatJobExecutionOwner, chatRequestFingerprint } from '../../src/jobs/chat-execution.ts'
import { ApprovalGate } from '../../src/agent/approvals.ts'
import { PrefillTracker } from '../../src/context/usage.ts'
import { threadsRoutes } from '../../src/http/threads-routes.ts'
import { recoverChatJobs } from '../../src/jobs/chat-recovery.ts'
import { createAppContext, type AppContext } from '../../src/context.ts'
import type { OllamaAdapter } from '../../src/ollama/plugin.ts'
import type { OllamaClient } from '../../src/ollama/client.ts'
import type { ModelService } from '../../src/models/service.ts'

const canary = () => `test_${randomBytes(24).toString('hex')}`
const reply: PiTransport['complete'] = async (model, _context, _options, onText) => {
  onText?.('hello')
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text: 'hello' }],
    timestamp: Date.now(), stopReason: 'stop', usage: { input: 8, output: 2, totalTokens: 10, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } }
}
async function setup(t: { after(fn: () => unknown): void }, pi: PiTransport = { complete: reply }, transport: typeof fetch = async () => { throw new Error('No network') }, resolve: EndpointResolver = async () => [{ address: '8.8.8.8', family: 4 }]) {
  const dir = await mkdtemp(join(tmpdir(), 'k3-chat-'))
  const scrubber = new SecretScrubber()
  const store = new ConnectionStore(join(dir, 'connections.sqlite'), scrubber)
  const wrapping = randomBytes(32)
  const vault = new Vault(store, async () => ({ key: () => Buffer.from(wrapping) }), scrubber, { ownerDevice: true, nodeKeyOptIn: false })
  const governor = new ResourceGovernor()
  const lifetime = new AbortController()
  const service = new Connections(store, vault, {} as never, scrubber, lifetime.signal, {} as OllamaAdapter, governor,
    () => 'http://127.0.0.1:11434', pi, transport, resolve)
  await vault.registerForScrubbing()
  t.after(async () => { lifetime.abort(); await service.close(); vault.close(); store.close(); wrapping.fill(0); await governor.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, service, scrubber, store, vault, governor }
}
async function imported(s: Connections, value = canary(), baseUrl?: string) {
  const result = await s.importKeys('local', [{ provider: 'openai', value, ...(baseUrl ? { baseUrl } : {}) }])
  return result.imported[0]!.connectionId
}
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('State did not settle')
}

test('dotenv treats quotes, comments, export, variables and shell substitution as data', () => {
  const key = canary()
  const entries = parseProviderKeys(`export OPENAI_API_KEY="${key}" # comment\nOPENAI_API_URL=https://api.example.invalid/v1\nDEEPSEEK_API_KEY='literal_$(touch /tmp/never)_\${HOME}'\nUNRELATED_API_KEY=ignored`)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.value, key)
  assert.equal(entries[0]!.baseUrl, 'https://api.example.invalid/v1')
  assert.equal(entries[1]!.value, 'literal_$(touch /tmp/never)_${HOME}')
})

test('base URL rejects insecure, credential-bearing, query and non-OpenAI roots', () => {
  for (const value of ['https://user:pass@example.invalid', 'https://example.invalid/?key=x', 'https://example.invalid/#key', 'file:///tmp/api']) assert.equal(connectionBaseUrlSchema.safeParse(value).success, false)
  for (const value of ['https://api.example.invalid/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'http://localhost/v1']) assert.equal(connectionBaseUrlSchema.safeParse(value).success, true)
  assert.equal(createConnectionSchema.safeParse({ name: 'x', kind: 'model_api', provider: 'deepseek', auth: 'api_key', baseUrl: 'https://example.invalid' }).success, false)
})

test('dotenv file import is idempotent, rotates, preserves retired scrubbing and hides canaries in every public surface', async t => {
  const logs: string[] = []
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const)
    t.mock.method(console, method, (...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  const f = await setup(t), first = canary(), second = canary()
  const file = join(f.dir, 'fixture.env')
  await writeFile(file, `OPENAI_API_KEY=${first}\nDEEPSEEK_API_KEY=${second}`)
  const created = await importProviderKeysFile(f.service, 'local', file)
  const snapshot = JSON.stringify(f.service.snapshot('local'))
  const repeated = await importProviderKeysFile(f.service, 'local', file)
  assert.deepEqual(repeated.imported.map(row => row.action), ['unchanged', 'unchanged'])
  assert.equal(JSON.stringify(f.service.snapshot('local')), snapshot)
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM vault_secrets').get()!.n, 2)
  await writeFile(file, `OPENAI_API_KEY=${second}\nDEEPSEEK_API_KEY=${second}`)
  const rotated = await importProviderKeysFile(f.service, 'local', file)
  assert.deepEqual(rotated.imported.map(row => row.action), ['rotated', 'unchanged'])
  assert.equal(f.service.snapshot('local').connections.length, 2)
  const surfaces = JSON.stringify([logs, created, repeated, rotated, f.service.snapshot('local'), f.scrubber.scrub(`${first} ${second}`)])
  for (const secret of [first, second]) {
    assert.ok(!surfaces.includes(secret))
    for (const suffix of ['', '-wal']) assert.ok(!(await readFile(join(f.dir, `connections.sqlite${suffix}`))).includes(Buffer.from(secret)))
  }
  assert.equal(f.service.snapshot('local').connections.every(row => row.unattended === false), true)
  assert.equal(f.vault.unlocked('local'), true)
})

test('parallel same-file imports create one connection; an endpoint change with the same key reuses it', async t => {
  const { service } = await setup(t), value = canary()
  const results = await Promise.all([0, 1].map(() => service.importKeys('local', [{ provider: 'openai', value }])))
  assert.deepEqual(results.map(result => result.imported[0]!.action), ['created', 'unchanged'])
  const endpoint = 'https://api.example.invalid/v1'
  const id = await imported(service, value, endpoint)
  assert.equal(service.snapshot('local').connections.length, 1)
  assert.equal(service.store.get('local', id).baseUrl, endpoint)
  const other = await imported(service, canary(), 'https://other.example.invalid/v1')
  assert.notEqual(other, id)
  assert.equal(service.snapshot('local').connections.length, 2)
})

test('reimporting the same OpenAI key with an endpoint reuses one connection; a different key stays separate', async t => {
  const f = await setup(t), key = 'sk-test-' + 'x'.repeat(40), otherKey = 'sk-test-' + 'y'.repeat(40)
  const first = await f.service.importKeys('local', [{ provider: 'openai', value: key }])
  const id = first.imported[0]!.connectionId
  assert.equal(f.service.snapshot('local').connections.length, 1)
  const withEndpoint = await f.service.importKeys('local', [{ provider: 'openai', value: key, baseUrl: 'https://api.example.invalid/v1' }])
  assert.deepEqual(withEndpoint.imported, [{ connectionId: id, provider: 'openai', action: 'unchanged' }])
  assert.equal(f.service.snapshot('local').connections.length, 1)
  assert.equal(f.store.get('local', id).baseUrl, 'https://api.example.invalid/v1')
  // A different secret without an endpoint is still a separate identity, not a rotation of the rooted one.
  const different = await f.service.importKeys('local', [{ provider: 'openai', value: otherKey }])
  const otherId = different.imported[0]!.connectionId
  assert.notEqual(otherId, id)
  assert.equal(f.store.get('local', otherId).baseUrl, undefined)
  assert.equal(f.service.snapshot('local').connections.length, 2)
  const otherRooted = await f.service.importKeys('local', [{ provider: 'openai', value: otherKey, baseUrl: 'https://other.example.invalid/v1' }])
  assert.equal(otherRooted.imported[0]!.connectionId, otherId)
  assert.equal(f.store.get('local', otherId).baseUrl, 'https://other.example.invalid/v1')
  // The reverse same-secret import removes the endpoint but keeps the original identity.
  const withoutEndpoint = await f.service.importKeys('local', [{ provider: 'openai', value: key }])
  assert.equal(withoutEndpoint.imported[0]!.connectionId, id)
  assert.equal(f.store.get('local', id).baseUrl, undefined)
  assert.equal(f.service.snapshot('local').connections.length, 2)
})

test('imported connections use catalog labels and a compatible endpoint names its host', async t => {
  const f = await setup(t), file = join(f.dir, 'labels.env')
  await writeFile(file, `DEEPSEEK_API_KEY=${canary()}\nOPENAI_COMPAT_API_KEY=${canary()}\nOPENAI_COMPAT_API_URL=https://api.example.invalid/v1\n`)
  const result = await importProviderKeysFile(f.service, 'local', file)
  const rows = result.imported.map(item => f.store.get('local', item.connectionId))
  assert.deepEqual(rows.map(row => row.name).sort(), ['DeepSeek', 'OpenAI-compatible (api.example.invalid)'])
  assert.ok(rows.every(row => row.facts.origin?.value === 'provider_key_import'))
})

test('failed file reads and invalid endpoint errors never include file contents or canaries', async t => {
  const { service, dir } = await setup(t), value = canary()
  const file = join(dir, 'invalid.env')
  await writeFile(file, `OPENAI_API_KEY=${value}\nOPENAI_API_URL=https://${value}@example.invalid`)
  const invalid = await importProviderKeysFile(service, 'local', file)
  assert.deepEqual(invalid.errors, [{ key: 'OPENAI_API_KEY', code: 'invalid_provider_key' }])
  assert.ok(!JSON.stringify(invalid).includes(value))
  for (const path of [join(dir, value)]) {
    await assert.rejects(importProviderKeysFile(service, 'local', path), error => {
      assert.ok(!String(error).includes(value)); return true
    })
  }
  assert.equal(service.snapshot('local').connections.length, 0)
})

test('custom connection discovers models with explicit credentials, refuses redirects and records source/time', async t => {
  const value = canary(), calls: { url: string; redirect?: string; auth?: string | null }[] = []
  const f = await setup(t, undefined, async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect, auth: new Headers(init?.headers).get('Authorization') })
    return Response.json({ data: [{ id: 'owner-model' }, { id: 'owner-model' }] })
  })
  const id = await imported(f.service, value, 'https://api.example.invalid/v1')
  const catalog = await f.service.chatModels('local', id)
  assert.deepEqual(catalog.models, ['owner-model'])
  assert.equal(catalog.source, 'api.example.invalid')
  assert.ok(Number.isFinite(Date.parse(catalog.observedAt!)))
  assert.deepEqual(calls, [{ url: 'https://api.example.invalid/v1/models', redirect: 'error', auth: `Bearer ${value}` }])
  await f.service.chatModels('local', id)
  assert.equal(calls.length, 1)
  assert.equal(f.service.snapshot('local').connections[0]!.baseUrl, 'https://api.example.invalid')
})

test('custom discovery failure is explicitly unknown and locked/service/keyless connections are absent from picker', async t => {
  let requests = 0
  const { service } = await setup(t, undefined, async () => { requests++; throw new Error('offline') })
  const id = await imported(service, canary(), 'https://api.example.invalid/v1')
  service.create('local', { name: 'no key', kind: 'model_api', provider: 'deepseek', auth: 'api_key' })
  service.create('local', { name: 'service', kind: 'service', provider: 'brave', auth: 'api_key' })
  const groups = await providerChatGroups(service)
  assert.equal(groups.length, 1)
  await service.chatModels('local', id)
  assert.equal(requests, 1)
  assert.deepEqual(groups[0]!.models, [])
  assert.equal((await service.chatModels('local', id)).state, 'unknown')
  assert.ok(chatModelsResponse.safeParse({ groups }).success)
  service.lockVault('local')
  assert.deepEqual(await providerChatGroups(service), [])
})

test('stream scrubbing withholds split and overlapping secret forms before release', () => {
  const scrubber = new SecretScrubber(), value = canary()
  scrubber.register('secret://stream/key', value)
  for (let cut = 1; cut < value.length; cut++) {
    const stream = new SafeTextStream(scrubber)
    const output = [stream.push('safe ' + value.slice(0, cut)), stream.push(value.slice(cut) + ' end'), stream.finish()].join('')
    assert.ok(!output.includes(value)); assert.ok(output.includes('REDACTED'))
  }
  scrubber.register('secret://stream/overlap', 'abababab')
  const overlap = new SafeTextStream(scrubber)
  assert.equal(overlap.push('abababab'), '')
  assert.ok(![overlap.push('abababab'), overlap.finish()].join('').includes('abababab'))
})

function chatFixture(f: Awaited<ReturnType<typeof setup>>, t: { after(fn: () => unknown): void }, local?: Pick<OllamaClient, 'chatStream'>) {
  const db = openDb(':memory:'), threads = new ThreadStore(db), jobs = new JobStore(db)
  const base = { db, threads, jobs, jobService: new JobService(jobs), governor: f.governor,
    workspaces: new WorkspaceStore(db), settings: new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' }),
    approvals: new ApprovalGate(), tracker: new PrefillTracker(), activeTurns: new Map<string, AbortController>(),
    connections: () => f.service, models: () => ({ assertContextAllowed: async () => {}, supportsTools: async () => false }) as unknown as ModelService,
    ollama: () => (local ?? { chatStream: async function* () { assert.fail('Provider request reached Ollama') } }) as OllamaClient,
  }
  const context = { ...base, chatExecution: new ChatJobExecutionOwner(base) } as AppContext
  const app = new Hono().route('/threads', threadsRoutes(context))
  t.after(async () => { await context.chatExecution.shutdown(); db.close() })
  const create = (model: string) => threads.create({ title: 'test', mode: 'chat', model, workspaceId: null,
    options: { numCtx: 4096, temperature: 0.7, think: 'off' } })
  return { app, context, create }
}

test('durable fake-provider turn scrubs context, streams safely, saves usage and replays once after disconnect', async t => {
  const value = canary(); let calls = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const f = await setup(t, { complete: async (model, context, options, onText) => {
    calls++
    assert.equal(context.systemPrompt, harnessSystemPrompt())
    assert.ok(!JSON.stringify(context).includes(value))
    assert.equal(options.apiKey, value)
    onText?.('early safe text ')
    await barrier
    onText?.(value.slice(0, 14)); onText?.(value.slice(14))
    return { ...await reply(model, context, options), content: [{ type: 'text', text: `early safe text ${value}` }] }
  } })
  const id = await imported(f.service, value), chat = chatFixture(f, t)
  const thread = chat.create(chatModelSelection(id, piModels('openai')[0]!.id))
  const body = { content: `Do not leak ${value}`, idempotencyKey: randomUUID() }
  const send = () => chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const response = await send()
  const reader = response.body!.getReader()
  await reader.read(); await reader.cancel()
  await settle(() => calls === 1)
  assert.equal(chat.context.jobs.activeChatJobForThread(thread.id) !== null, true)
  release()
  await settle(() => chat.context.jobs.activeChatJobForThread(thread.id) === null)
  const messages = chat.context.threads.messages(thread.id)
  assert.equal(messages.filter(row => row.role === 'assistant').length, 1)
  assert.equal(messages.at(-1)!.turnStatus, 'completed')
  const history = await (await chat.app.request(`/threads/${thread.id}`)).text()
  assert.ok(!history.includes(value))
  const durable = JSON.stringify(chat.context.db.prepare('SELECT input_json FROM chat_job_inputs').all())
  assert.ok(!durable.includes(value))
  assert.ok(!JSON.stringify(chat.context.jobs.eventsAfter(chat.context.db.prepare('SELECT id FROM jobs').get()!.id as string, 0, 100)).includes(value))
  f.service.lockVault('local')
  assert.ok(!messages.at(-1)!.content.includes(value))
  const replay = await (await send()).text()
  assert.equal(calls, 1); assert.ok(!replay.includes(value)); assert.ok(replay.includes('REDACTED'))
  const conflict = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, content: 'different' }) })
  assert.equal(conflict.status, 409)
  assert.equal(calls, 1)
  const costs = f.service.snapshot('local').costs
  assert.equal(costs.length, 1); assert.equal(costs[0]!.costUsd, 0.003)
  assert.match(costs[0]!.source, /catalog_estimate/)
  const groups = await chat.app.request('/threads/models')
  assert.equal(chatModelsResponse.parse(await groups.json()).groups.length, 0)
})

test('custom models dispatch pinned chat-completions, scrub final reply and keep cost unknown', async t => {
  const value = canary(); let wire = ''
  const f = await setup(t, { complete: async (model, context, options) => {
    assert.equal(model.api, 'openai-completions'); assert.equal(model.baseUrl, 'https://api.example.invalid/v1')
    await options.fetch!(`${model.baseUrl}/chat/completions`)
    return { ...await reply(model, context, options), content: [{ type: 'text', text: value }] }
  } }, async (url, init) => {
    wire = String(url); assert.equal(init?.redirect, 'error')
    return Response.json({ data: [{ id: 'owner-model' }] })
  })
  const id = await imported(f.service, value, 'https://api.example.invalid/v1')
  const result = await f.service.complete('local', id, { messages: [] }, { model: 'owner-model', runId: 'custom', requestId: 'custom' })
  assert.equal(wire, 'https://api.example.invalid/v1/chat/completions')
  assert.ok(!JSON.stringify(result).includes(value))
  assert.equal(f.service.snapshot('local').costs[0]!.costUsd, null)
})

test('custom transport refuses request escape before forwarding a credential', async t => {
  let calls = 0
  const f = await setup(t, { complete: async (_model, _context, options) => {
    await options.fetch!('https://escape.invalid/chat/completions'); throw new Error('unreachable')
  } }, async () => { calls++; return Response.json({ data: [{ id: 'owner-model' }] }) })
  const id = await imported(f.service, canary(), 'https://api.example.invalid/v1')
  await assert.rejects(f.service.complete('local', id, { messages: [] }, { model: 'owner-model', runId: 'escape', requestId: 'escape' }))
  assert.equal(calls, 0) // Completion does not rediscover; escape is rejected before transport.
})

test('plain Chat orientation is bounded English with brand and no execution access', () => {
  const prompt = harnessSystemPrompt()
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 350)
  assert.equal(prompt.split('\n').at(-1), 'Reply in the language the user writes in.')
  assert.ok(prompt.includes(PRODUCT_NAME))
  assert.match(prompt, /Node=local; OS=/)
  assert.match(prompt, /cwd=none; roots=0; mode=chat/)
  assert.match(prompt, /Tools=none\. Skills=off/)
  assert.match(prompt, /Paths, budgets, AGENTS.md=unavailable/)
  assert.doesNotMatch(prompt, /[^\x20-\x7e\n]/)
  assert.doesNotMatch(prompt, /[\\/]|\d{4}-\d{2}-\d{2}|quota|remaining|timestamp|Respond|You run/)
})

test('local dispatch starts with identical orientation bytes across turns and a locale change', async t => {
  const requests: { role: string; content: string }[][] = []
  const f = await setup(t), chat = chatFixture(f, t, { async *chatStream(request) {
    requests.push(request.messages.map(({ role, content }) => ({ role, content })))
    yield { model: request.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, done: true }
  } })
  const thread = chat.create('local-model')
  const value = canary()
  const contents = [`hello /private/work/${value} at 2026-10-23T12:34:56Z quota=987`, 'second turn']
  for (const [index, content] of contents.entries()) {
    chat.context.settings.update({ locale: index === 0 ? 'en' : 'ru' })
    const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.equal(requests.length, 2)
  for (const messages of requests) {
    assert.deepEqual(messages[0], { role: 'system', content: harnessSystemPrompt() })
    assert.equal(messages.filter(message => message.role === 'system').length, 1)
    assert.ok(!messages[0]!.content.includes(value))
    assert.equal(messages[1]!.content, contents[0])
  }
  assert.deepEqual(Buffer.from(requests[0]![0]!.content), Buffer.from(requests[1]![0]!.content))
  assert.equal(requests[1]!.at(-1)!.content, contents[1])
})

test('provider Stop is durable and terminal recovery never redispatches inference', async t => {
  let started = false, calls = 0
  const f = await setup(t, { complete: async (_model, _context, options) => {
    started = true; calls++
    await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    throw new Error('unreachable')
  } })
  const id = await imported(f.service), chat = chatFixture(f, t)
  const thread = chat.create(chatModelSelection(id, piModels('openai')[0]!.id))
  const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })
  await settle(() => started)
  await chat.context.chatExecution.cancelThread(thread.id)
  await response.text()
  assert.equal(chat.context.threads.messages(thread.id).at(-1)!.turnStatus, 'cancelled')
  await recoverChatJobs(chat.context)
  assert.equal(calls, 1)
})


test('fresh owner interrupts an executing provider association and retains output without inference', async t => {
  let calls = 0
  const f = await setup(t, { complete: async (...args) => { calls++; return reply(...args) } })
  const id = await imported(f.service), chat = chatFixture(f, t)
  const thread = chat.create(chatModelSelection(id, piModels('openai')[0]!.id))
  const input = { content: 'hello', attachments: [], autoApprove: null }
  const association = chat.context.jobService.createChat({ threadId: thread.id, idempotencyScope: `chat:${thread.id}:send:v1`,
    idempotencyKey: randomUUID(), requestFingerprint: chatRequestFingerprint(input), input, derivedTitle: 'hello' })
  for (const [expectedStatus, status] of [['queued', 'reserving'], ['reserving', 'loading'], ['loading', 'prefill'], ['prefill', 'generating']] as const)
    chat.context.jobService.transition({ jobId: association.job.id, expectedStatus, status, phase: status, metadata: {} })
  for (const event of [
    { type: 'start' as const, data: { messageId: association.assistantMessageId, model: thread.model, step: 0, status: 'pending' as const, jobId: association.job.id } },
    { type: 'token' as const, data: { delta: 'retained partial' } },
  ]) {
    const current = chat.context.jobService.get(association.job.id)!
    chat.context.jobService.appendSafeEvent({ jobId: current.id, expectedNextSequence: current.lastEventSequence + 1,
      type: 'output', metadata: {}, output: { privacyClassification: 'private_chat', event } })
  }
  const freshOwner = new ChatJobExecutionOwner(chat.context)
  const report = await recoverChatJobs({ ...chat.context, chatExecution: freshOwner })
  assert.equal(report.interrupted, 1)
  assert.equal(chat.context.jobService.get(association.job.id)!.status, 'interrupted')
  assert.equal(chat.context.threads.messages(thread.id).at(-1)!.content, 'retained partial')
  assert.equal(calls, 0)
  await freshOwner.shutdown()
})


test('real pi-ai fake wire keeps compacted history outside the stable orientation without invented model token ceilings', async t => {
  const value = canary(), requests: { role: string; content: string }[][] = []
  const f = await setup(t, piTransport, async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'owner-model' }] })
    assert.ok(new Headers(init?.headers).get('Authorization') === `Bearer ${value}`)
    const body = JSON.parse(String(init?.body))
    requests.push(body.messages)
    assert.equal(body.model, 'owner-model')
    assert.equal(body.max_tokens, undefined); assert.equal(body.max_completion_tokens, undefined)
    return new Response([
      { id: 'fake', choices: [{ index: 0, delta: { role: 'assistant', content: 'fake streamed reply' }, finish_reason: null }] },
      { id: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const id = await imported(f.service, value, 'https://api.example.invalid/v1')
  const chat = chatFixture(f, t), thread = chat.create('local-model')
  const source = 'compacted source must not be dispatched'
  const summary = 'Checkpoint at 2026-10-23T12:34:56Z /private/project quota=987'
  const tail = 'retained local history'
  chat.context.threads.addMessage({ threadId: thread.id, role: 'user', content: source })
  chat.context.threads.addMessage({ threadId: thread.id, role: 'assistant', content: 'prior local reply' })
  chat.context.threads.createContextCheckpoint({ threadId: thread.id, upToSeq: 1, expectedPreviousCheckpointId: null, summary })
  chat.context.threads.addMessage({ threadId: thread.id, role: 'user', content: tail })
  chat.context.threads.update(thread.id, { model: chatModelSelection(id, 'owner-model') })
  for (const locale of ['en', 'ru'] as const) {
    chat.context.settings.update({ locale })
    const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `hello ${value} /private/project at 2026-10-23T12:34:56Z quota=987` }) })
    assert.equal(response.status, 200)
    await response.text()
    assert.equal(chat.context.threads.messages(thread.id).at(-1)!.content, 'fake streamed reply')
    assert.equal(chat.context.threads.messages(thread.id).at(-1)!.turnStatus, 'completed')
  }
  assert.equal(requests.length, 2)
  for (const messages of requests) {
    assert.deepEqual(messages[0], { role: 'system', content: harnessSystemPrompt() })
    assert.equal(messages.filter(message => message.role === 'system').length, 1)
    assert.deepEqual(messages[1], { role: 'user', content: summary })
    assert.equal(messages.filter(message => message.content === summary).length, 1)
    assert.deepEqual(messages[2], { role: 'user', content: tail })
    assert.ok(!JSON.stringify(messages).includes(source))
    assert.ok(!JSON.stringify(messages).includes(value))
  }
  assert.deepEqual(Buffer.from(requests[0]![0]!.content), Buffer.from(requests[1]![0]!.content))
  assert.equal(requests[1]!.length, 6)
})


test('secret-bearing API roots are rejected without plaintext metadata, mapping or WAL', async t => {
  const f = await setup(t), value = canary()
  await assert.rejects(f.service.importKeys('local', [{ provider: 'openai', value, baseUrl: `https://api.example.invalid/v1/${value}` }]), error => {
    assert.ok(!String(error).includes(value)); return true
  })
  assert.equal(f.service.snapshot('local').connections.length, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dotenv_imports').get()!.n, 0)
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM vault_secrets').get()!.n, 0)
  for (const suffix of ['', '-wal']) assert.ok(!(await readFile(join(f.dir, `connections.sqlite${suffix}`))).includes(Buffer.from(value)))
})

test('local sends reach Ollama with an unregistered vault row or missing K3 service', async t => {
  const f = await setup(t)
  f.store.db.prepare('INSERT INTO vault_secrets VALUES(?,?,?)').run(`secret://local/${randomUUID()}`, 'local', 'unregistered')
  assert.throws(() => f.vault.assertScrubbingReady('local'))
  let calls = 0
  const chat = chatFixture(f, t, { async *chatStream(request) {
    calls++
    yield { model: request.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, done: true }
  } })
  for (const missing of [false, true]) {
    if (missing) chat.context.connections = () => { throw new Error('K3 missing') }
    const thread = chat.create('local-model')
    const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })
    assert.equal(response.status, 200)
    await response.text()
  }
  assert.equal(calls, 2)
})


test('failed refresh keeps the last successful custom discovery stale and low confidence', async t => {
  let failing = false
  const f = await setup(t, undefined, async () => {
    if (failing) throw new Error('offline')
    return Response.json({ data: [{ id: 'owner-model' }] })
  })
  const id = await imported(f.service, canary(), 'https://api.example.invalid/v1')
  const first = await f.service.chatModels('local', id)
  failing = true
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 61_000)
  const stale = await f.service.chatModels('local', id)
  assert.deepEqual(stale.models, ['owner-model'])
  assert.equal(stale.observedAt, first.observedAt)
  assert.equal(stale.confidence, 'low'); assert.equal(stale.state, 'stale')
})

test('admitted custom completion needs no rediscovery and uses neutral compat for a gpt catalog ID', async t => {
  let discovery = 0
  const f = await setup(t, { complete: async (model, context, options) => {
    assert.equal(model.api, 'openai-completions')
    assert.equal(model.reasoning, false)
    assert.equal((model.compat as { supportsDeveloperRole?: boolean }).supportsDeveloperRole, false)
    assert.equal(model.contextWindow, 0); assert.equal(model.maxTokens, 0)
    return reply(model, context, options)
  } }, async () => { discovery++; throw new Error('offline') })
  const id = await imported(f.service, canary(), 'https://api.example.invalid/v1')
  await f.service.complete('local', id, { messages: [] }, { model: 'gpt-5', runId: 'admitted', requestId: 'admitted' })
  assert.equal(discovery, 0)
})

test('dotenv handles BOM/CRLF and refuses duplicate, truncated, unterminated and unsupported input safely', () => {
  const key = canary()
  assert.equal(parseProviderKeys(`\uFEFFOPENAI_API_KEY="${key}"\r\n`)[0]!.value, key)
  for (const text of [
    `OPENAI_API_KEY=${key}\nOPENAI_API_KEY=${canary()}`,
    `OPENAI_API_KEY=${key}#truncated`,
    `OPENAI_API_KEY="${key}`,
    'UNSUPPORTED_KEY=fixture', '',
  ]) assert.throws(() => parseProviderKeys(text), error => {
    assert.ok(!String(error).includes(key)); return true
  })
})

test('provider turns bypass a held governor permit while local turns queue behind it', async t => {
  let providerCalls = 0, localCalls = 0
  const f = await setup(t, { complete: async (...args) => { providerCalls++; return reply(...args) } })
  const id = await imported(f.service)
  const ticket = f.governor.enqueue({ owner: { kind: 'operation', operationId: 'held' }, operation: 'chat',
    model: { provider: 'ollama', name: 'held' }, requestedContext: 4096, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const lease = await f.governor.acquire(ticket)
  t.after(() => lease.release())
  const chat = chatFixture(f, t, { async *chatStream(request) {
    localCalls++
    yield { model: request.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: 'local' }, done: true }
  } })
  const send = (model: string) => chat.app.request(`/threads/${chat.create(model).id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fixture' }) })
  const local = await send('local-model')
  const provider = await send(chatModelSelection(id, piModels('openai')[0]!.id))
  await provider.text()
  try {
    assert.equal(providerCalls, 1); assert.equal(localCalls, 0)
    assert.equal(f.governor.snapshot().queued.length, 1)
  } finally { lease.release() }
  await local.text()
  assert.equal(localCalls, 1)
})


test('startup defers queued provider jobs until Connections has loaded', async t => {
  let calls = 0, ready = false
  const f = await setup(t, { complete: async (...args) => { calls++; assert.equal(ready, true); return reply(...args) } })
  const id = await imported(f.service), chat = chatFixture(f, t)
  const thread = chat.create(chatModelSelection(id, piModels('openai')[0]!.id))
  const input = { content: 'queued provider', attachments: [], autoApprove: null }
  const association = chat.context.jobService.createChat({ threadId: thread.id, idempotencyScope: `chat:${thread.id}:send:v1`,
    idempotencyKey: randomUUID(), requestFingerprint: chatRequestFingerprint(input), input, derivedTitle: 'queued provider' })
  const context = await createAppContext({ db: chat.context.db, dbPath: join(f.dir, 'state.sqlite'), appVersion: 'test',
    deferChatRecovery: true, connections: () => { if (!ready) throw new Error('K3 not loaded'); return f.service } })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(context.jobService.get(association.job.id)!.status, 'queued')
    assert.equal(calls, 0)
    ready = true
    await recoverChatJobs(context)
    await settle(() => context.jobService.get(association.job.id)!.status === 'completed')
    assert.equal(calls, 1)
  } finally { await context.maintenance?.close(); await context.chatExecution.shutdown() }
})

test('provider context uses catalog evidence or unknown, never local numCtx, and cannot compact', async t => {
  const f = await setup(t), chat = chatFixture(f, t)
  for (const custom of [false, true]) {
    const id = await imported(f.service, canary(), custom ? 'https://api.example.invalid/private/v1' : undefined)
    const model = piModels('openai')[0]!
    const thread = chat.create(chatModelSelection(id, model.id))
    for (const path of [`/threads/${thread.id}`, `/threads/${thread.id}/context`]) {
      const body = await (await chat.app.request(path)).json()
      const context = contextStateSchema.parse(path.endsWith('/context') ? body : (body as { context: unknown }).context)
      assert.equal(context.allocatedTokens, custom ? null : model.contextWindow)
      assert.equal(context.compactable, false)
      assert.equal(context.providerContext!.confidence, custom ? 'unknown' : 'medium')
      assert.ok(!JSON.stringify(context).includes('/private/v1'))
    }
    const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fixture' }) })
    // A custom ID cannot be newly admitted while discovery is unknown.
    if (!custom) {
      const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      const context = frames.find(event => event.type === 'context').data
      assert.equal(context.allocatedTokens, model.contextWindow)
      assert.equal(context.compactable, false)
      assert.equal(context.providerContext.source, '@earendil-works/pi-ai@1.3.0')
    }
  }
})

test('discovery refuses oversized bodies, lists and IDs and contract rejects oversized picker payloads', async t => {
  const bodies = [
    ' '.repeat(1_048_577) + JSON.stringify({ data: [{ id: 'fixture' }] }),
    JSON.stringify({ data: Array.from({ length: 1025 }, (_, i) => ({ id: `model-${i}` })) }),
    JSON.stringify({ data: [{ id: 'x'.repeat(257) }] }),
  ]
  for (const body of bodies) {
    const f = await setup(t, undefined, async () => new Response(body))
    const id = await imported(f.service, canary(), 'https://api.example.invalid/v1')
    const catalog = await f.service.chatModels('local', id)
    assert.deepEqual(catalog.models, []); assert.equal(catalog.state, 'unknown')
  }
  const model = { selection: 'fixture', modelId: 'x'.repeat(257), source: 'fixture', observedAt: new Date().toISOString(), confidence: 'medium' }
  assert.equal(chatModelsResponse.safeParse({ groups: [{ id: 'fixture', label: 'fixture', kind: 'provider', models: [model] }] }).success, false)
  assert.equal(chatModelsResponse.safeParse({ groups: [{ id: 'fixture', label: 'fixture', kind: 'provider', models: Array(1025).fill({ ...model, modelId: 'fixture' }) }] }).success, false)
})

test('provider picker route belongs to the shared wire contract', () => {
  assert.equal(ROUTES.threadModels(), '/api/threads/models')
})

test('provider admission exposes actionable connection codes and HTTP statuses', async t => {
  const f = await setup(t), chat = chatFixture(f, t)
  const id = await imported(f.service)
  for (const [connectionId, status, code] of [[randomUUID(), 404, 'connection_not_found'], [id, 423, 'vault_locked']] as const) {
    f.service.lockVault('local')
    const thread = chat.create(chatModelSelection(connectionId, piModels('openai')[0]!.id))
    const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fixture' }) })
    assert.equal(response.status, status)
    assert.equal((await response.json() as { code: string }).code, code)
  }
})

test('send request cancellation reaches custom model discovery', async t => {
  let observed: AbortSignal | undefined, release!: () => void, started!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const f = await setup(t, undefined, async (_url, init) => {
    observed = init!.signal!; started(); await barrier
    return Response.json({ data: [{ id: 'owner-model' }] })
  })
  const id = await imported(f.service, canary(), 'https://api.example.invalid/v1'), chat = chatFixture(f, t)
  const thread = chat.create(chatModelSelection(id, 'owner-model')), controller = new AbortController()
  const pending = chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fixture' }) })
  await entered
  try { controller.abort(); assert.equal(observed!.aborted, true) }
  finally { release(); await (await pending).text() }
})

test('invalid OpenAI root reports its key while other provider keys still import', async t => {
  const f = await setup(t), value = canary(), file = join(f.dir, 'partial.env')
  await writeFile(file, `OPENAI_API_KEY=${value}\nOPENAI_API_URL=invalid-root\nDEEPSEEK_API_KEY=${canary()}`)
  const result = await importProviderKeysFile(f.service, 'local', file)
  assert.deepEqual(result.imported.map(row => row.provider), ['deepseek'])
  assert.deepEqual(result.errors, [{ key: 'OPENAI_API_KEY', code: 'invalid_provider_key' }])
  assert.ok(!JSON.stringify(result).includes(value))
})

test('one file imports official OpenAI and a separate compatible endpoint without redirecting either', async t => {
  const f = await setup(t), file = join(f.dir, 'two-openai.env')
  await writeFile(file, `OPENAI_API_KEY=${canary()}\nOPENAI_COMPAT_API_KEY=${canary()}\nOPENAI_COMPAT_API_URL=https://api.example.invalid/v1`)
  const result = await importProviderKeysFile(f.service, 'local', file)
  assert.equal(result.imported.length, 2)
  const rows = result.imported.map(item => f.store.get('local', item.connectionId))
  assert.equal(rows[0]!.baseUrl, undefined)
  assert.equal(rows[1]!.baseUrl, 'https://api.example.invalid/v1')
  assert.notEqual(rows[0]!.id, rows[1]!.id)
  assert.deepEqual(rows.map(row => row.name), ['OpenAI', 'OpenAI-compatible (api.example.invalid)'])
  assert.deepEqual((await importProviderKeysFile(f.service, 'local', file)).imported.map(item => item.action), ['unchanged', 'unchanged'])
})

test('boot survives provider import failure and logs only a fixed code with models unavailable', async t => {
  const { start } = await import('../../src/index.ts')
  const f = await setup(t), value = canary(), file = join(f.dir, 'boot-invalid.env')
  await writeFile(file, `UNKNOWN_KEY=${value}`)
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args))
  const node = await start({ port: 0, dataDir: join(f.dir, 'node'), providerKeysFile: file })
  try {
    assert.deepEqual(warnings, [['provider_key_import_failed']])
    assert.deepEqual(await providerChatGroups(node.context.connections!()), [])
    assert.ok(!JSON.stringify(warnings).includes(value))
  } finally { await node.close() }
})

test('trusted reimport persists and revokes private-network consent for an existing endpoint', async t => {
  const f = await setup(t), file = join(f.dir, 'consent.env'), value = canary()
  const body = `OPENAI_API_KEY=${value}\nOPENAI_API_URL=https://192.168.1.2/v1`
  let id = ''
  for (const consent of [false, true, false]) {
    await writeFile(file, `${body}\nGUANXI_PROVIDER_ALLOW_PRIVATE=${consent ? '1' : '0'}`)
    const result = await importProviderKeysFile(f.service, 'local', file)
    id ||= result.imported[0]!.connectionId
    assert.equal(result.imported[0]!.connectionId, id)
    assert.equal(f.store.get('local', id).allowPrivate, consent)
    const persisted = new ConnectionStore(join(f.dir, 'connections.sqlite'), f.scrubber)
    try { assert.equal(persisted.get('local', id).allowPrivate, consent) } finally { persisted.close() }
  }
})


test('real pi-ai preserves endpoint policy denial as a connection error with zero transport calls', async t => {
  let calls = 0
  const f = await setup(t, piTransport, async () => { calls++; throw new Error('unexpected_network') },
    async () => [{ address: '10.0.0.1', family: 4 }])
  const id = await imported(f.service, canary(), 'https://api.example.invalid/v1')
  await assert.rejects(f.service.complete('local', id, { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] },
    { model: 'owner-model', runId: 'denied', requestId: 'denied' }), { code: 'policy_denied' })
  assert.equal(calls, 0)
})
