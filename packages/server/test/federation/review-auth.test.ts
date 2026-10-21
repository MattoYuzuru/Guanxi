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
