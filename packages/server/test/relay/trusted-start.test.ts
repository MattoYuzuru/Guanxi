import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { RunningModel, RelayStartInput } from '@guanxi/contract'
import { runFixture, RUN_TIME } from '../fixtures/durable-runs.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { relayStartRoutes } from '../../src/relay/routes.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { Vault } from '../../src/vault/vault.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { sessionLogRoutes } from '../../src/session-log/routes.ts'
import { caps, reserves } from './fixture.ts'
const exec = promisify(execFile), peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(predicate: () => boolean) {
  // The clean gate runs in a container: a loaded shared machine takes several seconds, so the wait is a ceiling, not a budget.
  for (let n = 0; n < 6000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('fixture did not reach expected state')
}
async function settledWithin<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('fixture settlement guard')), 5000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t: { after(fn: () => unknown): void }, options: { beforeVersion?: () => Promise<void>; closeGate?: Promise<void>; failCommit?: () => boolean; unsafeAllocation?: string } = {}) {
  // Match the existing K4 fixtures: Colima shares the checkout, not macOS tmpdir().
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'trusted-relay-')))
  const source = join(parent, 'source'), root = join(parent, 'attempt'), runtimeBase = join(parent, 'runtime'), scratch = join(runtimeBase, 'scratch')
  for (const path of [source, root, runtimeBase, scratch]) await mkdir(path)
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'item.txt'), 'synthetic task content')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c','core.hooksPath=/dev/null',...args], { cwd: root })).stdout.trim()
  await git(['init']); await git(['add','.']); await git(['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture'])
  const f = runFixture(':memory:', { fault: (operation, point) => {
    if (options.failCommit?.() && operation === 'create_started' && point === 'before_commit') throw new Error('fixture atomic rollback')
  } })
  const relay = new RelayStore(f.db, f.store, f.scrubber, () => RUN_TIME), governor = new ResourceGovernor(), life = new AbortController()
  const connectionStore = new ConnectionStore(join(parent, 'connections.sqlite'), f.scrubber)
  const vault = new Vault(connectionStore, async () => { throw new Error('No fixture keychain') }, f.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  let posts = 0, work = 0, cleaned = false, allocated = 0
  const requests: any[] = [], order: string[] = []
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async (url, init) => {
    if (String(url).endsWith('/api/version')) { order.push('version'); await options.beforeVersion?.(); return Response.json({ version: 'fixture-v1' }) }
    posts++; const request = JSON.parse(String(init?.body)); requests.push(request); order.push('post')
    assert.equal(governor.snapshot().activeLease?.operation, 'chat')
    const prompt = request.messages[0].content
    const content = prompt.startsWith('Write a fresh') ? 'Completed fixture acceptance.' : JSON.stringify(++work === 1
      ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } }
      : work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
    assert.ok(Buffer.byteLength(prompt) + 5 <= 14800)
    return Response.json({ model: 'fixture', created_at: new Date(RUN_TIME).toISOString(), done: true,
      message: { role: 'assistant', content, thinking: 'SYNTHETIC-PRIVATE-REASONING' }, prompt_eval_count: Buffer.byteLength(prompt) + 5, eval_count: 100 })
  } })
  const connections = new Connections(connectionStore, vault, new BalanceProbes(connectionStore, vault), f.scrubber, life.signal,
    { client: () => client }, governor, () => 'http://127.0.0.1:11434')
  const connection = connections.create('local', { name: 'Fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const rows: RunningModel[] = [{ name: 'fixture:latest', digest: 'fixture-digest', sizeBytes: 1, sizeVramBytes: null, gpuPercent: null,
    processorLabel: null, contextLength: 16000, expiresAt: null, source: 'ollama_api_ps', observedAt: new Date(RUN_TIME).toISOString() }]
  const models = { runtimeHost: 'http://127.0.0.1:11434', async ps() { return rows },
    async installedArtifacts() { return [{ name: 'fixture', digest: 'fixture-digest' }] }, async runtimeVersion() { return 'fixture-v1' } }
  let readGate: Promise<void> | undefined, readEntered = deferred(), allocationGate: Promise<void> | undefined, allocationEntered = deferred()
  const runtime = new RelayRuntimeSource(connections, () => models, { maximumAgeMs: 10000, counter: async fact => {
    if (readGate) { readEntered.resolve(); await readGate }
    order.push('authorize')
    return { identity: { model: fact.model, digest: fact.digest, runtimeVersion: fact.runtimeVersion }, placement: 'installed_local',
      source: 'fixture exact renderer', observedAt: RUN_TIME, confidence: 'high', count: request => Buffer.byteLength(request.messages[0]!.content) + 5 }
  } }, () => RUN_TIME)
  const host = { runtime, reserves, clock: () => RUN_TIME, nodePorts: () => [4409, 5209],
    project: async (id: string) => ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: RUN_TIME }),
    allocate: async () => { allocated++; allocationEntered.resolve(); await allocationGate
      return { root: options.unsafeAllocation === 'root' ? source : root, scratch: options.unsafeAllocation === 'scratch' ? source : scratch,
        runtimeBase: options.unsafeAllocation === 'runtime' ? parent : runtimeBase, async close() { await options.closeGate; cleaned = true } } } }
  const starts = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, relay, host)
  const input: RelayStartInput = { key: 'start-key', projectId: 'project', connectionId: connection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base: await git(['rev-parse','HEAD']), goal: 'Read the fixture and run acceptance.',
      items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['/usr/bin/true'], protectedPaths: [] }], protectedPaths: [] }, caps }
  const app = new Hono().route('/api/relay', relayStartRoutes(() => starts)).route('/api/sessions', sessionLogRoutes(() => f.log))
  t.after(async () => { life.abort(); await starts.close(); await connections.close(); vault.close(); connectionStore.close(); await governor.close(); f.close()
    const quarantined = await readdir(join(runtimeBase, 'native-cleanup')).catch(() => [])
    if (!quarantined.length) await rm(parent, { recursive: true, force: true })
  })
  return { ...f, relay, starts, host, input, app, connections, connectionStore, rows, requests, order, governor, runtimeBase,
    posts: () => posts, cleaned: () => cleaned, allocated: () => allocated,
    holdRead(gate: Promise<void>) { readGate = gate; readEntered = deferred(); return readEntered.promise },
    holdAllocation(gate: Promise<void>) { allocationGate = gate; allocationEntered = deferred(); return allocationEntered.promise },
    post: (body: unknown) => app.request('/api/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, peer) }
}

test('public start runs the real K3 plus K4 tool/clean-gate path once, retains one immutable policy and exposes safe status/SSE', async t => {
  const f = await fixture(t), first = await f.post(f.input)
  assert.equal(first.status, 202)
  const receipt = await first.json() as { runId: string; sessionId: string }
  await until(() => f.cleaned())
  assert.equal(f.starts.status(f.input.key).status, 'completed', JSON.stringify({
    errors: f.log.readAll(receipt.sessionId, 'person').filter(e => e.type === 'error').map(e => e.data.code),
    state: f.relay.read(receipt.runId).state, posts: f.posts() }))
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 1)
  assert.equal(f.db.prepare('SELECT version FROM relay_start_migrations').get()!.version, 39)
  assert.equal(f.relay.read(receipt.runId).items.one, 'done')
  const events = f.log.readAll(receipt.sessionId, 'person')
  assert.ok(events.some(e => e.type === 'tool.call' && e.data.name === 'file_read'))
  assert.ok(events.some(e => e.type === 'tool.result' && e.data.status === 'ok'))
  assert.equal(JSON.stringify(events).includes('SYNTHETIC-PRIVATE-REASONING'), false)
  assert.equal(f.governor.snapshot().activeLease, null)
  const posts = f.posts(), replay = await f.post(f.input)
  assert.equal(replay.status, 202); assert.equal((await replay.json() as { runId: string }).runId, receipt.runId); assert.equal(f.posts(), posts)
  assert.equal((await f.post({ ...f.input, plan: { ...f.input.plan, goal: 'changed' } })).status, 409)
  const tail = await f.app.request(`/api/sessions/${receipt.sessionId}/stream?after=0`, {}, peer)
  assert.equal(tail.status, 200)
  const reader = tail.body!.getReader(); await reader.read(); await reader.cancel()
  assert.equal(f.starts.status(f.input.key).status, 'completed', 'subscriber disconnect does not cancel execution')
  assert.equal((await f.app.request(`/api/relay/${receipt.runId}`, {}, peer)).status, 200)
})

