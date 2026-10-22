import { randomUUID } from 'node:crypto'
import { remoteAttemptOfferSchema, remoteAttemptReceiptSchema, type RemoteAttemptOffer, type RemoteAttemptReceipt } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import type { RunStore } from '../runs/store.ts'
import type { Attempt, HomeFence, Synchronous } from '../runs/types.ts'
import type { ResourceGovernor, ResourceLease } from '../runtime/resource-governor.ts'
import { canonical, hash, FederationError } from '../federation/crypto.ts'

export interface OfferPolicy { maxReservationMs: number; leaseClock?: () => number }
type Status = RemoteAttemptReceipt['status']
interface Row { home: string; id: string; run_id: string; epoch: number; token: number; digest: string; payload: string; receipt: string }
interface Active { controller: AbortController; deadline: number; wallDeadline: number; lease?: ResourceLease; timer?: ReturnType<typeof setTimeout>; promise: Promise<RemoteAttemptReceipt>; final?: RemoteAttemptReceipt }

/** No dispatch method exists here. A reservation is process-local admission, never a run lease. */
export class AttemptOffers {
  private authority: HomeFence | undefined
  private readonly active = new Map<string, Active>()
  private readonly leaseClock: () => number
  private highWater = 0
  private closed = false
  private readonly db: Db
  private readonly runs: RunStore
  private readonly nodeId: string
  private readonly governor: ResourceGovernor
  private readonly policy: OfferPolicy
  private readonly clock: () => number
  constructor(db: Db, runs: RunStore, nodeId: string, governor: ResourceGovernor, policy: OfferPolicy, clock: () => number) {
    this.db = db; this.runs = runs; this.nodeId = nodeId; this.governor = governor; this.policy = policy; this.clock = clock
    if (!Number.isSafeInteger(policy.maxReservationMs) || policy.maxReservationMs <= 0) throw new FederationError('invalid_offer_policy')
    const reference = Date.now(), monotonic = performance.now()
    this.leaseClock = policy.leaseClock ?? (() => Math.floor(reference + performance.now() - monotonic))
  }
  private initialize(): void {
    if (this.authority) return
    const authority = this.runs.homeFence(), db = this.db
    authority.transaction('offers.initialize', () => {
      db.exec(`CREATE TABLE IF NOT EXISTS remote_attempt_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS remote_home_offers(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_target_offers(home TEXT NOT NULL,id TEXT NOT NULL,run_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,token INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(home,id));
        CREATE TABLE IF NOT EXISTS remote_target_fences(home TEXT NOT NULL,run_id TEXT NOT NULL,epoch INTEGER NOT NULL,token INTEGER NOT NULL,PRIMARY KEY(home,run_id));
        CREATE INDEX IF NOT EXISTS remote_target_offer_state ON remote_target_offers(home,run_id,json_extract(receipt,'$.status'));
        INSERT OR IGNORE INTO remote_attempt_migrations VALUES (36);`)
      const versions = db.prepare('SELECT version FROM remote_attempt_migrations').all()
      if (versions.length !== 1 || versions[0]!.version !== 36) throw new FederationError('offer_schema_version')
      for (const row of this.rows()) {
        const receipt = this.decode(row)
        if (receipt.status === 'queued' || receipt.status === 'reserved') this.write(row, { ...receipt, status: 'restart_lost' })
      }
    })
    this.authority = authority
  }
  ensureReady(): void { this.ready() }
  private ready(): void { if (this.closed) throw new FederationError('closed', 503); this.initialize(); this.authority!.assert() }
  private time(): number {
    const now = this.leaseClock()
    if (!Number.isSafeInteger(now) || now < 0) throw new FederationError('offer_clock')
    this.highWater = Math.max(this.highWater, now); return this.highWater
  }
  private key(home: string, id: string): string { return canonical([home, id]) }
  private rows(): Row[] { return this.db.prepare('SELECT * FROM remote_target_offers').all() as unknown as Row[] }
  private row(home: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM remote_target_offers WHERE home=? AND id=?').get(home, id) as unknown as Row | undefined
  }
  private decode(row: Row): RemoteAttemptReceipt { return remoteAttemptReceiptSchema.parse(JSON.parse(row.receipt)) }
  private write(row: Pick<Row, 'home' | 'id'>, receipt: RemoteAttemptReceipt): void {
    this.db.prepare('UPDATE remote_target_offers SET receipt=? WHERE home=? AND id=?').run(canonical(receipt), row.home, row.id)
  }
  private release(home: string, id: string): void {
    const active = this.active.get(this.key(home, id))
    if (!active) return
    clearTimeout(active.timer); active.controller.abort(); active.lease?.release()
    this.active.delete(this.key(home, id))
  }
  private setStatus(home: string, id: string, status: Status): void {
    try { this.authority!.transaction('offers.status', () => {
      const row = this.row(home, id)
      if (row) {
        const receipt = { ...this.decode(row), status }
        this.write(row, receipt)
        const active = this.active.get(this.key(home, id))
        if (active) active.final = receipt
      }
    }) } finally { this.release(home, id) }
  }
  create(a: Attempt, input: { id: string; executorNodeId: string; expiresAt: number; resource: RemoteAttemptOffer['resource'] }): RemoteAttemptOffer {
    this.ready()
    return this.runs.mutate(a, (db, emit) => {
      const lease = db.prepare('SELECT expires_at FROM leases WHERE key=?').get(`run:${a.run_id}/exec`)!
      if (input.expiresAt <= this.clock() || input.expiresAt > Number(lease.expires_at)) throw new FederationError('offer_expiry')
      const run = this.runs.get(a.run_id)
      const offer = remoteAttemptOfferSchema.parse({ ...input, runId: run.id, sessionId: run.session_id, homeNodeId: this.nodeId,
        fence: { attemptId: a.id, epoch: a.epoch, token: a.token }, mode: 'strict' })
      const prior = db.prepare('SELECT payload FROM remote_home_offers WHERE id=?').get(offer.id)
      if (prior) {
        if (prior.payload !== canonical(offer)) throw new FederationError('offer_conflict')
        return offer
      }
      db.prepare('INSERT INTO remote_home_offers VALUES (?,?)').run(offer.id, canonical(offer))
      emit({ type: 'agent.note', data: { text: canonical({ remoteOffer: offer.id, executor: offer.executorNodeId }) } })
      return offer
    })
  }
  async receive(raw: RemoteAttemptOffer, validate: () => void): Promise<RemoteAttemptReceipt> {
    this.ready(); validate()
    const offer = remoteAttemptOfferSchema.parse(raw), key = this.key(offer.homeNodeId, offer.id)
    this.reap()
    const existing = this.row(offer.homeNodeId, offer.id)
    if (existing) {
      if (existing.digest !== hash(offer)) throw new FederationError('offer_conflict')
      return this.active.get(key)?.promise ?? this.read(offer.homeNodeId, offer.id)
    }
    const receipt: RemoteAttemptReceipt = { offerId: offer.id, runId: offer.runId, homeNodeId: offer.homeNodeId,
      executorNodeId: this.nodeId, fence: offer.fence, status: 'queued', dispatchAuthorized: false, reservation: null }
    let duration = 0
    let obsolete: Row[] = []
    this.authority!.transaction('offers.queued', () => {
      validate()
      duration = Math.min(this.policy.maxReservationMs, offer.expiresAt - this.clock())
      if (duration <= 0) throw new FederationError('offer_expiry')
      const watermark = this.db.prepare('SELECT epoch,token FROM remote_target_fences WHERE home=? AND run_id=?').get(offer.homeNodeId, offer.runId) as { epoch: number; token: number } | undefined
      if (watermark && (offer.fence.epoch < watermark.epoch || offer.fence.epoch === watermark.epoch && offer.fence.token < watermark.token)) throw new FederationError('stale_lease')
      this.db.prepare(`INSERT INTO remote_target_fences VALUES (?,?,?,?) ON CONFLICT(home,run_id) DO UPDATE SET epoch=excluded.epoch,token=excluded.token`)
        .run(offer.homeNodeId, offer.runId, offer.fence.epoch, offer.fence.token)
      obsolete = this.db.prepare(`SELECT * FROM remote_target_offers WHERE home=? AND run_id=?
        AND json_extract(receipt,'$.status') IN ('queued','reserved') AND (epoch<? OR (epoch=? AND token<?))`)
        .all(offer.homeNodeId, offer.runId, offer.fence.epoch, offer.fence.epoch, offer.fence.token) as unknown as Row[]
      for (const row of obsolete) {
        const old = this.decode(row)
        if (old.status === 'queued' || old.status === 'reserved') this.write(row, { ...old, status: 'fenced' })
      }
      this.db.prepare('INSERT INTO remote_target_offers VALUES (?,?,?,?,?,?,?,?)')
        .run(offer.homeNodeId, offer.id, offer.runId, offer.fence.epoch, offer.fence.token, hash(offer), canonical(offer), canonical(receipt))
    })
    for (const row of obsolete) this.release(row.home, row.id)
    const active: Active = { controller: new AbortController(), deadline: this.time() + duration,
      wallDeadline: Math.min(offer.expiresAt, this.clock() + duration), promise: undefined! }
    this.active.set(key, active)
    const arm = () => {
      const remaining = Math.min(active.deadline - this.time(), active.wallDeadline - this.clock())
      if (remaining <= 0) { try { this.setStatus(offer.homeNodeId, offer.id, 'expired') } catch { this.release(offer.homeNodeId, offer.id) }; return }
      active.timer = setTimeout(arm, Math.min(remaining, 2_147_483_647)); active.timer.unref()
    }
    arm()
    active.promise = this.admit(offer, active, validate)
    return active.promise
  }
  private async admit(offer: RemoteAttemptOffer, active: Active, validate: () => void): Promise<RemoteAttemptReceipt> {
    try {
      active.controller.signal.throwIfAborted()
      const ticket = this.governor.enqueue({ owner: { kind: 'operation', operationId: this.key(offer.homeNodeId, offer.id) }, operation: 'chat',
        model: { provider: 'ollama', name: offer.resource.model }, requestedContext: offer.resource.requestedContext,
        priority: 'normal', enqueuedAt: new Date(this.clock()).toISOString() })
      active.lease = await this.governor.acquire(ticket, { signal: active.controller.signal })
      this.ready(); active.controller.signal.throwIfAborted()
      this.authority!.transaction('offers.reserved', () => {
        validate()
        if (this.time() >= active.deadline || active.wallDeadline <= this.clock()) throw new FederationError('offer_expiry')
        const row = this.row(offer.homeNodeId, offer.id)!, current = this.decode(row)
        if (current.status !== 'queued') throw new FederationError('offer_not_queued')
        const observedAt = this.clock()
        this.write(row, { ...current, status: 'reserved', reservation: { id: randomUUID(), ticketId: active.lease!.ticketId,
          expiresAt: Math.min(active.wallDeadline, observedAt + active.deadline - this.time()), source: 'target-governor', observedAt,
          confidence: 'observed', scope: 'application_process' } })
      })
    } catch (error) {
      this.release(offer.homeNodeId, offer.id)
      // A queue predecessor can release after shutdown already removed our map entry,
      // but before this acquire continuation receives the now-active governor lease.
      active.lease?.release()
      if (this.closed) {
        if (active.final) return active.final
        throw new FederationError('closed', 503)
      }
      this.authority!.transaction('offers.refused', () => {
        const row = this.row(offer.homeNodeId, offer.id)!, current = this.decode(row)
        if (current.status === 'queued') this.write(row, { ...current, status: error instanceof FederationError && error.code === 'offer_expiry' ? 'expired' : 'refused' })
      })
    }
    return this.decode(this.row(offer.homeNodeId, offer.id)!)
  }
  read(home: string, id: string): RemoteAttemptReceipt {
    this.ready(); this.reap()
    const row = this.row(home, id)
    if (!row) throw new FederationError('offer_not_found', 404)
    if (['queued', 'reserved'].includes(this.decode(row).status) && !this.active.has(this.key(home, id))) {
      this.setStatus(home, id, 'restart_lost')
      return this.decode(this.row(home, id)!)
    }
    return this.decode(row)
  }
  cancel(home: string, id: string): RemoteAttemptReceipt {
    this.ready()
    const row = this.row(home, id)
    if (!row) throw new FederationError('offer_not_found', 404)
    if (['queued', 'reserved'].includes(this.decode(row).status)) this.setStatus(home, id, 'canceled')
    return this.read(home, id)
  }
  /** Consume exactly one live reservation atomically with new dispatch metadata. */
  consume<T>(home: string, id: string, reservationId: string, body: () => Synchronous<T>): T {
    this.ready(); this.reap()
    const result = this.authority!.transaction('offers.consume', () => {
      const row = this.row(home, id)
      if (!row) throw new FederationError('offer_not_found', 404)
      const receipt = this.decode(row), active = this.active.get(this.key(home, id))
      if (!active?.lease || receipt.status !== 'reserved' || receipt.reservation?.id !== reservationId ||
        this.time() >= active.deadline || this.clock() >= active.wallDeadline) throw new FederationError('reservation_lost')
      this.write(row, { ...receipt, status: 'fenced' })
      return body()
    })
    this.release(home, id)
    return result
  }
  reap(): void {
    this.ready()
    for (const [key, active] of this.active) if (this.time() >= active.deadline || this.clock() >= active.wallDeadline) {
      const [home, id] = JSON.parse(key) as [string, string]
      this.setStatus(home, id, 'expired')
    }
  }
  close(): void {
    if (this.closed) return
    for (const [key] of this.active) {
      const [home, id] = JSON.parse(key) as [string, string]
      try { this.setStatus(home, id, 'restart_lost') } catch { this.release(home, id) }
    }
    this.closed = true
  }
}
