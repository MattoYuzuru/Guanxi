import { randomUUID } from 'node:crypto'
import { localInferenceJobSchema, remoteAttemptReceiptSchema, signedDispatchGrantSchema, signedDispatchEventSchema,
  type LocalInferenceJob, type RemoteAttemptOffer, type RemoteAttemptReceipt, type SignedDispatchGrant,
  type DispatchRef, type DispatchState, type SignedDispatchEvent, type DispatchEvent } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import type { CostInput, RunStore } from '../runs/store.ts'
import type { Attempt, HomeFence, Synchronous } from '../runs/types.ts'
import type { Connections } from '../connections/service.ts'
import type { FederationChannel } from '../federation/channel.ts'
import type { AttemptOffers } from './offers.ts'
import { canonical, hash, signValue, FederationError } from '../federation/crypto.ts'

export interface LocalModelAttestation {
  connectionId: string; model: string; placement: 'installed_local'; source: string; observedAt: number
}
export interface DispatchPolicy {
  ttlMs: number
  safetyMs: number
  maxModelAgeMs: number
  channel: (nodeId: string) => FederationChannel
  /** T0 host inventory/adapter attestation. Unknown and cloud placement must return null. */
  localModel?: (model: string) => LocalModelAttestation | null
  connections?: Connections
  leaseClock?: () => number
}
interface HomeRow { id: string; offer: string; job: string; attempt: string; grant: string | null }
interface Holder { grant: SignedDispatchGrant; controller: AbortController; deadline: number; wallDeadline: number;
  timer?: ReturnType<typeof setTimeout>; renewTimer?: ReturnType<typeof setTimeout>; refresh?: Promise<void> }
const ZERO = '0'.repeat(64)