test('canceling a noncooperative counter observation settles before its late completion with no allocation or run', async t => {
  const f = await fixture(t), gate = deferred(), entered = f.holdRead(gate.promise), pending = f.starts.start(f.input)
  await entered
  const rejection = assert.rejects(pending, /relay_stopped/)
  assert.equal((await f.starts.stop(f.input.key)).status, 'canceled'); await rejection
  assert.equal(f.allocated(), 0); assert.equal(f.posts(), 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
  gate.resolve(); await turn(); assert.equal(f.posts(), 0)
})

test('stop during resource-owning allocation waits for its cleanup acknowledgement before confirming cancellation', async t => {
  const allocation = deferred(), cleanup = deferred(), f = await fixture(t, { closeGate: cleanup.promise })
  const entered = f.holdAllocation(allocation.promise), pending = f.starts.start(f.input)
  await entered
  let returned = false
  const stopped = f.starts.stop(f.input.key).then(result => { returned = true; return result })
  const rejection = assert.rejects(pending, /relay_stopped/)
  await turn(); assert.equal(returned, false)
  allocation.resolve(); await turn(); assert.equal(returned, false); assert.equal(f.cleaned(), false)
  cleanup.resolve(); assert.equal((await stopped).status, 'canceled'); await rejection
  assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
})

test('public completion waits for checkout cleanup acknowledgement after the R1 terminal transition', async t => {
  const cleanup = deferred(), f = await fixture(t, { closeGate: cleanup.promise })
  try {
    const receipt = await f.starts.start(f.input)
    await until(() => f.store.get(receipt.runId!).state === 'completed')
    assert.equal(f.cleaned(), false)
    assert.equal(f.starts.status(f.input.key).status, 'running')
    const restarted = new RelayStarts(f.db, f.store, f.log, f.connections, f.scrubber, f.relay, f.host)
    assert.equal(restarted.status(f.input.key).status, 'interrupted', 'a terminal R1 row cannot prove missing owner cleanup')
    await restarted.close()
    cleanup.resolve()
    await until(() => f.starts.status(f.input.key).status === 'completed')
    assert.equal(f.cleaned(), true)
  } finally { cleanup.resolve() }
})

test('atomic start failure rolls back session/run/attempt/ledger39 and cleans the allocated checkout', async t => {
  const f = await fixture(t, { failCommit: () => true })
  await assert.rejects(f.starts.start(f.input), /relay_start_failed/)
  assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0)
  for (const table of ['durable_runs','sessions','run_attempts','relay_runs']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='relay_start_migrations'").get()!.n, 0)
})

test('consent revoked after Ollama version preflight prevents POST and releases the real K3 permit', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } })
  await f.starts.start(f.input); await entered.promise
  f.connectionStore.setUnattended('local', f.input.connectionId, false); gate.resolve()
  await until(() => f.cleaned())
  assert.equal(f.posts(), 0); assert.equal(f.governor.snapshot().activeLease, null)
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
})

