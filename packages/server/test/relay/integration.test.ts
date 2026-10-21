import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '@guanxi/kernel'
import { openDb } from '../../src/store/db.ts'
import { resourceGovernorPlugin } from '../../src/runtime/governor-plugin.ts'
import { ollamaAdapterPlugin } from '../../src/ollama/plugin.ts'
import { egressScrubberPlugin } from '../../src/egress/plugin.ts'
import { createSessionLogPlugin } from '../../src/session-log/plugin.ts'
import { createDurableRunsPlugin, type DurableRunsService } from '../../src/runs/plugin.ts'
import { connectionsPlugin } from '../../src/connections/plugin.ts'
import type { Connections } from '../../src/connections/service.ts'
import type { SessionLog } from '../../src/session-log/log.ts'
import { relayPlugin, type RelayService } from '../../src/relay/plugin.ts'
import { piModels } from '../../src/connections/pi.ts'
import { emptyUsage } from '../../src/native-agent/model.ts'
import { fixture, window, reserves, plan, caps } from './fixture.ts'
import { canonical } from '../../src/relay/handoff.ts'

test('kernel relay uses real K3 and scrubber for every model call; secrets/reasoning never enter ledger, seals or plain logs', async () => {
  const root=await mkdtemp(join(tmpdir(),'guanxi-r2-k3-')), db=openDb(join(root,'node.sqlite')), kernel=createKernel()
  const wrappingKey=randomBytes(32)
  const secret='fixture_relay_'+randomBytes(12).toString('hex'), thinking='fixture-hidden-thinking', requests:string[]=[]
  let releaseApi!:()=>void, apiStarted!:()=>void, releaseLocal!:()=>void, localStarted!:()=>void
  const apiResponse=new Promise<void>(r=>{releaseApi=r}), apiDispatch=new Promise<void>(r=>{apiStarted=r})
  const localResponse=new Promise<void>(r=>{releaseLocal=r}), localDispatch=new Promise<void>(r=>{localStarted=r})
  try {
    await kernel.plugin(resourceGovernorPlugin); await kernel.plugin(ollamaAdapterPlugin,{ fetch:async (url,init)=>{
      if(new URL(String(url)).pathname==='/api/version')return Response.json({version:'fixture'})
      if(String(init?.body).length>1000)return Response.json({model:'fixture',created_at:new Date().toISOString(),message:{role:'assistant',content:'fixture'},done:true,prompt_eval_count:20000,eval_count:1})
      localStarted(); await localResponse
      return new Response(JSON.stringify({model:'fixture',created_at:new Date().toISOString(),message:{role:'assistant',content:'fixture'},done:true,prompt_eval_count:10,eval_count:1}),{status:200,headers:{'Content-Type':'application/json'}})
    } })
    await kernel.plugin(egressScrubberPlugin,{expectedSources:['vault']}); await kernel.plugin(createSessionLogPlugin({db}))
    await kernel.plugin(createDurableRunsPlugin({db}))
    const model=piModels('deepseek')[0]!
    let turn=0
    await kernel.plugin(connectionsPlugin,{databasePath:join(root,'connections.sqlite'),localHost:()=> '127.0.0.1:11434',policy:{ownerDevice:true,nodeKeyOptIn:true},keychain:async()=>({key:()=>wrappingKey}),
      pi:{async complete(_m,context){
        const serialized=JSON.stringify(context); requests.push(serialized)
        if(requests.length===1){apiStarted();await apiResponse}
        const usage=emptyUsage(); usage.input=100; usage.output=100
        const narrative=serialized.includes('Write a fresh')
        const text=narrative ? 'Resume '+secret : canonical(++turn===1?{action:'verify',item:'one'}:{action:'handoff'})
        return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'thinking',thinking},{type:'text',text}],usage,stopReason:'stop',timestamp:Date.now()}
      }}})
    const connections=kernel.service<Connections>('connections.registry')!
    const c=connections.create('local',{name:'Fixture',provider:'deepseek',kind:'model_api',auth:'api_key'})
    await connections.unlockVault('local'); connections.saveSecret('local',c.id,secret); connections.setUnattended('local',c.id,true)
    const runs=kernel.service<DurableRunsService>('runs.durable')!.store
    await kernel.plugin(relayPlugin,{db})
    const service=kernel.service<RelayService>('agent.relay')!, run=runs.create(), a=runs.start(run.id)
    service.init(a,{...plan,goal:'Task '+secret},caps)
    const f=fixture()
    try {
      const workspace={...f.workspace,verify:async()=>({item:'one',head:plan.base,ok:true,output:secret})}
      const eta={scope:{model:model.id,host:'fixture-host',repo:'fixture-repo'},estimates:[{item:'one',remainingMs:1000}],history:[],
        policy:{simulations:1,seed:1,minSamples:1,maxAgeMs:1000}}
      await assert.rejects(service.execute(a,{connectionId:c.id,model:model.id,meter:{observe:async()=>window,count:p=>Buffer.byteLength(p)+32},workspace,reserves,
        eta:{...eta,scope:{...eta.scope,model:'wrong-model'}}}),/eta_model/)
      assert.equal(requests.length,0,'mismatched ETA model is refused before dispatch')
      const output:string[]=[]; const old=process.stdout.write
      process.stdout.write=((chunk: unknown)=>{ output.push(String(chunk));return true }) as typeof old
      try {
        const pending=service.execute(a,{connectionId:c.id,model:model.id,meter:{observe:async()=>window,count:p=>Buffer.byteLength(p)+32},workspace,reserves,eta})
        await apiDispatch
        assert.notEqual(runs.attempts(run.id)[0]!.first_model_at,null,'real K3 API start is observed while its response is pending')
        releaseApi();await pending
      }
      finally {process.stdout.write=old}
      assert.equal(runs.get(run.id).state,'completed',JSON.stringify(kernel.service<SessionLog>('session.log')!.readAll(run.session_id,'person').filter(e=>e.type==='error')))
      assert.equal(requests.length,3)
      assert.equal(service.read(run.id).eta!.status,'complete')
      assert.equal(service.read(run.id).eta!.p80RemainingMs,0)
      assert.notEqual(runs.attempts(run.id)[0]!.first_model_at,null)
      const persisted=JSON.stringify(db.prepare('SELECT * FROM relay_runs').all())+JSON.stringify(db.prepare('SELECT handoff,ledger,markdown FROM relay_seals').all())
      const events=JSON.stringify(kernel.service<SessionLog>('session.log')!.readAll(run.session_id,'person'))
      for(const text of [...requests,persisted,events,...output]) {assert.equal(text.includes(secret),false);assert.equal(text.includes(thinking),false)}
      assert.equal(db.prepare('SELECT COUNT(*) n FROM run_costs').get()!.n,3)
      // A value registered after relay request assembly expands at K3's final scrub.
      const {ConnectionRelayModel}=await import('../../src/relay/model.ts')
      const late='late_relay_'+randomBytes(8).toString('hex')
      const H=window.tokens-reserves.turn-reserves.safety
      const prompt=late.repeat(Math.floor((H-window.framingTokens)/Buffer.byteLength(late)))
      kernel.service<import('../../src/egress/types.ts').EgressScrubber>('egress.scrubber')!.register('secret://fixture/late-expansion-with-long-reference',late)
      const guarded=new ConnectionRelayModel(connections,c.id,model.id,{observe:async()=>window,count:p=>Buffer.byteLength(p)+32})
      const before=requests.length
      await assert.rejects(guarded.call(prompt,{runId:run.id,requestId:'late-api',maxOutput:100,maxInput:H,window}))
      assert.equal(requests.length,before,'redaction expansion is refused before API transport')
      const localGuard=connections.create('local',{name:'Guard local',kind:'local_runtime',provider:'ollama',auth:'none'})
      const localModel=new ConnectionRelayModel(connections,localGuard.id,'fixture',{observe:async()=>window,count:p=>Buffer.byteLength(p)+32},false)
      await assert.rejects(localModel.call(prompt,{runId:run.id,requestId:'late-local',maxOutput:100,maxInput:H,window}))

    } finally {f.close()}
    const governor=kernel.service<import('../../src/runtime/resource-governor.ts').ResourceGovernor>('governor')!
    const blocker=governor.enqueue({owner:{kind:'operation',operationId:'relay-fixture-blocker'},operation:'chat',model:{provider:'ollama',name:'fixture'},requestedContext:16000,priority:'normal',enqueuedAt:new Date().toISOString()})
    const lease=await governor.acquire(blocker)
    const local=connections.create('local',{name:'Local fixture',kind:'local_runtime',provider:'ollama',auth:'none'})
    let localStarts=0
    const pendingLocal=connections.localChat('local',local.id,{model:'fixture',stream:false,messages:[{role:'user',content:'fixture'}],options:{num_ctx:16000}},
      {runId:'local-fixture',requestId:'local-fixture',onStarted:()=>{localStarts++}})
    await new Promise<void>(r=>setImmediate(r))
    assert.equal(localStarts,0,'queued local inference is not acknowledged')
    lease.release();await localDispatch
    assert.equal(localStarts,1,'real K3 local start is observed before response resolution')
    releaseLocal();await pendingLocal
    await kernel.dispose()
    assert.equal(kernel.service('agent.relay'),undefined)
    assert.equal(kernel.service('runs.durable'),undefined)
  } finally {releaseApi?.();releaseLocal?.();await kernel.dispose();db.close();await rm(root,{recursive:true,force:true})}
})
test('no hidden cycle limit with observed commits; boundaries retain exact hashes over 25 cycles', async () => {
  let turns=0, checkpoint=0
  const f=fixture({caps:{cycles:null,tokens:null},actions:()=>{
    const n=++turns
    if(n===49)return canonical({action:'verify',item:'one'})
    return canonical({action:n%2?'checkpoint':'handoff'})
  }})
  f.workspace.checkpoint=async()=>{checkpoint++}
  f.workspace.verify=async(_p,item)=>({item,head:checkpoint.toString(16).padStart(40,'0'),ok:true,output:'pass'})
  f.workspace.observe=async()=>({head:checkpoint.toString(16).padStart(40,'0'),files:['src/task'],diffstat:'1 file',nonemptyCommit:true})
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.store.get(f.run.id).state,'completed')
    assert.equal(f.relay.read(f.run.id).cycle,25)
    const seals=f.db.prepare('SELECT ledger,handoff FROM relay_seals ORDER BY cycle').all()
    assert.equal(seals.length,25)
    const {hash}=await import('../../src/relay/handoff.ts')
    for(const s of seals)assert.equal(JSON.parse(String(s.handoff)).ledgerHash,hash(JSON.parse(String(s.ledger))))
    const writerPrompts=f.prompts.filter(p=>p.startsWith('Write a fresh'))
    assert.equal(writerPrompts.length,25)
    assert.ok(writerPrompts.every(p=>!p.includes('Continue the plan using its evidence.')))
  } finally {f.close()}
})
