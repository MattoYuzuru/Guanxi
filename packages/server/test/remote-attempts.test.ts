import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FederationChannel } from '../src/federation/channel.ts'
import { ATTEMPT_RESERVATIONS_CAPABILITY } from '@guanxi/contract/federation'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { AttemptOffers } from '../src/remote-attempts/offers.ts'
import { RunStore } from '../src/runs/store.ts'
import { requestProof, signValue } from '../src/federation/crypto.ts'
import { identity, SimNode } from './federation/harness.ts'

function keys(id: string) { return identity(id, { scopes: ['config', 'replicas', 'commands', 'telemetry', 'attempts'] }) }
function pair() {
  const hg = new ResourceGovernor(), tg = new ResourceGovernor(), clock = { now: 1_000_000 }
  const home = new SimNode(keys('home'), ':memory:', { attempts: { governor: hg, maxReservationMs: 5000, leaseClock: () => clock.now } })
  const target = new SimNode(keys('target'), ':memory:', { attempts: { governor: tg, maxReservationMs: 5000, leaseClock: () => clock.now } })
  home.trust(target); target.trust(home)
  const run = home.runs.create({ id: 'run', sessionId: 'session' }), attempt = home.runs.start(run.id)
  target.federation.replicas.bind({ streamId: run.id, kind: 'run', sessionId: run.session_id, ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
  assert.throws(() => target.federation.attemptOffers!.read('home', 'not-created'), /offer_not_found/)
  const create = (id = 'offer', expiresAt = home.time + 5000) => home.federation.createAttemptOffer(attempt,
    { id, executorNodeId: 'target', expiresAt, resource: { kind: 'local_inference', model: 'fixture-model', requestedContext: 32768 } })
  const context = { identity: home.keys.identity, readOnly: false, version: { major: 1, minor: 2 } }
  const channel = new FederationChannel({ local: home.keys.identity, privateKey: home.keys.privateKey, peer: target.keys.identity,
    clock: () => home.time, transport: async request => target.app.request(request) })
  return { home, target, hg, tg, run, attempt, create, context, channel, clock,
    close() { home.close(); target.close(); void hg.close(); void tg.close() } }
}

test('signed offer reserves the exact executor governor before acceptance and never authorizes dispatch', async () => {
  const f = pair()
  try {
    const offer = f.create(), receipt = await f.channel.offer(offer)
    assert.equal(receipt.status, 'reserved'); assert.equal(receipt.dispatchAuthorized, false)
    assert.equal(receipt.executorNodeId, 'target'); assert.deepEqual(receipt.fence, offer.fence)
    assert.equal(receipt.reservation!.ticketId, f.tg.snapshot().activeLease!.ticketId)
    assert.equal(f.tg.snapshot().activeLease!.requestedContext, 32768)
    assert.equal(f.tg.snapshot().activeLease!.model.name, 'fixture-model')
    assert.equal(f.target.runs.attempts('run').length, 0)
    assert.equal(f.home.runs.get('run').state, 'working')
    assert.equal(f.target.db.prepare('SELECT version FROM remote_attempt_migrations').get()!.version, 36)
    const canceled = await f.channel.cancelOffer({ offerId: offer.id, homeNodeId: 'home', executorNodeId: 'target' })
    assert.equal(canceled.status, 'canceled'); assert.equal(f.tg.snapshot().activeLease, null)
  } finally { f.close() }
})

test('concurrent exact retries share one governor ticket and changed payloads insert nothing', async () => {
  const f = pair()
  try {
    const offer = f.create(), [a, b] = await Promise.all([f.channel.offer(offer), f.channel.offer(offer)])
    assert.deepEqual(a, b); assert.equal(f.tg.snapshot().queued.length, 0)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 1)
    await assert.rejects(f.target.federation.receiveAttemptOffer(f.context, { ...offer, resource: { ...offer.resource, requestedContext: 65536 } }), /offer_conflict/)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 1)
  } finally { f.close() }
})

