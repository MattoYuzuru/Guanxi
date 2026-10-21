// Review 2 P4c/P4d and the context eligibility boundary (P5 remains in review-config).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { FederationChannel } from '../../src/federation/channel.ts'
import { signValue } from '../../src/federation/crypto.ts'
import { history } from './ingest-benchmark.ts'
import { SimNode, identity } from './harness.ts'

const present = (n: SimNode) => (n.federation.config.state()['["owner","grant","editor"]'] as { present: boolean } | undefined)?.present
const pull = (from: SimNode, to: SimNode) => new FederationChannel({ local: to.keys.identity, privateKey: to.keys.privateKey,
  peer: from.keys.identity, clock: () => to.time, transport: async (request) => from.app.request(request) })

test('P4c: revoked-origin context cannot spread deferral through honest fleet writes', async () => {
  const nodes = ['a', 'b', 'c', 'x'].map((id) => new SimNode(identity(id)))
  const [a, b, c, x] = nodes as [SimNode, SimNode, SimNode, SimNode]
  try {
    for (const n of nodes) for (const p of nodes) n.trust(p)
    b.federation.config.ingest([a.federation.config.create('editor', { kind: 'grant', present: true })])
    b.federation.revokePeer('x')
    a.federation.config.ingest([x.federation.config.create('theme', { kind: 'setting', value: 'x' })])
    a.federation.revokePeer('x')
    for (let i = 0; i < 3; i++) a.federation.config.create(`a${i}`, { kind: 'setting', value: i })
    a.federation.config.create('editor', { kind: 'grant', present: false })
    await pull(a, c).synchronize(c.federation)
    for (let i = 0; i < 3; i++) c.federation.config.create(`c${i}`, { kind: 'setting', value: i })
    const before = b.federation.config.operations().length
    const first = await pull(a, b).synchronize(b.federation)
    const second = await pull(c, b).synchronize(b.federation)
    assert.equal(first.accepted + second.accepted, 7, 'all seven honest fleet operations commit')
    assert.equal(b.federation.config.operations().length - before, 7)
    assert.equal(first.deferred + second.deferred, 0)
    assert.equal(first.skipped, 1, 'channel exposes skipped revoked history')
    assert.equal(second.skipped, 1)
    assert.equal(first.reasons.unauthenticated, 1)
    assert.deepEqual([present(a), present(b), present(c)], [false, false, false])
    assert.equal(b.federation.config.operations().filter((op) => op.operation.origin === 'x').length, 0)
  } finally { nodes.forEach((n) => n.close()) }
})

test('P4d: content withheld skips only that op; sync surfaces skipped and deferred counts', async () => {
  const nodes = ['a', 'b', 'z'].map((id) => new SimNode(identity(id)))
  const [a, b, z] = nodes as [SimNode, SimNode, SimNode]
  try {
    for (const n of nodes) for (const p of nodes) n.trust(p)
    // Synthetic, randomly generated fixture, never a real credential.
    const blocked = `fixture-${randomUUID()}`
    b.scrubber.register('secret://blocked', blocked)
    a.federation.config.create('note', { kind: 'glossary', term: 'key', replacement: blocked })
    a.federation.config.create('later', { kind: 'setting', value: 'waits for admissible a:1' })
    a.federation.config.ingest([z.federation.config.create('editor', { kind: 'grant', present: false })])
    const channel = pull(a, b)
    let first!: Awaited<ReturnType<typeof channel.synchronize>>
    await assert.doesNotReject(async () => { first = await channel.synchronize(b.federation) }, 'withheld content cannot abort independent sync')
    assert.equal(first.accepted, 1, 'independent z revoke commits past withheld content')
    assert.equal(first.skipped, 1, 'sync surfaces withheld count')
    assert.equal(first.deferred, 1, 'sync surfaces admissible same-origin gap')
    assert.deepEqual(first.reasons, { content_withheld: 1 })
    const second = await channel.synchronize(b.federation)
    assert.equal(second.accepted, 0)
    assert.equal(second.duplicates, 1)
    assert.equal(second.skipped, 1)
    assert.equal(second.deferred, 1)
    assert.equal(present(b), false)
    assert.equal(b.federation.config.operations().length, 1)
  } finally { nodes.forEach((n) => n.close()) }
})

