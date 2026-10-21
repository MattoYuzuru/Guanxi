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
  try {
    await kernel.plugin(resourceGovernorPlugin); await kernel.plugin(ollamaAdapterPlugin,{ fetch:async()=>{throw new Error('network forbidden')} })
    await kernel.plugin(egressScrubberPlugin,{expectedSources:['vault']}); await kernel.plugin(createSessionLogPlugin({db}))
    await kernel.plugin(createDurableRunsPlugin({db}))
    const model=piModels('deepseek')[0]!
    let turn=0
    await kernel.plugin(connectionsPlugin,{databasePath:join(root,'connections.sqlite'),localHost:()=> '127.0.0.1:11434',policy:{ownerDevice:true,nodeKeyOptIn:true},keychain:async()=>({key:()=>wrappingKey}),
      pi:{async complete(_m,context){
        const serialized=JSON.stringify(context); requests.push(serialized)
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
      const workspace={...f.workspace,verify:async()=>({item:'one',ok:true,output:secret})}
      const output:string[]=[]; const old=process.stdout.write
      process.stdout.write=((chunk: unknown)=>{ output.push(String(chunk));return true }) as typeof old
      try { await service.execute(a,{connectionId:c.id,model:model.id,meter:{observe:async()=>window,count:p=>Buffer.byteLength(p)+32},workspace,reserves}) }
      finally {process.stdout.write=old}
      assert.equal(runs.get(run.id).state,'completed',JSON.stringify(kernel.service<SessionLog>('session.log')!.readAll(run.session_id,'person').filter(e=>e.type==='error')))
      assert.equal(requests.length,3)
      const persisted=JSON.stringify(db.prepare('SELECT * FROM relay_runs').all())+JSON.stringify(db.prepare('SELECT handoff,ledger,markdown FROM relay_seals').all())
      const events=JSON.stringify(kernel.service<SessionLog>('session.log')!.readAll(run.session_id,'person'))
      for(const text of [...requests,persisted,events,...output]) {assert.equal(text.includes(secret),false);assert.equal(text.includes(thinking),false)}
      assert.equal(db.prepare('SELECT COUNT(*) n FROM run_costs').get()!.n,3)
    } finally {f.close()}
    await kernel.dispose()
    assert.equal(kernel.service('agent.relay'),undefined)
    assert.equal(kernel.service('runs.durable'),undefined)
  } finally {await kernel.dispose();db.close();await rm(root,{recursive:true,force:true})}
})
test('no hidden cycle limit with observed commits; boundaries retain exact hashes over 25 cycles', async () => {
  let turns=0, checkpoint=0
  const f=fixture({caps:{cycles:null,tokens:null},actions:()=>{
    const n=++turns
    if(n===49)return canonical({action:'verify',item:'one'})
    return canonical({action:n%2?'checkpoint':'handoff'})
  }})
  f.workspace.checkpoint=async()=>{checkpoint++}
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