test('subscriber disconnect while execution awaits preflight leaves the committed run active and replayable', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } })
  const receipt = await f.starts.start(f.input); await entered.promise
  const tail = await f.app.request(`/api/sessions/${receipt.sessionId}/stream?after=0`, {}, peer)
  const reader = tail.body!.getReader(); await reader.read(); await reader.cancel()
  assert.equal(f.starts.status(f.input.key).status, 'running'); assert.equal(f.cleaned(), false)
  assert.equal(f.store.get(receipt.runId!).state, 'working')
  gate.resolve(); await until(() => f.cleaned())
  assert.equal(f.starts.status(f.input.key).status, 'completed')
})

test('concurrent identical start shares admission and a deposed home cannot commit after allocation await', async t => {
  const f = await fixture(t), gate = deferred(), entered = f.holdAllocation(gate.promise)
  const first = f.starts.start(f.input), duplicate = f.starts.start(f.input)
  assert.equal(first, duplicate)
  await entered; assert.equal(f.allocated(), 1)
  assert.throws(() => f.starts.start({ ...f.input, model: 'changed' }), /relay_idempotency_conflict/)
  f.db.prepare("UPDATE leases SET token=token+1 WHERE key='durable-runs/home'").run()
  const rejected = assert.rejects(first, /stale_lease/)
  gate.resolve(); await rejected
  assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
})