test('busy governor keeps the offer queued with zero reservation until its existing holder releases', async () => {
  const f = pair()
  const ticket = f.tg.enqueue({ owner: { kind: 'operation', operationId: 'interactive' }, operation: 'chat',
    model: { provider: 'ollama', name: 'resident' }, requestedContext: 16000, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const busy = await f.tg.acquire(ticket)
  try {
    const offer = f.create(), pending = f.target.federation.receiveAttemptOffer(f.context, offer)
    assert.equal(f.target.federation.attemptOffers!.read('home', offer.id).status, 'queued')
    assert.equal(f.target.federation.attemptOffers!.read('home', offer.id).reservation, null)
    assert.equal(f.tg.snapshot().activeLease!.owner.kind, 'operation')
    assert.equal(f.tg.snapshot().queued.length, 1)
    busy.release()
    assert.equal((await pending).status, 'reserved')
    assert.equal(f.tg.snapshot().activeLease!.owner.kind, 'operation')
    assert.equal(f.tg.snapshot().queued.length, 0)
  } finally { busy.release(); f.close() }
})

test('expiry and queued cancellation release admission exactly once without overwriting terminal reasons', async () => {
  const f = pair()
  try {
    const first = f.create('short', f.home.time + 10)
    await f.target.federation.receiveAttemptOffer(f.context, first)
    f.clock.now += 11
    assert.equal(f.target.federation.attemptOffers!.read('home', first.id).status, 'expired')
    assert.equal(f.tg.snapshot().activeLease, null)
    const second = f.create('holder'), third = f.create('queued')
    await f.target.federation.receiveAttemptOffer(f.context, second)
    const pending = f.target.federation.receiveAttemptOffer(f.context, third)
    f.target.federation.cancelAttemptOffer(f.context, { offerId: third.id, homeNodeId: 'home', executorNodeId: 'target' })
    assert.equal((await pending).status, 'canceled')
    assert.equal(f.tg.snapshot().queued.length, 0)
    f.clock.now += 10000; f.target.federation.attemptOffers!.reap()
    assert.equal(f.target.federation.attemptOffers!.read('home', third.id).status, 'canceled')
  } finally { f.close() }
})

test('home stale fences cannot create durable intent and home intent is idempotent', () => {
  const f = pair()
  try {
    const offer = f.create(); assert.deepEqual(f.create(), offer)
    assert.throws(() => f.home.federation.createAttemptOffer(f.attempt, { id: offer.id, executorNodeId: 'target',
      expiresAt: offer.expiresAt, resource: { ...offer.resource, model: 'different-model' } }), /offer_conflict/)
    assert.deepEqual(JSON.parse(String(f.home.db.prepare('SELECT payload FROM remote_home_offers').get()!.payload)), offer)
    assert.throws(() => f.create('too-long', f.home.time + 60001), /offer_expiry/)
    assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_home_offers').get()!.n, 1)
    f.home.runs.cancel(f.run.id)
    assert.throws(() => f.create('stale'), /stale_lease/)
    assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM remote_home_offers').get()!.n, 1)
  } finally { f.close() }
})

test('newer fences invalidate old target reservations and stale offers cannot obtain another permit', async () => {
  const f = pair()
  try {
    const old = f.create(); await f.target.federation.receiveAttemptOffer(f.context, old)
    const replacement = { ...old, id: 'new', fence: { ...old.fence, attemptId: 'next-attempt', token: old.fence.token + 1 } }
    const receipt = await f.target.federation.receiveAttemptOffer(f.context, replacement)
    assert.equal(receipt.status, 'reserved')
    assert.equal(f.target.federation.attemptOffers!.read('home', old.id).status, 'fenced')
    await assert.rejects(f.target.federation.receiveAttemptOffer(f.context, { ...old, id: 'new-stale' }), /stale_lease/)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 2)
    assert.equal(f.tg.snapshot().activeLease!.ticketId, receipt.reservation!.ticketId)
  } finally { f.close() }
})

test('wrong home/executor, read-only peers, old minors, revoked grants and unbound runs reserve nothing', async () => {
  const f = pair()
  try {
    const offer = f.create()
    for (const changed of [{ homeNodeId: 'other' }, { executorNodeId: 'other' }, { runId: 'unbound' }, { expiresAt: f.home.time }])
      await assert.rejects(f.target.federation.receiveAttemptOffer(f.context, { ...offer, ...changed }))
    await assert.rejects(f.target.federation.receiveAttemptOffer({ ...f.context, readOnly: true }, offer), /contract_read_only/)
    await assert.rejects(f.target.federation.receiveAttemptOffer({ ...f.context, version: { major: 1, minor: 1 } }, offer), /contract_feature_unavailable/)
    f.target.federation.revokePeer('home')
    await assert.rejects(f.target.federation.receiveAttemptOffer(f.context, offer), /unauthenticated/)
    assert.equal(f.tg.snapshot().activeLease, null)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 0)
  } finally { f.close() }
})

