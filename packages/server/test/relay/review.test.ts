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
  const result=await model.call('prompt',{runId:'fixture',requestId:'call',maxOutput:10,maxInput:14000,window,onStarted:()=>{started++}})
  assert.equal(started,1);assert.equal(result.truncated,true)
  const preparedText='prepared text after registered redaction'
  const preparedConnections={snapshot:()=>({connections:[{id:'fixture',kind:'local_runtime'}]}),
    localChat:async(_a:unknown,_b:unknown,_r:unknown,call:{onPrepared?:(request:unknown)=>void})=>{
      call.onPrepared?.({messages:[{role:'user',content:preparedText}]})
      return {message:{content:'{}'},prompt_eval_count:Buffer.byteLength(preparedText)+32,eval_count:1,done_reason:'stop'}
    }} as unknown as Connections
  const preparedModel=new ConnectionRelayModel(preparedConnections,'fixture','model',{observe:async()=>window,count:p=>Buffer.byteLength(p)+32})
  const prepared=await preparedModel.call('original',{runId:'fixture',requestId:'prepared',maxOutput:10,maxInput:14000,window})
  assert.equal(prepared.truncated,false,'within-H redaction rewrite uses the exact prepared prompt count')
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
test('a refused local start observer consumes the aborted response rejection', async () => {
  const {OllamaClient}=await import('../../src/ollama/client.ts')
  const controller=new AbortController(), unhandled:unknown[]=[]
  const onUnhandled=(error:unknown)=>{unhandled.push(error)}
  process.on('unhandledRejection',onUnhandled)
  try {
    const client=new OllamaClient({host:'http://127.0.0.1:11434',fetch:async(url,init)=>{
      if(new URL(String(url)).pathname==='/api/version')return Response.json({version:'fixture'})
      return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))
    }})
    await assert.rejects(client.chat({model:'fixture',messages:[{role:'user',content:'fixture'}]},controller.signal,()=>{controller.abort();throw new Error('fixture_stale_lease')}),/fixture_stale_lease/)
    await new Promise<void>(r=>setImmediate(r));await new Promise<void>(r=>setImmediate(r))
    assert.equal(unhandled.length,0)
  } finally {controller.abort();process.removeListener('unhandledRejection',onUnhandled)}
})
test('an unreadable handoff body is a degraded critical probe failure with retained ledger progress', async () => {
  let work=0, damaged=false
  const f=fixture({actions:()=>canonical(++work===1?{action:'handoff'}:work===2?{action:'verify',item:'one'}:{action:'handoff'})})
  try {
    const read=f.relay.sealed.bind(f.relay)
    f.relay.sealed=a=>{
      if(!damaged&&f.db.prepare('SELECT cycle FROM relay_seals WHERE run_id=?').get(a.run_id)){
        // Simulate damaged persisted artifact bytes, bypassing fixture-only immutability.
        f.db.exec('DROP TRIGGER relay_seals_immutable')
        f.db.prepare('UPDATE relay_seals SET handoff=? WHERE run_id=?').run('{truncated',a.run_id)
        damaged=true
      }
      return read(a)
    }
    await f.executor.run(f.attempt)
    assert.equal(f.store.get(f.run.id).state,'completed')
    assert.ok(f.log.readAll(f.run.session_id,'person').some(e=>e.type==='agent.note'&&e.data.text.includes('"damaged":true')))
  } finally {f.close()}
})