test('restart projection reports interrupted retained intent and identical start never resumes inference', async t => {
  const f = await fixture(t), receipt = await f.starts.start(f.input)
  await until(() => f.cleaned()); await f.starts.close()
  // A crashed process can leave exactly these durable rows; R1 recovery is covered separately.
  f.db.prepare("UPDATE relay_public_starts SET status='running' WHERE key=?").run(f.input.key)
  f.db.prepare("UPDATE durable_runs SET state='working' WHERE id=?").run(receipt.runId!)
  const restarted = new RelayStarts(f.db, f.store, f.log, f.connections, f.scrubber, f.relay, f.host), posts = f.posts(), allocations = f.allocated()
  try {
    assert.equal(restarted.status(f.input.key).status, 'interrupted')
    assert.equal(restarted.status(f.input.key).error, 'process_restarted')
    assert.equal((await restarted.start(f.input)).runId, receipt.runId)
    assert.equal(f.posts(), posts); assert.equal(f.allocated(), allocations)
  } finally { await restarted.close() }
})

test('known cleanup quarantine is retained and cannot become a successful ownership-release acknowledgement', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } })
  await f.starts.start(f.input); await entered.promise
  const directory = join(f.runtimeBase, 'native-cleanup'), marker = join(directory, 'synthetic-known-quarantine.json')
  await mkdir(directory, { recursive: true }); await writeFile(marker, JSON.stringify([f.runtimeBase]))
  try {
    gate.resolve(); await until(() => f.starts.status(f.input.key).error === 'cleanup_unconfirmed')
    assert.equal(f.starts.status(f.input.key).status, 'failed'); assert.equal(f.cleaned(), false)
    assert.equal((await readdir(directory)).includes('synthetic-known-quarantine.json'), true)
  } finally { await rm(marker, { force: true }) } // This fixture marker names no real container.
})

test('allocator cannot turn project source or its parent into an executable root, scratch or runtime namespace', async t => {
  for (const unsafeAllocation of ['root','scratch','runtime']) {
    const f = await fixture(t, { unsafeAllocation })
    await assert.rejects(f.starts.start(f.input), /relay_checkout_invalid/)
    assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
  }
})

