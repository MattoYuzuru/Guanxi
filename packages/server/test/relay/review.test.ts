import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, plan, window } from './fixture.ts'
import { canonical } from '../../src/relay/handoff.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'
import type { Connections } from '../../src/connections/service.ts'

test('done evidence is invalidated by a later HEAD; failing final acceptance cannot complete', async () => {
  const f=fixture()
  try {
    f.relay.begin(f.attempt); f.relay.observe(f.attempt,{head:plan.base,files:[],diffstat:'',evidence:{item:'one',ok:true,output:'pass'}})
    assert.equal(f.relay.read(f.run.id).items.one,'done')
    f.relay.observe(f.attempt,{head:'b'.repeat(40),files:['src/changed'],diffstat:''})
    assert.equal(f.relay.read(f.run.id).items.one,'open')
  } finally {f.close()}
  const g=fixture();let gates=0
  try {
    g.workspace.verify=async(_p,item)=>({item,head:plan.base,ok:++gates===1,output:'gate'})
    await g.executor.run(g.attempt)
    assert.ok(gates>=2)
    assert.notEqual(g.store.get(g.run.id).state,'completed')
    assert.notEqual(g.relay.read(g.run.id).items.one,'done')
  } finally {g.close()}
})
test('selected notes are present in the next work context; notes.search pages reconstruct every Unicode character', async () => {
  let work=0, calls=0
  const f=fixture({actions:()=>canonical(++work===1?{action:'handoff'}:work===2?{action:'verify',item:'one'}:{action:'handoff'})})
  try {
    const marker='dead-end-do-not-repeat'
    f.relay.note(f.attempt,'dead_end',marker,['one'],null)
    await f.executor.run(f.attempt)
    assert.ok(f.prompts.filter(p=>p.startsWith('Execute'))[1]!.includes(marker))
  } finally {f.close()}
  const g=fixture()
  try {
    const text='Я🙂'.repeat(4000);g.relay.note(g.attempt,'lesson',text,['one'],null)
    let reconstructed='',offset=0
    // Invoke exactly the tool that the model sees, with its returned continuation.
    const access=g.executor as unknown as {tool: (a: typeof g.attempt,n:string,args:Record<string,unknown>,s:AbortSignal)=>Promise<string>}
    while(true){const page=JSON.parse(await access.tool(g.attempt,'notes.search',{query:'',offset},new AbortController().signal));reconstructed+=page.text;if(!page.more)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset}
    assert.equal(reconstructed,canonical(g.relay.notes(g.run.id)))
  } finally {g.close()}
})
test('real local adapter detects prompt_eval_count mismatch and passes dispatch observation through K3', async () => {
  let started=0
  const connections={snapshot:()=>({connections:[{id:'fixture',kind:'local_runtime'}]}),localChat:async(_a:unknown,_b:unknown,_r:unknown,call:{onStarted?:()=>void})=>{
    call.onStarted?.();return {message:{content:'{}'},prompt_eval_count:4,eval_count:1,done_reason:'stop'}
  }} as unknown as Connections
  const model=new ConnectionRelayModel(connections,'fixture','model',{observe:async()=>window,count:()=>100})
  const result=await model.call('prompt',{runId:'fixture',requestId:'call',maxOutput:10,window,onStarted:()=>{started++}})
  assert.equal(started,1);assert.equal(result.truncated,true)
})
test('cleanup uncertainty stops the loop before a following checkpoint', async () => {
  let actions=0,checkpoints=0
  const f=fixture({actions:()=>canonical(++actions===1?{action:'tool',name:'shell',args:{command:'cmd'}}:{action:'checkpoint'})})
  try {
    const {RelayError}=await import('../../src/relay/types.ts')
    f.workspace.tool=async()=>{throw new RelayError('cleanup_unconfirmed')}
    f.workspace.checkpoint=async()=>{checkpoints++}
    await f.executor.run(f.attempt)
    assert.equal(actions,1);assert.equal(checkpoints,0);assert.equal(f.store.get(f.run.id).state,'input_required')
  } finally {f.close()}
})
