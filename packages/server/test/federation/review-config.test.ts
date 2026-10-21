// Regression scenarios adapted from cross-family Review 1 probes (P1, P1b, P5).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signValue } from '../../src/federation/crypto.ts'
import { SimNode, identity } from './harness.ts'

const EDITOR = '["owner","grant","editor"]'
const present = (n: SimNode) => (n.federation.config.state()[EDITOR] as { present: boolean } | undefined)?.present

test('P1 remove-wins: unseen revoke defeats a grant after reordering (POST delivery)', async () => {
  const [a, c, d] = ['a', 'c', 'd'].map((id) => new SimNode(identity(id))) as [SimNode, SimNode, SimNode]
  try {
    for (const n of [a, c, d]) for (const p of [a, c, d]) n.trust(p)
    const revoke = a.federation.config.create('editor', { kind: 'grant', present: false }) // a:1
    const later = a.federation.config.create('theme', { kind: 'setting', value: 'dark' })   // a:2
    // Reordered network: c receives a:2 first; a:1 is still in flight.
    assert.equal((await a.request(c, 'POST', '/config', [later])).status, 200)
    const cStoredBefore = c.federation.config.operations().map((o) => `${o.operation.origin}:${o.operation.counter}`)
    assert.deepEqual(cStoredBefore, [], 'sparse op stays deferred until its context is stored')
    assert.equal(present(c), undefined, 'c has no grant state for editor at all')
    const grant = c.federation.config.create('editor', { kind: 'grant', present: true })
    for (const n of [a, c, d]) n.federation.config.ingest([revoke, later, grant])
    // Exit-gate property: a revoke the granter never observed must win.
    assert.equal(present(a), false, 'VIOLATION: concurrent (unobserved) revoke lost to grant')
  } finally { a.close(); c.close(); d.close() }
})

test('P1b non-admin cloud relay selectively forwards a later admin op; unseen revoke remains effective', async () => {
  const a = new SimNode(identity('a')); const c = new SimNode(identity('c'))
  const cloud = new SimNode(identity('cloud', { trust: 'cloud_ephemeral', admin: false, scopes: ['config'] }))
  try {
    for (const n of [a, c, cloud]) for (const p of [a, c, cloud]) n.trust(p)
    const grant0 = a.federation.config.create('editor', { kind: 'grant', present: true })
    c.federation.config.ingest([grant0])
    a.federation.config.create('editor', { kind: 'grant', present: false })        // a:2 revoke
    a.federation.config.create('theme', { kind: 'setting', value: 'dark' })        // a:3
    // The cloud node legitimately pulls A's whole log, then forwards only a:3 to C.
    const all = (await (await cloud.request(a, 'GET', '/config')).json() as { operations: { operation: { counter: number } }[] }).operations
    const onlyLater = all.filter((op) => op.operation.counter === 3)
    assert.equal((await cloud.request(c, 'POST', '/config', onlyLater)).status, 200)
    assert.equal(present(c), true, 'c still sees the old grant; it never saw the revoke')
    // C's admin re-affirms the grant it believes is current.
    const g = c.federation.config.create('editor', { kind: 'grant', present: true })
    // Revoke now arrives through honest anti-entropy everywhere.
    c.federation.config.ingest(all as never); a.federation.config.ingest([g])
    assert.equal(present(a), false, 'VIOLATION: non-admin relay made an unseen revoke lose')
  } finally { a.close(); c.close(); cloud.close() }
})

test('P5 compromised admin context claims are deferred without locking local writes', () => {
  const [a, b, x] = ['a', 'b', 'x'].map((id) => new SimNode(identity(id))) as [SimNode, SimNode, SimNode]
  try {
    for (const n of [a, b, x]) for (const p of [a, b, x]) n.trust(p)
    const operation = { origin: 'x', counter: 1, accountId: 'owner', key: 'editor', clock: { wall: x.time, logical: 0 },
      context: { x: 0, a: 1_000_000, b: 1_000_000 }, value: { kind: 'grant' as const, present: true } }
    const poisoned = { operation, signature: signValue(x.keys.privateKey, operation) }
    for (const n of [a, b]) {
      assert.equal(n.federation.config.ingest([poisoned]).deferred, 1)
      assert.equal(n.federation.config.operations().length, 0, 'unheld context never enters the log')
      n.federation.revokePeer('x')
    }
    const errors = [a, b].map((n) => { try { n.federation.config.create('editor', { kind: 'grant', present: false }); return 'ok' } catch (e) { return (e as Error).message } })
    assert.deepEqual(errors, ['ok', 'ok'], 'VIOLATION: revoked admin permanently blocks config writes')
  } finally { a.close(); b.close(); x.close() }
})

test('legacy sparse rows and attested contexts cannot inflate a newly authored vector', () => {
  const a = new SimNode(identity('a')); const c = new SimNode(identity('c'))
  try {
    a.trust(c); c.trust(a)
    // Model a pre-fix database containing a sparse row and an unchecked admin context.
    const operation = {origin:'a', counter:2, accountId:'owner', key:'old', clock:{wall:a.time,logical:0},
      context:{a:1,b:500}, value:{kind:'setting' as const,value:true}}
    c.db.prepare('INSERT INTO federation_operations VALUES (?,?,?)').run('a', 2,
      JSON.stringify({operation,signature:signValue(a.keys.privateKey,operation)}))
    const next = c.federation.config.create('next', {kind:'setting',value:true})
    assert.equal(next.operation.context.a, undefined, 'a sparse dot is not an observed prefix')
    assert.equal(next.operation.context.b, undefined, 'attested context is not stored history')
  } finally { a.close(); c.close() }
})

