import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDb, MIGRATIONS } from '../../src/store/db.ts'
import { migrateFederation } from '../../src/federation/schema.ts'
import { hash, requestProof, signValue } from '../../src/federation/crypto.ts'
import { replicaBody } from '../../src/federation/replicas.ts'
import { SimNode, identity } from './harness.ts'
import type { StreamBinding } from '@guanxi/contract/federation'

function setup() {
  const home = new SimNode(identity('home')); const peer = new SimNode(identity('peer'))
  home.trust(peer); peer.trust(home)
  return { home, peer, close: () => { home.close(); peer.close() } }
}

test('device authorization requires local approval; codes expire, poll slowly and cannot be reused', async () => {
  const { home, peer, close } = setup()
  try {
    const keys = identity('new')
    const req = await home.app.request('http://node/api/federation/device/code', { method: 'POST', body: JSON.stringify({ publicKey: keys.identity.publicKey }) })
    assert.equal(req.status,200)
    const code = await req.json() as { device_code: string; user_code: string }
    assert.throws(() => home.federation.enrollment.poll(code.device_code), /slow_down/)
    home.time += 10_000
    assert.throws(() => home.federation.enrollment.poll(code.device_code), /authorization_pending/)
    const { id, publicKey, ...options } = keys.identity
    const enrolled = home.federation.enrollment.approve(code.user_code, options)
    assert.notEqual(enrolled.id, id)
    assert.equal(enrolled.publicKey,publicKey)
    assert.throws(() => home.federation.enrollment.approve(code.user_code, options), /expired_token/)
    home.time += 10_000
    assert.deepEqual(home.federation.enrollment.poll(code.device_code), enrolled)
    assert.throws(() => home.federation.enrollment.poll(code.device_code), /expired_token/)
    const rows = JSON.stringify(home.db.prepare('SELECT * FROM federation_devices').all())
    assert.equal(rows.includes(code.device_code), false); assert.equal(rows.includes(code.user_code), false)
    const denied = home.federation.enrollment.begin(publicKey)
    home.federation.enrollment.deny(denied.user_code)
    assert.throws(() => home.federation.enrollment.poll(denied.device_code), /access_denied/)
    const expired = home.federation.enrollment.begin(publicKey); home.time += 600_000
    assert.throws(() => home.federation.enrollment.poll(expired.device_code), /expired_token/)
    const notAdmin = new SimNode(identity('cloud', { trust:'cloud_ephemeral',admin:false }))
    try { assert.throws(() => notAdmin.federation.enrollment.approve('unknown', options), /admin_required/) } finally { notAdmin.close() }
    peer.time=home.time
    assert.equal((await peer.request(home, 'POST', '/device/approve', {})).status,404)
  } finally { close() }
})

test('replica chain rejects gaps, altered data, wrong writers/epochs; retries duplicate zero rows', () => {
  const { home, peer, close } = setup()
  try {
    const run = home.runs.create({ id:'run',sessionId:'session' })
    const attempt = home.runs.start(run.id); home.runs.modelStarted(attempt)
    const binding: StreamBinding = { streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner' }
    home.federation.replicas.bind(binding); peer.federation.replicas.bind(binding)
    const entries = home.federation.replicas.export(peer.keys.identity,run.id)
    assert.equal(entries.length,3)
    assert.throws(() => peer.federation.replicas.ingest(home.keys.identity,[entries[1]!]), /replica_gap/)
    assert.equal(peer.federation.replicas.read(run.id).length,0)
    peer.federation.replicas.ingest(home.keys.identity,entries)
    peer.federation.replicas.ingest(home.keys.identity,entries)
    assert.deepEqual(peer.federation.replicas.read(run.id),entries.map((e)=>e.event))
    assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM federation_replicas').get()!.n,3)
    assert.throws(() => peer.federation.replicas.bind({ ...binding,homeEpoch:2 }), /home_conflict/)
    const altered = { ...entries[0]!,event:{ ...entries[0]!.event,redactions:999 } }
    assert.throws(() => peer.federation.replicas.ingest(home.keys.identity,[altered]), /invalid_replica/)
    const forged = { ...altered,hash:hash(replicaBody(altered)) }; forged.signature=signValue(peer.keys.privateKey,{hash:forged.hash})
    assert.throws(() => peer.federation.replicas.ingest(home.keys.identity,[forged]), /invalid_replica/)
    assert.throws(() => home.federation.replicas.ingest(peer.keys.identity,entries), /home_is_writer/)
    assert.throws(() => peer.log.open(run.session_id,{kind:'agent'}), /replica_is_read_only/)
    assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n,0)
    assert.equal(peer.db.prepare('SELECT COUNT(*) AS n FROM durable_runs').get()!.n,0)
  } finally { close() }
})