test('outbound channel needs minor2 and the explicit capability; U1-only or disabled peers receive no offer', async () => {
  const f = pair()
  try {
    for (const [minor, capabilities] of [[1, [ATTEMPT_RESERVATIONS_CAPABILITY]], [2, []]] as const) {
      let posts = 0
      const channel = new FederationChannel({ local: f.home.keys.identity, privateKey: f.home.keys.privateKey, peer: f.target.keys.identity,
        transport: async request => { if (request.method === 'POST') posts++; return Response.json({ version: { major: 1, minor }, negotiated: { major: 1, minor }, readOnly: false, capabilities }) } })
      await assert.rejects(channel.offer(f.create(`minor-${minor}`)), /contract_feature_unavailable/)
      assert.equal(posts, 0)
    }
    const off = new SimNode(keys('disabled'))
    try {
      assert.deepEqual(off.federation.capabilities(), [])
      assert.equal(off.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='remote_attempt_migrations'").get()!.n, 0)
    } finally { off.close() }
  } finally { f.close() }
})

test('shutdown with a queued offer releases the waiter before the database closes', async () => {
  const f = pair()
  try {
    await f.target.federation.receiveAttemptOffer(f.context, f.create('first'))
    const pending = f.target.federation.receiveAttemptOffer(f.context, f.create('waiting'))
    f.target.federation.close()
    assert.equal((await pending).status, 'restart_lost')
    assert.equal(f.tg.snapshot().activeLease, null); assert.equal(f.tg.snapshot().queued.length, 0)
    assert.throws(() => f.target.federation.attemptOffers!.read('home', 'first'), /closed/)
  } finally { f.close() }
})

test('restart preserves intent and invalidates a persisted accepted receipt without execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanxi-f2-offer-')), path = join(directory, 'node.sqlite'), f = pair()
  let local: SimNode | undefined
  const g = new ResourceGovernor(), targetKeys = keys('target')
  try {
    local = new SimNode(targetKeys, path, { attempts: { governor: g, maxReservationMs: 5000 } })
    local.trust(f.home)
    local.federation.replicas.bind({ streamId: 'run', kind: 'run', sessionId: 'session', ownerAccountId: 'owner', homeNodeId: 'home', homeEpoch: 1 })
    const receipt = await local.federation.receiveAttemptOffer(f.context, f.create())
    assert.equal(receipt.status, 'reserved')
    local.federation.close()
    // A crashed process loses its permit without a shutdown write. Restore that exact
    // accepted payload after stopping the fixture's feature, before closing its database.
    local.db.prepare('UPDATE remote_target_offers SET receipt=?').run(JSON.stringify(receipt))
    assert.equal(JSON.parse(String(local.db.prepare('SELECT receipt FROM remote_target_offers').get()!.receipt)).status, 'reserved')
    local.close()
    local = new SimNode(targetKeys, path, { attempts: { governor: g, maxReservationMs: 5000 } })
    assert.equal(local.federation.attemptOffers!.read('home', 'offer').status, 'restart_lost')
    assert.equal(local.runs.attempts('run').length, 0)
    assert.equal(local.db.prepare('PRAGMA user_version').get()!.user_version, 32)
    assert.equal(local.db.prepare('SELECT version FROM federation_migrations').get()!.version, 34)
  } finally { local?.close(); void g.close(); f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('signature tampering, a foreign account, a shared device and a missing attempt scope obtain no reservation', async () => {
  const f = pair()
  try {
    const offer = f.create()
    const tampered = new FederationChannel({ local: f.home.keys.identity, privateKey: f.home.keys.privateKey, peer: f.target.keys.identity,
      clock: () => f.home.time, transport: async request => {
        if (request.method === 'POST') {
          const body = await request.json() as typeof offer
          return f.target.app.request(new Request(request.url, { method: 'POST', headers: request.headers,
            body: JSON.stringify({ ...body, executorNodeId: 'forged-executor' }) }))
        }
        return f.target.app.request(request)
      } })
    await assert.rejects(tampered.offer(offer), /peer_refused/)
    for (const [index, override] of [{ accountId: 'foreign', scopes: ['attempts'] as const },
      { trust: 'shared_device' as const, admin: false, scopes: ['attempts'] as const }, { scopes: ['config'] as const }].entries()) {
      const other = new SimNode(identity(`other-${index}`, { ...override, scopes: [...override.scopes] }))
      try {
        f.target.trust(other)
        await assert.rejects(f.target.federation.receiveAttemptOffer({ ...f.context, identity: other.keys.identity },
          { ...offer, homeNodeId: other.keys.identity.id }), /owner_mismatch|scope_denied/)
      } finally { other.close() }
    }
    assert.equal(f.tg.snapshot().activeLease, null)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 0)
  } finally { f.close() }
})

