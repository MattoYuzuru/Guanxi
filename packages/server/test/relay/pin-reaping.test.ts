/** F2-reap: stale executor relay pins are released by the home's reconciliation and, failing that, by the executor's own lease.
 * Two in-process nodes over signed in-memory channels; the "crash" closes the home node without releasing anything and reopens the
 * same database file, which is exactly what a restarted process sees (an empty live set and a durable journal). */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FEDERATION_VERSION } from '@guanxi/contract/federation'
import { FederationChannel } from '../../src/federation/channel.ts'
import type { DispatchPolicy } from '../../src/remote-attempts/dispatch.ts'
import type { ExecutorRelayRuntime } from '../../src/remote-attempts/relay-runtime.ts'
import { normalizeOllamaModelReference } from '../../src/runtime/observation-key.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { openDb } from '../../src/store/db.ts'
import { SimNode } from '../federation/harness.ts'
import { RemoteRelayRuntime } from '../../src/relay/remote-runtime.ts'
import { keys, remoteFixture, until } from './remote-fixture.ts'

const MODEL = 'fixture'
const REF = normalizeOllamaModelReference(MODEL)!
const stubRuntime = (now: () => number): ExecutorRelayRuntime => ({ model: REF,
  observe: async () => ({ model: REF, digest: 'sha256:d', contextTokens: 16000, runtimeVersion: 'b1', source: 'stub', observedAt: now() }),
  measure: async () => { throw new Error('not used') }, expectedTransport: () => { throw new Error('not used') } })
const ask = (runId: string, over: Record<string, unknown> = {}) => ({ action: 'pin' as const, homeNodeId: 'home', executorNodeId: 'target', model: MODEL,
  runId, sessionId: `s-${runId}`, epoch: 1, challenge: `c-${runId}-${Math.random()}`, ...over })

interface Pair { lease: { now: number }; restartTarget(): SimNode; homeCtx: { identity: ReturnType<typeof keys>['identity']; readOnly: boolean; version: { major: number; minor: number } }; target: SimNode; home: () => SimNode; crash(maintenanceMs?: number): SimNode; streams(): string[]; down: { value: boolean; hang?: boolean }; sent: string[]; attempts: { value: number }; dir: string }
function pair(t: { after(fn: () => unknown): void }, o: { maxPins?: number; pinTtlMs?: number; maintenanceMs?: number; persistentTarget?: boolean } = {}): Pair {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-reap-')), path = join(dir, 'home.sqlite'), down = { value: false } as { value: boolean; hang?: boolean }, sent: string[] = [], attempts = { value: 0 }
  const homeKeys = keys('home'), targetKeys = keys('target'), homeCtx = { identity: homeKeys.identity, readOnly: false, version: { major: 1, minor: 4 } }
  let home!: SimNode, target!: SimNode
  const lease = { now: 1_000_000 }, mono = () => lease.now, targetPath = o.persistentTarget ? join(dir, 'target.sqlite') : ':memory:'
  const channel = (from: () => SimNode, to: () => SimNode) => new FederationChannel({ local: from().keys.identity, privateKey: from().keys.privateKey, peer: to().keys.identity,
    clock: () => from().time, transport: async request => {
      const route = new URL(request.url).pathname.replace('/api/federation', '')
      if (route === '/attempts/runtime/pin') sent.push((await request.clone().json() as { action: string }).action)
      attempts.value++
      if (down.hang) return new Promise<Response>(() => undefined)
      if (down.value) throw new Error('executor unreachable')
      return to().app.request(request)
    } })
  const tp: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: mono, channel: () => channel(() => target, () => home),
    relayLimits: { ...(o.maxPins ? { maxPinsPerPeer: o.maxPins } : {}), ...(o.pinTtlMs ? { pinTtlMs: o.pinTtlMs } : {}) }, relayPinMaintenanceMs: o.maintenanceMs ?? 0 }
  const openTarget = () => new SimNode(targetKeys, targetPath, { attempts: { governor: new ResourceGovernor(), maxReservationMs: 5000, leaseClock: mono }, dispatch: tp })
  target = openTarget()
  tp.relayRuntime = stubRuntime(() => target.time)
  const open = (maintenanceMs = 0) => {
    const policy: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: mono, channel: () => channel(() => home, () => target), relayPinMaintenanceMs: maintenanceMs }
    const node = new SimNode(homeKeys, path, { attempts: { governor: new ResourceGovernor(), maxReservationMs: 5000, leaseClock: mono }, dispatch: policy })
    node.trust(target); return node
  }
  home = open(); target.trust(home)
  t.after(() => { try { home.close() } catch { /* already closed */ } target.close(); rmSync(dir, { recursive: true, force: true }) })
  return { lease, get target() { return target }, restartTarget() { const time = target.time; target.close(); target = openTarget(); target.time = time; target.trust(home); return target },
    homeCtx, home: () => home, dir, down, sent, attempts,
    crash(maintenanceMs = 0) { home.close(); home = open(maintenanceMs); return home },
    streams: () => (target.db.prepare('SELECT id FROM federation_streams ORDER BY id').all() as Array<{ id: string }>).map(row => row.id) }
}
/** What RemoteRelaySession.prepareBind does: journal first, then the signed pin. */
async function pinFromHome(p: Pair, runId: string, epoch = 1): Promise<void> {
  const home = p.home(), request = ask(runId, { epoch })
  home.federation.journalRelayPin('target', { runId, sessionId: request.sessionId, epoch, model: MODEL })
  await home.federation.relayChannel('target').relayPin(request)
}
const journal = (node: SimNode) => (node.db.prepare('SELECT run_id FROM federation_relay_pin_journal ORDER BY run_id').all() as Array<{ run_id: string }>).map(row => row.run_id)

