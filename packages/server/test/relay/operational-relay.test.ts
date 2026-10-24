import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Hono } from 'hono'
import type { RelayStartInput } from '@guanxi/contract'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import { createOperationalRelay } from '../../src/relay/operational.ts'
import { relayStartRoutes } from '../../src/relay/routes.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { LlamaServerClient } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerRuntime } from '../../src/runtime/llama-server/runtime.ts'
import { Vault } from '../../src/vault/vault.ts'
import { RUN_TIME, runFixture } from '../fixtures/durable-runs.ts'
import { fakeRender, reply, startFakeLlama, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'
import { caps, reserves } from './fixture.ts'

const exec = promisify(execFile), peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
async function until(predicate: () => boolean | Promise<boolean>, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('fixture did not reach the expected state')
}
/** The same three-step script the Ollama fixture uses: read a file, verify the item, hand off. */
const script = reply(prompt => {
  const state = globalThis as unknown as { work?: number }
  if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
  state.work = (state.work ?? 0) + 1
  return JSON.stringify(state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
    : state.work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
})

async function fixture(t: { after(fn: () => unknown): void }, options: { fake?: Partial<FakeLlamaState>; remove?: (path: string) => Promise<void>; git?: string } = {}) {
  // Match the K4 fixtures: Colima shares the checkout, not macOS tmpdir().
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'operational-relay-')))
  const source = join(parent, 'project'), checkouts = join(parent, 'checkouts'), modelPath = join(parent, 'model.gguf')
  await mkdir(join(source, 'src'), { recursive: true }); await writeFile(join(source, 'src', 'item.txt'), 'synthetic task content'); await writeFile(modelPath, 'GGUF-operational-weights')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: source })).stdout.trim()
  await git(['init', '-q', '-b', 'main']); await git(['add', '.']); await git(['commit', '-q', '-m', 'fixture'])
  const base = await git(['rev-parse', 'HEAD'])
  await writeFile(join(source, 'src', 'later.txt'), 'committed after the plan base'); await git(['add', '.']); await git(['commit', '-q', '-m', 'later'])
  const fake = await startFakeLlama({ alias: 'fixture', modelPath, nCtx: 16000, replies: [script], ...options.fake })
  let now = RUN_TIME
  const f = runFixture(':memory:')
  const relay = new RelayStore(f.db, f.store, f.scrubber, () => now), governor = new ResourceGovernor(), life = new AbortController()
  const connectionStore = new ConnectionStore(join(parent, 'connections.sqlite'), f.scrubber)
  const vault = new Vault(connectionStore, async () => { throw new Error('No fixture keychain') }, f.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  let ollama = 0
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async () => { ollama++; throw new Error('Ollama must not be used by an llama-server relay') } })
  const connections = new Connections(connectionStore, vault, new BalanceProbes(connectionStore, vault), f.scrubber, life.signal,
    { client: () => client }, governor, () => 'http://127.0.0.1:11434')
  const connection = connections.create('local', { name: 'Fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const runtime = new LlamaServerRuntime({ client: new LlamaServerClient({ baseUrl: fake.url }), model: 'fixture', clock: () => now, countTimeoutMs: 5000 })
  const source_ = new RelayRuntimeSource(connections, () => { throw new Error('Ollama models must not be consulted') },
    { maximumAgeMs: 10_000, observer: runtime, counter: runtime.counter }, () => now)
  let allocations = 0
  const allocator = new OwnedCheckoutAllocator({ root: checkouts, ...(options.remove ? { remove: options.remove } : {}), ...(options.git ? { git: options.git } : {}) })
  const host = { runtime: source_, reserves, clock: () => now, nodePorts: () => [4412, 5212],
    project: async (id: string) => ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: now }),
    allocate: (async (policy, signal) => { allocations++; return allocator.allocate(policy, signal) }) as NonNullable<ConstructorParameters<typeof RelayStarts>[6]['allocate']> }
  const starts = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, relay, host)
  const input: RelayStartInput = { key: 'operational-key', projectId: 'project', connectionId: connection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base, goal: 'Read the fixture and run acceptance.',
      items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['/usr/bin/true'], protectedPaths: [] }], protectedPaths: [] }, caps }
  const app = new Hono().route('/api/relay', relayStartRoutes(() => starts))
  t.after(async () => {
    life.abort(); await starts.close(); await runtime.close(); await connections.close(); vault.close(); connectionStore.close(); await governor.close(); f.close(); await fake.close()
    await chmod(checkouts, 0o700).catch(() => undefined)
    // A real K4 quarantine (a container that may still hold the paths) is the only reason to keep files.
    let quarantined = false
    for (const name of await readdir(checkouts).catch(() => [] as string[])) {
      if ((await readdir(join(checkouts, name, 'runtime', 'native-cleanup')).catch(() => [] as string[])).length) quarantined = true
    }
    if (!quarantined) await rm(parent, { recursive: true, force: true })
  })
  return { ...f, relay, starts, input, app, connections, fake, governor, runtime, host, base, parent, source, checkouts, modelPath, ollama: () => ollama, allocations: () => allocations,
    time(value: number) { now = value }, holdings: () => readdir(checkouts).catch(() => [] as string[]),
    post: (body: unknown) => app.request('/api/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, peer),
    errors: (sessionId: string) => f.log.readAll(sessionId, 'person').filter(event => event.type === 'error').map(event => (event.data as { code: string }).code) }
}

