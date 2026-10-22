import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Connections } from '../../src/connections/service.ts'
import type { OllamaChatRequest } from '../../src/ollama/types.ts'
import { RelayRuntimeSource, type RelayRuntimeModels } from '../../src/relay/runtime.ts'
import { RelayError } from '../../src/relay/types.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime, modelFileIdentity } from '../../src/runtime/llama-server/runtime.ts'
import { fakeRender, fakeTokens, startFakeLlama, type FakeLlama } from '../fixtures/fake-llama-server.ts'

const NOW = 1_800_000_000_000
async function fixture(t: { after(fn: () => unknown): void }, state: Parameters<typeof startFakeLlama>[0] = {}, options: { ready?: () => void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi-llama-runtime-'))
  const modelPath = join(directory, 'model.gguf')
  await writeFile(modelPath, 'GGUF-fixture-weights-one')
  const fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, buildInfo: 'b10964-fixture', ...state })
  let now = NOW
  const clock = () => now
  const runtime = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: fake.url }), model: 'fixture', clock, countTimeoutMs: 3000, ...options })
  t.after(async () => { await runtime.close(); await fake.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, modelPath, fake, runtime, clock, time(value: number) { now = value } }
}
const signal = () => new AbortController().signal
const request = (content: string, extra: Partial<OllamaChatRequest> = {}): OllamaChatRequest => ({ model: 'fixture', stream: false, think: false,
  messages: [{ role: 'user', content }], options: { num_ctx: 16000, num_predict: 500 }, ...extra })
const expectedCount = (content: string) => fakeTokens(fakeRender(content, { template: 'chat' }, false))
const code = (expected: string) => (error: unknown) => error instanceof RelayError && error.code === expected

test('observe reports the served identity: alias, SHA-256 of the GGUF, per-slot window, build, source and time', async t => {
  const f = await fixture(t), seen = await f.runtime.observe('fixture:latest', signal())
  assert.deepEqual(seen, { model: 'fixture:latest', digest: 'sha256:' + createHash('sha256').update('GGUF-fixture-weights-one').digest('hex'),
    contextTokens: 16000, runtimeVersion: 'llama-server/b10964-fixture', source: 'llama_server_props', observedAt: NOW })
})

test('the digest follows the file bytes: a replaced model is a different identity', async t => {
  const f = await fixture(t), first = await f.runtime.observe('fixture:latest', signal())
  assert.equal((await f.runtime.observe('fixture:latest', signal())).digest, first.digest)
  await writeFile(f.modelPath, 'GGUF-fixture-weights-TWO')
  const second = await f.runtime.observe('fixture:latest', signal())
  assert.notEqual(second.digest, first.digest)
  assert.equal(second.digest, 'sha256:' + createHash('sha256').update('GGUF-fixture-weights-TWO').digest('hex'))
  // Same size and content but a newer mtime: the identity key changed, the bytes did not.
  await utimes(f.modelPath, new Date(NOW), new Date(NOW + 5000))
  assert.equal((await f.runtime.observe('fixture:latest', signal())).digest, second.digest)
})

test('an unknown, differently named, unreadable or unintelligible server never yields an identity', async t => {
  const f = await fixture(t)
  await assert.rejects(f.runtime.observe('other:latest', signal()), code('runtime_identity_unknown'))
  await f.fake.configure({ alias: 'other' })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  await f.fake.configure({ alias: null })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  await f.fake.configure({ alias: 'fixture', modelPath: join(f.directory, 'missing.gguf') })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  await f.fake.configure({ modelPath: f.directory })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  await f.fake.configure({ modelPath: f.modelPath, propsOverride: { surprise: true } })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
})

test('spawn mode refuses a server that reports a different model file, or a file replaced after the process opened it', async t => {
  const f = await fixture(t)
  const other = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: f.fake.url }), model: 'fixture', expectedModel: { ...modelFileIdentity(f.modelPath), path: join(f.directory, 'different.gguf') } })
  t.after(() => other.close())
  await assert.rejects(other.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  const same = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: f.fake.url }), model: 'fixture', expectedModel: modelFileIdentity(f.modelPath) })
  t.after(() => same.close())
  assert.equal((await same.observe('fixture:latest', signal())).model, 'fixture:latest')
  // An atomic rename of a new file over the same path leaves the server on the old inode.
  await writeFile(join(f.directory, 'replacement.gguf'), 'GGUF-fixture-weights-one'); await rename(join(f.directory, 'replacement.gguf'), f.modelPath)
  await assert.rejects(same.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
  // Every attribute but the inode matches what the process is claimed to have opened.
  const current = modelFileIdentity(f.modelPath)
  const lookalike = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: f.fake.url }), model: 'fixture', expectedModel: { ...current, ino: current.ino + 1 } })
  t.after(() => lookalike.close())
  await assert.rejects(lookalike.observe('fixture:latest', signal()), code('runtime_identity_unknown'))
})

