import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DispatchPolicy } from '../src/remote-attempts/dispatch.ts'
import type { LocalInferenceJob, SignedDispatchEvent, NodeIdentity } from '@guanxi/contract/federation'
import { FederationChannel } from '../src/federation/channel.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { Connections } from '../src/connections/service.ts'
import { ConnectionStore } from '../src/connections/store.ts'
import { Vault } from '../src/vault/vault.ts'
import { BalanceProbes } from '../src/probes/balances.ts'
import { canonical, hash, signValue } from '../src/federation/crypto.ts'
import { identity, SimNode } from './federation/harness.ts'

const keys = (id: string) => identity(id, { scopes: ['config','replicas','commands','telemetry','attempts'] })
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function fixture(t: { after(fn: () => unknown): void }, options: { beforeVersion?: () => Promise<void>; modelPost?: (signal: AbortSignal) => Promise<Response>; targetPath?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-f2b-')), hg = new ResourceGovernor(), tg = new ResourceGovernor(), clock = { mono: 1_000_000 }
  let home!: SimNode, target!: SimNode, renewIntercept: (() => Promise<void>) | undefined, eventsBlocked = false, attested = true
  const channel = (from: SimNode, to: SimNode) => new FederationChannel({ local: from.keys.identity, privateKey: from.keys.privateKey,
    peer: to.keys.identity, clock: () => from.time, transport: async request => {
      const path = new URL(request.url).pathname
      if (path.endsWith('/renew') && renewIntercept) await renewIntercept()
      if (path.endsWith('/events') && eventsBlocked) throw new Error('fixture partition')
      return to.app.request(request)
    } })
  const hp: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: () => clock.mono, channel: () => channel(home, target) }
  const tp: DispatchPolicy = { ...hp, channel: () => channel(target, home) }
  home = new SimNode(keys('home'), ':memory:', { attempts: { governor: hg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: hp })
  target = new SimNode(keys('target'), options.targetPath ?? ':memory:', { attempts: { governor: tg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: tp })
  home.trust(target); target.trust(home)
  const store = new ConnectionStore(join(dir, 'connections.sqlite'), target.scrubber)
  const vault = new Vault(store, async () => { throw new Error('No fixture keychain') }, target.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  let posts = 0, versions = 0, posted: unknown
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async (url, init) => {
    if (String(url).endsWith('/api/version')) { versions++; await options.beforeVersion?.(); return Response.json({ version: 'fixture' }) }
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat')
    posts++; posted = JSON.parse(String(init?.body))
    return options.modelPost ? options.modelPost(init!.signal!) : Response.json({ model: 'fixture-model', created_at: '2026-10-22T00:00:00Z', done: true,
      message: { role: 'assistant', content: 'fixture result', thinking: 'never federate this fixture reasoning' }, prompt_eval_count: 7, eval_count: 3 })
  } })
  const life = new AbortController(), connections = new Connections(store, vault, new BalanceProbes(store, vault), target.scrubber,
    life.signal, { client: () => client }, tg, () => 'http://127.0.0.1:11434')
  const connection = connections.create('owner', { name: 'Fixture local', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  tp.connections = connections
  tp.localModel = model => attested ? { connectionId: connection.id, model, placement: 'installed_local', source: 'fixture installed inventory', observedAt: target.time } : null
  const run = home.runs.create({ id: 'run', sessionId: 'session' })
  target.federation.replicas.bind({ streamId: run.id, kind: 'run', sessionId: run.session_id, ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  const job: LocalInferenceJob = { kind: 'local_inference', model: 'fixture-model', context: 32768, outputTokens: 512,
    deadline: home.time + 30_000, messages: [{ role: 'user', content: 'fixture prompt' }] }
  let outgoing = channel(home, target)
  const homeContext = { identity: home.keys.identity, readOnly: false, version: { major: 1, minor: 3 } }, targetContext = { ...homeContext, identity: target.keys.identity }
  const prepare = async (override: Partial<LocalInferenceJob> = {}) => {
    const offer = home.federation.prepareDispatch(run.id, 'target', { ...job, ...override }, 4000)
    const receipt = await outgoing.offer(offer)
    const grant = home.federation.grantDispatch(offer.id, receipt)
    const ref = { id: offer.id, homeNodeId: 'home', executorNodeId: 'target' }
    return { offer, receipt, grant, ref, attempt: home.runs.attempts(run.id).at(-1)! }
  }
  t.after(async () => { life.abort(); target.federation.close(); await connections.close(); home.close(); target.close(); store.close(); await hg.close(); await tg.close(); rmSync(dir, { recursive: true, force: true }) })
  return { home, get target() { return target }, hg, tg, clock, run, job, get outgoing() { return outgoing }, homeContext, targetContext, prepare, connections, store, tp,
    hp,
    async restartTarget(id: string) {
      const targetKeys = target.keys, task = target.federation.attemptDispatch!.settled(id)
      target.federation.close(); await task; await connections.close()
      // A crash leaves the prior in-flight marker. Reconstruct that exact durable artifact.
      target.db.prepare("UPDATE remote_dispatch_holders SET status='running' WHERE id=?").run(id)
      target.close()
      target = new SimNode(targetKeys, options.targetPath!, { attempts: { governor: tg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: tp })
      target.trust(home); outgoing = channel(home, target)
    },
    get posts() { return posts }, get versions() { return versions }, get posted() { return posted },
    blockEvents(value: boolean) { eventsBlocked = value }, attest(value: boolean) { attested = value },
    interceptRenew(fn: () => Promise<void>) { renewIntercept = fn } }
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)) }
  assert.fail('fixture did not reach expected state')
}

test('fresh remote binding and offer commit together, local executor cannot use its token', async t => {
  const f = await fixture(t), p = await f.prepare()
  assert.equal(p.receipt.dispatchAuthorized, false); assert.equal(p.grant.grant.dispatchAuthorized, true)
  assert.equal(f.home.db.prepare('SELECT executor FROM run_remote_bindings').get()!.executor, 'target')
  assert.equal(f.home.db.prepare('SELECT version FROM remote_dispatch_migrations').get()!.version, 37)
  assert.equal(f.home.db.prepare('SELECT version FROM remote_attempt_migrations').get()!.version, 36)
  for (const action of [() => f.home.runs.renew(p.attempt), () => f.home.runs.modelStarted(p.attempt), () => f.home.runs.complete(p.attempt, 'completed'), () => f.home.runs.mutate(p.attempt, () => {})]) assert.throws(action, /stale_lease/)
  assert.throws(() => f.home.runs.start(f.run.id), /invalid_transition/)
  assert.equal(f.posts, 0)
  assert.equal(JSON.stringify(f.home.federation).includes(f.home.keys.privateKey), false)
  assert.equal(JSON.stringify(f.target.federation).includes(f.target.keys.privateKey), false)
})

test('signed two-node execution consumes reservation, performs actual K3 fake transport and commits one result', async t => {
  const f = await fixture(t), p = await f.prepare()
  assert.ok(f.tg.snapshot().activeLease)
  await f.outgoing.dispatch(p.grant)
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  await f.target.federation.attemptDispatch!.flush(p.offer.id)
  assert.equal(f.posts, 1); assert.equal(f.versions, 1)
  assert.deepEqual(f.posted, { model: 'fixture-model', messages: f.job.messages, think: false, options: { num_ctx: 32768, num_predict: 512 }, stream: false })
  assert.equal(f.tg.snapshot().activeLease, null)
  assert.equal(f.target.federation.attemptOffers!.read('home', p.offer.id).status, 'fenced')
  assert.equal(f.target.federation.attemptOffers!.read('home', p.offer.id).dispatchAuthorized, false)
  assert.equal(f.home.runs.get(f.run.id).state, 'completed')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_receipts').get()!.n, 2)
  const payloads = f.target.db.prepare('SELECT payload FROM remote_dispatch_events ORDER BY seq').all().map(r => String(r.payload))
  assert.equal(payloads.join('').includes('never federate'), false)
  const result = JSON.parse(payloads[1]!) as SignedDispatchEvent
  assert.deepEqual(result.entry.event, { kind: 'terminal', outcome: 'completed', content: 'fixture result', inputTokens: 7, outputTokens: 3, source: 'ollama:/api/chat' })
  const version = f.home.runs.get(f.run.id).version
  for (const payload of payloads) f.home.federation.receiveDispatchEvent(f.targetContext, JSON.parse(payload))
  assert.equal(f.home.runs.get(f.run.id).version, version)
  await f.outgoing.dispatch(p.grant); assert.equal(f.posts, 1)
  assert.equal(f.store.costs('owner').length, 1)
})

test('forged grant, immutable job edits, wrong executor, old capability and unavailable local placement dispatch zero times', async t => {
  const f = await fixture(t), p = await f.prepare()
  await assert.rejects(f.target.federation.receiveDispatch(f.homeContext, { ...p.grant, signature: 'forged' }), /invalid_signature/)
  const edited = { ...p.grant.grant, job: { ...p.grant.grant.job, model: 'other' } }
  await assert.rejects(f.target.federation.receiveDispatch(f.homeContext, { grant: edited, signature: signValue(f.home.keys.privateKey, edited) }), /dispatch_binding/)
  await assert.rejects(f.target.federation.receiveDispatch({ ...f.homeContext, version: { major: 1, minor: 2 } }, p.grant), /contract_feature_unavailable/)
  await assert.rejects(f.target.federation.receiveDispatch({ ...f.homeContext, identity: f.target.keys.identity }, p.grant), /owner_mismatch/)
  f.attest(false)
  await assert.rejects(f.target.federation.receiveDispatch(f.homeContext, p.grant), /local_placement_required/)
  for (const observedAt of [f.target.time - f.tp.maxModelAgeMs - 1, f.target.time + 1]) {
    f.tp.localModel = model => ({ connectionId: f.store.list('owner')[0]!.id, model, placement: 'installed_local', source: 'fixture inventory', observedAt })
    await assert.rejects(f.target.federation.receiveDispatch(f.homeContext, p.grant), /local_placement_required/)
  }
  assert.equal(f.posts, 0); assert.ok(f.tg.snapshot().activeLease)
})

test('home cancellation while renewal is awaiting causes zero dispatch and cannot allocate a second attempt', async t => {
  const f = await fixture(t), p = await f.prepare(), gate = deferred(), entered = deferred()
  f.interceptRenew(async () => { entered.resolve(); await gate.promise })
  const pending = f.outgoing.dispatch(p.grant)
  await entered.promise; f.home.runs.cancel(f.run.id); gate.resolve()
  await assert.rejects(pending)
  assert.equal(f.posts, 0); assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'lost')
  assert.equal(f.home.runs.attempts(f.run.id).length, 1)
  assert.equal(f.tg.snapshot().activeLease, null)
})

test('revocation during adapter preflight is checked after await, before final preparation and transport', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  f.target.federation.revokePeer('home'); gate.resolve()
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 0); assert.equal(f.versions, 1); assert.equal(f.tg.snapshot().activeLease, null)
})