test('POST /api/relay admits and completes a run against llama-server fixtures: exact counts, one dispatch string, no Ollama, owned checkout removed', async t => {
  const f = await fixture(t), response = await f.post(f.input)
  assert.equal(response.status, 202)
  const receipt = await response.json() as { runId: string; sessionId: string }
  await until(() => f.starts.status(f.input.key).status === 'completed' || f.starts.status(f.input.key).status === 'input_required' || f.starts.status(f.input.key).status === 'failed')
  const status = f.starts.status(f.input.key)
  assert.equal(status.status, 'completed', JSON.stringify({ errors: f.errors(receipt.sessionId), error: status.error }))
  assert.equal(f.relay.read(receipt.runId).items.one, 'done')
  assert.equal(f.ollama(), 0, 'no Ollama request of any kind')
  assert.equal(status.runtime?.source, 'llama_server_props'); assert.equal(status.runtime?.contextTokens, 16000)
  assert.match(status.runtime!.digest, /^sha256:[0-9a-f]{64}$/); assert.equal(status.runtime?.runtimeVersion, 'llama-server/b0-fixture')
  assert.equal(status.meter?.source, 'llama-server:/apply-template+/tokenize'); assert.equal(status.meter?.measurement, 'exact_rendered_request')
  const posts = await f.fake.requests('/completion')
  assert.ok(posts.length >= 4, 'work steps plus the fresh narrative were dispatched')
  for (const post of posts) {
    const content = (await f.fake.requests('/apply-template')).map(r => fakeRender(r.body.messages[0].content, { template: 'chat' }, false)).includes(post.body.prompt)
    assert.ok(content, 'every dispatched string is exactly a rendering the counter measured')
    assert.equal(post.body.n_predict, reserves.turn); assert.equal(post.body.stream, false)
  }
  assert.deepEqual(f.errors(receipt.sessionId), [], 'no protocol error, so every prompt_eval_count equalled the exact count')
  const costs = f.connections.snapshot('local').costs.filter(cost => cost.runId === receipt.runId)
  assert.ok(costs.length >= 4); assert.ok(costs.every(cost => cost.source === 'llama-server:/completion' && cost.inputTokens! > 0))
  assert.equal(f.governor.snapshot().activeLease, null)
  await until(async () => (await f.holdings()).length === 0)
  assert.equal(f.allocations(), 1)
  const replay = await f.post(f.input); assert.equal((await replay.json() as { runId: string }).runId, receipt.runId)
  assert.equal((await f.fake.requests('/completion')).length, posts.length, 'an identical retry dispatches nothing')
})

test('the checkout the executor works in is the exact base commit: a file committed after it does not exist there', async t => {

  const steps = reply(prompt => {
    const state = globalThis as unknown as { work?: number }
    if (prompt.startsWith('<|user|>\nWrite a fresh')) return 'Completed fixture acceptance.'
    state.work = (state.work ?? 0) + 1
    return JSON.stringify(state.work === 1 ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
      : state.work === 2 ? { action: 'tool', name: 'file_read', args: { path: 'src/later.txt' } } : { action: 'handoff' })
  })

  const f = await fixture(t, { fake: { replies: [steps] } }), receipt = await f.starts.start(f.input)
  const results = () => f.log.readAll(receipt.sessionId!, 'person').filter(event => event.type === 'tool.result').map(event => event.data as { status: string; result: string | null; error: string | null })
  await until(() => results().length >= 2)
  await f.starts.stop(f.input.key)
  assert.equal(results()[0]!.status, 'ok'); assert.match(results()[0]!.result ?? '', /synthetic task content/)
  assert.equal(results()[1]!.status, 'error', 'src/later.txt exists in the project but only after the plan base, so the checkout has no such file')
  assert.equal(results()[1]!.result, null, 'a failed tool has no result')
  assert.equal(results()[1]!.error, 'tool_failed', 'the trace carries the fixed code, not a denial or free text')
  assert.match(await readFile(join(f.source, 'src', 'later.txt'), 'utf8'), /committed after the plan base/)
  assert.deepEqual(await f.holdings(), [])
})