test('a deposed target generation cannot accept after the asynchronous governor wait', async () => {
  const f = pair()
  const ticket = f.tg.enqueue({ owner: { kind: 'operation', operationId: 'interactive' }, operation: 'chat',
    model: { provider: 'ollama', name: 'resident' }, requestedContext: 16000, priority: 'normal', enqueuedAt: new Date().toISOString() })
  const busy = await f.tg.acquire(ticket)
  try {
    const pending = f.target.federation.receiveAttemptOffer(f.context, f.create())
    f.target.db.prepare("UPDATE leases SET holder='replacement',token=token+1 WHERE key='durable-runs/home'").run()
    busy.release()
    await assert.rejects(pending, /stale_lease/)
    assert.equal(f.tg.snapshot().activeLease, null); assert.equal(f.tg.snapshot().queued.length, 0)
    const row = f.target.db.prepare('SELECT receipt FROM remote_target_offers').get()!
    assert.equal(JSON.parse(String(row.receipt)).status, 'queued')
  } finally { busy.release(); f.close() }
})

test('failed replacement persistence rolls back the watermark and preserves the old live reservation', async () => {
  const f = pair()
  try {
    const old = f.create(), accepted = await f.target.federation.receiveAttemptOffer(f.context, old)
    f.target.db.exec("CREATE TRIGGER refused_offer BEFORE INSERT ON remote_target_offers WHEN NEW.id='replacement' BEGIN SELECT RAISE(ABORT,'fixture_refusal'); END")
    await assert.rejects(f.target.federation.receiveAttemptOffer(f.context, { ...old, id: 'replacement', fence: { ...old.fence, token: old.fence.token + 1 } }), /fixture_refusal/)
    assert.equal(f.target.federation.attemptOffers!.read('home', old.id).status, 'reserved')
    assert.equal(f.tg.snapshot().activeLease!.ticketId, accepted.reservation!.ticketId)
    assert.equal(f.target.db.prepare('SELECT token FROM remote_target_fences').get()!.token, old.fence.token)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 1)
  } finally { f.close() }
})

