import assert from 'node:assert/strict'
import { test } from 'node:test'
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
