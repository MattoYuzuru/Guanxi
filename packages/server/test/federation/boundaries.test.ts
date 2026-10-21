import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { nodeIdentitySchema, replicaEntrySchema, type StreamBinding } from '@guanxi/contract/federation'
import { hash, requestProof, signValue } from '../../src/federation/crypto.ts'
import { SimNode, identity } from './harness.ts'

function group() {
  const owner = new SimNode(identity('home'))
  const peer = new SimNode(identity('peer'))
  owner.trust(peer); peer.trust(owner)
  return { owner, peer, close: () => { owner.close(); peer.close() } }
}
function bindRun(owner: SimNode, peer: SimNode) {
  const run = owner.runs.create({ id: 'run', sessionId: 'session' })
  const binding: StreamBinding = { kind: 'run', streamId: run.id, sessionId: run.session_id, homeNodeId: owner.keys.identity.id, homeEpoch: 1, ownerAccountId: 'owner' }
  owner.federation.replicas.bind(binding); peer.federation.replicas.bind(binding)
  return run
}

test('delayed stop is dropped after a new state version; exact stop retry cancels once', async () => {
  const { owner, peer, close } = group()
  try {
    const run = bindRun(owner, peer)
    const stop = { id: 'stop', runId: run.id, sessionId: run.session_id, homeNodeId: 'home', stateVersion: run.version, expiresAt: owner.time + 100_000, action: { kind: 'stop' as const } }
    peer.federation.enqueue(stop)
    await peer.federation.flush(async () => { throw new Error('partition') })
    const attempt = owner.runs.start(run.id)
    const newer = owner.runs.get(run.id)
    assert.ok(newer.version > stop.stateVersion)
    await peer.federation.flush(async (command) => {
      const response = await peer.request(owner, 'POST', '/commands', command)
      assert.equal(response.status, 200)
      return (await response.json() as { result: string }).result
    })
    assert.deepEqual(owner.runs.get(run.id), newer)
    assert.equal(owner.runs.attempts(run.id)[0]!.state, attempt.state)
    assert.equal(owner.runs.get(run.id).cancel_count, 0)
    const current = { ...stop, id: 'stop-current', stateVersion: newer.version }
    for (let i=0;i<2;i++) {
      const res = await peer.request(owner, 'POST', '/commands', current)
      assert.deepEqual(await res.json(), { result: 'applied' })
    }
    assert.equal(owner.runs.get(run.id).cancel_count, 1)
    assert.equal(owner.log.readAll(run.session_id, 'remote_agent').filter((e) => e.type === 'run.lifecycle' && e.data.action === 'canceled').length, 1)
    assert.equal(owner.db.prepare('SELECT result FROM federation_outbox').get(), undefined)
    assert.equal(peer.db.prepare('SELECT result FROM federation_outbox').get()!.result, 'stale_version')
  } finally { close() }
})

test('trust scope: cloud, shared and other-owner receive zero vault, session and reasoning records', async () => {
  const owner = new SimNode(identity('home'))
  const peers = [identity('own'), identity('cloud', { trust: 'cloud_ephemeral', admin: false }), identity('shared', { trust: 'shared_device', admin: false }), identity('other', { accountId: 'someone-else' })].map((k) => new SimNode(k))
  try {
    const h = owner.log.open('session', { kind: 'agent' })
    h.append({ type: 'prompt', data: { origin: 'typed', messageId: 'message', text: 'hello', attachmentCount: 0 } })
    h.append({ type: 'reasoning', data: { messageId: 'message', step: 1, text: 'private chain' } })
    h.append({ type: 'assistant.message', data: { messageId: 'answer', step: 1, text: 'answer' } }); h.close()
    const binding: StreamBinding = { kind: 'session', streamId: 'session', sessionId: 'session', homeNodeId: 'home', homeEpoch: 1, ownerAccountId: 'owner' }
    owner.federation.replicas.bind(binding)
    for (const peer of peers) {
      owner.trust(peer); peer.trust(owner)
      const response = await peer.request(owner, 'GET', '/replicas/session')
      assert.equal(response.status, 200)
      const payload = await response.json() as { entries: unknown[] }
      // Also fail if a transport adds vault records alongside the replica list.
      assert.deepEqual(Object.keys(payload), ['entries'])
      const { entries } = payload
      assert.equal(JSON.stringify(entries).includes('private chain'), false)
      assert.equal(entries.filter((e) => (e as { event: { class: string } }).event.class === 'reasoning').length, 0)
      assert.equal(entries.filter((e) => 'vault' in (e as object)).length, 0)
      if (peer.keys.identity.id !== 'own') {
        assert.equal(entries.length, 0)
        assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM federation_replicas').get()!.n, 0)
        assert.throws(() => peer.federation.replicas.bind(binding), /replica_forbidden/)
        const malicious = owner.federation.replicas.export(peers[0]!.keys.identity, 'session')
        const res = await owner.request(peer, 'POST', '/replicas', malicious)
        assert.notEqual(res.status, 200)
        assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM federation_replicas').get()!.n, 0)
      } else {
        peer.federation.replicas.bind(binding)
        const res = await owner.request(peer, 'POST', '/replicas', entries)
        assert.equal(res.status, 200)
        assert.equal(peer.federation.replicas.read('session').length, 4)
        assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0)
      }
    }
    assert.equal(replicaEntrySchema.safeParse({ vault: 'record' }).success, false)
  } finally { owner.close(); peers.forEach((p) => p.close()) }
})