/** Optional local inference protocol; all methods are host-owned, wire identity is checked by F1. */
export class AttemptDispatch {
  private authority: HomeFence | undefined
  private closed = false
  private readonly active = new Map<string, Holder>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly flushing = new Map<string, Promise<void>>()
  private readonly mono: () => number
  private highWater = 0
  private readonly db: Db
  private readonly runs: RunStore
  private readonly offers: AttemptOffers
  private readonly node: string
  private readonly accountId: string
  readonly #privateKey: string
  private readonly policy: DispatchPolicy
  private readonly clock: () => number
  constructor(db: Db, runs: RunStore, offers: AttemptOffers, node: string, accountId: string, privateKey: string, policy: DispatchPolicy, clock: () => number) {
    this.db = db; this.runs = runs; this.offers = offers; this.node = node; this.accountId = accountId; this.#privateKey = privateKey; this.policy = policy; this.clock = clock
    if (!Number.isSafeInteger(policy.maxModelAgeMs) || policy.maxModelAgeMs <= 0 || !Number.isSafeInteger(policy.ttlMs) || policy.ttlMs < 1 || !Number.isSafeInteger(policy.safetyMs) || policy.safetyMs < 1 || policy.safetyMs >= policy.ttlMs / 2) throw new FederationError('dispatch_policy')
    const wall = Date.now(), monotonic = performance.now()
    this.mono = policy.leaseClock ?? (() => Math.floor(wall + performance.now() - monotonic))
  }
  private time(): number {
    const now = this.mono()
    if (!Number.isSafeInteger(now) || now < this.highWater) throw new FederationError('dispatch_clock')
    this.highWater = now; return now
  }
  private ready(): void {
    if (this.closed) throw new FederationError('closed', 503)
    if (!this.authority) {
      this.offers.ensureReady()
      const authority = this.runs.homeFence()
      authority.transaction('dispatch.initialize', () => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS remote_dispatch_migrations(version INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS run_remote_bindings(run_id TEXT NOT NULL,attempt_id TEXT PRIMARY KEY,executor TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS remote_binding_run ON run_remote_bindings(run_id);
          CREATE TABLE IF NOT EXISTS remote_dispatch_home(id TEXT PRIMARY KEY,offer TEXT NOT NULL,job TEXT NOT NULL,attempt TEXT NOT NULL,grant TEXT);
          CREATE TABLE IF NOT EXISTS remote_dispatch_holders(id TEXT PRIMARY KEY,grant TEXT NOT NULL,status TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS remote_dispatch_events(id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,seq));
          CREATE TABLE IF NOT EXISTS remote_dispatch_receipts(id TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,seq));
          INSERT OR IGNORE INTO remote_dispatch_migrations VALUES (37);`)
        const versions = this.db.prepare('SELECT version FROM remote_dispatch_migrations').all()
        if (versions.length !== 1 || versions[0]!.version !== 37) throw new FederationError('dispatch_schema_version')
        this.db.prepare("UPDATE remote_dispatch_holders SET status='lost' WHERE status IN ('accepted','running')").run()
      })
      this.authority = authority
    }
    this.authority.assert()
  }
  private home(id: string): HomeRow {
    const row = this.db.prepare('SELECT * FROM remote_dispatch_home WHERE id=?').get(id) as unknown as HomeRow | undefined
    if (!row) throw new FederationError('dispatch_not_found', 404)
    return row
  }
  private actor<T>(row: HomeRow, body: (attempt: Attempt) => Synchronous<T>): T {
    const a = JSON.parse(row.attempt) as Attempt, offer = JSON.parse(row.offer) as RemoteAttemptOffer
    return this.runs.asRemoteExecutor(a, offer.executorNodeId, () => body(a))
  }
  /** The fresh token, binding, immutable job and offer intent commit together. */
  prepare(runId: string, executorNodeId: string, raw: LocalInferenceJob, reservationMs: number): RemoteAttemptOffer {
    this.ready()
    const job = localInferenceJobSchema.parse(raw)
    if (job.deadline <= this.clock() || !Number.isSafeInteger(reservationMs) || reservationMs <= 0) throw new FederationError('dispatch_deadline')
    return this.runs.startRemote(runId, executorNodeId, (a, db) => {
      if (job.deadline <= this.clock()) throw new FederationError('dispatch_deadline')
      const run = this.runs.get(runId), lease = db.prepare('SELECT expires_at FROM leases WHERE key=?').get(`run:${runId}/exec`)!
      const offer: RemoteAttemptOffer = { id: randomUUID(), runId, sessionId: run.session_id, homeNodeId: this.node, executorNodeId,
        fence: { attemptId: a.id, epoch: a.epoch, token: a.token }, mode: 'strict',
        expiresAt: Math.min(job.deadline, this.clock() + reservationMs, Number(lease.expires_at)),
        resource: { kind: 'local_inference', model: job.model, requestedContext: job.context } }
      db.prepare('INSERT INTO remote_home_offers VALUES (?,?)').run(offer.id, canonical(offer))
      db.prepare('INSERT INTO remote_dispatch_home VALUES (?,?,?,?,NULL)').run(offer.id, canonical(offer), canonical(job), canonical(a))
      return offer
    })
  }
  homeExecutor(id: string): string { this.ready(); return (JSON.parse(this.home(id).offer) as RemoteAttemptOffer).executorNodeId }
  grant(id: string, raw: RemoteAttemptReceipt): SignedDispatchGrant {
    this.ready()
    const row = this.home(id), offer = JSON.parse(row.offer) as RemoteAttemptOffer, receipt = remoteAttemptReceiptSchema.parse(raw)
    return this.actor(row, a => this.runs.mutate(a, db => {
      if (receipt.offerId !== id || receipt.status !== 'reserved' || !receipt.reservation || receipt.reservation.expiresAt <= this.clock() ||
        receipt.homeNodeId !== this.node || receipt.executorNodeId !== offer.executorNodeId || receipt.runId !== offer.runId || canonical(receipt.fence) !== canonical(offer.fence)) throw new FederationError('reservation_lost')
      const job = localInferenceJobSchema.parse(JSON.parse(row.job))
      if (job.deadline <= this.clock()) throw new FederationError('dispatch_deadline')
      const grant = { id, offer, reservationId: receipt.reservation.id, job, jobHash: hash(job), dispatchAuthorized: true as const }
      const signed = signedDispatchGrantSchema.parse({ grant, signature: signValue(this.#privateKey, grant) })
      if (row.grant && row.grant !== canonical(signed)) throw new FederationError('dispatch_conflict')
      db.prepare('UPDATE remote_dispatch_home SET grant=? WHERE id=?').run(canonical(signed), id)
      return signed
    }))
  }
  renew(ref: DispatchRef, validate: () => void): { id: string; ttlMs: number } {
    this.ready(); validate()
    const row = this.home(ref.id), offer = JSON.parse(row.offer) as RemoteAttemptOffer
    if (!row.grant || ref.homeNodeId !== this.node || ref.executorNodeId !== offer.executorNodeId) throw new FederationError('dispatch_binding')
    const job = localInferenceJobSchema.parse(JSON.parse(row.job))
    const ttl = Math.min(this.policy.ttlMs, job.deadline - this.clock())
    if (ttl <= this.policy.safetyMs * 2) throw new FederationError('dispatch_deadline')
    return this.actor(row, a => {
      const renewed = this.runs.renew(a, ttl, () => { validate(); if (job.deadline - this.clock() < ttl) throw new FederationError('dispatch_deadline') })
      return { id: ref.id, ttlMs: renewed.ttlMs }
    })
  }
  ingest(raw: SignedDispatchEvent, validate: () => void): void {
    this.ready(); validate()
    const signed = signedDispatchEventSchema.parse(raw), e = signed.entry, row = this.home(e.ref.id), offer = JSON.parse(row.offer) as RemoteAttemptOffer
    if (!row.grant || e.ref.homeNodeId !== this.node || e.ref.executorNodeId !== offer.executorNodeId || signed.hash !== hash(e)) throw new FederationError('dispatch_binding')
    const prior = this.authority!.transaction('dispatch.replay', () => {
      validate()
      return this.db.prepare('SELECT payload FROM remote_dispatch_receipts WHERE id=? AND seq=?').get(e.ref.id, e.seq)
    })
    if (prior) { if (prior.payload !== canonical(signed)) throw new FederationError('dispatch_conflict'); return }
    const record = (db: Db) => {
      validate()
      const job = localInferenceJobSchema.parse(JSON.parse(row.job))
      if (job.deadline <= this.clock()) throw new FederationError('dispatch_deadline')
      const previous = db.prepare('SELECT payload FROM remote_dispatch_receipts WHERE id=? ORDER BY seq DESC LIMIT 1').get(e.ref.id)
      const last = previous ? signedDispatchEventSchema.parse(JSON.parse(String(previous.payload))) : undefined
      if (e.seq !== (last?.entry.seq ?? 0) + 1 || e.previousHash !== (last?.hash ?? ZERO) || last?.entry.event.kind === 'terminal') throw new FederationError('dispatch_sequence')
      if (e.event.kind === 'started' && e.seq !== 1 || e.event.kind === 'terminal' && e.event.outcome === 'completed' && last?.entry.event.kind !== 'started') throw new FederationError('dispatch_sequence')
      db.prepare('INSERT INTO remote_dispatch_receipts VALUES (?,?,?)').run(e.ref.id, e.seq, canonical(signed))
    }
    this.actor(row, a => {
      if (e.event.kind === 'started') this.runs.modelStarted(a, record)
      else {
        const inputTokens = e.event.inputTokens, outputTokens = e.event.outputTokens
        const cost: CostInput | undefined = inputTokens !== null && outputTokens !== null &&
          Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
          ? { key: `remote-dispatch:${e.ref.id}`, inputTokens, outputTokens, costMicrounits: null, currency: 'unknown' }
          : undefined
        this.runs.complete(a, e.event.outcome, record, cost)
      }
    })
  }
  private ref(grant: SignedDispatchGrant): DispatchRef { return { id: grant.grant.id, homeNodeId: grant.grant.offer.homeNodeId, executorNodeId: this.node } }
  private setStatus(id: string, status: DispatchState['status']): void {
    this.authority!.transaction('dispatch.status', () => this.db.prepare('UPDATE remote_dispatch_holders SET status=? WHERE id=?').run(status, id))
  }
  state(id: string): DispatchState {
    this.ready()
    const row = this.db.prepare('SELECT status FROM remote_dispatch_holders WHERE id=?').get(id)
    if (!row) throw new FederationError('dispatch_not_found', 404)
    return { id, status: row.status as DispatchState['status'] }
  }
  private lose(h: Holder, status: 'lost' | 'canceled' = 'lost'): void {
    h.controller.abort(); clearTimeout(h.timer); clearTimeout(h.renewTimer)
    if (this.active.get(h.grant.grant.id) !== h) return
    try { this.setStatus(h.grant.grant.id, status) } catch { /* A deposed generation must still stop its external work. */ } finally { this.active.delete(h.grant.grant.id) }
  }
  private guard(h: Holder): void {
    this.ready(); h.controller.signal.throwIfAborted()
    if (this.active.get(h.grant.grant.id) !== h) throw new FederationError('dispatch_lost')
    if (this.time() >= h.deadline || this.clock() >= h.wallDeadline) { this.lose(h); throw new FederationError('dispatch_expired') }
  }
  private arm(h: Holder): void {
    clearTimeout(h.timer)
    const remaining = Math.min(h.deadline - this.time(), h.wallDeadline - this.clock())
    h.timer = setTimeout(() => { try { this.guard(h); this.arm(h) } catch { this.lose(h) } }, Math.max(1, Math.min(remaining, 2_147_483_647)))
    h.timer.unref()
  }
  private async untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    let remove = () => {}
    const canceled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new FederationError('dispatch_canceled'))
      signal.addEventListener('abort', abort, { once: true })
      remove = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
    })
    // Promise.race observes late success/rejection even when cancellation wins.
    try { return await Promise.race([pending, canceled]) } finally { remove() }
  }
  private refresh(h: Holder, validate: () => void): Promise<void> {
    if (h.refresh) return h.refresh
    const task = (async () => {
      this.guard(h); validate()
      const sent = this.time(), wallSent = this.clock()
      const renewed = await this.untilAbort(this.policy.channel(h.grant.grant.offer.homeNodeId).renewDispatch(this.ref(h.grant)), h.controller.signal)
      this.guard(h); validate()
      if (renewed.id !== h.grant.grant.id || renewed.ttlMs > this.policy.ttlMs) throw new FederationError('dispatch_renewal')
      const deadline = sent + renewed.ttlMs - this.policy.safetyMs, wallDeadline = Math.min(h.grant.grant.job.deadline, wallSent + renewed.ttlMs - this.policy.safetyMs)
      if (this.time() >= deadline || this.clock() >= wallDeadline) throw new FederationError('dispatch_expired')
      h.deadline = deadline; h.wallDeadline = wallDeadline; this.arm(h)
      clearTimeout(h.renewTimer)
      h.renewTimer = setTimeout(() => { void this.refresh(h, validate).catch(() => this.lose(h)) }, Math.max(1, Math.floor(renewed.ttlMs / 3)))
      h.renewTimer.unref()
    })()
    h.refresh = task
    void task.finally(() => { h.refresh = undefined }).catch(() => undefined)
    return task
  }
  private attestation(job: LocalInferenceJob): LocalModelAttestation {
    const attested = this.policy.localModel?.(job.model)
    if (!attested || attested.placement !== 'installed_local' || attested.model !== job.model || !attested.connectionId || !attested.source ||
      !Number.isSafeInteger(attested.observedAt) || attested.observedAt > this.clock() || this.clock() - attested.observedAt > this.policy.maxModelAgeMs || /:cloud$/i.test(job.model)) throw new FederationError('local_placement_required')
    return attested
  }
  async receive(raw: SignedDispatchGrant, validate: () => void): Promise<DispatchState> {
    this.ready(); validate()
    const signed = signedDispatchGrantSchema.parse(raw), g = signed.grant
    if (g.offer.executorNodeId !== this.node || g.id !== g.offer.id || g.jobHash !== hash(g.job) ||
      g.offer.resource.model !== g.job.model || g.offer.resource.requestedContext !== g.job.context || g.job.deadline <= this.clock()) throw new FederationError('dispatch_binding')
    this.attestation(g.job)
    if (!this.policy.connections) throw new FederationError('local_executor_unavailable')
    const old = this.db.prepare('SELECT grant FROM remote_dispatch_holders WHERE id=?').get(g.id)
    if (old) { if (old.grant !== canonical(signed)) throw new FederationError('dispatch_conflict'); return this.state(g.id) }
    const h: Holder = { grant: signed, controller: new AbortController(), deadline: this.time() + this.policy.ttlMs - this.policy.safetyMs,
      wallDeadline: Math.min(g.job.deadline, this.clock() + this.policy.ttlMs - this.policy.safetyMs) }
    // Persist consumption before any await/effect. A crash cannot reuse this reservation.
    this.offers.consume(g.offer.homeNodeId, g.offer.id, g.reservationId, () => {
      validate(); this.db.prepare("INSERT INTO remote_dispatch_holders VALUES (?,?,'accepted')").run(g.id, canonical(signed))
    })
    this.active.set(g.id, h); this.arm(h)
    const admission = this.refresh(h, validate)
    this.tasks.set(g.id, admission)
    try { await admission; this.guard(h); validate() }
    catch (error) { this.lose(h); throw error }
    finally { if (this.tasks.get(g.id) === admission) this.tasks.delete(g.id) }
    const task = this.work(h, validate)
    this.tasks.set(g.id, task)
    void task.finally(() => { if (this.tasks.get(g.id) === task) this.tasks.delete(g.id) }).catch(() => undefined)
    return this.state(g.id)
  }
  private emit(h: Holder, event: DispatchEvent['event']): void {
    this.authority!.transaction('dispatch.event', () => {
      const id = h.grant.grant.id, previous = this.db.prepare('SELECT payload FROM remote_dispatch_events WHERE id=? ORDER BY seq DESC LIMIT 1').get(id)
      const last = previous ? signedDispatchEventSchema.parse(JSON.parse(String(previous.payload))) : undefined
      if (last?.entry.event.kind === 'terminal') return
      const entry: DispatchEvent = { ref: this.ref(h.grant), seq: (last?.entry.seq ?? 0) + 1, previousHash: last?.hash ?? ZERO, observedAt: this.clock(), event }
      const signed = signedDispatchEventSchema.parse({ entry, hash: hash(entry), signature: signValue(this.#privateKey, entry) })
      this.db.prepare('INSERT INTO remote_dispatch_events VALUES (?,?,?,0)').run(id, entry.seq, canonical(signed))
    })
    void this.flush(h.grant.grant.id).catch(() => undefined)
  }
  private async work(h: Holder, validate: () => void): Promise<void> {
    const g = h.grant.grant
    try {
      const attested = this.attestation(g.job)
      const result = await this.policy.connections!.localChat(this.accountId, attested.connectionId,
        { model: g.job.model, messages: g.job.messages, think: false, options: { num_ctx: g.job.context, num_predict: g.job.outputTokens } }, {
          runId: g.offer.runId, requestId: g.id, background: true, signal: h.controller.signal,
          authorizeDispatch: async () => { this.guard(h); validate(); await this.refresh(h, validate); this.guard(h); validate() },
          onPrepared: () => { this.guard(h); validate(); if (this.attestation(g.job).connectionId !== attested.connectionId) throw new FederationError('local_placement_changed') },
          onStarted: () => { this.guard(h); validate(); this.setStatus(g.id, 'running'); this.emit(h, { kind: 'started' }) },
        })
      this.guard(h); validate()
      if (!result.done || result.message?.role !== 'assistant' || typeof result.message.content !== 'string') throw new FederationError('local_result_invalid')
      this.emit(h, { kind: 'terminal', outcome: 'completed', content: result.message?.content ?? '', inputTokens: result.prompt_eval_count ?? null,
        outputTokens: result.eval_count ?? null, source: 'ollama:/api/chat' })
      this.setStatus(g.id, 'completed')
    } catch {
      if (!this.closed) {
        const state = this.state(g.id).status
        this.emit(h, { kind: 'terminal', outcome: h.controller.signal.aborted ? 'canceled' : 'failed', content: '', inputTokens: null, outputTokens: null, source: 'ollama:/api/chat' })
        if (state !== 'lost' && state !== 'canceled') this.setStatus(g.id, h.controller.signal.aborted ? 'canceled' : 'failed')
      }
    } finally {
      clearTimeout(h.timer); clearTimeout(h.renewTimer); h.controller.abort(); this.active.delete(g.id)
    }
  }
  async flush(id: string): Promise<void> {
    this.ready()
    const pending = this.flushing.get(id)
    if (pending) return pending
    const task = (async () => {
      const row = this.db.prepare('SELECT grant FROM remote_dispatch_holders WHERE id=?').get(id)
      if (!row) throw new FederationError('dispatch_not_found', 404)
      const grant = signedDispatchGrantSchema.parse(JSON.parse(String(row.grant)))
      for (;;) {
        this.ready()
        const event = this.db.prepare('SELECT seq,payload FROM remote_dispatch_events WHERE id=? AND delivered=0 ORDER BY seq LIMIT 1').get(id)
        if (!event) return
        await this.policy.channel(grant.grant.offer.homeNodeId).dispatchEvent(signedDispatchEventSchema.parse(JSON.parse(String(event.payload))))
        this.ready()
        this.authority!.transaction('dispatch.delivered', () => this.db.prepare('UPDATE remote_dispatch_events SET delivered=1 WHERE id=? AND seq=?').run(id, Number(event.seq)))
      }
    })()
    this.flushing.set(id, task)
    try { await task } finally { this.flushing.delete(id) }
  }
  binding(id: string): DispatchRef {
    this.ready()
    const row = this.db.prepare('SELECT grant FROM remote_dispatch_holders WHERE id=?').get(id)
    if (!row) throw new FederationError('dispatch_not_found', 404)
    return this.ref(signedDispatchGrantSchema.parse(JSON.parse(String(row.grant))))
  }
  cancel(id: string): DispatchState {
    this.ready()
    const h = this.active.get(id)
    if (h) this.lose(h, 'canceled')
    return this.state(id)
  }
  async settled(id: string): Promise<void> {
    // Admission can be replaced by work while this observer is awaiting it.
    for (;;) {
      const task = this.tasks.get(id)
      if (!task) return
      await task.catch(() => undefined)
    }
  }
  close(): void {
    if (this.closed) return
    for (const h of this.active.values()) { try { this.lose(h) } catch { h.controller.abort() } }
    this.closed = true
  }
}
