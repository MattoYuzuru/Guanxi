// Review 1 P2/P2b: a recipient must never be able to replay a proof to another node.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { FederationChannel } from '../../src/federation/channel.ts'
import { requestProof, signValue } from '../../src/federation/crypto.ts'
import { SimNode, identity } from './harness.ts'

for (const scenario of ['P2 replicas', 'P2b cross-account config']) test(`${scenario}: signed request replayed to a second node gets 401`, async () => {
  const home = new SimNode(identity('home')); const owner = new SimNode(identity('owner-node', {admin:false}))
  const relay = new SimNode(identity('relay', scenario.startsWith('P2b') ? {accountId:'family'} : {trust:'cloud_ephemeral',admin:false}))
  try {
    for (const n of [home,owner,relay]) for (const peer of [home,owner,relay]) n.trust(peer)
    const writer = home.log.open('session', {kind:'agent'})
    writer.append({type:'prompt',data:{origin:'typed',messageId:'m',text:'private prompt',attachmentCount:0}}); writer.close()
    home.federation.replicas.bind({kind:'session',streamId:'session',sessionId:'session',homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    home.federation.config.create('connection', {kind:'connection',ownerAccountId:'owner',label:'Owner subscription',auth:'subscription',enabled:true})
    const route = scenario.startsWith('P2b') ? '/api/federation/config' : '/api/federation/replicas/session'
    const auth = {nodeId:owner.keys.identity.id,audience:'relay',version:{major:1,minor:0},issuedAt:owner.time,nonce:randomUUID(),signature:''}
    auth.signature = signValue(owner.keys.privateKey, requestProof('GET',route,null,auth))
    const replay = () => home.app.request(`http://node${route}`, {headers:{'X-Guanxi-Node':JSON.stringify(auth)}})
    assert.equal((await replay()).status, 401, 'recipient replay is unauthenticated')
    auth.audience = 'home' // An intermediary also cannot edit the signed audience.
    assert.equal((await replay()).status, 401, 'audience is covered by the signature')
    const legitimate = await owner.request(home, 'GET', route.replace('/api/federation',''))
    assert.equal(legitimate.status, 200)
    const payload = await legitimate.json() as {operations?: unknown[];entries?: unknown[]}
    assert.ok((payload.operations ?? payload.entries)!.length > 0)
  } finally { home.close(); owner.close(); relay.close() }
})

test('channel only requests streams pinned to its peer home', async () => {
  const owner = new SimNode(identity('owner')); const home = new SimNode(identity('home')); const cloud = new SimNode(identity('cloud',{trust:'cloud_ephemeral',admin:false}))
  try {
    for (const n of [owner,home,cloud]) for (const peer of [owner,home,cloud]) n.trust(peer)
    owner.federation.replicas.bind({kind:'session',streamId:'session',sessionId:'session',homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const paths: string[] = []
    const channel = new FederationChannel({local:owner.keys.identity,privateKey:owner.keys.privateKey,peer:cloud.keys.identity,clock:()=>owner.time,
      transport:async (request) => { paths.push(new URL(request.url).pathname); return cloud.app.request(request) }})
    await assert.doesNotReject(() => channel.synchronize(owner.federation, ['session']))
    assert.deepEqual(paths, ['/api/federation/handshake','/api/federation/config'], 'no stream proof is sent to a non-home peer')
  } finally { owner.close(); home.close(); cloud.close() }
})

test('P3 non-admin home revokes a peer locally and stops serving replicas', async () => {
  const home = new SimNode(identity('home', {admin:false})); const laptop = new SimNode(identity('laptop', {admin:false}))
  try {
    home.trust(laptop); laptop.trust(home)
    const writer = home.log.open('session', {kind:'agent'}); writer.close()
    home.federation.replicas.bind({kind:'session',streamId:'session',sessionId:'session',homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const before = await laptop.request(home, 'GET', '/replicas/session')
    assert.equal(before.status, 200)
    assert.ok((await before.json() as {entries:unknown[]}).entries.length > 0)
    assert.doesNotThrow(() => home.federation.revokePeer('laptop'), 'host-local removal needs no admin')
    assert.equal((await laptop.request(home, 'GET', '/replicas/session')).status, 401)
  } finally { home.close(); laptop.close() }
})

test('P7 command account binding refuses another account before prompt effects (D-190)', async () => {
  const home = new SimNode(identity('home')); const other = new SimNode(identity('family-node', {accountId:'family'}))
  try {
    home.trust(other); other.trust(home)
    const run = home.runs.create({id:'run',sessionId:'session'})
    home.federation.replicas.bind({kind:'run',streamId:'run',sessionId:'session',homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const response = await other.request(home, 'POST', '/commands', {id:'p',runId:'run',sessionId:'session',homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+5000,action:{kind:'prompt',text:'cross-account prompt'}})
    assert.equal(response.status, 403, 'commands are bound to the credential account')
    assert.deepEqual(await response.json(), {code:'owner_mismatch'})
    assert.equal(home.runs.get(run.id).version, run.version)
    assert.deepEqual(home.federation.pendingPrompts(run.id), [])
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_command_receipts').get()!.n, 0)
  } finally { home.close(); other.close() }
})

test('revocation invalidates a previously authenticated held context', () => {
  const home = new SimNode(identity('home')); const peer = new SimNode(identity('peer'))
  try {
    home.trust(peer)
    const path = '/api/federation/config'
    const auth = {nodeId:'peer',audience:'home',version:{major:1,minor:0},issuedAt:peer.time,nonce:randomUUID(),signature:''}
    auth.signature = signValue(peer.keys.privateKey, requestProof('GET',path,null,auth))
    const held = home.federation.authenticate('GET',path,null,auth)
    assert.equal(home.federation.authorize(held,'config').id, 'peer')
    home.federation.revokePeer('peer')
    assert.throws(() => home.federation.authorize(held,'config'), /unauthenticated/, 'held contexts recheck current trust')
  } finally { home.close(); peer.close() }
})
