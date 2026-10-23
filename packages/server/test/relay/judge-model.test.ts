import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { createKernel } from '@guanxi/kernel'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import type { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { connectionsPlugin } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import { egressScrubberPlugin } from '../../src/egress/plugin.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'
import {
  ConnectionJudgeModel,
  type InstalledJudgeAttestation
} from '../../src/relay/judge-model.ts'
import type { JudgeRole } from '../../src/relay/delegation-brief.ts'
import type { VaultKeychain } from '../../src/vault/keychain.ts'

const now = 1800000000000,
  account = 'real-t0-fixture-owner'
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
async function setup(t: { after(fn: () => unknown): void }, fetch: typeof globalThis.fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-r3-judge-')),
    kernel = createKernel(),
    keys = new Map<string, Buffer>()
  const keychain: VaultKeychain = {
    key(owner, create, purpose) {
      const id = JSON.stringify([owner, purpose])
      if (!keys.has(id) && create) keys.set(id, randomBytes(32))
      if (!keys.has(id)) throw new Error('fixture missing key')
      return Buffer.from(keys.get(id)!)
    }
  }
  await kernel.plugin(resourceGovernorPlugin)
  const transport: typeof globalThis.fetch = (url, init) =>
    String(url).endsWith('/api/version')
      ? Promise.resolve(Response.json({ version: '0.32.0' }))
      : fetch(url, init)
  await kernel.plugin(ollamaAdapterPlugin, { fetch: transport })
  await kernel.plugin(egressScrubberPlugin, { expectedSources: ['vault'] })
  await kernel.plugin(connectionsPlugin, {
    databasePath: join(dir, 'k3.sqlite'),
    localHost: () => 'http://127.0.0.1:11434',
    policy: { ownerDevice: true, nodeKeyOptIn: true },
    keychain: async () => keychain,
    transport: fetch
  })
  t.after(async () => {
    await kernel.dispose()
    await rm(dir, { recursive: true, force: true })
    for (const key of keys.values()) key.fill(0)
  })
  const connections = kernel.service<Connections>('connections.registry')!,
    scrubber = kernel.service<EgressScrubber>('egress.scrubber')!
  const row = connections.create(account, {
    name: 'Fixture local',
    kind: 'local_runtime',
    provider: 'ollama',
    auth: 'none'
  })
  connections.setUnattended(account, row.id, true)
  const role: JudgeRole = {
    connectionId: row.id,
    model: 'fixture-local',
    windowTokens: 16000,
    maxInputTokens: 12000,
    maxOutputTokens: 1000,
    temperature: 0,
    tokenReserve: 13000,
    moneyReserveMicros: 0
  }
  const fact: InstalledJudgeAttestation = {
    accountId: account,
    connectionId: row.id,
    model: role.model,
    placement: 'installed-local',
    digest: 'a'.repeat(64),
    source: 'fixture:installed-inventory',
    observedAt: now,
    confidence: 'high',
    unattended: true
  }
  const meter = {
    countIsExact: true as const,
    observe: async () => ({
      tokens: 16000,
      framingTokens: 0,
      source: 'fixture:loaded-rendered',
      observedAt: now,
      confidence: 'high' as const
    }),
    count: (text: string) => Buffer.byteLength(text)
  }
  const governor = kernel.service<ResourceGovernor>('governor')!
  return { connections, scrubber, role, fact, meter, governor }
}

test('actual K3 uses explicit owner account, one fresh tool-free request and final secret scrub', async (t) => {
  const requests: Record<string, unknown>[] = [],
    f = await setup(t, async (_url, init) => {
      const body = JSON.parse(String(init!.body))
      requests.push(body)
      return Response.json({
        message: { role: 'assistant', content: '{"fixture":true}' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: Buffer.byteLength(body.messages[0].content),
        eval_count: 5
      })
    })
  f.scrubber.register('secret://judge-fixture', 'synthetic-judge-secret')
  const model = new ConnectionJudgeModel(
    f.connections,
    account,
    f.meter,
    f.scrubber,
    async () => f.fact,
    1000,
    () => now
  )
  const signal = new AbortController().signal,
    input = { accountId: account, role: f.role, signal }
  assert.equal(await model.admit(input), true)
  for (let n = 0; n < 2; n++)
    await model.sample({
      ...input,
      runId: 'run',
      requestId: `sample-${n}`,
      prompt: 'quoted synthetic-judge-secret',
      check: () => {}
    })
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(Object.hasOwn(request, 'tools'), false)
    assert.equal((request.messages as unknown[]).length, 1)
    assert.equal(JSON.stringify(request).includes('synthetic-judge-secret'), false)
  }
  assert.equal(f.connections.snapshot('local').connections.length, 0)
  assert.equal(f.connections.snapshot(account).costs.length, 2)
})
test('unknown/stale/future/foreign/cloud placement refuses before any actual K3 post', async (t) => {
  let posts = 0
  const f = await setup(t, async () => {
    posts++
    throw new Error('must not dispatch')
  })
  const facts = [
    null,
    { ...f.fact, observedAt: now - 1001 },
    { ...f.fact, observedAt: now + 1 },
    { ...f.fact, accountId: 'foreign' },
    { ...f.fact, placement: 'cloud' as 'installed-local' }
  ]
  for (const fact of facts) {
    const model = new ConnectionJudgeModel(
        f.connections,
        account,
        f.meter,
        f.scrubber,
        async () => fact,
        1000,
        () => now
      ),
      input = { accountId: account, role: f.role, signal: new AbortController().signal }
    if (fact === null) assert.equal(await model.admit(input), false)
    else await assert.rejects(model.admit(input))
  }
  const cloudRole = { ...f.role, model: 'fixture:cloud' },
    cloud = new ConnectionJudgeModel(
      f.connections,
      account,
      f.meter,
      f.scrubber,
      async () => ({ ...f.fact, model: cloudRole.model }),
      1000,
      () => now
    )
  await assert.rejects(
    cloud.admit({ accountId: account, role: cloudRole, signal: new AbortController().signal })
  )
  assert.equal(posts, 0)
})
test('K3 governor-held late revocation refuses before transport and releases permit', async (t) => {
  let posts = 0
  const f = await setup(t, async () => {
    posts++
    throw new Error('zero dispatch expected')
  })
  const model = new ConnectionJudgeModel(
      f.connections,
      account,
      f.meter,
      f.scrubber,
      async () => f.fact,
      1000,
      () => now
    ),
    signal = new AbortController().signal,
    input = { accountId: account, role: f.role, signal }
  await model.admit(input)
  const ticket = f.governor.enqueue({
    owner: { kind: 'operation', operationId: 'fixture-block' },
    operation: 'chat',
    model: { provider: 'ollama', name: 'other' },
    requestedContext: 16000,
    priority: 'normal',
    enqueuedAt: new Date(now).toISOString()
  })
  const lease = await f.governor.acquire(ticket),
    started = deferred()
  let live = true,
    checks = 0
  const task = model.sample({
    ...input,
    runId: 'run',
    requestId: 'queued',
    prompt: 'fixture',
    check: () => {
      checks++
      started.resolve()
      if (!live) throw new Error('stale_lease')
    }
  })
  await started.promise
  live = false
  lease.release()
  await assert.rejects(task)
  assert.ok(checks >= 2)
  assert.equal(posts, 0)
  const next = f.governor.enqueue({
    owner: { kind: 'operation', operationId: 'after' },
    operation: 'chat',
    model: { provider: 'ollama', name: 'other' },
    requestedContext: 16000,
    priority: 'normal',
    enqueuedAt: new Date(now).toISOString()
  })
  const released = await f.governor.acquire(next)
  released.release()
})

test('an older cached window expires independently of fresh inventory before sample entry', async (t) => {
  let posts = 0,
    clock = now
  const f = await setup(t, async () => {
    posts++
    throw new Error('zero dispatch expected')
  })
  const meter = {
    ...f.meter,
    observe: async () => ({ ...(await f.meter.observe()), observedAt: now - 900 })
  }
  const model = new ConnectionJudgeModel(
    f.connections,
    account,
    meter,
    f.scrubber,
    async () => f.fact,
    1000,
    () => clock
  )
  const input = { accountId: account, role: f.role, signal: new AbortController().signal }
  assert.equal(await model.admit(input), true)
  clock += 200
  await assert.rejects(
    model.sample({
      ...input,
      runId: 'run',
      requestId: 'old-window',
      prompt: 'fixture',
      check: () => {}
    }),
    /judge_window_unknown/
  )
  assert.equal(posts, 0)
  assert.equal(f.governor.snapshot().activeLease, null)
})
test('queued governor window expiry refuses at final preparation while inventory remains fresh', async (t) => {
  let posts = 0,
    clock = now
  const f = await setup(t, async () => {
    posts++
    throw new Error('zero dispatch expected')
  })
  const meter = {
    ...f.meter,
    observe: async () => ({ ...(await f.meter.observe()), observedAt: now - 900 })
  }
  const model = new ConnectionJudgeModel(
    f.connections,
    account,
    meter,
    f.scrubber,
    async () => f.fact,
    1000,
    () => clock
  )
  const input = { accountId: account, role: f.role, signal: new AbortController().signal }
  await model.admit(input)
  const ticket = f.governor.enqueue({
    owner: { kind: 'operation', operationId: 'old-window-block' },
    operation: 'chat',
    model: { provider: 'ollama', name: 'other' },
    requestedContext: 16000,
    priority: 'normal',
    enqueuedAt: new Date(now).toISOString()
  })
  const lease = await f.governor.acquire(ticket),
    entered = deferred()
  const task = model.sample({
    ...input,
    runId: 'run',
    requestId: 'queued-window',
    prompt: 'fixture',
    check: () => entered.resolve()
  })
  try {
    await entered.promise
    clock += 200
    lease.release()
    await assert.rejects(task)
    assert.equal(posts, 0)
    assert.equal(f.governor.snapshot().activeLease, null)
  } finally {
    lease.release()
  }
})

// ---- R3-remote: a meter that names a runtime transport ---------------------------------------------------------------------

const noScrubber = {} as EgressScrubber, noConnections = {} as Connections
const transport = { id: 'llama-server', host: 'federation://executor', usageSource: 'federation:llama-server:/completion', remote: { nodeId: 'executor' },
  chat: async () => { throw new Error('not dispatched here') } }
const transportMeter = { countIsExact: true as const, localOnly: true, transport, count: () => 1, countAsync: async () => 1,
  observe: async () => ({ tokens: 16000, framingTokens: 0, source: 'fixture:loaded', observedAt: now, confidence: 'high' as const }) }
const binding = { connectionId: 'relay-connection', model: 'fixture' }
const build = (meter: unknown, runtime?: { connectionId: string; model: string }) =>
  new ConnectionJudgeModel(noConnections, account, meter as never, noScrubber, async () => null, 1000, () => now, runtime)

test('a transport meter is accepted only bound to the one connection and model its runtime serves; a stock meter is unchanged', () => {
  assert.doesNotThrow(() => build(transportMeter, binding), 'consistent: counted and served by the same runtime')
  assert.doesNotThrow(() => build({ ...transportMeter, countAsync: undefined }, binding), 'a local llama-server counts synchronously and is dispatched through its transport')
  assert.doesNotThrow(() => build({ countIsExact: true, observe: transportMeter.observe, count: () => 1 }), 'a stock Ollama meter needs no binding')
  assert.throws(() => build(transportMeter), /judge_config_invalid/, 'a transport with no named runtime')
  assert.throws(() => build(transportMeter, { connectionId: '', model: 'fixture' }), /judge_config_invalid/)
  assert.throws(() => build(transportMeter, { connectionId: 'c', model: 'bad model!' }), /judge_config_invalid/)
  assert.throws(() => build({ ...transportMeter, transport: undefined }, binding), /judge_config_invalid/, 'counted asynchronously by a runtime the dispatch would not use')
  assert.throws(() => build({ countIsExact: true, observe: transportMeter.observe, count: () => 1, countAsync: async () => 1 }), /judge_config_invalid/)
  assert.throws(() => build({ ...transportMeter, countIsExact: false }, binding), /judge_config_invalid/, 'no exact source')
  assert.throws(() => build({ ...transportMeter, countIsExact: undefined }, binding), /judge_config_invalid/)
})
test('a role that is not served by the runtime that counts is refused at admission, before any attestation or call', async () => {
  let attested = 0
  const model = new ConnectionJudgeModel(noConnections, account, transportMeter as never, noScrubber, async () => { attested++; return null }, 1000, () => now, binding)
  const role = { connectionId: 'relay-connection', model: 'fixture', windowTokens: 16000, maxInputTokens: 12000, maxOutputTokens: 1000, temperature: 0, tokenReserve: 13000, moneyReserveMicros: 0 }
  const signal = new AbortController().signal
  for (const other of [{ connectionId: 'another-connection' }, { model: 'another-model' }, { model: 'fixture:cloud' }])
    await assert.rejects(model.admit({ accountId: account, role: { ...role, ...other }, signal }), /judge_config_invalid/)
  assert.equal(attested, 0)
  assert.equal(await model.admit({ accountId: account, role: { ...role, model: ' FIXTURE ' }, signal }), false, 'the same model by another spelling reaches attestation (which declined)')
  assert.equal(attested, 1)
})

// ---- R3-remote: the judge dispatches through the transport that counts, on real K3 ----------------------------------------

/** A llama-server-shaped meter and transport on loopback: the count and the evaluation are the same runtime's. */
function runtimeMeter(f: Awaited<ReturnType<typeof setup>>, options: { async?: boolean; evaluated?: (counted: number) => number; counted?: number } = {}) {
  const calls: string[] = [], known = new Map<string, number>(), requests: Array<Record<string, unknown>> = []
  const size = (text: string) => options.counted ?? Buffer.byteLength(text)
  const meter = {
    countIsExact: true as const, localOnly: true,
    observe: async () => ({ tokens: 16000, framingTokens: 0, source: 'fixture:loaded-rendered', observedAt: now, confidence: 'high' as const }),
    authorizeDispatch: async () => { calls.push('authorize') },
    count: (text: string) => { calls.push('count'); const n = options.async ? known.get(text) : size(text); if (n === undefined) throw new Error('uncounted string'); return n },
    ...(options.async ? { countAsync: async (text: string) => { calls.push('countAsync'); known.set(text, size(text)); return size(text) } } : {}),
    transport: { id: 'llama-server', host: 'http://127.0.0.1:8099', usageSource: 'fixture:llama-server',
      async chat(request: Record<string, unknown>, _signal: AbortSignal, onDispatched: () => void, dispatch: { authorizeDispatch(): Promise<void>; prepare(): Record<string, any> }) {
        calls.push('chat'); await dispatch.authorizeDispatch()
        const first = dispatch.prepare(); requests.push(first); onDispatched()
        const counted = known.get(first.messages[0].content) ?? size(first.messages[0].content)
        return { model: String(request['model']), created_at: new Date(now).toISOString(), done: true, done_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' },
          prompt_eval_count: options.evaluated ? options.evaluated(counted) : counted, eval_count: 7 }
      } },
  }
  return { meter, calls, requests, role: { ...f.role }, binding: { connectionId: f.role.connectionId, model: f.role.model } }
}
const never: typeof globalThis.fetch = async () => { throw new Error('the Ollama path must not be used') }

for (const asynchronous of [false, true]) {
  test(`a ${asynchronous ? 'remote (asynchronously counted)' : 'local llama-server'} meter: count, authorization and dispatch all go through the meter's own runtime, never Ollama`, async t => {
    const f = await setup(t, never), r = runtimeMeter(f, { async: asynchronous })
    f.scrubber.register('secret://judge-fixture', 'synthetic-judge-secret')
    const model = new ConnectionJudgeModel(f.connections, account, r.meter as never, f.scrubber, async () => f.fact, 1000, () => now, r.binding)
    const input = { accountId: account, role: r.role, signal: new AbortController().signal }
    assert.equal(await model.admit(input), true)
    assert.equal(await model.sample({ ...input, runId: 'run', requestId: 'sample-0', prompt: 'quoted synthetic-judge-secret', check: () => {} }), '{"ok":true}')
    assert.deepEqual(r.calls, asynchronous ? ['countAsync', 'chat', 'authorize', 'count'] : ['chat', 'authorize', 'count'], JSON.stringify(r.calls))
    const [request] = r.requests
    assert.equal(request!['think'], false); assert.equal(request!['stream'], false); assert.equal(request!['model'], r.role.model)
    assert.deepEqual(request!['options'], { num_ctx: 16000, num_predict: 1000, temperature: 0 })
    assert.equal(JSON.stringify(request).includes('synthetic-judge-secret'), false, 'scrubbed before it reaches the runtime')
    assert.equal(f.connections.snapshot(account).costs.length, 1, 'K3 recorded the usage with the transport\'s source')
    assert.equal(f.governor.snapshot().activeLease, null)
  })
}
test('a runtime that evaluates other tokens than were counted gives the judge no result', async t => {
  const f = await setup(t, never), r = runtimeMeter(f, { async: true, evaluated: n => n + 1 })
  const model = new ConnectionJudgeModel(f.connections, account, r.meter as never, f.scrubber, async () => f.fact, 1000, () => now, r.binding)
  const input = { accountId: account, role: r.role, signal: new AbortController().signal }
  await model.admit(input)
  await assert.rejects(model.sample({ ...input, runId: 'run', requestId: 's', prompt: 'fixture', check: () => {} }), /judge_usage_invalid/)
})
test('an input the runtime counts above the judge\'s ceiling is refused before the runtime is asked to evaluate it', async t => {
  const f = await setup(t, never), r = runtimeMeter(f, { async: true, counted: 12001 })
  const model = new ConnectionJudgeModel(f.connections, account, r.meter as never, f.scrubber, async () => f.fact, 1000, () => now, r.binding)
  const input = { accountId: account, role: r.role, signal: new AbortController().signal }
  await model.admit(input)
  await assert.rejects(model.sample({ ...input, runId: 'run', requestId: 's', prompt: 'fixture', check: () => {} }), /judge_context_ceiling/)
  assert.deepEqual(r.calls, ['countAsync'], 'counted, then nothing: no authorization and no dispatch')
})
test('a transport meter cannot reach a role on another connection or model through K3', async t => {
  const f = await setup(t, never), r = runtimeMeter(f, { async: true })
  const model = new ConnectionJudgeModel(f.connections, account, r.meter as never, f.scrubber, async () => f.fact, 1000, () => now, r.binding)
  for (const other of [{ model: 'another-model' }, { connectionId: 'another-connection' }]) {
    const role = { ...r.role, ...other }
    await assert.rejects(model.admit({ accountId: account, role, signal: new AbortController().signal }), /judge_config_invalid/)
    // A role that was never admitted cannot be sampled either.
    await assert.rejects(model.sample({ accountId: account, role, signal: new AbortController().signal, runId: 'run', requestId: 's', prompt: 'x', check: () => {} }))
  }
  assert.deepEqual(r.calls, [])
})
