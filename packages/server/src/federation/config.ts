import { configOperationSchema, signedConfigOperationSchema, type ConfigOperation, type Hlc, type NodeIdentity,
  type SignedConfigOperation } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import { compareLayouts } from '@guanxi/contract'
import { validateLayoutOperation } from '../layouts/operation.ts'
import { canonical, FederationError, hash, signValue, validSignature } from './crypto.ts'

export const MAX_CLOCK_DRIFT_MS = 60_000
export function compareConfigOperations(a: Pick<ConfigOperation, 'clock' | 'origin' | 'counter'>, b: Pick<ConfigOperation, 'clock' | 'origin' | 'counter'>): number {
  return a.clock.wall - b.clock.wall || a.clock.logical - b.clock.logical ||
    (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0) || a.counter - b.counter
}
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
    const sorted = [...all].sort((a, b) =>
      a.value.kind === 'layout' && b.value.kind === 'layout'
        ? compareLayouts(a.value.document, b.value.document) || compareConfigOperations(a, b)
        : compareConfigOperations(a, b))
    return [key, sorted.at(-1)!.value]
  }))
}
interface StoredHistory {
  vector: Record<string, number>
  sparse: Map<string, Set<number>>
}
interface PreparedOperation { signed: SignedConfigOperation; author: NodeIdentity }
function advance(history: StoredHistory, origin: string, counter: number): number {
  const before = counterAt(history.vector, origin)
  if (counter <= before) return before
  let sparse = history.sparse.get(origin)
  if (!sparse) { sparse = new Set(); history.sparse.set(origin, sparse) }
  sparse.add(counter)
  let prefix = before
  while (sparse.delete(prefix + 1)) prefix++
  if (prefix > before) history.vector[origin] = prefix
  return prefix
}
export class SharedConfig {
  private readonly db: Db
  private readonly local: NodeIdentity
  #privateKey: string
  private readonly peer: (id: string) => NodeIdentity
  private readonly now: () => number
  private readonly clean: (value: unknown) => void
  private readonly onAccepted: (operation: SignedConfigOperation) => void
  constructor(db: Db, local: NodeIdentity, privateKey: string, peer: (id: string) => NodeIdentity,
    now: () => number, clean: (value: unknown) => void,
    onAccepted: (operation: SignedConfigOperation) => void = () => undefined) {
    this.db = db; this.local = local; this.#privateKey = privateKey; this.peer = peer
    this.now = now; this.clean = clean; this.onAccepted = onAccepted
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
  private histories(): Map<string, StoredHistory> {
    // Read only counters/account ids once. Admission never reparses or re-scrubs
    // the stored log; signed payloads are scrubbed on export instead.
    const histories = new Map<string, StoredHistory>()
    for (const row of this.db.prepare(`SELECT origin,counter,
      json_extract(data,'$.operation.accountId') AS account FROM federation_operations ORDER BY origin,counter`).all()) {
      let history = histories.get(row.account as string)
      if (!history) { history = { vector: Object.create(null), sparse: new Map() }; histories.set(row.account as string, history) }
      advance(history, row.origin as string, row.counter as number)
    }
    return histories
  }
  private missing(signed: SignedConfigOperation, stored: Record<string, number>,
    eligible = new Map<string, boolean>()): [string, number][] {
    const op = signed.operation
    const admin = ['grant', 'membership', 'identity'].includes(op.value.kind)
    return Object.entries(op.context).filter(([origin, counter]) => {
      if (counter <= counterAt(stored, origin)) return false
      const key = canonical([op.accountId, admin, origin])
      let allowed = eligible.get(key)
      if (allowed === undefined) {
        try {
          const peer = this.peer(origin)
          allowed = peer.accountId === op.accountId && peer.scopes.includes('config') && (!admin || peer.admin)
        } catch (error) {
          if (!(error instanceof FederationError) || error.code !== 'unauthenticated') throw error
          allowed = false
        }
        eligible.set(key, allowed)
      }
      // Ineligible origins cannot author a relevant unseen revoke here. Their
      // missing history must not poison otherwise admissible fleet operations.
      return allowed
    })
  }
  create(key: string, value: ConfigOperation['value']): SignedConfigOperation {
    this.clean(null)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const history = this.histories().get(this.local.accountId) ?? { vector: Object.create(null), sparse: new Map() }
      const context = { ...history.vector }
      const last = this.db.prepare('SELECT MAX(counter) AS counter FROM federation_operations WHERE origin=?').get(this.local.id)?.counter as number | null
      const ownCounter = last ?? 0
      if ((context[this.local.id] ?? 0) > ownCounter) throw new FederationError('local_history_missing')
      context[this.local.id] = ownCounter
      const clock = mergeClock(this.clock(), { wall: 0, logical: 0 }, this.now())
      if (clock.wall > this.now() + MAX_CLOCK_DRIFT_MS) throw new FederationError('clock_drift')
      const operation = configOperationSchema.parse({ origin: this.local.id, counter: ownCounter + 1,
        accountId: this.local.accountId, key, clock, context, value })
      const signed = { operation, signature: signValue(this.#privateKey, operation) }
      const prepared = this.prepare(signed)!
      if (this.missing(signed, history.vector).length) throw new FederationError('context_missing')
      this.acceptWithin(prepared)
      this.db.exec('COMMIT'); return signed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  ingest(operations: readonly SignedConfigOperation[]) {
    this.clean(null)
    const result = { accepted: 0, duplicates: 0, deferred: 0, skipped: 0, reasons: {} as Record<string, number> }
    const histories = this.histories()
    const eligible = new Map<string, boolean>()
    type Entry = PreparedOperation & { remaining: number }
    // Register every missing dot once. Prefix advancement wakes each dependency
    // once, and only fully ready operations reach signature verification/SQLite.
    const waiting = new Map<string, Entry[]>()
    const ready: Entry[] = []
    let head = 0
    const dot = (account: string, origin: string, counter: number) => canonical([account, origin, counter])
    const skipped = (error: unknown) => {
      if (!(error instanceof FederationError) ||
        !['unauthenticated', 'forbidden', 'admin_required', 'clock_drift', 'content_withheld'].includes(error.code)) throw error
      result.skipped++; result.reasons[error.code] = (result.reasons[error.code] ?? 0) + 1
    }
    for (const input of operations) {
      let prepared: PreparedOperation | undefined
      try { prepared = this.prepare(input) } catch (error) { skipped(error); continue }
      if (!prepared) { result.duplicates++; continue }
      const op = prepared.signed.operation
      let history = histories.get(op.accountId)
      if (!history) { history = { vector: Object.create(null), sparse: new Map() }; histories.set(op.accountId, history) }
      const missing = this.missing(prepared.signed, history.vector, eligible)
      const entry: Entry = { ...prepared, remaining: missing.length }
      result.deferred++
      for (const [origin, counter] of missing) {
        const key = dot(op.accountId, origin, counter)
        const entries = waiting.get(key) ?? []
        entries.push(entry); waiting.set(key, entries)
      }
      if (!entry.remaining) ready.push(entry)
      while (head < ready.length) {
        const current = ready[head++]!
        const accepted = current.signed.operation
        const stored = histories.get(accepted.accountId)!
        result.deferred--
        this.db.exec('BEGIN IMMEDIATE')
        try {
          // A duplicate dot may have been waiting alongside this one.
          const status = this.existing(current.signed) ? 'duplicates' : this.acceptWithin(current)
          this.db.exec('COMMIT'); result[status]++
        } catch (error) { this.db.exec('ROLLBACK'); skipped(error); continue }
        const before = counterAt(stored.vector, accepted.origin)
        const prefix = advance(stored, accepted.origin, accepted.counter)
        for (let counter = before + 1; counter <= prefix; counter++) {
          const key = dot(accepted.accountId, accepted.origin, counter)
          for (const dependent of waiting.get(key) ?? []) if (--dependent.remaining === 0) ready.push(dependent)
          waiting.delete(key)
        }
      }
    }
    return result
  }
  private existing(signed: SignedConfigOperation): boolean {
    const op = signed.operation
    const existing = this.db.prepare('SELECT data FROM federation_operations WHERE origin=? AND counter=?').get(op.origin, op.counter)
    if (!existing) return false
    if (canonical(JSON.parse(existing.data as string)) !== canonical(signed)) throw new FederationError('operation_conflict')
    return true
  }
  private prepare(input: SignedConfigOperation): PreparedOperation | undefined {
    const signed = signedConfigOperationSchema.parse(input)
    const op = signed.operation
    validateLayoutOperation(op)
    this.clean(signed)
    // Stored acceptance survives credential revocation. Otherwise every full
    // anti-entropy batch containing a revoked author's history would be wedged.
    // New or changed dots still require CURRENT author admission below.
    if (this.existing(signed)) return undefined
    const author = this.peer(op.origin)
    if (author.accountId !== op.accountId || !author.scopes.includes('config')) throw new FederationError('forbidden', 403)
    if (['grant', 'membership', 'identity'].includes(op.value.kind) && !author.admin) throw new FederationError('admin_required', 403)
    if (op.value.kind === 'connection' && op.value.ownerAccountId !== op.accountId) throw new FederationError('owner_mismatch', 403)
    if (counterAt(op.context, op.origin) !== op.counter - 1) throw new FederationError('invalid_context')
    if (op.clock.wall > this.now() + MAX_CLOCK_DRIFT_MS) throw new FederationError('clock_drift')
    return { signed, author }
  }
  private acceptWithin({ signed, author }: PreparedOperation): 'accepted' {
    const op = signed.operation
    if (!validSignature(author.publicKey, op, signed.signature)) throw new FederationError('unauthenticated', 401)
    this.setClock(mergeClock(this.clock(), op.clock, this.now()))
    this.db.prepare('INSERT INTO federation_operations VALUES (?,?,?)').run(op.origin, op.counter, canonical(signed))
    this.onAccepted(signed)
    return 'accepted'
  }
}