test('direct signed cancellation aborts pending inference and commits canceled once without resuming on retry', async t => {
  const entered = deferred(), aborted = deferred(), f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('fixture aborted')) }, { once: true })
  }) }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  assert.equal((await f.outgoing.dispatchState(p.ref, true)).status, 'canceled')
  await aborted.promise
  await f.target.federation.attemptDispatch!.settled(p.offer.id); await f.target.federation.attemptDispatch!.flush(p.offer.id)
  assert.equal(f.posts, 1); assert.equal(f.home.runs.get(f.run.id).state, 'canceled')
  assert.equal((await f.outgoing.dispatch(p.grant)).status, 'canceled'); assert.equal(f.posts, 1)
})

test('wall suspension while version preflight waits self-fences even if monotonic time does not advance', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  f.target.time += 4000; gate.resolve()
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 0); assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'lost')
  assert.equal(f.home.runs.attempts(f.run.id).length, 1)
})

test('durable event outbox survives partition and exact replay; changed duplicate cannot alter home terminal', async t => {
  const f = await fixture(t), p = await f.prepare()
  f.blockEvents(true); await f.outgoing.dispatch(p.grant); await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.home.runs.get(f.run.id).state, 'working')
  assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_events WHERE delivered=0').get()!.n, 2)
  f.blockEvents(false); await f.target.federation.attemptDispatch!.flush(p.offer.id)
  assert.equal(f.home.runs.get(f.run.id).state, 'completed')
  const payload = JSON.parse(String(f.target.db.prepare('SELECT payload FROM remote_dispatch_events WHERE seq=2').get()!.payload)) as SignedDispatchEvent
  const edited = { ...payload.entry, observedAt: payload.entry.observedAt + 1 }
  await assert.rejects(async () => f.home.federation.receiveDispatchEvent(f.targetContext, { entry: edited, hash: hash(edited), signature: signValue(f.target.keys.privateKey, edited) }))
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_receipts').get()!.n, 2)
})

