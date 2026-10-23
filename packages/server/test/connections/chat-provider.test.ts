import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { connectionBaseUrlSchema, createConnectionSchema, chatModelSelection, chatModelsResponse } from '@guanxi/contract'
import { parseProviderKeys, importProviderKeysFile } from '../../src/connections/dotenv.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { Connections } from '../../src/connections/service.ts'
import { piModels, type PiTransport } from '../../src/connections/pi.ts'
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
import { ChatJobExecutionOwner } from '../../src/jobs/chat-execution.ts'
import { ApprovalGate } from '../../src/agent/approvals.ts'
import { PrefillTracker } from '../../src/context/usage.ts'
import { threadsRoutes } from '../../src/http/threads-routes.ts'
import { recoverChatJobs } from '../../src/jobs/chat-recovery.ts'
import type { AppContext } from '../../src/context.ts'
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
async function setup(t: { after(fn: () => unknown): void }, pi: PiTransport = { complete: reply }, transport: typeof fetch = async () => { throw new Error('No network') }) {
  const dir = await mkdtemp(join(tmpdir(), 'k3-chat-'))
  const scrubber = new SecretScrubber()
  const store = new ConnectionStore(join(dir, 'connections.sqlite'), scrubber)
  const wrapping = randomBytes(32)
  const vault = new Vault(store, async () => ({ key: () => Buffer.from(wrapping) }), scrubber, { ownerDevice: true, nodeKeyOptIn: false })
  const governor = new ResourceGovernor()
  const lifetime = new AbortController()
  const service = new Connections(store, vault, {} as never, scrubber, lifetime.signal, {} as OllamaAdapter, governor,
    () => 'http://127.0.0.1:11434', pi, transport)
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
  for (const value of ['http://example.invalid/v1', 'https://user:pass@example.invalid', 'https://example.invalid/?key=x', 'https://example.invalid/#key', 'file:///tmp/api']) assert.equal(connectionBaseUrlSchema.safeParse(value).success, false)
  for (const value of ['https://api.example.invalid/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1', 'http://localhost/v1']) assert.equal(connectionBaseUrlSchema.safeParse(value).success, true)
  assert.equal(createConnectionSchema.safeParse({ name: 'x', kind: 'model_api', provider: 'deepseek', auth: 'api_key', baseUrl: 'https://example.invalid' }).success, false)
})

test('dotenv file import is idempotent, rotates, preserves retired scrubbing and hides canaries in every public surface', async t => {
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
  const surfaces = JSON.stringify([created, repeated, rotated, f.service.snapshot('local'), f.scrubber.scrub(`${first} ${second}`)])
  for (const secret of [first, second]) {
    assert.ok(!surfaces.includes(secret))
    for (const suffix of ['', '-wal']) assert.ok(!(await readFile(join(f.dir, `connections.sqlite${suffix}`))).includes(Buffer.from(secret)))
  }
  assert.equal(f.service.snapshot('local').connections.every(row => row.unattended === false), true)
  assert.equal(f.vault.unlocked('local'), true)
})

test('parallel same-file imports create exactly one connection and endpoint changes get a separate identity', async t => {
  const { service } = await setup(t), value = canary()
  const results = await Promise.all([0, 1].map(() => service.importKeys('local', [{ provider: 'openai', value }])))
  assert.deepEqual(results.map(result => result.imported[0]!.action), ['created', 'unchanged'])
  await imported(service, value, 'https://api.example.invalid/v1')
  assert.equal(service.snapshot('local').connections.length, 2)
})

test('failed file reads and invalid endpoint errors never include file contents or canaries', async t => {
  const { service, dir } = await setup(t), value = canary()
  const file = join(dir, 'invalid.env')
  await writeFile(file, `OPENAI_API_KEY=${value}\nOPENAI_API_URL=https://${value}@example.invalid`)
  for (const path of [file, join(dir, value)]) {
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
  assert.equal(catalog.source, 'api.example.invalid/models')
  assert.ok(Number.isFinite(Date.parse(catalog.observedAt)))
  assert.deepEqual(calls, [{ url: 'https://api.example.invalid/v1/models', redirect: 'error', auth: `Bearer ${value}` }])
  await f.service.chatModels('local', id)
  assert.equal(calls.length, 1)
  assert.equal(f.service.snapshot('local').connections[0]!.baseUrl, 'https://api.example.invalid/v1')
})

test('discovery failure falls back to catalog and locked/service/keyless connections are absent from picker', async t => {
  const { service } = await setup(t)
  const id = await imported(service, canary(), 'https://api.example.invalid/v1')
  service.create('local', { name: 'no key', kind: 'model_api', provider: 'deepseek', auth: 'api_key' })
  service.create('local', { name: 'service', kind: 'service', provider: 'brave', auth: 'api_key' })
  const groups = await providerChatGroups(service)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.models[0]!.source, '@earendil-works/pi-ai@1.3.0')
  assert.ok(groups[0]!.models.some(model => model.selection === chatModelSelection(id, piModels('openai')[0]!.id)))
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
    assert.ok(context.systemPrompt?.includes('Guanxi'))
    assert.ok(context.systemPrompt?.includes('Node: local'))
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
  assert.ok(!messages.at(-1)!.content.includes(value))
  const replay = await (await send()).text()
  assert.equal(calls, 1); assert.ok(!replay.includes(value)); assert.ok(replay.includes('REDACTED'))
  const costs = f.service.snapshot('local').costs
  assert.equal(costs.length, 1); assert.equal(costs[0]!.costUsd, 0.003)
  assert.match(costs[0]!.source, /catalog_estimate/)
  const groups = await chat.app.request('/threads/models')
  assert.equal(chatModelsResponse.parse(await groups.json()).groups.length, 1)
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
  assert.equal(calls, 1) // Discovery only.
})

test('local dispatch gets localized harness identity without project paths', async t => {
  let prompt = ''
  const f = await setup(t), chat = chatFixture(f, t, { async *chatStream(request) {
    prompt = request.messages[0]!.content
    yield { model: request.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, done: true }
  } })
  chat.context.settings.update({ locale: 'ru' })
  const thread = chat.create('local-model')
  const response = await chat.app.request(`/threads/${thread.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })
  await response.text()
  assert.match(prompt, /Guanxi/); assert.match(prompt, /Узел: local/); assert.match(prompt, /Инструменты и разрешения/)
  const projectPrompt = harnessSystemPrompt('en', '/private/work/Project')
  assert.match(projectPrompt, /Project: "Project"/); assert.ok(!projectPrompt.includes('/private'))
})

test('provider Stop is durable and restart recovery never redispatches inference', async t => {
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
