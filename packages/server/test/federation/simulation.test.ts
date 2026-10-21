import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signValue } from '../../src/federation/crypto.ts'
import { SimNetwork, SimNode, identity } from './harness.ts'

// Reproducible schedules; keys are throwaway, and do not enter the projected state hash.
test('64 seeds: shared replicas converge after partitions, skew, delayed/reordered duplicate operations', async () => {
  for (let seed = 1; seed <= 64; seed++) {
    const nodes = ['a', 'b', 'c'].map((id) => new SimNode(identity(id)))
    try {
      for (const a of nodes) for (const b of nodes) a.trust(b)
      const net = new SimNetwork(seed)
      nodes[0]!.time += 800; nodes[1]!.time -= 900
      net.partition(nodes[0]!, nodes[1]!)
      for (let i = 0; i < 40; i++) {
        const source = nodes[Math.floor(net.random() * nodes.length)]!
        const kind = i % 3 === 0 ? 'grant' : i % 3 === 1 ? 'membership' : 'setting'
        const op = source.federation.config.create(`field-${i % 4}`, kind === 'setting' ? { kind, value: i } : { kind, present: net.random() > 0.5 })
        for (const target of nodes.filter((n) => n !== source)) {
          const deliver = async () => { const res = await source.request(target, 'POST', '/config', [op]); assert.equal(res.status, 200, `seed ${seed}: ${await res.text()}`) }
          net.send(source, target, deliver)
          if (net.random() < 0.3) net.send(source, target, deliver)
        }
        await net.step()
        if (i === 20) net.heal()
      }
      assert.ok(net.pending > 0)
      await net.drain()
      const hashes = nodes.map((n) => n.federation.config.stateHash())
      assert.equal(new Set(hashes).size, 1, `seed ${seed}: ${hashes}`)
      for (const node of nodes) assert.equal(node.federation.config.operations().length, 40)
    } finally { nodes.forEach((node) => node.close()) }
  }
})

test('concurrent revoke wins in both delivery orders; an observed regrant restores access', () => {
  const a = new SimNode(identity('a')); const b = new SimNode(identity('b')); const c = new SimNode(identity('c'))
  try {
    for (const n of [a,b,c]) for (const peer of [a,b,c]) n.trust(peer)
    const revoke = a.federation.config.create('editor', { kind: 'grant', present: false })
    b.time += 59_000
    const grant = b.federation.config.create('editor', { kind: 'grant', present: true })
    a.federation.config.ingest([grant]); b.federation.config.ingest([revoke]); c.federation.config.ingest([grant,revoke])
    for (const n of [a,b,c]) assert.deepEqual(Object.values(n.federation.config.state()), [{ kind: 'grant', present: false }])
    const regrant = c.federation.config.create('editor', { kind: 'grant', present: true })
    a.federation.config.ingest([regrant]); b.federation.config.ingest([regrant])
    for (const n of [a,b,c]) assert.deepEqual(Object.values(n.federation.config.state()), [{ kind: 'grant', present: true }])
    assert.equal(new Set([a,b,c].map((n) => n.federation.config.stateHash())).size, 1)
  } finally { a.close(); b.close(); c.close() }
})

test('sparse and transitive observation of a revoke makes the next grant causally later', () => {
  const [a,b,c]=['a','b','c'].map((id)=>new SimNode(identity(id))) as [SimNode,SimNode,SimNode]
  try {
    for(const n of [a,b,c]) for(const peer of [a,b,c]) n.trust(peer)
    const predecessor=a.federation.config.create('unrelated',{kind:'setting',value:true})
    const revoke=a.federation.config.create('editor',{kind:'grant',present:false})
    // B sees the revoke before its predecessor, then C sees only B's unrelated op.
    b.federation.config.ingest([revoke])
    const intermediate=b.federation.config.create('other',{kind:'setting',value:true})
    c.federation.config.ingest([intermediate])
    const grant=c.federation.config.create('editor',{kind:'grant',present:true})
    assert.equal(intermediate.operation.context.a,2)
    assert.equal(grant.operation.context.a,2)
    assert.equal(grant.operation.context.b,1)
    for(const n of [a,b,c]) n.federation.config.ingest([grant,intermediate,revoke,predecessor])
    for(const n of [a,b,c]) assert.equal((n.federation.config.state()['["owner","grant","editor"]'] as {present:boolean}).present,true)
    assert.equal(new Set([a,b,c].map((n)=>n.federation.config.stateHash())).size,1)
    // Direct sparse observation also suffices, without the intermediate node.
    const direct=b.federation.config.create('editor',{kind:'grant',present:true})
    assert.equal(direct.operation.context.a,2)
  } finally {a.close();b.close();c.close()}
})