test('late renewal cannot resurrect expired holder even if the granting response succeeds', async t => {
  const f = await fixture(t), p = await f.prepare(), entered = deferred(), gate = deferred()
  f.interceptRenew(async () => { entered.resolve(); await gate.promise })
  const pending = f.outgoing.dispatch(p.grant)
  await entered.promise; f.clock.mono += 3000; gate.resolve()
  await assert.rejects(pending)
  assert.equal(f.posts, 0); assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'lost')
  assert.equal((await f.outgoing.dispatch(p.grant)).status, 'lost'); assert.equal(f.posts, 0)
})

test('local-only model attestation never permits a :cloud model', async t => {
  const f = await fixture(t), p = await f.prepare({ model: 'fixture:cloud' })
  await assert.rejects(f.outgoing.dispatch(p.grant))
  assert.equal(f.posts, 0); assert.equal(f.versions, 0)
})

test('periodic signed renewal keeps one admitted inference alive and later cancellation releases it', async t => {
  const entered = deferred(), f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) })
  f.hp.ttlMs = 300; f.hp.safetyMs = 10; f.tp.ttlMs = 300; f.tp.safetyMs = 10
  let renewals = 0
  f.interceptRenew(async () => { renewals++; f.home.time += 20; f.target.time += 20; f.clock.mono += 20 })
  const p = await f.prepare(); await f.outgoing.dispatch(p.grant); await entered.promise
  await waitFor(() => renewals >= 3)
  assert.equal(f.posts, 1); assert.equal(f.home.runs.attempts(f.run.id).length, 1)
  assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'running')
  await f.outgoing.dispatchState(p.ref, true)
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.tg.snapshot().activeLease, null)
})