test('telemetry retains source/time/confidence and refuses forgery, future or older observations', () => {
  const { home, peer, close } = setup()
  try {
    const sample = { nodeId:'peer',source:'simulated:pressure',observedAt:peer.time,confidence:'reported' as const,memoryPressure:'warning' as const,cpuUtilization:0.8,ownerPresent:true }
    home.federation.receiveTelemetry(peer.context(),sample)
    home.time += 500
    home.federation.receiveTelemetry(peer.context(),{...sample,observedAt:sample.observedAt-1,memoryPressure:'normal'})
    assert.deepEqual(home.federation.telemetry(),[{...sample,ageMs:500}])
    assert.throws(()=>home.federation.receiveTelemetry(peer.context(),{...sample,nodeId:'home'}),/invalid_telemetry/)
    assert.throws(()=>home.federation.receiveTelemetry(peer.context(),{...sample,observedAt:home.time+60_001}),/invalid_telemetry/)
    assert.equal(home.federation.telemetry().length,1)
  } finally { close() }
})

test('commands are atomic/idempotent, expire at the home, and prompts remain durable input', async () => {
  const { home, peer, close } = setup()
  try {
    const run = home.runs.create({id:'run',sessionId:'session'})
    const binding: StreamBinding = {streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'}
    home.federation.replicas.bind(binding);peer.federation.replicas.bind(binding)
    const command = {id:'prompt',runId:run.id,sessionId:run.session_id,homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+500,action:{kind:'prompt' as const,text:'additional input'}}
    for(let i=0;i<2;i++) assert.equal(home.federation.receiveCommand(peer.context(),command),'applied')
    assert.equal(home.runs.get(run.id).version,run.version+1)
    assert.equal(home.runs.attempts(run.id).length,0)
    assert.deepEqual(home.federation.pendingPrompts(run.id),[command])
    home.federation.acknowledgePrompt('peer',command.id)
    assert.equal(home.federation.pendingPrompts(run.id).length,0)
    assert.throws(()=>home.federation.receiveCommand(peer.context(),{...command,action:{kind:'stop'}}),/command_conflict/)
    const expired={...command,id:'expired',stateVersion:home.runs.get(run.id).version,expiresAt:home.time,action:{kind:'stop' as const}}
    assert.equal(home.federation.receiveCommand(peer.context(),expired),'expired')
    assert.equal(home.runs.get(run.id).cancel_count,0)
    peer.federation.enqueue(expired)
    let sends=0;await peer.federation.flush(async()=>{sends++;return 'applied'})
    assert.equal(sends,0)
    assert.equal(peer.db.prepare('SELECT result FROM federation_outbox').get()!.result,'expired')
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_command_receipts').get()!.n,2)
  } finally { close() }
})

test('migration 34 is additive, rollback/retry safe, and leaves reserved K4 migration numbers untouched', () => {
  const db=openDb(':memory:')
  try {
    const oldVersion=db.prepare('PRAGMA user_version').get()!.user_version
    const digest=hash(MIGRATIONS)
    db.prepare("INSERT INTO settings VALUES ('preserved','value')").run()
    db.exec('CREATE TABLE federation_operations(collision TEXT)')
    assert.throws(()=>migrateFederation(db),/already exists/)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='federation_peers'").get(),undefined)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='federation_migrations'").get(),undefined)
    db.exec('DROP TABLE federation_operations');migrateFederation(db);migrateFederation(db)
    assert.deepEqual(db.prepare('SELECT version FROM federation_migrations').all().map((r)=>r.version),[34])
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,oldVersion)
    assert.equal(hash(MIGRATIONS),digest)
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='preserved'").get()!.value,'value')
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok')
  } finally {db.close()}
})

