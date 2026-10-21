/** Review sweep: run with `node sweep.ts <fromSeed> <toSeed>`; prints a JSON summary. */
import type { SignedConfigOperation } from '@guanxi/contract/federation'
import { MAX_CLOCK_DRIFT_MS } from '../../src/federation/config.ts'
import { SimNode, identity, rng } from './harness.ts'

const dot = (s: SignedConfigOperation) => `${s.operation.origin}:${s.operation.counter}`
export type OracleInput = { seed: number; created: SignedConfigOperation[]; knowledge: Map<string, Set<string>>;
  state: Record<string, { kind: string; present?: boolean }> }
export function sweep(from: number, to: number, MODE = 'mixed', oracle?: (input: OracleInput) => void) {
const OPS = 60
const summary = { seeds: 0, ops: 0, convergenceFailures: [] as number[], countFailures: [] as number[], hlcViolations: 0,
  deferred: 0, clockDriftRejections: 0, rollbackRefusals: 0, otherErrors: [] as string[], groups: 0, unsafeGrantWins: 0,
  unsafeSeeds: [] as number[], unsafeSeedCount: 0, conservative: 0, seedsWithSkewBeyondBound: 0 }
for (let seed = from; seed <= to; seed++) {
  const random = rng(seed * 7919 + 13)
  const ids = ['a', 'b', 'c', 'd']
  const nodes = ids.map((id) => new SimNode(identity(id, id === 'd' ? { admin: false } : {})))
  const byId = new Map(ids.map((id, i) => [id, nodes[i]!]))
  try {
    for (const x of nodes) for (const y of nodes) x.trust(y)
    let T = 1_000_000_000
    // Skew up to +-120 s: pairs can differ by up to 240 s, four times the drift bound.
    const offset = new Map(ids.map((id) => [id, Math.round((random() * 2 - 1) * 120_000)]))
    const spread = Math.max(...offset.values()) - Math.min(...offset.values())
    if (spread > MAX_CLOCK_DRIFT_MS) summary.seedsWithSkewBeyondBound++
    const rollbackAt = random() < 0.5 ? Math.floor(random() * OPS) : -1
    let rolled = false
    const setTimes = () => { for (const [id, n] of byId) n.time = T + offset.get(id)! }
    const knowledge = new Map<string, Set<string>>()
    const created: SignedConfigOperation[] = []
    type Packet = { to: string; ops: SignedConfigOperation[]; due: number }
    let packets: Packet[] = []
    const cut = new Set<string>()
    const pair = (x: string, y: string) => [x, y].sort().join('/')
    const ingest = (target: SimNode, ops: SignedConfigOperation[]): boolean => {
      try { summary.deferred += target.federation.config.ingest(ops).deferred; return true } catch (e) {
        const m = (e as Error).message
        if (m === 'clock_drift') { summary.clockDriftRejections++; return false }
        summary.otherErrors.push(`seed ${seed}: ${m}`); return false
      }
    }
    const step = () => {
      T += Math.floor(random() * 5_000); setTimes()
      if (random() < 0.05) { const [x, y] = [ids[Math.floor(random() * 4)]!, ids[Math.floor(random() * 4)]!]; if (x !== y) cut.add(pair(x, y)) }
      if (random() < 0.03) cut.clear()
      const ready = packets.filter((p) => p.due <= T)
      if (ready.length) {
        const p = ready[Math.floor(random() * ready.length)]!
        packets.splice(packets.indexOf(p), 1)
        const from = p.ops[0]!.operation.origin
        if (cut.has(pair(from, p.to)) || !ingest(byId.get(p.to)!, p.ops)) packets.push({ ...p, due: T + Math.floor(random() * 30_000) })
      }
      if (random() < (MODE === 'pull' ? 0.5 : 0.1)) { // full-log anti-entropy pull between two connected nodes
        const [x, y] = [byId.get(ids[Math.floor(random() * 4)]!)!, byId.get(ids[Math.floor(random() * 4)]!)!]
        if (x !== y && !cut.has(pair(x.keys.identity.id, y.keys.identity.id))) ingest(x, y.federation.config.operations())
      }
      for (const n of nodes) { if (rolled && n.keys.identity.id === 'c') continue; const c = n.db.prepare('SELECT wall FROM federation_clock').get()!.wall as number; if (c > n.time + MAX_CLOCK_DRIFT_MS) summary.hlcViolations++ }
    }
    setTimes()
    for (let i = 0; i < OPS; i++) {
      if (i === rollbackAt) { rolled = true; offset.set('c', offset.get('c')! - 90_000); setTimes() }
      const src = nodes[Math.floor(random() * 4)]!
      const admin = src.keys.identity.admin
      const r = random()
      const key = `k${Math.floor(random() * 3)}`
      const value = !admin || r < 0.3 ? { kind: 'setting' as const, value: Math.floor(random() * 5) }
        : r < 0.65 ? { kind: 'grant' as const, present: random() < 0.5 } : { kind: 'membership' as const, present: random() < 0.5 }
      const before = new Set(src.federation.config.operations().map(dot))
      let op: SignedConfigOperation
      try { op = src.federation.config.create(key, value) } catch (e) {
        if ((e as Error).message === 'clock_drift') { summary.rollbackRefusals++; step(); continue }
        throw e
      }
      if (op.operation.clock.wall > src.time + MAX_CLOCK_DRIFT_MS) summary.hlcViolations++
      knowledge.set(dot(op), before); created.push(op)
      for (const n of nodes) if (n !== src) {
        // random sub-batch: sometimes bundle with up to 3 earlier ops of any origin, in random order
        if (MODE === 'pull') continue
        const extra = MODE === 'push' ? [] : created.filter(() => random() < 0.05).slice(0, 3)
        const batch = [op, ...extra].sort(() => random() - 0.5)
        packets.push({ to: n.keys.identity.id, ops: batch, due: T + Math.floor(random() * 40_000) })
        if (random() < 0.3) packets.push({ to: n.keys.identity.id, ops: [op], due: T + Math.floor(random() * 80_000) })
      }
      step()
    }
    // Heal, let real time pass beyond any skew/rollback, drain with retries, then pairwise anti-entropy.
    cut.clear(); T += 400_000; setTimes()
    let guard = 0
    while (packets.length && guard++ < 100_000) step()
    for (let round = 0; round < 2; round++) for (const x of nodes) for (const y of nodes) if (x !== y) ingest(x, y.federation.config.operations())
    summary.seeds++; summary.ops += created.length
    const hashes = nodes.map((n) => n.federation.config.stateHash())
    if (new Set(hashes).size !== 1) summary.convergenceFailures.push(seed)
    if (nodes.some((n) => n.federation.config.operations().length !== created.length)) summary.countFailures.push(seed)
    // Remove-wins oracle on DIRECT knowledge: b observed a iff a was stored at b's origin when b was created.
    const state = nodes[0]!.federation.config.state() as Record<string, { kind: string; present?: boolean }>
    oracle?.({ seed, created, knowledge, state })
    const groups = new Map<string, SignedConfigOperation[]>()
    for (const op of created) if (['grant', 'membership'].includes(op.operation.value.kind)) {
      const g = JSON.stringify([op.operation.accountId, op.operation.value.kind, op.operation.key]); groups.set(g, [...(groups.get(g) ?? []), op])
    }
    let unsafe = false
    for (const [g, all] of groups) {
      summary.groups++
      const frontier = all.filter((x) => !all.some((y) => knowledge.get(dot(y))!.has(dot(x))))
      const expected = frontier.length > 0 && frontier.every((x) => (x.operation.value as { present: boolean }).present)
      const actual = state[g]!.present
      if (actual && !expected) { summary.unsafeGrantWins++; unsafe = true
      }
      if (!actual && expected) summary.conservative++
    }
    if (unsafe) summary.unsafeSeedCount++
    if (unsafe && summary.unsafeSeeds.length < 10) summary.unsafeSeeds.push(seed)
  } finally { nodes.forEach((n) => n.close()) }
}
summary.otherErrors = summary.otherErrors.slice(0, 10)
return summary
}