test('without reaping, crashed runs exhaust maxPinsPerPeer (the premise), and with reconciliation 20 crashes in a row never do', async t => {
  const control = pair(t)
  for (let i = 0; i < 16; i++) { await pinFromHome(control, `old-${i}`); control.crash() }   // no reconciliation: control group
  await assert.rejects(pinFromHome(control, 'old-16'), /peer_refused/, 'the 17th pin is refused at the default cap of 16')
  assert.equal(control.streams().length, 16)

  const p = pair(t)
  for (let i = 0; i < 20; i++) {
    await pinFromHome(p, `run-${i}`)                                  // the executor acknowledges the pin ...
    assert.deepEqual(p.streams(), [`relay:run-${i}`], `exactly the live run's pin before crash ${i}`)
    const restarted = p.crash()                                       // ... and the home dies before the run is anywhere else
    assert.deepEqual(journal(restarted), [`run-${i}`], 'the durable journal survived')
    assert.deepEqual(await restarted.federation.reconcileRelayPins(), { released: 1, kept: 0, failed: 0 })
    assert.deepEqual(p.streams(), [], `no stale pin after reconciliation ${i}`)
    assert.deepEqual(journal(restarted), [])
  }
  assert.equal(p.sent.filter(a => a === 'pin').length, 20)
  assert.equal(p.sent.filter(a => a === 'unpin').length, 20)
})

test('the home reaps by itself after a restart: the maintenance timer needs no host wiring', async t => {
  const p = pair(t)
  await pinFromHome(p, 'dead-1'); await pinFromHome(p, 'dead-2')
  p.crash(10)
  await until(() => p.streams().length === 0, 5000)
  assert.deepEqual(journal(p.home()), [])
})