test('requests refuse unknown, forged, replayed, expired, modified bodies and incompatible majors', async () => {
  const { owner, peer, close } = group()
  const stranger = new SimNode(identity('stranger'))
  try {
    assert.equal((await owner.app.request('http://node/api/federation/handshake')).status, 401)
    assert.equal((await stranger.request(owner, 'GET', '/handshake')).status, 401)
    const path = '/api/federation/handshake'
    const auth = { nodeId: 'peer', audience: 'home', version: { major: 1, minor: 0 }, issuedAt: peer.time, nonce: randomUUID(), signature: '' }
    auth.signature = signValue(peer.keys.privateKey, requestProof('GET', path, null, auth))
    const headers = { 'X-Guanxi-Node': JSON.stringify(auth) }
    assert.equal((await owner.app.request('http://node'+path, { headers })).status, 200)
    assert.equal((await owner.app.request('http://node'+path, { headers })).status, 401)
    auth.nonce = randomUUID(); auth.signature = signValue(stranger.keys.privateKey, requestProof('GET',path,null,auth))
    assert.equal((await owner.app.request('http://node'+path, { headers: { 'X-Guanxi-Node': JSON.stringify(auth) } })).status, 401)
    assert.equal((await peer.request(owner, 'GET', '/handshake', null, 2)).status, 426)
    peer.time -= 61_000
    assert.equal((await peer.request(owner, 'GET', '/handshake')).status, 401)
    peer.time += 61_000
    const postAuth = { ...auth, nonce: randomUUID() }
    postAuth.signature = signValue(peer.keys.privateKey, requestProof('POST', '/api/federation/config', [], postAuth))
    assert.equal((await owner.app.request('http://node/api/federation/config', { method: 'POST', headers: { 'X-Guanxi-Node': JSON.stringify(postAuth) }, body: '[{}]' })).status, 401)
    owner.federation.revokePeer('peer')
    assert.equal((await peer.request(owner, 'GET', '/handshake')).status, 401)
  } finally { close(); stranger.close() }
})

test('older major can read but cannot mutate any node-channel surface', async () => {
  const { owner, peer, close } = group()
  try {
    const hs = await peer.request(owner, 'GET', '/handshake', null, 0)
    assert.equal((await hs.json() as { readOnly: boolean }).readOnly, true)
    assert.equal((await peer.request(owner, 'GET', '/config', null, 0)).status, 200)
    for (const path of ['/config','/replicas','/commands','/telemetry']) {
      const result = await peer.request(owner, 'POST', path, [], 0)
      assert.equal(result.status, 403, path)
      assert.deepEqual(await result.json(), { code: 'contract_read_only' })
    }
    assert.equal(owner.federation.config.operations().length, 0)
    assert.equal(owner.federation.telemetry().length, 0)
  } finally { close() }
})

test('admin-only identities/grants and signed origins prevent spoofing; clock drift is bounded', () => {
  const admin = new SimNode(identity('admin')); const shared = new SimNode(identity('shared', { trust: 'shared_device', admin: false }))
  try {
    admin.trust(shared); shared.trust(admin)
    for (const kind of ['grant','membership'] as const) assert.throws(() => shared.federation.config.create('permission',{ kind,present:true }), /admin_required/)
    assert.throws(() => shared.federation.config.create('user',{ kind:'identity',displayName:'user',disabled:false }), /admin_required/)
    const op = shared.federation.config.create('theme', { kind: 'setting', value: 'dark' })
    admin.federation.config.ingest([op])
    const forged = { operation: { ...op.operation, origin: 'admin', value: { kind: 'grant' as const, present: true } }, signature: op.signature }
    assert.equal(admin.federation.config.ingest([forged]).reasons.unauthenticated, 1)
    shared.time += 60_001
    const future = shared.federation.config.create('future', { kind:'setting',value:true })
    assert.equal(admin.federation.config.ingest([future]).reasons.clock_drift, 1)
    assert.equal(admin.federation.config.operations().length,1)
    assert.equal(nodeIdentitySchema.safeParse({ ...shared.keys.identity, admin:true }).success,false)
    assert.throws(() => admin.federation.config.create('connection',{ kind:'connection',ownerAccountId:'other',auth:'subscription',enabled:true,label:'subscription' }), /owner_mismatch/)
    assert.equal(hash(admin.federation.config.state()),admin.federation.config.stateHash())
  } finally { admin.close(); shared.close() }
})
