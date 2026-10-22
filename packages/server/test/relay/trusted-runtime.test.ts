import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunningModel } from '@guanxi/contract'
import type { Connections } from '../../src/connections/service.ts'
import { RelayRuntimeSource, type RelayExactCounter } from '../../src/relay/runtime.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'

const now = 1_800_000_000_000
function fixture() {
  let currentTime = now, sourceCalls = 0, local = true, unattended = true, available = true
  const running: RunningModel[] = [{ name: 'fixture:latest', digest: 'fixture-digest', sizeBytes: 1, sizeVramBytes: null,
    gpuPercent: null, processorLabel: null, contextLength: 16000, expiresAt: null, source: 'ollama_api_ps', observedAt: new Date(now).toISOString() }]
  const installed = [{ name: 'fixture:latest', digest: 'fixture-digest' }]
  const source = { runtimeHost: 'http://127.0.0.1:11434', async ps() { sourceCalls++; return running },
    async installedArtifacts() { return installed }, async runtimeVersion() { return 'fixture-v1' } }
  const connections = { snapshot: () => ({ connections: [{ id: 'local', kind: local ? 'local_runtime' : 'model_api', unattended }],
    vault: { unattendedAvailable: available } }) } as unknown as Connections
  const counter: RelayExactCounter = { identity: { model: 'fixture:latest', digest: 'fixture-digest', runtimeVersion: 'fixture-v1' },
    placement: 'installed_local', source: 'fixture-exact-renderer', observedAt: now, confidence: 'high',
    count(request) { assert.equal(request.think, false); assert.equal(request.messages.length, 1)
      return Buffer.byteLength(request.messages[0]!.content) + 5 } }
  const signal = new AbortController()
  return { running, installed, source, connections, counter, signal, calls: () => sourceCalls,
    time(value: number) { currentTime = value }, local(value: boolean) { local = value }, consent(value: boolean) { unattended = value },
    nodeConsent(value: boolean) { available = value },
    runtime: (bind: ((fact: any, signal: AbortSignal) => Promise<RelayExactCounter>) | undefined = async () => counter) =>
      new RelayRuntimeSource(connections, () => source, { maximumAgeMs: 1000, counter: bind }, () => currentTime) }
}

test('trusted runtime derives W and identity from loaded/installed observations and counts complete framing exactly once', async () => {
  const f = fixture(), prepared = await f.runtime().prepare('local', 'fixture', 1000, f.signal.signal)
  assert.deepEqual(prepared.fact, { model: 'fixture:latest', digest: 'fixture-digest', contextTokens: 16000,
    runtimeVersion: 'fixture-v1', source: 'ollama_api_ps', observedAt: now, confidence: 'high' })
  assert.equal(prepared.meter.countIsExact, true); assert.equal(prepared.meter.count('界'), 8)
  assert.deepEqual(prepared.meterFact, { source: 'fixture-exact-renderer', observedAt: now, confidence: 'high',
    measurement: 'exact_rendered_request', framing: 'included', computeCost: 'host_local_compute_policy' })
  assert.equal((await prepared.meter.observe()).framingTokens, 0)
  f.time(now + 2000)
  await assert.rejects(prepared.meter.observe(), /runtime_observation_stale/)
})

test('missing counter, local consent or placement refuses before model effects; no fabricated source fallback', async () => {
  const f = fixture(), runtime = new RelayRuntimeSource(f.connections, () => f.source, { maximumAgeMs: 1000 })
  await assert.rejects(runtime.prepare('local', 'fixture', 1000, f.signal.signal), /runtime_meter_unavailable/)
  assert.equal(f.calls(), 0)
  for (const change of [() => f.local(false), () => { f.local(true); f.consent(false) }, () => { f.consent(true); f.nodeConsent(false) }]) {
    change(); await assert.rejects(f.runtime().prepare('local', 'fixture', 1000, f.signal.signal), /relay_local_connection_required/)
  }
  f.nodeConsent(true)
  await assert.rejects(f.runtime().prepare('local', 'fixture:cloud', 1000, f.signal.signal), /relay_local_model_required/)
  const cloud = { ...f.counter, placement: 'cloud' } as unknown as RelayExactCounter
  await assert.rejects(f.runtime(async () => cloud).prepare('local', 'fixture', 1000, f.signal.signal), /runtime_counter_mismatch/)
})