test('reconciliation never unpins a live run, including one that is still pinning while it runs', async t => {
  const p = pair(t)
  await pinFromHome(p, 'dead')
  const home = p.crash()
  // A live session of this process: journaled and registered, pinned on the executor.
  await pinFromHome(p, 'live')
  const during = (async () => { await pinFromHome(p, 'fresh') })()            // a start that overlaps the reconciliation
  const result = await home.federation.reconcileRelayPins()
  await during
  assert.deepEqual(p.streams(), ['relay:fresh', 'relay:live'], 'only the dead run lost its pin')
  assert.deepEqual(result, { released: 1, kept: 2, failed: 0 }, 'the live and the overlapping fresh run are kept, the dead one is released')
  assert.deepEqual(journal(home), ['fresh', 'live'])
  // The live pin still serves its run: the executor answers its observe.
  const live = { homeNodeId: 'home', executorNodeId: 'target', model: MODEL, run: { runId: 'live', sessionId: 's-live', fence: { attemptId: 'a', epoch: 1, token: 1 } } }
  assert.equal((await p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'x' })).entry.kind, 'observe')
  // Once the session retires without an acknowledged unpin, the next reconciliation takes it.
  home.federation.retireRelayPin('live')
  assert.equal((await home.federation.reconcileRelayPins()).released, 1)
  assert.deepEqual(p.streams(), ['relay:fresh'])
})

test('an unpin is fenced by the epoch: a late unpin of an old attempt removes nothing, another home is refused, the right one removes the pin', async t => {
  const p = pair(t), channel = () => p.home().federation.relayChannel('target')
  await pinFromHome(p, 'run', 2)
  const late = await channel().relayPin(ask('run', { action: 'unpin', epoch: 1 }))
  assert.equal(late.epoch, 1, 'acknowledged (idempotent) ...')
  assert.deepEqual(p.streams(), ['relay:run'], '... but the newer pin stays')
  assert.throws(() => p.target.federation.replicas.unbind('relay:run', 'another-home', 2), /home_conflict/, 'another home never removes it, whatever epoch it names')
  assert.deepEqual(p.streams(), ['relay:run'])
  await channel().relayPin(ask('run', { action: 'unpin', epoch: 2 }))
  assert.deepEqual(p.streams(), [])
  await channel().relayPin(ask('run', { action: 'unpin', epoch: 2 }))        // unknown pin: still acknowledged
})

test('an unreachable executor keeps the journal row, and the next pass releases it', async t => {
  const p = pair(t)
  await pinFromHome(p, 'run')
  const home = p.crash()
  p.down.value = true
  assert.deepEqual(await home.federation.reconcileRelayPins(), { released: 0, kept: 0, failed: 1 })
  assert.deepEqual(journal(home), ['run']); assert.deepEqual(p.streams(), ['relay:run'])
  p.down.value = false
  assert.deepEqual(await home.federation.reconcileRelayPins(), { released: 1, kept: 0, failed: 0 })
  assert.deepEqual(p.streams(), [])
})

