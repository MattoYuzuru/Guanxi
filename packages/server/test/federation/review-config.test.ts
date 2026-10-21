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
