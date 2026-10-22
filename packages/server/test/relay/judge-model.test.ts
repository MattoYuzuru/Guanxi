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