test('an unreachable server or a not-ready owner is the stock meter refusal, and cancellation stays a cancellation', async t => {
  let ready = false
  const f = await fixture(t, {}, { ready: () => { if (!ready) throw new RelayError('runtime_meter_unavailable') } })
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_meter_unavailable'))
  ready = true
  assert.equal((await f.runtime.observe('fixture:latest', signal())).model, 'fixture:latest')
  const controller = new AbortController(); controller.abort(new Error('canceled by owner'))
  await assert.rejects(f.runtime.observe('fixture:latest', controller.signal), /canceled by owner/)
  await f.fake.close()
  await assert.rejects(f.runtime.observe('fixture:latest', signal()), code('runtime_meter_unavailable'))
})

test('the counter binds its own observation, proves the template once per identity and counts the rendered think:false request exactly', async t => {
  const f = await fixture(t), fact = await f.runtime.observe('fixture:latest', signal())
  const counter = await f.runtime.counter({ ...fact }, signal())
  assert.deepEqual(counter.identity, { model: 'fixture:latest', digest: fact.digest, runtimeVersion: fact.runtimeVersion })
  assert.equal(counter.placement, 'installed_local'); assert.equal(counter.confidence, 'high')
  assert.equal(counter.source, 'llama-server:/apply-template+/tokenize')
  for (const content of ['x', 'two words', 'multi\nline <|special|> text', '界 ✓']) assert.equal(counter.count(request(content)), expectedCount(content), content)
  assert.ok(counter.count(request('framing')) > fakeTokens('framing'), 'template framing is part of the count')
  const isProbe = (r: { body: any }) => r.body.messages[0].content.startsWith('guanxi-render-probe')
  const proved = (await f.fake.requests('/apply-template')).filter(isProbe).length
  assert.equal(proved, 2, 'the proof renders once through the client and once through the synchronous bridge')
  await f.runtime.counter({ ...fact }, signal())
  assert.equal((await f.fake.requests('/apply-template')).filter(isProbe).length, proved, 'a second bind for the same identity does not prove it again')
  await f.fake.configure({ buildInfo: 'b10965-new' })
  const next = await f.runtime.observe('fixture:latest', signal())
  await f.runtime.counter({ ...next }, signal())
  assert.equal((await f.fake.requests('/apply-template')).filter(isProbe).length, proved + 2, 'a new served identity is proven again')
  for (const bad of [request('x', { think: true }), request('x', { think: undefined }), { ...request('x'), messages: [...request('x').messages, ...request('y').messages] },
    { ...request('x'), messages: [{ role: 'system' as const, content: 'x' }] }]) {
    assert.throws(() => counter.count(bad), code('runtime_request_changed'))
  }
})

test('a template that adds no framing, a repeated message or an unstable tokenizer is refused at bind, never guessed', async t => {
  const raw = await fixture(t, { template: 'raw' })
  await assert.rejects(raw.runtime.counter(await raw.runtime.observe('fixture:latest', signal()), signal()), code('runtime_counter_mismatch'))
  const unstable = await fixture(t, { tokenizeSkewAfter: 1 })
  await assert.rejects(unstable.runtime.counter(await unstable.runtime.observe('fixture:latest', signal()), signal()), code('runtime_counter_mismatch'))
  const echoing = await fixture(t)
  const client = new LlamaServerClient({ baseUrl: echoing.fake.url }), render = client.render.bind(client)
  client.render = async content => { const rendered = await render(content); return rendered + rendered }
  const twice = new LlamaServerRuntime({ client, model: 'fixture' }); t.after(() => twice.close())
  await assert.rejects(twice.counter(await twice.observe('fixture:latest', signal()), signal()), code('runtime_counter_mismatch'))
})