test('target process restart invalidates a persisted running holder and signed replay never resumes it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-f2b-restart-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const entered = deferred(), f = await fixture(t, { targetPath: join(dir, 'node.sqlite'), modelPost: signal => new Promise((_resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  await f.restartTarget(p.offer.id)
  assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'lost')
  assert.equal((await f.outgoing.dispatch(p.grant)).status, 'lost')
  assert.equal(f.posts, 1); assert.equal(f.tg.snapshot().activeLease, null)
  assert.equal(f.target.db.prepare('PRAGMA user_version').get()!.user_version, 32)
  assert.equal(f.target.db.prepare('SELECT version FROM remote_attempt_migrations').get()!.version, 36)
})

test('grant consumed before K3 queue wait cannot dispatch after home cancellation during that wait', async t => {
  const f = await fixture(t), p = await f.prepare(), entered = deferred(), gate = deferred()
  f.interceptRenew(async () => { entered.resolve(); await gate.promise })
  const admission = f.outgoing.dispatch(p.grant); await entered.promise
  // Reservation was consumed/released, so an ordinary local operation can win readmission.
  const ticket = f.tg.enqueue({ owner: { kind: 'operation', operationId: 'interactive' }, operation: 'chat',
    model: { provider: 'ollama', name: 'fixture-model' }, requestedContext: 1024, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const busy = await f.tg.acquire(ticket)
  gate.resolve(); await admission
  assert.equal(f.tg.snapshot().queued.length, 1)
  f.home.runs.cancel(f.run.id); busy.release()
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
})

test('failed fresh-attempt metadata rolls back run state, token and binding before any holder exists', async t => {
  const f = await fixture(t)
  // Initialize optional metadata without starting the submitted run.
  assert.throws(() => f.home.federation.attemptDispatch!.state('missing'), /dispatch_not_found/)
  f.home.db.exec("CREATE TRIGGER fail_dispatch_home BEFORE INSERT ON remote_dispatch_home BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  assert.throws(() => f.home.federation.prepareDispatch(f.run.id, 'target', f.job, 4000), /fixture rollback/)
  assert.equal(f.home.runs.get(f.run.id).state, 'submitted')
  assert.equal(f.home.runs.attempts(f.run.id).length, 0)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM run_remote_bindings').get()!.n, 0)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_home_offers').get()!.n, 0)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM leases WHERE key=?').get(`run:${f.run.id}/exec`)!.n, 0)
  f.home.db.exec('DROP TRIGGER fail_dispatch_home')
  const p = await f.prepare(); assert.equal(p.attempt.token, 1)
})

test('failed holder persistence preserves exact live reservation for an explicit retry', async t => {
  const f = await fixture(t), p = await f.prepare()
  assert.throws(() => f.target.federation.attemptDispatch!.state('missing'), /dispatch_not_found/)
  f.target.db.exec("CREATE TRIGGER fail_dispatch_holder BEFORE INSERT ON remote_dispatch_holders BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  await assert.rejects(f.outgoing.dispatch(p.grant))
  assert.equal(f.target.federation.attemptOffers!.read('home', p.offer.id).status, 'reserved')
  assert.equal(f.tg.snapshot().activeLease!.ticketId, p.receipt.reservation!.ticketId)
  assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_holders').get()!.n, 0)
  f.target.db.exec('DROP TRIGGER fail_dispatch_holder')
  await f.outgoing.dispatch(p.grant); await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 1)
})

test('failed terminal receipt is rolled back with run completion and can be delivered once later', async t => {
  const f = await fixture(t), p = await f.prepare()
  f.home.db.exec("CREATE TRIGGER fail_dispatch_receipt BEFORE UPDATE ON durable_runs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  await f.outgoing.dispatch(p.grant); await f.target.federation.attemptDispatch!.settled(p.offer.id)
  await assert.rejects(f.target.federation.attemptDispatch!.flush(p.offer.id))
  assert.equal(f.home.runs.get(f.run.id).state, 'working')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_receipts').get()!.n, 1)
  f.home.db.exec('DROP TRIGGER fail_dispatch_receipt')
  await f.target.federation.attemptDispatch!.flush(p.offer.id)
  assert.equal(f.home.runs.get(f.run.id).state, 'completed')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_receipts').get()!.n, 2)
})

test('an expired remote result cannot resolve a child or wake a parent after an explicit replacement attempt', async t => {
  const f = await fixture(t), parent = f.home.runs.create({ id: 'parent' }), lead = f.home.runs.start(parent.id)
  f.home.runs.modelStarted(lead)
  const promise = f.home.runs.delegate(lead, { key: 'child', deadline: f.home.time + 90_000 })
  f.target.federation.replicas.bind({ streamId: promise.child_id, kind: 'run', sessionId: 'parent', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  const offer = f.home.federation.prepareDispatch(promise.child_id, 'target', { ...f.job, deadline: f.home.time + 90_000 }, 4000)
  const grant = f.home.federation.grantDispatch(offer.id, await f.outgoing.offer(offer))
  f.blockEvents(true); await f.outgoing.dispatch(grant); await f.target.federation.attemptDispatch!.settled(offer.id)
  f.home.time += 4000; f.home.runs.tick()
  assert.equal(f.home.runs.attempts(promise.child_id).length, 1, 'expiry alone creates no replacement')
  assert.equal(f.home.runs.get(promise.child_id).state, 'interrupted')
  const replacement = f.home.runs.start(promise.child_id)
  assert.ok(replacement.token > offer.fence.token)
  f.blockEvents(false)
  await assert.rejects(f.target.federation.attemptDispatch!.flush(offer.id))
  assert.equal(f.home.runs.wakes(parent.id).length, 0)
  assert.equal(f.home.runs.promises(parent.id)[0]!.outcome, null)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_receipts WHERE id=?').get(offer.id)!.n, 0)
  f.home.runs.complete(replacement, 'completed')
  assert.equal(f.home.runs.wakes(parent.id).length, 1)
  await assert.rejects(f.target.federation.attemptDispatch!.flush(offer.id))
  assert.equal(f.home.runs.wakes(parent.id).length, 1)
})

test('K3 authorization follows preflight and final preparation has no asynchronous gap before actual POST', async t => {
  const order: string[] = [], f = await fixture(t, { beforeVersion: async () => { order.push('version') }, modelPost: async () => {
    order.push('post'); assert.equal(order.includes('prepared-microtask'), false)
    return Response.json({ model: 'fixture-model', created_at: '2026-10-22T00:00:00Z', done: true, message: { role: 'assistant', content: 'ok' } })
  } })
  await f.connections.localChat('owner', f.store.list('owner')[0]!.id,
    { model: 'fixture-model', messages: [], options: { num_ctx: 1024 } }, { runId: 'run', requestId: 'ordering',
      authorizeDispatch: async () => { order.push('authorize'); await Promise.resolve(); order.push('authorized') },
      onPrepared: () => { order.push('prepared'); queueMicrotask(() => order.push('prepared-microtask')) },
      onStarted: () => order.push('started'),
    })
  assert.deepEqual(order, ['version','authorize','authorized','prepared','post','started','prepared-microtask'])
})

test('target generation deposed across renewal await admits no model request', async t => {
  const f = await fixture(t), p = await f.prepare(), gate = deferred(), entered = deferred()
  f.interceptRenew(async () => { entered.resolve(); await gate.promise })
  const pending = f.outgoing.dispatch(p.grant)
  await entered.promise
  f.target.db.prepare("UPDATE leases SET token=token+1 WHERE key='durable-runs/home'").run()
  gate.resolve(); await assert.rejects(pending)
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
})

test('revoked unattended consent after version preflight prevents transport and releases K3 permit', async t => {
  const entered = deferred(), gate = deferred(), f = await fixture(t, { beforeVersion: async () => { entered.resolve(); await gate.promise } }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  f.store.setUnattended('owner', f.store.list('owner')[0]!.id, false); gate.resolve()
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
})

test('dispatch channel requires both minor3 and its explicit capability, with zero dispatched grant POSTs', async t => {
  const f = await fixture(t), p = await f.prepare()
  for (const [minor, capabilities] of [[2, ['local-inference-dispatch-v1']], [3, ['attempt-reservations-v1']]] as const) {
    let posts = 0
    const channel = new FederationChannel({ local: f.home.keys.identity, privateKey: f.home.keys.privateKey, peer: f.target.keys.identity, transport: async request => {
      if (request.method === 'POST') posts++
      return Response.json({ version: { major: 1, minor }, negotiated: { major: 1, minor }, readOnly: false, capabilities })
    } })
    await assert.rejects(channel.dispatch(p.grant), /contract_feature_unavailable/)
    assert.equal(posts, 0)
  }
  assert.equal(f.posts, 0)
})

test('failed additive dispatch DDL rolls back ledger37 and new tables while leaving ledger36/global schema intact', async t => {
  const f = await fixture(t)
  f.home.db.exec('CREATE TABLE run_remote_bindings(unrelated TEXT)')
  assert.throws(() => f.home.federation.attemptDispatch!.state('missing'), /run_id/)
  assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='remote_dispatch_migrations'").get()!.n, 0)
  assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='remote_dispatch_holders'").get()!.n, 0)
  assert.equal(f.home.db.prepare('SELECT version FROM remote_attempt_migrations').get()!.version, 36)
  assert.equal(f.home.db.prepare('PRAGMA user_version').get()!.user_version, 32)
  f.home.db.exec('DROP TABLE run_remote_bindings')
  assert.throws(() => f.home.federation.attemptDispatch!.state('missing'), /dispatch_not_found/)
  assert.equal(f.home.db.prepare('SELECT version FROM remote_dispatch_migrations').get()!.version, 37)
  assert.equal(f.home.runs.attempts(f.run.id).length, 0)
})

test('cancel during initial renewal settles admission before a late response, without dispatch or resurrection', async t => {
  const f = await fixture(t), p = await f.prepare(), entered = deferred(), gate = deferred()
  f.interceptRenew(async () => { entered.resolve(); await gate.promise })
  const pending = f.outgoing.dispatch(p.grant)
  await entered.promise
  const settled = f.target.federation.attemptDispatch!.settled(p.offer.id)
  await f.outgoing.dispatchState(p.ref, true)
  await assert.rejects(pending); await settled
  assert.equal(f.tg.snapshot().activeLease, null); assert.equal(f.posts, 0)
  assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'canceled')
  gate.resolve(); await new Promise(r => setTimeout(r, 5))
  assert.equal(f.posts, 0); assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'canceled')
})

test('cancel releases the K3 permit while post-preflight renewal remains blocked and late rejection is observed', async t => {
  const f = await fixture(t), p = await f.prepare(), entered = deferred(), gate = deferred()
  let count = 0
  f.interceptRenew(async () => { if (++count === 2) { entered.resolve(); await gate.promise; throw new Error('fixture late rejection') } })
  await f.outgoing.dispatch(p.grant); await entered.promise
  const captured = f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.ok(f.tg.snapshot().activeLease)
  await f.outgoing.dispatchState(p.ref, true)
  await f.target.federation.attemptDispatch!.settled(p.offer.id); await captured
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
  assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'canceled')
  gate.resolve(); await new Promise(r => setTimeout(r, 5))
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
})

test('R1 rejects accidental async renewal/start/terminal receipt callbacks and rolls their writes back', async t => {
  const f = await fixture(t), a = f.home.runs.start(f.run.id)
  f.home.db.exec('CREATE TABLE callback_trace(value TEXT)')
  const callback = async (db: typeof f.home.db) => { db.prepare('INSERT INTO callback_trace VALUES (?)').run('uncommitted'); await Promise.resolve(); throw new Error('fixture late callback rejection') }
  const expiry = f.home.db.prepare('SELECT expires_at FROM leases WHERE key=?').get(`run:${f.run.id}/exec`)!.expires_at
  // @ts-expect-error Async validation is forbidden; runtime defense also protects JavaScript callers.
  assert.throws(() => f.home.runs.renew(a, 100, callback), /invalid_input/)
  // @ts-expect-error Receipt callbacks must commit synchronously with the lifecycle update.
  assert.throws(() => f.home.runs.modelStarted(a, callback), /invalid_input/)
  // @ts-expect-error Receipt callbacks must commit synchronously with the terminal update.
  assert.throws(() => f.home.runs.complete(a, 'completed', callback), /invalid_input/)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM callback_trace').get()!.n, 0)
  assert.equal(f.home.db.prepare('SELECT expires_at FROM leases WHERE key=?').get(`run:${f.run.id}/exec`)!.expires_at, expiry)
  assert.equal(f.home.runs.attempts(f.run.id)[0]!.first_model_at, null)
  assert.equal(f.home.runs.get(f.run.id).state, 'working')
})

test('holder expiry releases K3 while authorization renewal is indefinitely pending', async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred()
  f.hp.ttlMs = 300; f.hp.safetyMs = 10; f.tp.ttlMs = 300; f.tp.safetyMs = 10
  const p = await f.prepare(); let count = 0
  f.interceptRenew(async () => { if (++count === 2) { entered.resolve(); await gate.promise } })
  await f.outgoing.dispatch(p.grant); await entered.promise
  f.target.time += 4000
  await waitFor(() => f.tg.snapshot().activeLease === null)
  await f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal(f.posts, 0); assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'lost')
  gate.resolve(); await new Promise(r => setTimeout(r, 5))
  assert.equal(f.posts, 0); assert.equal(f.tg.snapshot().activeLease, null)
})

