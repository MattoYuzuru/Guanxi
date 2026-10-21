import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signValue } from '../../src/federation/crypto.ts'
import { SimNode, identity } from './harness.ts'
import { sweep } from './sweep.ts'

// The independent oracle records DIRECT stored knowledge at creation, never signed claims.
test('64 seeds per mode: convergence and remove-wins under skew, rollback, per-op push and partial subsets', () => {
  for (const mode of ['mixed', 'push', 'pull']) {
    const summary = sweep(1, 64, mode, ({seed, created, knowledge, state}) => {
      const dot = (op: typeof created[number]) => `${op.operation.origin}:${op.operation.counter}`
      const groups = new Map<string, typeof created>()
      for (const op of created) if (['grant','membership'].includes(op.operation.value.kind)) {
        const key = JSON.stringify([op.operation.accountId, op.operation.value.kind, op.operation.key])
        groups.set(key, [...(groups.get(key) ?? []), op])
      }
      for (const [key, all] of groups) {
        const frontier = all.filter((x) => !all.some((y) => knowledge.get(dot(y))!.has(dot(x))))
        const expected = frontier.length > 0 && frontier.every((x) => 'present' in x.operation.value && x.operation.value.present)
        assert.equal(state[key]!.present, expected, `${mode} seed ${seed}: saw only what was stored: ${key}`)
      }
    })
    assert.equal(summary.seeds, 64)
    assert.deepEqual(summary.convergenceFailures, [])
    assert.deepEqual(summary.countFailures, [])
    assert.equal(summary.unsafeGrantWins, 0)
    assert.equal(summary.hlcViolations, 0)
    assert.ok(summary.seedsWithSkewBeyondBound > 0)
    assert.ok(summary.rollbackRefusals > 0)
    if (mode !== 'pull') assert.ok(summary.deferred > 0)
    assert.deepEqual(summary.otherErrors, [])
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

test('sparse and transitive claims wait for stored dependencies before a regrant', () => {
  const [a,b,c] = ['a','b','c'].map((id) => new SimNode(identity(id))) as [SimNode,SimNode,SimNode]
  try {
    for (const n of [a,b,c]) for (const peer of [a,b,c]) n.trust(peer)
    const predecessor = a.federation.config.create('unrelated', {kind:'setting',value:true})
    const revoke = a.federation.config.create('editor', {kind:'grant',present:false})
    assert.equal(b.federation.config.ingest([revoke]).deferred, 1)
    const intermediate = b.federation.config.create('other', {kind:'setting',value:true})
    c.federation.config.ingest([intermediate])
    const grant = c.federation.config.create('editor', {kind:'grant',present:true})
    assert.equal(intermediate.operation.context.a, undefined)
    assert.equal(grant.operation.context.a, undefined)
    assert.equal(grant.operation.context.b, 1)
    for (const n of [a,b,c]) n.federation.config.ingest([grant,intermediate,revoke,predecessor])
    for (const n of [a,b,c]) assert.equal((n.federation.config.state()['["owner","grant","editor"]'] as {present:boolean}).present, false)
    assert.equal(new Set([a,b,c].map((n) => n.federation.config.stateHash())).size, 1)
    const direct = b.federation.config.create('editor', {kind:'grant',present:true})
    assert.equal(direct.operation.context.a, 2)
    for (const n of [a,b,c]) {
      n.federation.config.ingest([direct])
      assert.equal((n.federation.config.state()['["owner","grant","editor"]'] as {present:boolean}).present, true)
    }
  } finally { a.close(); b.close(); c.close() }
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

test('trusted foreign claims are deferred without changing local history or clock', () => {
  const a = new SimNode(identity('a')); const c = new SimNode(identity('c'))
  try {
    a.trust(c); c.trust(a)
    const operation = {origin:'a',counter:1,accountId:'owner',key:'metadata',clock:{wall:a.time,logical:0},context:{c:999},value:{kind:'setting' as const,value:true}}
    const clock = c.db.prepare('SELECT * FROM federation_clock').get()
    assert.equal(c.federation.config.ingest([{operation,signature:signValue(a.keys.privateKey,operation)}]).deferred, 1)
    assert.equal(c.federation.config.operations().length, 0)
    assert.deepEqual(c.db.prepare('SELECT * FROM federation_clock').get(), clock)
    const local = c.federation.config.create('local', {kind:'setting',value:true})
    assert.equal(local.operation.counter, 1)
    assert.equal(local.operation.context.c, 0)
  } finally { a.close(); c.close() }
})