test('the relay runtime source admits the llama-server observer with exact facts and never touches Ollama', async t => {
  const f = await fixture(t)
  const untouched = new Proxy({} as RelayRuntimeModels, { get() { throw new Error('Ollama was consulted') } })
  const connections = { snapshot: () => ({ connections: [{ id: 'local', kind: 'local_runtime', unattended: true }], vault: { unattendedAvailable: true } }) } as unknown as Connections
  const source = new RelayRuntimeSource(connections, () => untouched, { maximumAgeMs: 1000, observer: f.runtime, counter: f.runtime.counter }, f.clock)
  const prepared = await source.prepare('local', 'fixture', 500, signal())
  const digest = 'sha256:' + createHash('sha256').update('GGUF-fixture-weights-one').digest('hex')
  assert.deepEqual(prepared.fact, { model: 'fixture:latest', digest, contextTokens: 16000, runtimeVersion: 'llama-server/b10964-fixture',
    source: 'llama_server_props', observedAt: NOW, confidence: 'high' })
  assert.deepEqual(prepared.meterFact, { source: 'llama-server:/apply-template+/tokenize', observedAt: NOW, confidence: 'high',
    measurement: 'exact_rendered_request', framing: 'included', computeCost: 'host_local_compute_policy' })
  assert.equal(prepared.meter.countIsExact, true); assert.equal(prepared.meter.localOnly, true)
  assert.equal(prepared.meter.transport, f.runtime.transport)
  assert.equal(prepared.meter.count('界 ✓'), expectedCount('界 ✓'))
  assert.deepEqual(await prepared.meter.observe(), { tokens: 16000, source: 'llama_server_props', observedAt: NOW, confidence: 'high', framingTokens: 0 })
  prepared.meter.validatePrepared!({ model: 'fixture', stream: false, think: false, messages: [{ role: 'user', content: 'x' }], options: { num_ctx: 16000, num_predict: 500 } })
  await assert.rejects(source.prepare('local', 'fixture:cloud', 500, signal()), code('relay_local_model_required'))
})

test('a stale observation, a replaced model, a new build, a new window or a stopped server invalidates an admitted meter', async t => {
  const connections = { snapshot: () => ({ connections: [{ id: 'local', kind: 'local_runtime', unattended: true }], vault: { unattendedAvailable: true } }) } as unknown as Connections
  const untouched = new Proxy({} as RelayRuntimeModels, { get() { throw new Error('Ollama was consulted') } })
  for (const mode of ['stale', 'weights', 'build', 'window', 'alias', 'down']) {
    const f = await fixture(t), source = new RelayRuntimeSource(connections, () => untouched, { maximumAgeMs: 1000, observer: f.runtime, counter: f.runtime.counter }, f.clock)
    const prepared = await source.prepare('local', 'fixture', 500, signal())
    await prepared.meter.observe()
    if (mode === 'stale') {
      f.time(NOW + 1001)
      assert.throws(() => prepared.meter.count('x'), /runtime_observation_stale/, 'a count after the admitted observations aged out is refused')
      await prepared.meter.observe()
      assert.equal(prepared.meter.count('x'), expectedCount('x'), 'a fresh observation restores it')
      continue
    }
    if (mode === 'weights') { await writeFile(f.modelPath, 'GGUF-other-weights-xx'); await assert.rejects(prepared.meter.observe(), /runtime_identity_changed/); continue }
    if (mode === 'build') await f.fake.configure({ buildInfo: 'b99999-new' })
    if (mode === 'window') await f.fake.configure({ nCtx: 32000 })
    if (mode === 'alias') await f.fake.configure({ alias: 'swapped' })
    if (mode === 'down') await f.fake.close()
    await assert.rejects(prepared.meter.observe(), mode === 'alias' ? /runtime_identity_unknown/ : mode === 'down' ? /runtime_meter_unavailable/ : /runtime_identity_changed/, mode)
  }
})

// ---- transport -----------------------------------------------------------------------------

function dispatchFor(prepared: OllamaChatRequest | (() => OllamaChatRequest), hooks: { authorize?: () => Promise<void> } = {}) {
  let prepares = 0
  return { prepares: () => prepares, dispatch: { authorizeDispatch: hooks.authorize ?? (async () => undefined),
    prepare: () => { prepares++; return typeof prepared === 'function' ? prepared() : prepared } } }
}
async function bound(t: { after(fn: () => unknown): void }, state: Parameters<typeof startFakeLlama>[0] = {}) {
  const f = await fixture(t, state)
  const fact = await f.runtime.observe('fixture:latest', signal())
  const counter = await f.runtime.counter({ ...fact }, signal())
  return { ...f, counter }
}

test('transport dispatches exactly the counted rendered string and reports llama-server usage in the Ollama shape', async t => {
  const f = await bound(t, { replies: ['{"action":"finish"}'] }), content = 'plan this\nplease', prepared = request(content)
  const n = f.counter.count(prepared)
  let started = 0
  const { dispatch, prepares } = dispatchFor(prepared)
  const chunk = await f.runtime.transport.chat(prepared, signal(), () => { started++ }, dispatch)
  assert.equal(chunk.prompt_eval_count, n); assert.equal(chunk.eval_count, fakeTokens('{"action":"finish"}', false))
  assert.equal(chunk.message?.content, '{"action":"finish"}'); assert.equal(chunk.done, true); assert.equal(chunk.done_reason, 'stop')
  assert.equal(started, 1, 'the dispatch observer fires once, for the completion only'); assert.equal(prepares(), 2)
  const posts = await f.fake.requests('/completion')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0]!.body, { prompt: fakeRender(content, { template: 'chat' }, false), n_predict: 500, stream: false, cache_prompt: true })
  assert.equal(f.runtime.transport.id, 'llama-server'); assert.equal(f.runtime.transport.host, f.fake.url)
  await f.fake.configure({ stopType: 'limit' })
  assert.equal((await f.runtime.transport.chat(prepared, signal(), () => {}, dispatchFor(prepared).dispatch)).done_reason, 'length')
})