test('the host reservation policy bounds the target TTL and an actual timer releases the permit', async () => {
  const f = pair()
  try {
    const receipt = await f.target.federation.receiveAttemptOffer(f.context, f.create('policy', f.home.time + 60000))
    assert.equal(receipt.reservation!.expiresAt, f.target.time + 5000)
    f.target.federation.attemptOffers!.cancel('home', 'policy')
    const short = f.create('timer', f.home.time + 15)
    await f.target.federation.receiveAttemptOffer(f.context, short)
    f.clock.now += 20
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.tg.snapshot().activeLease, null, 'the timer releases without a receipt read or polling')
    assert.equal(f.target.federation.attemptOffers!.read('home', 'timer').status, 'expired')
    const wallOnly = f.create('wall-only')
    await f.target.federation.receiveAttemptOffer(f.context, wallOnly)
    f.target.time += 5001
    assert.equal(f.target.federation.attemptOffers!.read('home', wallOnly.id).status, 'expired')
    assert.equal(f.tg.snapshot().activeLease, null, 'wall time expires a permit even when the injected monotonic clock has not advanced')
  } finally { f.close() }
})

test('failed additive offer DDL rolls back its marker and can retry without changing existing node migrations', () => {
  const f = pair()
  try {
    const version = f.target.db.prepare('PRAGMA user_version').get()!.user_version
    f.target.db.exec('DROP TABLE remote_target_offers; DROP TABLE remote_home_offers; DROP TABLE remote_target_fences; DROP TABLE remote_attempt_migrations; CREATE TABLE remote_target_offers(collision TEXT)')
    assert.throws(() => new AttemptOffers(f.target.db, f.target.runs, 'target', f.tg, { maxReservationMs: 5000 }, () => f.target.time).read('home', 'missing'), /receipt|run_id|home/)
    assert.equal(f.target.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='remote_attempt_migrations'").get()!.n, 0)
    f.target.db.exec('DROP TABLE remote_target_offers')
    const recovered = new AttemptOffers(f.target.db, f.target.runs, 'target', f.tg, { maxReservationMs: 5000 }, () => f.target.time)
    assert.throws(() => recovered.read('home', 'missing'), /offer_not_found/)
    assert.equal(f.target.db.prepare('SELECT version FROM remote_attempt_migrations').get()!.version, 36)
    assert.equal(f.target.db.prepare('PRAGMA user_version').get()!.user_version, version)
    assert.equal(f.target.db.prepare('SELECT version FROM federation_migrations').get()!.version, 34)
    recovered.close()
  } finally { f.close() }
})

test('offer service construction never bypasses or turns R1 restart grace into a node boot failure', () => {
  const f = pair()
  const replacement = new RunStore({ db: f.target.db, log: f.target.log, scrubber: f.target.scrubber, clock: () => f.target.time })
  try {
    let service!: AttemptOffers
    assert.doesNotThrow(() => { service = new AttemptOffers(f.target.db, replacement, 'target', f.tg, { maxReservationMs: 5000 }, () => f.target.time) })
    assert.throws(() => service.read('home', 'any'), /writer_busy/)
    assert.equal(f.tg.snapshot().activeLease, null)
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM remote_target_offers').get()!.n, 0)
    service.close()
  } finally { replacement.close(); f.close() }
})

test('legacy strict handshake readers receive no new capability field, including an older major with a high minor', async () => {
  const f = pair()
  try {
    for (const version of [{ major: 1, minor: 1 }, { major: 0, minor: 9 }]) {
      const path = '/api/federation/handshake'
      const auth = { nodeId: 'home', audience: 'target', version, issuedAt: f.home.time,
        nonce: `legacy-${version.major}-${version.minor}`, signature: '' }
      auth.signature = signValue(f.home.keys.privateKey, requestProof('GET', path, null, auth))
      const response = await f.target.app.request(path, { headers: { 'X-Guanxi-Node': JSON.stringify(auth) } })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.ok(body !== null && typeof body === 'object')
      assert.equal(Object.hasOwn(body, 'capabilities'), false)
    }
  } finally { f.close() }
})