test('ambiguous/missing/different installed identity and stale/future loaded facts fail closed', async () => {
  for (const mode of ['ambiguous', 'missing', 'digest', 'stale', 'future']) {
    const f = fixture()
    if (mode === 'ambiguous') f.running.push({ ...f.running[0]! })
    if (mode === 'missing') f.installed.length = 0
    if (mode === 'digest') f.installed[0]!.digest = 'replacement'
    if (mode === 'stale') f.running[0]!.observedAt = new Date(now - 1001).toISOString()
    if (mode === 'future') f.running[0]!.observedAt = new Date(now + 1).toISOString()
    await assert.rejects(f.runtime().prepare('local', 'fixture', 1000, f.signal.signal), /runtime_identity_unknown|runtime_observation_stale/)
  }
})

test('a changed window, digest, runtime version or host invalidates an already admitted meter', async () => {
  for (const mode of ['window', 'digest', 'version', 'host']) {
    const f = fixture(), prepared = await f.runtime().prepare('local', 'fixture', 1000, f.signal.signal)
    if (mode === 'window') f.running[0]!.contextLength = 32000
    if (mode === 'digest') { f.running[0]!.digest = 'replacement'; f.installed[0]!.digest = 'replacement' }
    if (mode === 'version') f.source.runtimeVersion = async () => 'fixture-v2'
    if (mode === 'host') f.source.runtimeHost = 'http://127.0.0.1:11435'
    await assert.rejects(prepared.meter.observe(), /runtime_identity_changed/)
  }
})

test('exact meter rejects a final request with a different renderer shape or refreshed counter source', async () => {
  const f = fixture(), prepared = await f.runtime().prepare('local', 'fixture', 1000, f.signal.signal)
  const request = { model: 'fixture', stream: false, think: false,
    messages: [{ role: 'user' as const, content: 'fixture prompt' }], options: { num_ctx: 16000, num_predict: 1000 } }
  prepared.meter.validatePrepared!(request)
  for (const changed of [{ ...request, model: 'other' }, { ...request, think: true },
    { ...request, options: { ...request.options, num_ctx: 32000 } },
    { ...request, options: { ...request.options, num_predict: 1001 } },
    { ...request, messages: [...request.messages, { role: 'user' as const, content: 'extra' }] }]) {
    assert.throws(() => prepared.meter.validatePrepared!(changed), /runtime_request_changed/)
  }
  f.counter.source = 'different-renderer'
  await assert.rejects(prepared.meter.observe(), /runtime_counter_mismatch/)
})

test('late counter observation cannot cross stop; per-call wall signal unblocks a noncooperative runtime read', async () => {
  const f = fixture()
  let release!: (counter: RelayExactCounter) => void
  const pending = f.runtime(async () => new Promise(resolve => { release = resolve })).prepare('local', 'fixture', 1000, f.signal.signal)
  await new Promise(resolve => setImmediate(resolve)); f.signal.abort()
  await assert.rejects(pending, /relay_stopped/)
  release(f.counter)
  const other = fixture(), prepared = await other.runtime().prepare('local', 'fixture', 1000, other.signal.signal)
  other.source.ps = async () => new Promise(() => {})
  const wall = new AbortController(), observation = prepared.meter.observe(wall.signal)
  wall.abort()
  await assert.rejects(observation, /relay_stopped/)
})

test('final prepared prompt is measured after scrubbing and exact usage mismatch remains a protocol fact', async () => {
  const f = fixture(), prepared = await f.runtime().prepare('local', 'fixture', 1000, f.signal.signal)
  let dispatched = 0, inputTokens = 24
  const connections = { ...f.connections, snapshot: f.connections.snapshot.bind(f.connections),
    async localChat(_account: string, _id: string, request: any, call: any) {
      request.messages[0].content = 'expanded final text'
      await call.authorizeDispatch(); call.onPrepared(request); dispatched++
      return { message: { content: '{}' }, prompt_eval_count: inputTokens, eval_count: 1, done_reason: 'stop' }
    } } as unknown as Connections
  const model = new ConnectionRelayModel(connections, 'local', 'fixture', prepared.meter)
  assert.equal(model.countIsExact, true)
  const options = { runId: 'run', requestId: 'request', maxOutput: 1000, maxInput: 10, window: await model.observe() }
  await assert.rejects(model.call('x', options), /context_ceiling/); assert.equal(dispatched, 0)
  const reply = await model.call('x', { ...options, maxInput: 100 })
  assert.equal(reply.inputTruncated, false); assert.equal(dispatched, 1)
  inputTokens = 23
  assert.equal((await model.call('x', { ...options, maxInput: 100 })).inputTruncated, true)
})