test('the executor lease: an expired pin is released on its own transaction, frees the cap and serves nothing', async t => {
  const p = pair(t, { maxPins: 1, pinTtlMs: 1000 }), live = { homeNodeId: 'home', executorNodeId: 'target', model: MODEL, run: { runId: 'a', sessionId: 's-a', fence: { attemptId: 'x', epoch: 1, token: 1 } } }
  await pinFromHome(p, 'a')
  await assert.rejects(pinFromHome(p, 'b'), /peer_refused/, 'the cap holds while the lease does')
  p.lease.now += 999
  assert.equal((await p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c1' })).entry.kind, 'observe', 'inside the lease')
  p.lease.now += 999                                                     // 1998 ms after the pin, 999 after its use: renewed by use
  assert.equal((await p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c2' })).entry.kind, 'observe', 'a valid use renews the lease')
  p.lease.now += 1001                                                    // the home never came back
  await assert.rejects(p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c3' }), /unknown_stream/, 'an expired pin serves no run')
  assert.deepEqual(p.streams(), [])
  assert.equal(p.target.db.prepare('SELECT COUNT(*) n FROM federation_relay_pin_leases').get()!.n, 0, 'its lease row is gone too')
  await pinFromHome(p, 'b')                                                // the cap is free again
  assert.deepEqual(p.streams(), ['relay:b'])
  // Asking again (the home's heartbeat) renews, and restores a lapsed pin.
  p.lease.now += 900; await p.home().federation.relayChannel('target').relayPin(ask('b')); p.lease.now += 900
  assert.equal(p.target.federation.sweepRelayPins(), 0); assert.deepEqual(p.streams(), ['relay:b'])
  p.lease.now += 200
  assert.equal(p.target.federation.sweepRelayPins(), 1); assert.deepEqual(p.streams(), [])
})

test('the executor sweep removes a lease-less relay pin and leaves ordinary pins and replicated streams alone', async t => {
  const p = pair(t)
  const bind = (streamId: string) => p.target.federation.replicas.bind({ streamId, kind: 'run', sessionId: `s-${streamId}`, ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  p.target.federation.sweepRelayPins()                                   // the boot grace is spent on the first sweep; a lease-less pin made after it is not owed one
  bind('relay:legacy'); bind('ordinary-run')
  assert.equal(p.target.federation.sweepRelayPins(), 1)
  assert.deepEqual(p.streams(), ['ordinary-run'])
})

test('the home session journals before the pin leaves, settles on release, and a release that cannot reach the executor leaves the row to the reconciliation', async t => {
  const f = await remoteFixture(t)
  let atPin: string[] | undefined
  f.probes.push(path => { if (path === '/attempts/runtime/pin' && !atPin) atPin = (f.home.db.prepare('SELECT run_id FROM federation_relay_pin_journal').all() as Array<{ run_id: string }>).map(r => r.run_id) })
  const r = await f.relay('journaled')
  assert.deepEqual(atPin, ['journaled'], 'the intent was durable before the first pin message')
  const rows = () => (f.home.db.prepare('SELECT run_id FROM federation_relay_pin_journal').all() as Array<{ run_id: string }>).map(x => x.run_id)
  assert.deepEqual(rows(), ['journaled'])
  assert.deepEqual(await f.home.federation.reconcileRelayPins(), { released: 0, kept: 1, failed: 0 }, 'a live session is kept')
  await r.prepared.release!()
  assert.deepEqual(rows(), [], 'an acknowledged unpin settles the row')

  const g = await remoteFixture(t), s = await g.relay('stranded')
  g.rules.push(path => { if (path === '/attempts/runtime/pin') throw new Error('executor unreachable') })
  await s.prepared.release!()
  assert.deepEqual((g.home.db.prepare('SELECT run_id FROM federation_relay_pin_journal').all() as Array<{ run_id: string }>).map(x => x.run_id), ['stranded'], 'the pin could not be released, so the journal still names it')
  assert.deepEqual(g.target.db.prepare("SELECT id FROM federation_streams WHERE id LIKE 'relay:%'").all().map(x => x.id), ['relay:stranded'])
  g.rules.length = 0
  assert.deepEqual(await g.home.federation.reconcileRelayPins(), { released: 1, kept: 0, failed: 0 })
  assert.deepEqual(g.target.db.prepare("SELECT id FROM federation_streams WHERE id LIKE 'relay:%'").all(), [])
})

test('a live session renews its lease by heartbeat, so an idle run outlives the executor TTL; without the heartbeat it does not', async t => {
  const beating = await remoteFixture(t, { relayLimits: { pinTtlMs: 1000 }, pinRenewMs: 15 })
  await beating.relay('beat')
  const pins = (f: typeof beating) => f.target.db.prepare("SELECT id FROM federation_streams WHERE id LIKE 'relay:%'").all().map(x => x.id)
  for (let i = 0; i < 4; i++) {
    const before = beating.sent.filter(s => s.path === '/attempts/runtime/pin').length
    beating.clock.mono += 900                                           // idle: no observe, no count
    // Not lapsed-and-restored: the pin is still there before the beat arrives, and the lease it has was renewed, not recreated.
    assert.equal(beating.target.federation.sweepRelayPins(), 0, 'a sweep right now removes nothing')
    await until(() => beating.sent.filter(s => s.path === '/attempts/runtime/pin').length > before, 3000)
    await until(() => Number(beating.target.db.prepare('SELECT expires_at FROM federation_relay_pin_leases').get()?.expires_at) === beating.clock.mono + 1000, 3000)
    assert.deepEqual(pins(beating), ['relay:beat'], `still pinned after ${(i + 1) * 900} ms idle`)
  }
  const silent = await remoteFixture(t, { relayLimits: { pinTtlMs: 1000 } })
  await silent.relay('quiet')
  silent.clock.mono += 1001
  assert.equal(silent.target.federation.sweepRelayPins(), 1, 'the default heartbeat is 60 s of real time, far from this test')
})

test('migration 42 upgrades a database made before F2-reap, reopening is idempotent and federation_migrations stays [34]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-reap-mig-')), path = join(dir, 'node.sqlite'), k = keys('solo')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  new SimNode(k, path).close()
  const old = openDb(path)
  old.exec('DROP TABLE federation_relay_pin_journal; DROP TABLE federation_relay_pin_leases; DROP TABLE federation_relay_pin_tombstones; DROP TABLE federation_relay_pin_migrations')
  old.close()
  for (let reopen = 0; reopen < 2; reopen++) {                         // the second reopening finds the ledger and changes nothing
    const node = new SimNode(k, path)
    assert.deepEqual(node.db.prepare('SELECT version FROM federation_relay_pin_migrations').all().map(r => r.version), [42])
    assert.deepEqual(node.db.prepare('SELECT version FROM federation_migrations').all().map(r => r.version), [34])
    node.federation.journalRelayPin('elsewhere', { runId: `r${reopen}`, sessionId: 's', epoch: 1, model: MODEL })
    node.close()
  }
  const again = openDb(path)
  assert.deepEqual(again.prepare('SELECT run_id FROM federation_relay_pin_journal ORDER BY run_id').all().map(r => r.run_id), ['r0', 'r1'], 'rows written after the upgrade survive reopening')
  again.close()
})

test('a heartbeat slower than the 5 s bound of the session itself cannot re-create the pin after its unpin', async t => {
  const f = await remoteFixture(t, { pinRenewMs: 10 }), r = await f.relay('late-beat')
  let delayed = 0
  f.rules.push(async (path, request) => {
    if (path !== '/attempts/runtime/pin') return
    if ((await request.clone().json() as { action: string }).action === 'pin' && !delayed++) await new Promise(resolve => setTimeout(resolve, 5500))   // slower than the heartbeat's own 5 s bound
  })
  await until(() => delayed > 0, 3000)                                   // a renewal is in flight, held up in transit
  await r.prepared.release!()
  await new Promise(resolve => setTimeout(resolve, 1200))                // the beat is still in transit when the session lets go, and lands after the unpin
  assert.deepEqual(f.target.db.prepare("SELECT id FROM federation_streams WHERE id LIKE 'relay:%'").all(), [], 'the unpin was the last word')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM federation_relay_pin_journal').get()!.n, 0)
})

test('an executor that permanently refuses one journaled row does not block the releasable rows behind it', async t => {
  const p = pair(t), home = p.home()
  // The oldest row names a model the executor does not serve: a definitive 409, never going to succeed.
  home.federation.journalRelayPin('target', { runId: 'aaa-refused', sessionId: 's-refused', epoch: 1, model: 'other-model' })
  await pinFromHome(p, 'good')
  const restarted = p.crash()
  assert.deepEqual(await restarted.federation.reconcileRelayPins(), { released: 1, kept: 0, failed: 1 }, 'the refused row fails, the good one is released in the same pass')
  assert.deepEqual(p.streams(), [], 'relay:good is gone')
  assert.deepEqual(journal(restarted), ['aaa-refused'], 'the refused row stays for the executor lease to backstop')
  // A transport failure still ends the pass for that executor after one attempt (it is down, not refusing).
  restarted.federation.journalRelayPin('target', { runId: 'zzz-1', sessionId: 's', epoch: 1, model: MODEL }); restarted.federation.retireRelayPin('zzz-1')
  p.down.value = true
  const before = p.attempts.value
  assert.deepEqual(await restarted.federation.reconcileRelayPins(), { released: 0, kept: 0, failed: 2 })
  assert.equal(p.attempts.value - before, 1, 'one request for two rows of a down executor')
})

test('the lease runs on the lease clock: a wall-clock jump lapses nothing, and the lease still ends by the lease clock', async t => {
  const p = pair(t, { pinTtlMs: 1000 })
  await pinFromHome(p, 'a')
  p.target.time += 24 * 3_600_000                                        // the wall clock leaps a day (NTP step, resume)
  assert.equal(p.target.federation.sweepRelayPins(), 0, 'the wall clock is not the lease clock')
  assert.deepEqual(p.streams(), ['relay:a'])
  p.lease.now += 1001
  assert.equal(p.target.federation.sweepRelayPins(), 1)
})

test('an executor restart grants every relay pin a fresh lease, including lease-less ones, so homes can renew first', async t => {
  const p = pair(t, { pinTtlMs: 1000, persistentTarget: true })
  await pinFromHome(p, 'a')
  p.target.federation.replicas.bind({ streamId: 'relay:legacy', kind: 'run', sessionId: 's-legacy', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  p.lease.now += 50_000                                                  // an outage far longer than the TTL: both leases are long expired
  const restarted = p.restartTarget()
  assert.equal(restarted.federation.sweepRelayPins(), 0, 'nothing is swept at boot')
  assert.deepEqual(p.streams(), ['relay:a', 'relay:legacy'])
  const expiries = restarted.db.prepare('SELECT expires_at FROM federation_relay_pin_leases ORDER BY stream_id').all().map(r => r.expires_at)
  assert.deepEqual(expiries, [p.lease.now + 1000, p.lease.now + 1000], 'a grace of one TTL from the boot')
  p.lease.now += 500
  await p.home().federation.relayChannel('target').relayPin(ask('a'))    // the home renews inside the grace
  p.lease.now += 600
  assert.equal(restarted.federation.sweepRelayPins(), 1, 'only the pin nobody renewed lapses')
  assert.deepEqual(p.streams(), ['relay:a'])
})

test('a first pin that was aborted in transit cannot create the pin after the unpin that undid it', async t => {
  const f = await remoteFixture(t), controller = new AbortController()
  const prepared = await f.source.prepare(f.homeConnection.id, 'fixture', 1000, controller.signal)
  let held = 0
  f.rules.push(async (path, request) => {
    if (path === '/attempts/runtime/pin' && (await request.clone().json() as { action: string }).action === 'pin' && !held++) await new Promise(resolve => setTimeout(resolve, 600))
  })
  const run = f.home.runs.create({ id: 'aborted', sessionId: 'aborted-session' }), attempt = f.home.runs.start(run.id)
  const binding = prepared.prepareBind!({ runId: run.id, sessionId: run.session_id, epoch: attempt.epoch }, controller.signal).catch((error: unknown) => error)
  await until(() => held > 0, 3000)
  controller.abort()                                                     // the start is abandoned while the pin is still on the wire
  assert.ok((await binding) instanceof Error)
  await new Promise(resolve => setTimeout(resolve, 900))                 // the pin lands after the unpin
  assert.deepEqual(f.target.db.prepare("SELECT id FROM federation_streams WHERE id LIKE 'relay:%'").all(), [], 'the unpin was the last word')
})

test('a released relay run is tombstoned on the executor for one TTL, and the tombstone lapses', async t => {
  const p = pair(t, { pinTtlMs: 1000 }), channel = () => p.home().federation.relayChannel('target')
  await channel().relayPin(ask('gone', { action: 'unpin' }))              // an unpin that found nothing still records the release
  await assert.rejects(channel().relayPin(ask('gone')), /peer_refused/, 'a pin of a released run id is refused')
  assert.deepEqual(p.streams(), [])
  await pinFromHome(p, 'kept', 2)
  await channel().relayPin(ask('kept', { action: 'unpin', epoch: 1 }))    // fenced out: nothing was released, so nothing is tombstoned
  await channel().relayPin(ask('kept', { epoch: 2 }))
  p.lease.now += 1001
  p.target.federation.sweepRelayPins()
  assert.equal(p.target.db.prepare('SELECT COUNT(*) n FROM federation_relay_pin_tombstones').get()!.n, 0, 'tombstones lapse with the TTL')
})

test('closing the federation ends a reconciliation that waits on a hung executor at once', async t => {
  const p = pair(t)
  await pinFromHome(p, 'run')
  const home = p.crash()
  p.down.hang = true
  const pass = home.federation.reconcileRelayPins()
  await new Promise(resolve => setTimeout(resolve, 50))
  const started = Date.now()
  home.federation.close()
  await pass
  assert.ok(Date.now() - started < 1000, `the pass ended ${Date.now() - started} ms after close, not after the 5 s unpin bound`)
})

test('the maintenance and heartbeat periods are capped at the largest timer Node honours', async t => {
  const p = pair(t), tooLong = 2 ** 31
  assert.throws(() => new SimNode(keys('x'), ':memory:', { attempts: { governor: new ResourceGovernor(), maxReservationMs: 5000, leaseClock: () => 1 },
    dispatch: { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: () => 1, channel: () => { throw new Error('unused') }, relayPinMaintenanceMs: tooLong } }), /invalid_relay_limits/)
  const f = await remoteFixture(t)
  assert.throws(() => new RemoteRelayRuntime({ federation: f.home.federation, runs: f.home.runs, executorNodeId: 'target', model: 'fixture', pinRenewMs: tooLong }), /relay_policy_invalid/)
  new RemoteRelayRuntime({ federation: f.home.federation, runs: f.home.runs, executorNodeId: 'target', model: 'fixture', pinRenewMs: 2 ** 31 - 1 })
  assert.ok(p)
})

test('a federation closed under a starting relay refuses the start cleanly and leaves the session reusable-or-refusing, never half bound', async t => {
  const f = await remoteFixture(t), controller = new AbortController()
  const prepared = await f.source.prepare(f.homeConnection.id, 'fixture', 1000, controller.signal)
  f.home.federation.close()
  const bind = () => prepared.prepareBind!({ runId: 'closed-run', sessionId: 'closed-session', epoch: 1 }, controller.signal).then(() => 'bound', (error: { code?: string }) => error.code)
  assert.equal(await bind(), 'runtime_meter_unavailable', 'a typed relay refusal, not the raw federation error')
  assert.equal(await bind(), 'runtime_meter_unavailable', 'and no stale pending state turns the next attempt into relay_policy_invalid')
})

test('an executor refuses relay pins from a home older than the lease protocol, and the handshake offers 1.6 (R2-json)', async t => {
  const p = pair(t), old = { ...p.homeCtx, version: { major: 1, minor: 4 } }, fresh = { ...p.homeCtx, version: { major: 1, minor: 5 } }
  await assert.rejects(async () => p.target.federation.receiveRelayPin(old, ask('old')), /contract_feature_unavailable/, 'a home without the heartbeat would lose its pin mid-run')
  assert.deepEqual(p.streams(), [])
  assert.equal(p.target.federation.receiveRelayPin(fresh, ask('new')).entry.runId, 'new')
  assert.equal(FEDERATION_VERSION.minor, 6)
})
