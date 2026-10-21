import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootServerKernel } from '../../src/runtime/kernel.ts'
import { openDb } from '../../src/store/db.ts'
import { FEDERATION_SERVICE } from '../../src/federation/plugin.ts'
import { FederationChannel } from '../../src/federation/channel.ts'
import { identity, SimNode } from './harness.ts'

test('configured kernel owns federation lifetime; default boots no federation service or tables', async () => {
  for(const enabled of [false,true]) {
    const db=openDb(':memory:'); const keys=identity('local')
    const kernel=await bootServerKernel(undefined,{db,...(enabled?{federation:keys}:{})})
    try {
      assert.equal(kernel.federation!==null,enabled)
      assert.equal(kernel.node.service(FEDERATION_SERVICE)!==undefined,enabled)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='federation_migrations'").get()!.n,enabled?1:0)
      assert.equal(kernel.node.counters().fibers,enabled?6:5)
    } finally {await kernel.node.dispose();db.close()}
    if(enabled) assert.throws(()=>kernel.federation!.config.operations(),/closed/)
  }
})

test('real signed channel pulls config/session/run projections and drains a durable command outbox', async () => {
  const home=new SimNode(identity('home'));const peer=new SimNode(identity('peer'))
  try {
    home.trust(peer);peer.trust(home)
    const run=home.runs.create({id:'run',sessionId:'session'})
    for(const [kind,streamId] of [['session','session'],['run','run']] as const) {
      const binding={streamId,kind,sessionId:'session',homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'}
      home.federation.replicas.bind(binding);peer.federation.replicas.bind(binding)
    }
    home.federation.config.create('project',{kind:'project',name:'Project',archived:false})
    const channel=new FederationChannel({local:peer.keys.identity,privateKey:peer.keys.privateKey,peer:home.keys.identity,
      transport:async(req)=>home.app.request(req),clock:()=>peer.time})
    assert.deepEqual(await channel.synchronize(peer.federation,['session','run']),{readOnly:false})
    assert.equal(peer.federation.config.stateHash(),home.federation.config.stateHash())
    assert.equal(peer.federation.replicas.read('run').length,1)
    assert.equal(peer.federation.replicas.read('session').length,3)
    peer.federation.enqueue({id:'stop',runId:run.id,sessionId:'session',homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+5000,action:{kind:'stop'}})
    await peer.federation.flush((command)=>channel.command(command))
    assert.equal(home.runs.get(run.id).cancel_count,1)
    await channel.synchronize(peer.federation,['session','run'])
    assert.equal(peer.federation.replicas.read('run').length,2)
    assert.equal(peer.runs.attempts(run.id).length,0)
  } finally {home.close();peer.close()}
})

test('outbound older-major negotiation imports zero data and sends zero mutation requests', async () => {
  const home=new SimNode(identity('home'));const peer=new SimNode(identity('peer'))
  try {
    home.trust(peer);peer.trust(home)
    const requests:string[]=[]
    const channel=new FederationChannel({local:peer.keys.identity,privateKey:peer.keys.privateKey,peer:home.keys.identity,clock:()=>peer.time,
      transport:async(request)=>{
        requests.push(`${request.method} ${new URL(request.url).pathname}`)
        if(new URL(request.url).pathname.endsWith('/handshake')) return Response.json({version:{major:0,minor:9},negotiated:{major:0,minor:0},readOnly:false})
        throw new Error('older peer must not be queried for operations, replicas or mutation')
      }})
    assert.deepEqual(await channel.synchronize(peer.federation,['session','run']),{readOnly:true})
    await assert.rejects(()=>channel.command({id:'stop',runId:'run',sessionId:'session',homeNodeId:'home',stateVersion:1,expiresAt:peer.time+5000,action:{kind:'stop'}}),/contract_read_only/)
    assert.deepEqual(requests,['GET /api/federation/handshake','GET /api/federation/handshake'])
    assert.equal(peer.federation.config.operations().length,0)
    assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM federation_replicas').get()!.n,0)
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_command_receipts').get()!.n,0)
  } finally {home.close();peer.close()}
})