test('H4: context eligibility covers pins, revocation, config scope, account and admin rights', () => {
  for (const mode of ['unpinned', 'revoked', 'scope', 'account', 'admin', 'admissible'] as const) {
    const receiver = new SimNode(identity('receiver')); const author = new SimNode(identity('author'))
    const origin = new SimNode(identity('origin', mode === 'scope' ? { scopes: [] } : mode === 'account' ? { accountId: 'other' } : mode === 'admin' ? { admin: false } : {}))
    try {
      receiver.trust(author)
      if (mode !== 'unpinned') receiver.trust(origin)
      if (mode === 'revoked') receiver.federation.revokePeer('origin')
      const operation = { origin: 'author', counter: 1, accountId: 'owner', key: 'editor', clock: { wall: author.time, logical: 0 },
        context: { author: 0, origin: 1 }, value: { kind: 'grant' as const, present: false } }
      const result = receiver.federation.config.ingest([{ operation, signature: signValue(author.keys.privateKey, operation) }])
      assert.equal(result.accepted, mode === 'admissible' ? 0 : 1, `${mode}: only eligible origins require history`)
      assert.equal(result.deferred, mode === 'admissible' ? 1 : 0)
      const local = receiver.federation.config.create('local', { kind: 'setting', value: true })
      assert.equal(local.operation.context.origin, undefined, 'ignored context never advances stored prefixes')
    } finally { receiver.close(); author.close(); origin.close() }
  }
})

test('P4e residual: revoked-author equivocation remains fatal without rewriting signed history', async () => {
  const nodes = ['a', 'b', 'x', 'y'].map((id) => new SimNode(identity(id)))
  const [a, b, x, y] = nodes as [SimNode, SimNode, SimNode, SimNode]
  try {
    for (const n of nodes) for (const p of nodes) n.trust(p)
    const conflicting = (value: string) => {
      const operation = { origin: 'x', accountId: 'owner', counter: 1, key: 'theme', clock: { wall: x.time, logical: 0 },
        context: { x: 0 }, value: { kind: 'setting' as const, value } }
      return { operation, signature: signValue(x.keys.privateKey, operation) }
    }
    a.federation.config.ingest([conflicting('A')]); b.federation.config.ingest([conflicting('B')])
    a.federation.revokePeer('x'); b.federation.revokePeer('x')
    a.federation.config.ingest([y.federation.config.create('editor', { kind: 'grant', present: false })])
    await assert.rejects(() => pull(a, b).synchronize(b.federation), /operation_conflict/, 'equivocation requires operator-reviewed rebaseline')
    assert.equal(present(b), undefined, 'later honest operations in this pull remain blocked')
    // Recovery for this independent revoke can use a clean packet; the conflicting
    // history itself still needs reviewed rebaseline, not an automatic overwrite.
    b.federation.config.ingest(y.federation.config.operations())
    assert.equal(present(b), false, 'targeted clean catch-up admits independent work')
  } finally { nodes.forEach((n) => n.close()) }
})


test('self-review: ready queue waits for every missing origin before admission', () => {
  const nodes = ['receiver', 'author', 'x', 'y'].map((id) => new SimNode(identity(id)))
  const [receiver, author, x, y] = nodes as [SimNode, SimNode, SimNode, SimNode]
  try {
    for (const n of nodes) for (const p of nodes) n.trust(p)
    const hx = history(x, 2); const hy = history(y, 2)
    author.federation.config.ingest([...hx, ...hy])
    const dependent = author.federation.config.create('editor', { kind: 'grant', present: false })
    const first = receiver.federation.config.ingest([dependent, hx[0]!, hy[0]!, hx[1]!])
    assert.equal(first.accepted, 3, 'one satisfied origin cannot release a multiply dependent op')
    assert.equal(first.deferred, 1)
    assert.equal(present(receiver), undefined)
    const second = receiver.federation.config.ingest([dependent, hy[1]!])
    assert.equal(second.accepted, 2, 'the final missing dot releases exactly one dependent')
    assert.equal(second.deferred, 0)
    assert.equal(present(receiver), false)
  } finally { nodes.forEach((n) => n.close()) }
})

test('independent review: non-admin config origins remain metadata dependencies in either cache order', () => {
  for (const reverse of [false, true]) {
    const receiver = new SimNode(identity('receiver')); const writer = new SimNode(identity('writer'))
    const admin = new SimNode(identity('admin')); const origin = new SimNode(identity('origin', { admin: false }))
    const nodes = [receiver, writer, admin, origin]
    try {
      for (const n of nodes) for (const p of nodes) n.trust(p)
      const dependency = origin.federation.config.create('source', { kind: 'setting', value: true })
      for (const n of [writer, admin]) n.federation.config.ingest([dependency])
      const metadata = writer.federation.config.create('theme', { kind: 'setting', value: 'dark' })
      const privilege = admin.federation.config.create('editor', { kind: 'grant', present: false })
      const result = receiver.federation.config.ingest(reverse ? [metadata, privilege] : [privilege, metadata])
      assert.equal(result.accepted, 1, 'non-admin history is optional only for privileged operations')
      assert.equal(result.deferred, 1, 'metadata still waits for its admissible non-admin origin')
      assert.deepEqual(receiver.federation.config.operations().map((op) => op.operation.origin), ['admin'])
      assert.equal(receiver.federation.config.ingest([metadata, dependency]).accepted, 2)
      assert.equal(receiver.federation.config.operations().length, 3)
    } finally { nodes.forEach((n) => n.close()) }
  }
})