test('revoked-origin historical duplicates cannot wedge unrelated current-author synchronization', () => {
  const [a,b,c]=['a','b','c'].map((id)=>new SimNode(identity(id))) as [SimNode,SimNode,SimNode]
  try {
    for(const n of [a,b,c]) for(const peer of [a,b,c]) n.trust(peer)
    const historical=a.federation.config.create('old',{kind:'setting',value:'accepted'})
    b.federation.config.ingest([historical]);c.federation.config.ingest([historical])
    const unseen=a.federation.config.create('unseen',{kind:'setting',value:'not admitted'})
    b.federation.revokePeer('a');c.federation.revokePeer('a')
    const current=b.federation.config.create('new',{kind:'setting',value:'current'})
    c.federation.config.ingest(b.federation.config.operations())
    assert.equal(c.federation.config.stateHash(),b.federation.config.stateHash())
    assert.equal(c.federation.config.operations().length,2)
    c.federation.config.ingest([historical,current])
    assert.equal(c.federation.config.operations().length,2)
    assert.throws(()=>c.federation.config.ingest([{...historical,operation:{...historical.operation,value:{kind:'setting',value:'altered'}}}]),/operation_conflict/)
    assert.throws(()=>c.federation.config.ingest([unseen]),/unauthenticated/)
    assert.equal(c.federation.config.operations().length,2)
  } finally {a.close();b.close();c.close()}
})

test('non-admin and foreign-account context cannot defeat a concurrent revoke or invent local counters', () => {
  for(const policy of [{trust:'shared_device' as const,admin:false},{accountId:'other-account',admin:true}]) {
  const a=new SimNode(identity('a'));const b=new SimNode(identity('b',policy));const c=new SimNode(identity('c'))
  try {
    for(const n of [a,b,c]) for(const peer of [a,b,c]) n.trust(peer)
    // B has its own legitimate metadata credential, but no signature from A
    // and no authority to attest another admin's privileged causal history.
    const operation={origin:'b',counter:1,accountId:b.keys.identity.accountId,key:'metadata',clock:{wall:b.time,logical:0},context:{a:1,c:999},value:{kind:'setting' as const,value:true}}
    const forged={operation,signature:signValue(b.keys.privateKey,operation)}
    c.federation.config.ingest([forged])
    const grant=c.federation.config.create('editor',{kind:'grant',present:true})
    assert.equal(grant.operation.counter,1)
    assert.equal(grant.operation.context.a,undefined)
    assert.equal(grant.operation.context.c,0)
    const revoke=a.federation.config.create('editor',{kind:'grant',present:false})
    for(const n of [a,c]) n.federation.config.ingest([grant,revoke,forged])
    for(const n of [a,c]) assert.equal((n.federation.config.state()['["owner","grant","editor"]'] as {present:boolean}).present,false)
    assert.equal(a.federation.config.stateHash(),c.federation.config.stateHash())
  } finally {a.close();b.close();c.close()}
  }
})

test('trusted foreign claims cannot invent the local origin counter or mutate its clock', () => {
  const a=new SimNode(identity('a'));const c=new SimNode(identity('c'))
  try {
    a.trust(c);c.trust(a)
    const operation={origin:'a',counter:1,accountId:'owner',key:'metadata',clock:{wall:a.time,logical:0},context:{c:999},value:{kind:'setting' as const,value:true}}
    c.federation.config.ingest([{operation,signature:signValue(a.keys.privateKey,operation)}])
    const clock=c.db.prepare('SELECT * FROM federation_clock').get()
    assert.throws(()=>c.federation.config.create('local',{kind:'setting',value:true}),/local_history_missing/)
    assert.equal(c.federation.config.operations().length,1)
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM federation_operations WHERE origin='c'").get()!.n,0)
    assert.deepEqual(c.db.prepare('SELECT * FROM federation_clock').get(),clock)
  } finally {a.close();c.close()}
})
