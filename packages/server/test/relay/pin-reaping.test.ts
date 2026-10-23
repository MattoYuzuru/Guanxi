/** F2-reap: stale executor relay pins are released by the home's reconciliation and, failing that, by the executor's own lease.
 * Two in-process nodes over signed in-memory channels; the "crash" closes the home node without releasing anything and reopens the
 * same database file, which is exactly what a restarted process sees (an empty live set and a durable journal). */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FederationChannel } from '../../src/federation/channel.ts'
import type { DispatchPolicy } from '../../src/remote-attempts/dispatch.ts'
import type { ExecutorRelayRuntime } from '../../src/remote-attempts/relay-runtime.ts'
import { normalizeOllamaModelReference } from '../../src/runtime/observation-key.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { openDb } from '../../src/store/db.ts'
import { SimNode } from '../federation/harness.ts'
import { keys, remoteFixture, until } from './remote-fixture.ts'

const MODEL = 'fixture'
const REF = normalizeOllamaModelReference(MODEL)!
const stubRuntime = (now: () => number): ExecutorRelayRuntime => ({ model: REF,
  observe: async () => ({ model: REF, digest: 'sha256:d', contextTokens: 16000, runtimeVersion: 'b1', source: 'stub', observedAt: now() }),
  measure: async () => { throw new Error('not used') }, expectedTransport: () => { throw new Error('not used') } })
const ask = (runId: string, over: Record<string, unknown> = {}) => ({ action: 'pin' as const, homeNodeId: 'home', executorNodeId: 'target', model: MODEL,
  runId, sessionId: `s-${runId}`, epoch: 1, challenge: `c-${runId}-${Math.random()}`, ...over })

interface Pair { homeCtx: { identity: ReturnType<typeof keys>['identity']; readOnly: boolean; version: { major: number; minor: number } }; target: SimNode; home: () => SimNode; crash(maintenanceMs?: number): SimNode; streams(): string[]; down: { value: boolean }; sent: string[]; attempts: { value: number }; dir: string }
function pair(t: { after(fn: () => unknown): void }, o: { maxPins?: number; pinTtlMs?: number; maintenanceMs?: number } = {}): Pair {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-reap-')), path = join(dir, 'home.sqlite'), down = { value: false }, sent: string[] = [], attempts = { value: 0 }
  const homeKeys = keys('home'), targetKeys = keys('target'), homeCtx = { identity: homeKeys.identity, readOnly: false, version: { major: 1, minor: 4 } }
  let home!: SimNode, target!: SimNode
  const mono = () => 1_000_000
  const channel = (from: () => SimNode, to: () => SimNode) => new FederationChannel({ local: from().keys.identity, privateKey: from().keys.privateKey, peer: to().keys.identity,
    clock: () => from().time, transport: async request => {
      const route = new URL(request.url).pathname.replace('/api/federation', '')
      if (route === '/attempts/runtime/pin') sent.push((await request.clone().json() as { action: string }).action)
      attempts.value++
      if (down.value) throw new Error('executor unreachable')
      return to().app.request(request)
    } })
  const tp: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: mono, channel: () => channel(() => target, () => home),
    relayLimits: { ...(o.maxPins ? { maxPinsPerPeer: o.maxPins } : {}), ...(o.pinTtlMs ? { pinTtlMs: o.pinTtlMs } : {}) }, relayPinMaintenanceMs: o.maintenanceMs ?? 0 }
  target = new SimNode(targetKeys, ':memory:', { attempts: { governor: new ResourceGovernor(), maxReservationMs: 5000, leaseClock: mono }, dispatch: tp })
  tp.relayRuntime = stubRuntime(() => target.time)
  const open = (maintenanceMs = 0) => {
    const policy: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: mono, channel: () => channel(() => home, () => target), relayPinMaintenanceMs: maintenanceMs }
    const node = new SimNode(homeKeys, path, { attempts: { governor: new ResourceGovernor(), maxReservationMs: 5000, leaseClock: mono }, dispatch: policy })
    node.trust(target); return node
  }
  home = open(); target.trust(home)
  t.after(() => { try { home.close() } catch { /* already closed */ } target.close(); rmSync(dir, { recursive: true, force: true }) })
  return { homeCtx, target, home: () => home, dir, down, sent, attempts,
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
  p.target.time += 999
  assert.equal((await p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c1' })).entry.kind, 'observe', 'inside the lease')
  p.target.time += 999                                                     // 1998 ms after the pin, 999 after its use: renewed by use
  assert.equal((await p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c2' })).entry.kind, 'observe', 'a valid use renews the lease')
  p.target.time += 1001                                                    // the home never came back
  await assert.rejects(p.target.federation.receiveRelayObserve(p.homeCtx, { binding: live, challenge: 'c3' }), /unknown_stream/, 'an expired pin serves no run')
  assert.deepEqual(p.streams(), [])
  assert.equal(p.target.db.prepare('SELECT COUNT(*) n FROM federation_relay_pin_leases').get()!.n, 0, 'its lease row is gone too')
  await pinFromHome(p, 'b')                                                // the cap is free again
  assert.deepEqual(p.streams(), ['relay:b'])
  // Asking again (the home's heartbeat) renews, and restores a lapsed pin.
  p.target.time += 900; await p.home().federation.relayChannel('target').relayPin(ask('b')); p.target.time += 900
  assert.equal(p.target.federation.sweepRelayPins(), 0); assert.deepEqual(p.streams(), ['relay:b'])
  p.target.time += 200
  assert.equal(p.target.federation.sweepRelayPins(), 1); assert.deepEqual(p.streams(), [])
})

test('the executor sweep removes a lease-less relay pin and leaves ordinary pins and replicated streams alone', async t => {
  const p = pair(t)
  const bind = (streamId: string) => p.target.federation.replicas.bind({ streamId, kind: 'run', sessionId: `s-${streamId}`, ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
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
    beating.target.time += 900                                           // idle: no observe, no count
    await until(() => beating.sent.filter(s => s.path === '/attempts/runtime/pin').length > before, 3000)
    assert.deepEqual(pins(beating), ['relay:beat'], `still pinned after ${(i + 1) * 900} ms idle`)
  }
  const silent = await remoteFixture(t, { relayLimits: { pinTtlMs: 1000 } })
  await silent.relay('quiet')
  silent.target.time += 1001
  assert.equal(silent.target.federation.sweepRelayPins(), 1, 'the default heartbeat is 60 s of real time, far from this test')
})

test('migration 42 upgrades a database made before F2-reap, reopening is idempotent and federation_migrations stays [34]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-reap-mig-')), path = join(dir, 'node.sqlite'), k = keys('solo')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  new SimNode(k, path).close()
  const old = openDb(path)
  old.exec('DROP TABLE federation_relay_pin_journal; DROP TABLE federation_relay_pin_leases; DROP TABLE federation_relay_pin_migrations')
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

test('a heartbeat already on the wire when the session is released cannot re-create the pin after its unpin', async t => {
  const f = await remoteFixture(t, { pinRenewMs: 10 }), r = await f.relay('late-beat')
  let delayed = 0
  f.rules.push(async (path, request) => {
    if (path !== '/attempts/runtime/pin') return
    if ((await request.clone().json() as { action: string }).action === 'pin') { delayed++; await new Promise(resolve => setTimeout(resolve, 150)) }
  })
  await until(() => delayed > 0, 3000)                                   // a renewal is in flight, held up in transit
  await r.prepared.release!()
  await new Promise(resolve => setTimeout(resolve, 300))                 // long enough for a misordered renewal to land
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
