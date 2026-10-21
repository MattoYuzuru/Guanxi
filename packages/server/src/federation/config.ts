import { configOperationSchema, signedConfigOperationSchema, type ConfigOperation, type Hlc, type NodeIdentity,
  type SignedConfigOperation } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import { canonical, FederationError, hash, signValue, validSignature } from './crypto.ts'

export const MAX_CLOCK_DRIFT_MS = 60_000
function counterAt(vector: Record<string, number>, origin: string): number {
  return Object.hasOwn(vector, origin) ? vector[origin]! : 0
}
export function mergeClock(local: Hlc, remote: Hlc, now: number): Hlc {
  if (remote.wall > now + MAX_CLOCK_DRIFT_MS) throw new FederationError('clock_drift')
  const wall = Math.max(now, local.wall, remote.wall)
  const logical = wall === local.wall && wall === remote.wall ? Math.max(local.logical, remote.logical) + 1
    : wall === local.wall ? local.logical + 1 : wall === remote.wall ? remote.logical + 1 : 0
  if (!Number.isSafeInteger(logical)) throw new FederationError('clock_overflow')
  return { wall, logical }
}
export function configState(ops: readonly SignedConfigOperation[]) {
  const groups = new Map<string, ConfigOperation[]>()
  for (const { operation: op } of ops) {
    const key = canonical([op.accountId, op.value.kind, op.key])
    groups.set(key, [...(groups.get(key) ?? []), op])
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, all]) => {
    const kind = all[0]!.value.kind
    if (kind === 'grant' || kind === 'membership') {
      // Maximal causal frontier. A remove wins over every concurrent add, regardless of HLC.
      const frontier = all.filter((a) => !all.some((b) => counterAt(b.context, a.origin) >= a.counter))
      return [key, { kind, present: frontier.length > 0 && frontier.every((op) => 'present' in op.value && op.value.present) }]
    }
    const sorted = [...all].sort((a, b) => a.clock.wall - b.clock.wall || a.clock.logical - b.clock.logical ||
      (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.counter - b.counter)
    return [key, sorted.at(-1)!.value]
  }))
}
export class SharedConfig {
  private readonly db: Db
  private readonly local: NodeIdentity
  #privateKey: string
  private readonly peer: (id: string) => NodeIdentity
  private readonly now: () => number
  private readonly clean: (value: unknown) => void
  constructor(db: Db, local: NodeIdentity, privateKey: string, peer: (id: string) => NodeIdentity,
    now: () => number, clean: (value: unknown) => void) {
    this.db = db; this.local = local; this.#privateKey = privateKey; this.peer = peer
    this.now = now; this.clean = clean
  }

  operations(): SignedConfigOperation[] {
    this.clean(null)
    return this.db.prepare('SELECT data FROM federation_operations ORDER BY origin,counter').all()
      .map((row) => { const op = signedConfigOperationSchema.parse(JSON.parse(row.data as string)); this.clean(op); return op })
  }
  state() { return configState(this.operations()) }
  stateHash() { return hash(this.state()) }
  private clock(): Hlc { return this.db.prepare('SELECT wall,logical FROM federation_clock WHERE id=1').get() as unknown as Hlc }
  private setClock(clock: Hlc) { this.db.prepare('UPDATE federation_clock SET wall=?,logical=? WHERE id=1').run(clock.wall, clock.logical) }
  private vector(): Record<string, number> {
    const seen: Record<string, number> = Object.create(null)
    for (const { operation: op } of this.operations()) {
      // Another account's administrator has no authority over our privilege
      // history or local counters, even on a shared installation.
      if (op.accountId !== this.local.accountId) continue
      // Only the unbroken, actually stored prefix is evidence of observation.
      // Neither a sparse dot nor an author's claimed context fills a gap.
      if (op.counter === (seen[op.origin] ?? 0) + 1) seen[op.origin] = op.counter
    }
    return seen
  }
  create(key: string, value: ConfigOperation['value']): SignedConfigOperation {
    this.clean(null)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const context = this.vector()
      const last = this.db.prepare('SELECT MAX(counter) AS counter FROM federation_operations WHERE origin=?').get(this.local.id)?.counter as number | null
      const ownCounter = last ?? 0
      if ((context[this.local.id] ?? 0) > ownCounter) throw new FederationError('local_history_missing')
      context[this.local.id] = ownCounter
      const clock = mergeClock(this.clock(), { wall: 0, logical: 0 }, this.now())
      if (clock.wall > this.now() + MAX_CLOCK_DRIFT_MS) throw new FederationError('clock_drift')
      const operation = configOperationSchema.parse({ origin: this.local.id, counter: ownCounter + 1,
        accountId: this.local.accountId, key, clock, context, value })
      const signed = { operation, signature: signValue(this.#privateKey, operation) }
      this.acceptWithin(signed)
      this.db.exec('COMMIT'); return signed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  ingest(operations: readonly SignedConfigOperation[]): { deferred: number } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let pending = [...operations]
      while (pending.length) {
        const deferred: SignedConfigOperation[] = []
        for (const op of pending) {
          try { this.acceptWithin(op) }
          catch (error) {
            if (!(error instanceof FederationError) || error.code !== 'context_missing') throw error
            deferred.push(op)
          }
        }
        if (deferred.length === pending.length) { pending = deferred; break }
        pending = deferred
      }
      this.db.exec('COMMIT'); return { deferred: pending.length }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private acceptWithin(input: SignedConfigOperation): void {
    const signed = signedConfigOperationSchema.parse(input)
    const op = signed.operation
    this.clean(signed)
    // Stored acceptance survives credential revocation. Otherwise every full
    // anti-entropy batch containing a revoked author's history would be wedged.
    // New or changed dots still require CURRENT author admission below.
    const existing = this.db.prepare('SELECT data FROM federation_operations WHERE origin=? AND counter=?').get(op.origin, op.counter)
    if (existing) {
      if (canonical(JSON.parse(existing.data as string)) !== canonical(signed)) throw new FederationError('operation_conflict')
      return
    }
    const author = this.peer(op.origin)
    if (author.accountId !== op.accountId || !author.scopes.includes('config')) throw new FederationError('forbidden', 403)
    if (['grant', 'membership', 'identity'].includes(op.value.kind) && !author.admin) throw new FederationError('admin_required', 403)
    if (op.value.kind === 'connection' && op.value.ownerAccountId !== op.accountId) throw new FederationError('owner_mismatch', 403)
    if (counterAt(op.context, op.origin) !== op.counter - 1) throw new FederationError('invalid_context')
    if (!validSignature(author.publicKey, op, signed.signature)) throw new FederationError('unauthenticated', 401)
    if (op.clock.wall > this.now() + MAX_CLOCK_DRIFT_MS) throw new FederationError('clock_drift')
    const stored = this.vector()
    if (Object.entries(op.context).some(([origin, counter]) => counter > counterAt(stored, origin))) {
      throw new FederationError('context_missing')
    }
    this.setClock(mergeClock(this.clock(), op.clock, this.now()))
    this.db.prepare('INSERT INTO federation_operations VALUES (?,?,?)').run(op.origin, op.counter, canonical(signed))
  }
}