test('another trusted owner device cancels the exact executor grant while the home is unreachable, with durable report replay', async t => {
  const entered = deferred(), f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) }), p = await f.prepare(), controller = new SimNode(keys('controller'))
  t.after(() => controller.close()); f.target.trust(controller)
  await f.outgoing.dispatch(p.grant); await entered.promise
  f.blockEvents(true); f.interceptRenew(async () => { throw new Error('fixture home partition') })
  const channel = new FederationChannel({ local: controller.keys.identity, privateKey: controller.keys.privateKey, peer: f.target.keys.identity,
    clock: () => controller.time, transport: async request => f.target.app.request(request) })
  const cancel = { ...p.ref, expiresAt: controller.time + 1000 }, captured = f.target.federation.attemptDispatch!.settled(p.offer.id)
  assert.equal((await channel.cancelDispatch(cancel)).status, 'canceled')
  await captured
  assert.equal((await channel.cancelDispatch(cancel)).status, 'canceled')
  assert.equal(f.posts, 1); assert.equal(f.tg.snapshot().activeLease, null)
  assert.equal(f.home.runs.get(f.run.id).state, 'working', 'partitioned target Stop has not yet changed home state')
  assert.ok(Number(f.target.db.prepare('SELECT COUNT(*) n FROM remote_dispatch_events WHERE delivered=0').get()!.n) >= 1)
  f.blockEvents(false); await f.target.federation.attemptDispatch!.flush(p.offer.id)
  assert.equal(f.home.runs.get(f.run.id).state, 'canceled')
})