test('stop during post-preflight counter observation releases K3 before the read returns and consumes its late outcome', async t => {
  const versionEntered = deferred(), versionGate = deferred(), readGate = deferred()
  const f = await fixture(t, { beforeVersion: async () => { versionEntered.resolve(); await versionGate.promise } })
  try {
    await f.starts.start(f.input); await versionEntered.promise
    const readEntered = f.holdRead(readGate.promise)
    versionGate.resolve(); await readEntered
    assert.ok(f.governor.snapshot().activeLease)
    assert.equal((await settledWithin(f.starts.stop(f.input.key))).status, 'canceled')
    assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0); assert.equal(f.governor.snapshot().activeLease, null)
    readGate.resolve(); await turn(); assert.equal(f.posts(), 0)
  } finally { versionGate.resolve(); readGate.resolve() }
})

for (const revoke of ['home', 'run'] as const) test(`review regression: ${revoke} revocation during version preflight dispatches zero POSTs`, async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } })
  try {
    const receipt = await f.starts.start(f.input); await entered.promise
    if (revoke === 'home') f.db.prepare("UPDATE leases SET token=token+1 WHERE key='durable-runs/home'").run()
    else f.store.cancel(receipt.runId!)
    gate.resolve(); await until(() => f.cleaned())
    assert.equal(f.posts(), 0)
    assert.equal(f.governor.snapshot().activeLease, null)
  } finally { gate.resolve() }
})

for (const revoke of ['home', 'run'] as const) test(`review regression: ${revoke} revocation during runtime authorization dispatches zero POSTs`, async t => {
  const entered = deferred(), version = deferred(), read = deferred()
  const f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await version.promise } })
  try {
    const receipt = await f.starts.start(f.input); await entered.promise
    const reading = f.holdRead(read.promise); version.resolve(); await reading
    assert.ok(f.governor.snapshot().activeLease)
    if (revoke === 'home') f.db.prepare("UPDATE leases SET token=token+1 WHERE key='durable-runs/home'").run()
    else f.store.cancel(receipt.runId!)
    read.resolve(); await until(() => f.cleaned())
    assert.equal(f.posts(), 0); assert.equal(f.governor.snapshot().activeLease, null)
  } finally { version.resolve(); read.resolve() }
})

test('review regression: stop reports failed preparation cleanup without acknowledging cancellation', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  const starts = new RelayStarts(f.db, f.store, f.log, f.connections, f.scrubber, f.relay, { ...f.host, allocate: async () => {
    const owned = await f.host.allocate(); entered.resolve(); await release.promise
    return { ...owned, close: async () => { throw new Error('synthetic cleanup failure') } }
  } })
  t.after(() => starts.close())
  const first = starts.start({ ...f.input, key: 'cleanup-failure' }), rejected = assert.rejects(first, /cleanup_unconfirmed/)
  try {
    await entered.promise
    const stopped = starts.stop('cleanup-failure'); release.resolve()
    const result = await stopped; await rejected
    assert.equal(result.error, 'cleanup_unconfirmed'); assert.equal(result.status, 'failed')
    assert.equal(result.runId, null); assert.equal(f.posts(), 0)
  } finally { release.resolve() }
})

for (const target of ['policy', 'runtime'] as const) test(`review regression: late registered ${target} content refuses atomically before persistence`, async t => {
  const version = deferred(), f = await fixture(t, { beforeVersion: () => version.promise })
  const gate = deferred(), entered = f.holdAllocation(gate.promise)
  const secret = target === 'policy' ? 'synthetic-r2-late-secret-20261022' : 'fixture exact renderer'
  const input = target === 'policy' ? { ...f.input, key: 'late-secret', plan: { ...f.input.plan, goal: `Synthetic objective ${secret}` } } : f.input
  const pending = f.starts.start(input)
  try {
    await entered; f.scrubber.register('secret://r2-review', secret); gate.resolve()
    await assert.rejects(pending, /content_withheld/)
    assert.equal(f.cleaned(), true); assert.equal(f.posts(), 0)
    for (const table of ['durable_runs', 'sessions', 'run_attempts', 'relay_runs']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='relay_public_starts'").get()!.n, 0)
  } finally { gate.resolve(); await f.starts.stop(input.key).catch(() => undefined); version.resolve() }
})