test('a dispatcher that evaluates a different token count than was counted fails the run closed with the existing protocol code and nothing else is sent', async t => {
  const f = await fixture(t, { fake: { evaluatedSkew: 1 } }), receipt = await f.starts.start(f.input)
  await until(() => f.starts.status(f.input.key).status !== 'running')
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
  assert.deepEqual(f.errors(receipt.sessionId!), ['truncation_protocol'])
  assert.equal((await f.fake.requests('/completion')).length, 1, 'no fallback estimate and no second attempt')
  await until(async () => (await f.holdings()).length === 0)
})

test('a replaced model file refuses the next dispatch; a stale admitted observation refuses the next count', async t => {
  const changed = await fixture(t, { fake: { completionDelayMs: 250 } }), receipt = await changed.starts.start(changed.input)
  await until(async () => (await changed.fake.count('/completion')) >= 1)
  await writeFile(changed.modelPath, 'GGUF-operational-weights-REPLACED')
  await until(() => changed.starts.status(changed.input.key).status !== 'running')
  assert.equal((await changed.fake.requests('/completion')).length, 1, 'no dispatch after the served identity changed')
  assert.equal(changed.starts.status(changed.input.key).status, 'input_required')
  // Observed before the call (runtime_identity_changed) or inside K3 authorization (model_failed): both stop before dispatch.
  assert.ok(changed.errors(receipt.sessionId!).some(code => ['runtime_identity_changed', 'model_failed'].includes(code)), JSON.stringify(changed.errors(receipt.sessionId!)))
  // An observation that aged out during a call is observed again before the next count, and the run goes on: the age rule protects a request
  // from a runtime nobody has looked at, not a healthy runtime from a slow model.
  const slow = await fixture(t, { fake: { completionDelayMs: 250 } }), slowReceipt = await slow.starts.start(slow.input)
  await until(async () => (await slow.fake.count('/completion')) >= 1)
  const looked = await slow.fake.count('/props')
  slow.time(RUN_TIME + 20_000)
  await until(() => slow.starts.status(slow.input.key).status !== 'running')
  assert.equal(slow.starts.status(slow.input.key).status, 'completed', JSON.stringify(slow.errors(slowReceipt.sessionId!)))
  assert.ok((await slow.fake.count('/props')) > looked, 'the runtime was observed again after the clock moved')
  // An aged-out observation that cannot be refreshed (the server no longer answers as the observed model) still stops everything.
  const stale = await fixture(t, { fake: { completionDelayMs: 250 } }), staleReceipt = await stale.starts.start(stale.input)
  await until(async () => (await stale.fake.count('/completion')) >= 1)
  stale.time(RUN_TIME + 20_000)
  await stale.fake.configure({ alias: 'another-model' })
  await until(() => stale.starts.status(stale.input.key).status !== 'running')
  assert.equal((await stale.fake.requests('/completion')).length, 1, 'no dispatch on an aged-out observation that cannot be refreshed')
  assert.equal(stale.starts.status(stale.input.key).status, 'input_required')
  assert.ok(stale.errors(staleReceipt.sessionId!).some(code => ['runtime_identity_unknown', 'runtime_observation_stale', 'model_failed'].includes(code)), JSON.stringify(stale.errors(staleReceipt.sessionId!)))
})

test('a loading, unreachable or mismatched server refuses admission before any run, session or allocation exists', async t => {
  for (const mode of ['down', 'alias', 'window'] as const) {
    const f = await fixture(t)
    if (mode === 'down') await f.fake.close()
    if (mode === 'alias') await f.fake.configure({ alias: 'another-model' })
    if (mode === 'window') await f.fake.configure({ nCtx: 0 })
    const response = await f.post(f.input)
    assert.equal(response.status, 503, mode)
    assert.ok(['runtime_meter_unavailable', 'runtime_identity_unknown', 'relay_start_failed'].includes((await response.json() as { code: string }).code), mode)
    assert.equal(f.allocations(), 0, mode); assert.equal(f.ollama(), 0)
    for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, `${mode} ${table}`)
  }
})