test('direct cancel refuses foreign/shared/unscoped/forged/expired or mismatched identities before stopping work', async t => {
  const entered = deferred(), f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    entered.resolve(); signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) }), p = await f.prepare()
  await f.outgoing.dispatch(p.grant); await entered.promise
  const input = { ...p.ref, expiresAt: f.target.time + 1000 }
  const cases: [string, Partial<NodeIdentity>][] = [['foreign-controller', { accountId: 'foreign' }], ['shared-controller', { trust: 'shared_device', admin: false }], ['unscoped-controller', { scopes: ['config'] }]]
  for (const [id, override] of cases) {
    const peerKeys = identity(id, { scopes: ['attempts'], ...override })
    f.target.federation.trust(peerKeys.identity)
    const channel = new FederationChannel({ local: peerKeys.identity, privateKey: peerKeys.privateKey, peer: f.target.keys.identity,
      clock: () => f.target.time, transport: async request => f.target.app.request(request) })
    await assert.rejects(channel.cancelDispatch(input))
    assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'running')
  }
  const controller = new SimNode(keys('valid-controller')); t.after(() => controller.close()); f.target.trust(controller)
  const channel = new FederationChannel({ local: controller.keys.identity, privateKey: controller.keys.privateKey, peer: f.target.keys.identity,
    clock: () => controller.time, transport: async request => f.target.app.request(request) })
  for (const bad of [{ ...input, expiresAt: f.target.time }, { ...input, homeNodeId: 'forged-home' }, { ...input, id: 'different-grant' }]) {
    await assert.rejects(channel.cancelDispatch(bad))
    assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'running')
  }
  await assert.rejects(channel.cancelDispatch({ ...input, actorAccountId: 'owner' } as never))
  const forged = new FederationChannel({ local: controller.keys.identity, privateKey: controller.keys.privateKey, peer: f.target.keys.identity,
    clock: () => controller.time, transport: async request => {
      if (request.method === 'POST') {
        const body = await request.json() as typeof input
        return f.target.app.request(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ ...body, expiresAt: body.expiresAt + 1 }) }))
      }
      return f.target.app.request(request)
    } })
  await assert.rejects(forged.cancelDispatch(input))
  assert.equal(f.target.federation.attemptDispatch!.state(p.offer.id).status, 'running')
  assert.equal(f.posts, 1)
  await channel.cancelDispatch(input); await f.target.federation.attemptDispatch!.settled(p.offer.id)
})