test('a count that disagrees with the synchronous measure, a truncated prompt or a window overrun never reaches the model as accepted work', async t => {
  const f = await bound(t, { replies: ['{}'] }), prepared = request('disagree about me')
  f.counter.count(prepared)
  const tokenizes = (await f.fake.count('/tokenize'))
  await f.fake.configure({ tokenizeSkewAfter: tokenizes })
  await assert.rejects(f.runtime.transport.chat(prepared, signal(), () => {}, dispatchFor(prepared).dispatch), code('runtime_counter_mismatch'))
  assert.equal(await f.fake.count('/completion'), 0, 'refused before the first token was evaluated')
  await f.fake.configure({ tokenizeSkewAfter: null, truncated: true })
  await assert.rejects(f.runtime.transport.chat(prepared, signal(), () => {}, dispatchFor(prepared).dispatch), code('truncation_protocol'))
  await f.fake.configure({ truncated: false })
  const tight = request('disagree about me', { options: { num_ctx: 20, num_predict: 500 } })
  await assert.rejects(f.runtime.transport.chat(tight, signal(), () => {}, dispatchFor(tight).dispatch), code('context_ceiling'))
  assert.equal(await f.fake.count('/completion'), 1, 'only the truncated attempt reached the model, and it was rejected')
})

test('the final fence check and the POST share one synchronous stretch: a revocation during the asynchronous count dispatches nothing', async t => {
  const f = await bound(t), prepared = request('fenced')
  let calls = 0
  const revoked = dispatchFor(() => { if (++calls === 2) throw new RelayError('stale_lease'); return prepared })
  await assert.rejects(f.runtime.transport.chat(prepared, signal(), () => {}, revoked.dispatch), code('stale_lease'))
  assert.equal(await f.fake.count('/completion'), 0)
  let changed = 0
  const rewritten = dispatchFor(() => ++changed === 1 ? prepared : request('different after the count'))
  await assert.rejects(f.runtime.transport.chat(prepared, signal(), () => {}, rewritten.dispatch), code('runtime_request_changed'))
  assert.equal(await f.fake.count('/completion'), 0)
  const denied = dispatchFor(prepared, { authorize: async () => { throw new RelayError('relay_stopped') } })
  await assert.rejects(f.runtime.transport.chat(prepared, signal(), () => {}, denied.dispatch), code('relay_stopped'))
  assert.equal(denied.prepares(), 0, 'authorization precedes final preparation')
})

test('cancellation during the asynchronous count or the completion surfaces as cancellation and leaves no running request', async t => {
  const f = await bound(t, { tokenizeDelayMs: 300 }), prepared = request('cancel me')
  f.counter.count(prepared)
  const early = new AbortController(), pending = f.runtime.transport.chat(prepared, early.signal, () => {}, dispatchFor(prepared).dispatch)
  setTimeout(() => early.abort(new Error('stop during count')), 30)
  await assert.rejects(pending, /stop during count/)
  assert.equal(await f.fake.count('/completion'), 0)
  await f.fake.configure({ tokenizeDelayMs: 0, completionDelayMs: 400 })
  const late = new AbortController(), running = f.runtime.transport.chat(prepared, late.signal, () => late.abort(new Error('stop during completion')), dispatchFor(prepared).dispatch)
  await assert.rejects(running, /stop during completion/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await f.fake.aborted(), 1)
})

test('no await separates the final fence check from the POST: nothing queued after the check can run before the request is issued', async t => {
  const f = await fixture(t)
  let microtaskRan = false, issuedAfterMicrotask: boolean | undefined
  const client = new LlamaServerClient({ baseUrl: f.fake.url, fetch: (url, init) => {
    if (String(url).endsWith('/completion')) issuedAfterMicrotask = microtaskRan
    return fetch(url, init)
  } })
  const runtime = new LlamaServerRuntime({ client, model: 'fixture', clock: f.clock, countTimeoutMs: 3000 }); t.after(() => runtime.close())
  const counter = await runtime.counter(await runtime.observe('fixture:latest', signal()), signal()), prepared = request('ordered')
  counter.count(prepared)
  let calls = 0
  // The fence check is the second prepare(); anything it schedules would run at the first await after it.
  const dispatch = { authorizeDispatch: async () => undefined, prepare: () => { if (++calls === 2) queueMicrotask(() => { microtaskRan = true }); return prepared } }
  await runtime.transport.chat(prepared, signal(), () => {}, dispatch)
  assert.equal(issuedAfterMicrotask, false, 'the POST was issued in the same synchronous stretch as the final check')
})