test('reopen preserves op-log, HLC, pins and outbox; late secrets and readiness fail closed', async () => {
  const dir=mkdtempSync(join(tmpdir(),'guanxi-f1-'));const path=join(dir,'node.sqlite');const keys=identity('home')
  let node=new SimNode(keys,path)
  const secret=randomBytes(24).toString('hex')
  try {
    node.federation.config.create('theme',{kind:'setting',value:'dark'})
    const run=node.runs.create({id:'run',sessionId:'session'})
    const binding: StreamBinding={streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'}
    node.federation.replicas.bind(binding)
    const queued={id:'queued',runId:run.id,sessionId:run.session_id,homeNodeId:'home',stateVersion:run.version,expiresAt:node.time+10_000,action:{kind:'stop' as const}}
    node.federation.enqueue(queued)
    const before=node.federation.config.stateHash()
    const maxWall=(node.db.prepare('SELECT wall FROM federation_clock').get()!.wall as number)
    node.close();node=new SimNode(keys,path)
    assert.equal(node.federation.config.stateHash(),before)
    assert.deepEqual(node.federation.replicas.binding('run'),binding)
    assert.equal(node.db.prepare('SELECT COUNT(*) AS n FROM federation_outbox WHERE result IS NULL').get()!.n,1)
    let delivered:unknown;await node.federation.flush(async(c)=>{delivered=c;return 'stale_version'})
    assert.deepEqual(delivered,queued)
    const op=node.federation.config.create('next',{kind:'setting',value:'light'})
    assert.equal(op.operation.counter,2);assert.ok(op.operation.clock.wall>=maxWall)
    node.scrubber.expect('vault')
    assert.throws(()=>node.federation.config.operations(),/egress_not_ready/)
    node.scrubber.register('secret://test',secret);node.scrubber.ready('vault')
    assert.throws(()=>node.federation.config.create('secret',{kind:'setting',value:secret}),/content_withheld/)
    assert.equal(node.federation.config.operations().length,2)
    assert.equal(JSON.stringify(node.db.prepare('SELECT * FROM federation_operations').all()).includes(secret),false)
    assert.equal(Object.values(node.federation).includes(keys.privateKey),false)
    assert.equal(Object.values(node.federation.config).includes(keys.privateKey),false)
  } finally {node.close();rmSync(dir,{recursive:true,force:true})}
})

test('receipt failure rolls back stop, trace and receipt together', () => {
  const {home,peer,close}=setup()
  try {
    const run=home.runs.create({id:'run',sessionId:'session'})
    home.federation.replicas.bind({streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const command={id:'stop',runId:run.id,sessionId:run.session_id,homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+10_000,action:{kind:'stop' as const}}
    const before=home.log.readAll(run.session_id,'person')
    home.db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON federation_command_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END")
    assert.throws(()=>home.federation.receiveCommand(peer.context(),command),/fixture/)
    assert.deepEqual({...home.runs.get(run.id)},run)
    assert.deepEqual(home.log.readAll(run.session_id,'person'),before)
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_command_receipts').get()!.n,0)
    home.db.exec('DROP TRIGGER refuse_receipt')
    assert.equal(home.federation.receiveCommand(peer.context(),command),'applied')
    assert.equal(home.runs.get(run.id).cancel_count,1)
  } finally {close()}
})

test('remote prompt accepts content beyond identifier length without a hidden model limit', () => {
  const {home,peer,close}=setup()
  try {
    const run=home.runs.create({id:'run',sessionId:'session'})
    home.federation.replicas.bind({streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const text='A detailed prompt. '.repeat(1000)
    const command={id:'long-prompt',runId:run.id,sessionId:run.session_id,homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+5000,action:{kind:'prompt' as const,text}}
    assert.ok(text.length>200)
    assert.equal(home.federation.receiveCommand(peer.context(),command),'applied')
    assert.deepEqual(home.federation.pendingPrompts(run.id),[command])
    assert.equal(home.log.readAll(run.session_id,'person').filter((event)=>event.type==='prompt'&&event.data.text===text).length,1)
  } finally {close()}
})

test('restart preserves nonce rejection, command receipts and prompt acceptance order', () => {
  const dir=mkdtempSync(join(tmpdir(),'guanxi-f1-receipts-'));const path=join(dir,'node.sqlite');const keys=identity('home')
  const peer=new SimNode(identity('peer'));let home=new SimNode(keys,path)
  try {
    home.trust(peer);peer.trust(home)
    const run=home.runs.create({id:'run',sessionId:'session'})
    home.federation.replicas.bind({streamId:run.id,kind:'run',sessionId:run.session_id,homeNodeId:'home',homeEpoch:1,ownerAccountId:'owner'})
    const auth={nodeId:'peer',version:{major:1,minor:0},issuedAt:peer.time,nonce:'nonce',signature:''}
    auth.signature=signValue(peer.keys.privateKey,requestProof('GET','/api/federation/handshake',null,auth))
    home.federation.authenticate('GET','/api/federation/handshake',null,auth)
    const first={id:'z-first',runId:run.id,sessionId:run.session_id,homeNodeId:'home',stateVersion:run.version,expiresAt:home.time+5000,action:{kind:'prompt' as const,text:'first'}}
    assert.equal(home.federation.receiveCommand(peer.context(),first),'applied')
    const second={...first,id:'a-second',stateVersion:home.runs.get(run.id).version,action:{kind:'prompt' as const,text:'second'}}
    assert.equal(home.federation.receiveCommand(peer.context(),second),'applied')
    assert.deepEqual(home.federation.pendingPrompts(run.id),[first,second])
    const version=home.runs.get(run.id).version
    home.close();home=new SimNode(keys,path)
    assert.throws(()=>home.federation.authenticate('GET','/api/federation/handshake',null,auth),/request_replayed/)
    assert.equal(home.federation.receiveCommand(peer.context(),first),'applied')
    assert.equal(home.federation.receiveCommand(peer.context(),second),'applied')
    assert.equal(home.runs.get(run.id).version,version)
    assert.equal(home.runs.attempts(run.id).length,0)
    assert.deepEqual(home.federation.pendingPrompts(run.id),[first,second])
    assert.equal(home.db.prepare('SELECT COUNT(*) AS n FROM federation_command_receipts').get()!.n,2)
    const prompts=home.log.readAll(run.session_id,'person').filter((e)=>e.type==='prompt')
    assert.deepEqual(prompts.map((e)=>e.data.text),['first','second'])
  } finally {home.close();peer.close();rmSync(dir,{recursive:true,force:true})}
})