test('settled captured during initial admission follows replacement work until inference cleanup finishes', async t => {
  const modelEntered = deferred(), f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    modelEntered.resolve(); signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) }), p = await f.prepare(), admissionEntered = deferred(), gate = deferred()
  let count = 0, returned = false
  f.interceptRenew(async () => { if (++count === 1) { admissionEntered.resolve(); await gate.promise } })
  const pending = f.outgoing.dispatch(p.grant)
  await admissionEntered.promise
  const lifetime = f.target.federation.attemptDispatch!.settled(p.offer.id).then(() => { returned = true })
  gate.resolve(); await pending; await modelEntered.promise; await Promise.resolve()
  assert.equal(returned, false, 'successful admission does not mean work has settled')
  assert.ok(f.tg.snapshot().activeLease)
  await f.outgoing.dispatchState(p.ref, true); await lifetime
  assert.equal(returned, true); assert.equal(f.tg.snapshot().activeLease, null)
})

test('a delayed owner cancel for an expired grant cannot stop a newer attempt of the same run', async t => {
  const f = await fixture(t, { modelPost: signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fixture stop')), { once: true })
  }) })
  f.hp.ttlMs = 300; f.hp.safetyMs = 10; f.tp.ttlMs = 300; f.tp.safetyMs = 10
  const old = await f.prepare(); await f.outgoing.dispatch(old.grant); await waitFor(() => f.posts === 1)
  f.home.time += 1000; f.target.time += 1000; f.clock.mono += 1000
  f.home.runs.tick()
  await waitFor(() => f.tg.snapshot().activeLease === null)
  await f.target.federation.attemptDispatch!.settled(old.offer.id)
  assert.equal(f.home.runs.get(f.run.id).state, 'interrupted')
  assert.equal(f.home.runs.attempts(f.run.id).length, 1)
  const next = await f.prepare(); assert.ok(next.attempt.token > old.attempt.token)
  await f.outgoing.dispatch(next.grant); await waitFor(() => f.posts === 2)
  const controller = new SimNode(keys('late-controller')); controller.time = f.target.time
  t.after(() => controller.close()); f.target.trust(controller)
  const channel = new FederationChannel({ local: controller.keys.identity, privateKey: controller.keys.privateKey, peer: f.target.keys.identity,
    clock: () => controller.time, transport: async request => f.target.app.request(request) })
  assert.equal((await channel.cancelDispatch({ ...old.ref, expiresAt: controller.time + 1000 })).status, 'lost')
  assert.equal(f.target.federation.attemptDispatch!.state(next.offer.id).status, 'running')
  assert.ok(f.tg.snapshot().activeLease)
  await channel.cancelDispatch({ ...next.ref, expiresAt: controller.time + 1000 })
  await f.target.federation.attemptDispatch!.settled(next.offer.id)
  assert.equal(f.tg.snapshot().activeLease, null)
})