// P4/P4b retain strict H1 admission: a revoke depending on forbidden history
// requires explicit reauthoring. Independent operations must still synchronize.
for (const mode of ['revoked', 'unknown'] as const) test(`${mode === 'revoked' ? 'P4' : 'P4b'}: inadmissible author cannot wedge independent sync; impossible dependencies need reauthoring`, async () => {
  const a = new SimNode(identity('a')); const b = new SimNode(identity('b'))
  const x = new SimNode(identity('x', {trust:'cloud_ephemeral',admin:false,scopes:['config']}))
  const independent = new SimNode(identity('independent'))
  try {
    a.trust(b); b.trust(a); a.trust(x); a.trust(independent); b.trust(independent)
    if (mode === 'revoked') { b.trust(x); b.federation.revokePeer('x') }
    const grant = a.federation.config.create('editor', {kind:'grant',present:true})
    b.federation.config.ingest([grant])
    a.federation.config.ingest([x.federation.config.create('project', {kind:'project',name:'x',archived:false})])
    a.federation.config.create('editor', {kind:'grant',present:false})
    const allowed = independent.federation.config.create('independent', {kind:'setting',value:true})
    a.federation.config.ingest([allowed])
    const response = await a.request(b, 'POST', '/config', a.federation.config.operations())
    assert.equal(response.status, 200)
    const report = await response.json() as {accepted:number;skipped:number;deferred:number;reasons:Record<string,number>}
    assert.equal(report.skipped, 1, 'inadmissible author is counted')
    assert.equal(report.reasons.unauthenticated, 1)
    assert.equal(report.accepted, 1, 'independent author commits')
    assert.equal(report.deferred, 1, 'dependent revoke remains unadmitted under H1')
    assert.equal(present(b), true)
    assert.ok(b.federation.config.operations().some((op) => op.operation.origin === 'independent'))
    // Retry through the shipped channel succeeds; it cannot bypass H1 or undo local recovery.
    const { FederationChannel } = await import('../../src/federation/channel.ts')
    const channel = new FederationChannel({local:b.keys.identity,privateKey:b.keys.privateKey,peer:a.keys.identity,clock:()=>b.time,transport:async(req)=>a.app.request(req)})
    await assert.doesNotReject(() => channel.synchronize(b.federation))
    const recovery = b.federation.config.create('editor', {kind:'grant',present:false})
    a.federation.config.ingest([recovery])
    await channel.synchronize(b.federation)
    assert.equal(present(a), false)
    assert.equal(present(b), false, 'current-admin reauthoring restores the revoke without forbidden history')
  } finally { a.close(); b.close(); x.close(); independent.close() }
})

test('batch commits independent ops around unknown, revoked, unscoped, non-admin and future authors', () => {
  const receiver = new SimNode(identity('receiver'))
  const nodes = [identity('unknown'),identity('revoked'),identity('unscoped',{scopes:[]}),identity('nonadmin',{admin:false}),identity('future'),identity('good')].map((keys)=>new SimNode(keys))
  try {
    const ops = nodes.map((n, index) => {
      if (index !== 2) return n.federation.config.create('metadata', {kind:'setting',value:true})
      const operation = {origin:n.keys.identity.id,counter:1,accountId:'owner',key:'metadata',clock:{wall:n.time,logical:0},context:{},value:{kind:'setting' as const,value:true}}
      return {operation,signature:signValue(n.keys.privateKey,operation)}
    })
    for (const n of nodes.slice(1)) receiver.trust(n)
    receiver.federation.revokePeer('revoked')
    const signed = (index:number, change:Record<string,unknown>) => {
      const operation = {...ops[index]!.operation,...change}
      return {operation,signature:signValue(nodes[index]!.keys.privateKey,operation)}
    }
    const batch = [...ops]
    batch[3] = signed(3,{value:{kind:'grant',present:true}})
    batch[4] = signed(4,{clock:{wall:receiver.time+60_001,logical:0}})
    let report: ReturnType<typeof receiver.federation.config.ingest> | undefined
    assert.doesNotThrow(() => { report = receiver.federation.config.ingest(batch) })
    assert.equal(report!.accepted, 1)
    assert.equal(report!.skipped, 5)
    assert.deepEqual(report!.reasons, {unauthenticated:2,forbidden:1,admin_required:1,clock_drift:1})
    assert.deepEqual(receiver.federation.config.operations(), [ops[5]])
    const valid = nodes[5]!.federation.config.create('next', {kind:'setting',value:'committed before conflict'})
    const conflict = {...ops[5]!,signature:'altered'}
    assert.throws(() => receiver.federation.config.ingest([valid,conflict]), /operation_conflict/, 'conflict remains fatal')
    assert.equal(receiver.federation.config.operations().length, 2, 'an admitted op commits independently before a later conflict')
  } finally { receiver.close(); nodes.forEach((n)=>n.close()) }
})