test('stop during checkout allocation cancels and leaves nothing; an uncleanable allocation is cleanup_unconfirmed, never relay_stopped', async t => {
  // The call counter precedes filesystem ownership. Wait for scratch, which is
  // created after the owner marker, so cancellation actually exercises cleanup.
  const owned = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const [name] = await f.holdings()
    return !!name && await readdir(join(f.checkouts, name, 'runtime', 'scratch')).then(() => true, () => false)
  }
  const slow = join(await mkdtemp(join(process.cwd(), '.lane-data', 'slow-git-')), 'git')
  await writeFile(slow, '#!/bin/sh\nexec /bin/sleep 20\n'); await chmod(slow, 0o755)
  t.after(() => rm(join(slow, '..'), { recursive: true, force: true }))
  const clean = await fixture(t, { git: slow }), pending = clean.starts.start(clean.input), rejected = assert.rejects(pending, /relay_stopped/)
  await until(() => clean.allocations() === 1)
  await until(() => owned(clean))
  assert.equal((await clean.starts.stop(clean.input.key)).status, 'canceled'); await rejected
  assert.deepEqual(await clean.holdings(), []); assert.equal((await clean.fake.requests('/completion')).length, 0)
  for (const table of ['durable_runs', 'sessions']) assert.equal(clean.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
  const stuck = await fixture(t, { git: slow, remove: async () => { throw new Error('synthetic EBUSY') } }), failing = stuck.starts.start(stuck.input), failed = assert.rejects(failing, /cleanup_unconfirmed/)
  await until(() => stuck.allocations() === 1)
  await until(() => owned(stuck))
  const stopped = await stuck.starts.stop(stuck.input.key); await failed
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.error, 'cleanup_unconfirmed')
  assert.equal((await stuck.holdings()).length, 1, 'the allocation that could not be removed is retained for the owner')
})

test('a finished run whose checkout cannot be removed is failed/cleanup_unconfirmed, not completed', async t => {
  const f = await fixture(t, { remove: async () => { throw new Error('synthetic EBUSY') } })
  await f.starts.start(f.input)
  await until(() => f.starts.status(f.input.key).status !== 'running')
  assert.equal(f.starts.status(f.input.key).status, 'failed'); assert.equal(f.starts.status(f.input.key).error, 'cleanup_unconfirmed')
  assert.equal((await f.holdings()).length, 1)
})

test('after a restart the retained intent is interrupted, and neither a dispatch nor an allocation is repeated', async t => {
  const f = await fixture(t), receipt = await f.starts.start(f.input)
  await until(() => f.starts.status(f.input.key).status === 'completed')
  await f.starts.close()
  f.db.prepare("UPDATE relay_public_starts SET status='running' WHERE key=?").run(f.input.key)
  f.db.prepare("UPDATE durable_runs SET state='working' WHERE id=?").run(receipt.runId!)
  const restarted = new RelayStarts(f.db, f.store, f.log, f.connections, f.scrubber, f.relay, f.host)
  const posts = (await f.fake.requests('/completion')).length, allocations = f.allocations()
  try {
    assert.equal(restarted.status(f.input.key).status, 'interrupted'); assert.equal(restarted.status(f.input.key).error, 'process_restarted')
    assert.equal((await restarted.start(f.input)).runId, receipt.runId)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await f.fake.requests('/completion')).length, posts); assert.equal(f.allocations(), allocations)
  } finally { await restarted.close() }
})

test('without the operational option or without the binary the stock refusals are unchanged and nothing starts', async t => {
  const f = await fixture(t), connections = f.connections
  const bare = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, new RelayStore(f.db, f.store, f.scrubber, () => RUN_TIME), { project: async () => { throw new Error('unexpected') }, nodePorts: () => [] })
  t.after(() => bare.close())
  assert.throws(() => bare.start(f.input), /runtime_meter_unavailable/)
  const noWorkspace = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, new RelayStore(f.db, f.store, f.scrubber, () => RUN_TIME),
    { runtime: f.host.runtime, project: async () => { throw new Error('unexpected') }, nodePorts: () => [] })
  t.after(() => noWorkspace.close())
  assert.throws(() => noWorkspace.start(f.input), /relay_workspace_unavailable/)
  const absent = createOperationalRelay({ llamaServer: { kind: 'spawn', binary: join(f.parent, 'no-such-llama-server'), modelPath: f.modelPath, model: 'fixture', contextTokens: 8192 }, reserves }, f.parent)
  t.after(() => absent.close())
  assert.equal(absent.relay, undefined); assert.equal(absent.state().state, 'unavailable')
  assert.equal(f.allocations(), 0)
  for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
})
