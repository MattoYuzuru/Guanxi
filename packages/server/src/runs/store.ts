/** R1's single-node execution home. No model/process is held by a sleeping run. */
import { createHash, randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import type { NativeRunBudget, SessionEventType, SessionEventData } from '@guanxi/contract'
import { routedCommandSchema, type RoutedCommand } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import type { SessionLog, SessionEventInput, AppendOptions, AppendResult } from '../session-log/log.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { RunError, TERMINAL_RUN_STATES, type Attempt, type HomeAuthority, type HomeFence, type PromiseRecord, type Run, type RunState,
  type Synchronous, type TerminalRunState, type Wake } from './types.ts'

interface Lease { key: string; epoch: number; token: number; holder: string; expires_at: number; released: number; regrant_after: number }
export interface RunStoreOptions {
  db: Db
  log: SessionLog
  scrubber: EgressScrubber
  /** Explicit host assertion; a laptop must hand over in F2 before enabling delegation. */
  alwaysOn?: boolean
  /** Wall time for durable deadlines and observations, clamped against clock rollback. */
  clock?: () => number
  /** Monotonic elapsed time, anchored to wall time for persisted lease bounds. */
  leaseClock?: () => number
  ownerTtlMs?: number
  maxAttemptTtlMs?: number
  /** Every store statement and transaction boundary; tests also inject K2 append points. */
  fault?: (operation: string, point: string) => void
}
export interface DelegateInput {
  key: string
  deadline: number
  deadlinePolicy?: 'cancel_wrap_up' | 'detach'
  cancelPolicy?: 'cancel' | 'detach'
}
export interface CostInput {
  key: string
  inputTokens: number
  outputTokens: number
  costMicrounits: number | null
  currency: 'USD' | 'EUR' | 'RUB' | 'unknown'
}
type Action = SessionEventData<'run.lifecycle'>['action']
const HOME_KEY = 'durable-runs/home'
const EPSILON_MS = 1_000

export class RunStore implements HomeAuthority {
  private readonly db: Db
  private readonly log: SessionLog
  private readonly scrubber: EgressScrubber
  private readonly ownerId = randomUUID()
  private owner: Lease | null = null
  private predecessor: { token: number; holder: string; observedBound: number; activeExpiry: number; bound: number } | null = null
  private readonly ownerTtl: number
  private readonly maxTtl: number
  private readonly clock: () => number
  private renewAt = 0
  private highWater = 0
  private leaseHighWater = 0
  private readonly leaseClock: () => number
  private closed = false
  private operation = ''
  private readonly changedSessions = new Set<string>()
  private readonly startupNativeRuns = new Set<string>()
  private readonly startupAttempts = new Set<string>()
  private readonly runFailures = new Map<string, { runId: string; operation: string; code: string }>()
  failures() {
    for (const [key, failure] of this.runFailures) {
      const pending = failure.operation === 'timers'
        ? this.row("SELECT 1 FROM timers t JOIN promises p ON p.id=t.promise_id WHERE p.parent_id=? AND t.state='pending'", failure.runId)
        : failure.operation === 'wake'
          ? this.row('SELECT 1 FROM outbox WHERE run_id=? AND acknowledged_at IS NULL AND suppressed_at IS NULL', failure.runId)
          : this.row("SELECT 1 FROM run_attempts WHERE run_id=? AND state IN ('delivered','started')", failure.runId)
      if (!pending) this.runFailures.delete(key)
    }
    return [...this.runFailures.values()].map((failure) => ({ ...failure }))
  }
  private isolate(runId: string, operation: string, body: () => void): void {
    const key = `${operation}:${runId}`
    try { body(); this.runFailures.delete(key) } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'storage_error'
      if (['closed', 'egress_not_ready'].includes(code)) throw error
      if (code === 'stale_lease' || code === 'writer_busy') this.assertOwner()
      this.runFailures.set(key, { runId, operation, code })
    }
  }
  private readonly options: RunStoreOptions
  /** The host's explicit always-on assertion; `delegate` refuses `no_always_on_home` without it. */
  get alwaysOnHome(): boolean { return this.options.alwaysOn === true }

  constructor(options: RunStoreOptions) {
    this.options = options
    this.db = options.db
    this.log = options.log
    this.scrubber = options.scrubber
    const wallReference = Date.now()
    const monotonicReference = performance.now()
    this.clock = options.clock ?? Date.now
    this.leaseClock = options.leaseClock ?? options.clock ?? (() => Math.floor(wallReference + performance.now() - monotonicReference))
    this.ownerTtl = options.ownerTtlMs ?? 30_000
    this.maxTtl = options.maxAttemptTtlMs ?? 60_000
    this.integer(this.ownerTtl, 1)
    this.integer(this.maxTtl, 1)
  }

  /** Called by the pump; construction never prevents the rest of the node booting. */
  private claimHome(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.row<Lease>('SELECT * FROM leases WHERE key = ?', HOME_KEY)
      const now = this.leaseNow()
      const activeExpiry = this.row<{ expiry: number | null }>("SELECT MAX(expires_at) AS expiry FROM leases WHERE key LIKE 'run:%/exec' AND released=0")?.expiry ?? 0
      if (prior && !prior.released) {
        // Migration 31 persists the predecessor's configured maximum as this
        // relative interval. A smaller successor limit only affects new grants.
        const recoveryMaxTtl = Math.max(this.maxTtl, prior.regrant_after - prior.expires_at - EPSILON_MS)
        const persistedBound = Math.max(prior.regrant_after, prior.expires_at + recoveryMaxTtl + EPSILON_MS, activeExpiry + EPSILON_MS)
        // Fix the cap on first observation, rather than moving it on every retry.
        // Wall-clock corrections in a predecessor cannot prevent boot indefinitely.
        if (this.predecessor?.token !== prior.token || this.predecessor.holder !== prior.holder ||
          this.predecessor.observedBound !== persistedBound || this.predecessor.activeExpiry !== activeExpiry) {
          this.predecessor = { token: prior.token, holder: prior.holder, observedBound: persistedBound, activeExpiry,
            bound: Math.max(now + recoveryMaxTtl + EPSILON_MS,
              Math.min(persistedBound, now + this.ownerTtl + recoveryMaxTtl + EPSILON_MS)) }
        }
        if (now < this.predecessor.bound) throw new RunError('writer_busy')
      }
      const token = (prior?.token ?? 0) + 1
      this.db.prepare(`INSERT INTO leases (key,epoch,token,holder,expires_at,released,regrant_after) VALUES (?,1,?,?,?,0,?)
        ON CONFLICT(key) DO UPDATE SET token=excluded.token,holder=excluded.holder,
        expires_at=excluded.expires_at,released=0,regrant_after=excluded.regrant_after`).run(HOME_KEY, token, this.ownerId,
        now + this.ownerTtl, now + this.ownerTtl + this.maxTtl + EPSILON_MS)
      const owner = this.row<Lease>('SELECT * FROM leases WHERE key = ?', HOME_KEY)!
      const inheritedNative = this.rows<{ id: string }>('SELECT r.id FROM durable_runs r JOIN native_sessions n ON n.session_id=r.session_id')
      const inherited = this.rows<{ id: string }>("SELECT id FROM run_attempts WHERE state IN ('delivered','started')")
      this.db.exec('COMMIT')
      this.owner = owner
      this.renewAt = now + this.ownerTtl / 3
      for (const run of inheritedNative) this.startupNativeRuns.add(run.id)
      for (const attempt of inherited) this.startupAttempts.add(attempt.id)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private now(): number {
    // Durable timers include suspend on platforms whose monotonic clock excludes it.
    const time = this.clock()
    this.integer(time, 0)
    this.highWater = Math.max(this.highWater, time)
    return this.highWater
  }
  private leaseNow(): number {
    const time = this.leaseClock()
    this.integer(time, 0)
    this.leaseHighWater = Math.max(this.leaseHighWater, time)
    return this.leaseHighWater
  }
  private integer(value: number, min = 0): void {
    if (!Number.isSafeInteger(value) || value < min) throw new RunError('invalid_input')
  }
  private clean(value: string): void {
    if (this.closed) throw new RunError('closed')
    if (typeof value !== 'string' || !value.length || value.length > 200 || this.scrubber.scrub(value) !== value) {
      throw new RunError('invalid_input')
    }
  }
  private row<T>(sql: string, ...args: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as unknown as T | undefined
  }
  private rows<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args).map((row) => ({ ...row })) as unknown as T[]
  }
  private write(sql: string, ...args: SQLInputValue[]): void {
    if (JSON.stringify(this.scrubber.scrub(args)) !== JSON.stringify(args)) throw new RunError('invalid_input')
    this.db.prepare(sql).run(...args)
    this.point('statement')
  }
  private point(point: string): void { this.options.fault?.(this.operation, point) }
  private assertOwner(): void {
    if (this.closed) throw new RunError('closed')
    if (!this.owner) throw new RunError('writer_busy')
    const lease = this.row<Lease>('SELECT * FROM leases WHERE key = ?', HOME_KEY)
    if (!lease || lease.holder !== this.ownerId || lease.token !== this.owner.token ||
      lease.released) throw new RunError('stale_lease')
  }
  private tx<T>(operation: string, body: () => T, requiresReady = true): T {
    if (this.closed) throw new RunError('closed')
    this.operation = operation
    this.changedSessions.clear()
    this.point('before_begin')
    this.db.exec('BEGIN IMMEDIATE')
    let result: T
    let renewed = false
    try {
      this.point('begin')
      this.assertOwner()
      if (requiresReady && !this.scrubber.isReady()) throw new RunError('egress_not_ready')
      if (this.leaseNow() >= this.renewAt) {
        this.write('UPDATE leases SET expires_at=?,regrant_after=? WHERE key=?', this.leaseNow() + this.ownerTtl,
          this.leaseNow() + this.ownerTtl + this.maxTtl + EPSILON_MS, HOME_KEY)
        renewed = true
      }
      result = body()
      this.point('before_commit')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.changedSessions.clear()
      throw error
    }
    if (renewed) this.renewAt = this.leaseNow() + this.ownerTtl / 3
    this.point('committed')
    this.log.notify(this.changedSessions)
    this.changedSessions.clear()
    return result
  }
  private event(run: Run, action: Action, relatedId: string | null = null, wakeSeq: number | null = null): void {
    this.log.appendFromHomeWithin(run.session_id, { kind: 'agent' }, {
      type: 'run.lifecycle', data: { runId: run.id, state: run.state, version: run.version, action, relatedId, wakeSeq, ...(this.executionReason(run.id) ? { reason: this.executionReason(run.id)! } : {}) },
    })
    this.changedSessions.add(run.session_id)
    this.point('trace')
  }
  private setState(runId: string, state: RunState, action: Action, relatedId: string | null = null): Run {
    this.write('UPDATE durable_runs SET state=?,version=version+1,updated_at=? WHERE id=?', state, this.now(), runId)
    const run = this.get(runId)
    this.event(run, action, relatedId)
    return run
  }
  get(runId: string): Run {
    if (this.closed) throw new RunError('closed')
    const run = this.row<Run>('SELECT * FROM durable_runs WHERE id=?', runId)
    if (!run) throw new RunError('run_not_found')
    return run
  }
  attempts(runId: string): Attempt[] { return this.rows('SELECT * FROM run_attempts WHERE run_id=? ORDER BY ordinal', runId) }
  promises(runId: string): PromiseRecord[] { return this.rows('SELECT * FROM promises WHERE parent_id=? ORDER BY id', runId) }
  wakes(runId: string): Wake[] { return this.rows('SELECT * FROM outbox WHERE run_id=? ORDER BY wake_seq', runId) }

  create(input: { id?: string; sessionId?: string } = {}): Run {
    const id = input.id ?? randomUUID()
    const sessionId = input.sessionId ?? id
    this.clean(id); this.clean(sessionId)
    return this.tx('create', () => {
      const existing = this.row<Run>('SELECT * FROM durable_runs WHERE id=?', id)
      if (existing) {
        if (existing.session_id !== sessionId || existing.parent_id) throw new RunError('idempotency_conflict')
        return existing
      }
      // K2 creates the session inside this same transaction before the run FK is inserted.
      const run: Run = { id, session_id: sessionId, parent_id: null, state: 'submitted', version: 1,
        wake_seq: 0, cancel_count: 0, created_at: this.now(), updated_at: this.now() }
      this.event(run, 'created')
      this.insertRun(run)
      return run
    })
  }
  private insertRun(run: Run): void {
    this.write(`INSERT INTO durable_runs (id,session_id,parent_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      run.id, run.session_id, run.parent_id, run.state, run.created_at, run.updated_at)
  }
  /** T0 start extension: session, run, first attempt and host metadata commit together.
   * The host captures and rechecks its home generation inside the synchronous callback. */
  createStarted<T>(input: { id: string; sessionId: string }, initialize: (attempt: Attempt, db: Db,
    emit: (event: import('../session-log/log.ts').SessionEventInput) => void) => Synchronous<T>): T {
    this.clean(input.id); this.clean(input.sessionId)
    return this.tx('create_started', () => {
      if (this.row('SELECT id FROM durable_runs WHERE id=?', input.id)) throw new RunError('idempotency_conflict')
      const run: Run = { id: input.id, session_id: input.sessionId, parent_id: null, state: 'submitted', version: 1,
        wake_seq: 0, cancel_count: 0, created_at: this.now(), updated_at: this.now() }
      this.event(run, 'created'); this.insertRun(run)
      const attempt = this.newAttempt(run.id, null)
      const result = initialize(attempt, this.db, event => {
        this.log.appendFromHomeWithin(run.session_id, { kind: 'agent' }, event); this.changedSessions.add(run.session_id)
      })
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined)
        throw new RunError('invalid_input')
      }
      return result
    })
  }
  private grant(key: string, holder: string, ttl: number): Lease {
    const old = this.row<Lease>('SELECT * FROM leases WHERE key=?', key)
    if (old && !old.released && old.expires_at > this.leaseNow()) throw new RunError('stale_lease')
    this.write(`INSERT INTO leases (key,epoch,token,holder,expires_at,released) VALUES (?,1,?,?,?,0) ON CONFLICT(key) DO UPDATE SET
      token=excluded.token,holder=excluded.holder,expires_at=excluded.expires_at,released=0`,
    key, (old?.token ?? 0) + 1, holder, this.leaseNow() + ttl)
    return this.row<Lease>('SELECT * FROM leases WHERE key=?', key)!
  }
  private release(runId: string): void {
    this.write('UPDATE leases SET released=1 WHERE key=?', `run:${runId}/exec`)
  }
  private syncResult(result: unknown): void {
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      // Reject the async boundary and observe late rejection; external effects cannot be undone.
      void Promise.resolve(result).catch(() => undefined)
      throw new RunError('invalid_input')
    }
  }
  private syncCallback<T>(body: ((db: Db) => Synchronous<T>) | undefined): void { this.syncResult(body?.(this.db)) }
  private remoteActor: { attemptId: string; executor: string } | undefined
  /** T0-only synchronous actor scope; the caller must derive executor from authenticated identity. */
  asRemoteExecutor<T>(attempt: Attempt, executor: string, body: () => Synchronous<T>): T {
    const previous = this.remoteActor
    this.remoteActor = { attemptId: attempt.id, executor }
    try {
      const result = body()
      this.syncResult(result)
      return result
    } finally { this.remoteActor = previous }
  }
  private fenced(attempt: Attempt): Attempt {
    const stored = this.row<Attempt>('SELECT * FROM run_attempts WHERE id=?', attempt.id)
    const lease = this.row<Lease>('SELECT * FROM leases WHERE key=?', `run:${attempt.run_id}/exec`)
    if (this.startupAttempts.has(attempt.id) || !stored || stored.run_id !== attempt.run_id || stored.epoch !== attempt.epoch || stored.token !== attempt.token ||
      !['delivered', 'started'].includes(stored.state) || !lease || lease.holder !== attempt.id ||
      lease.epoch !== attempt.epoch || lease.token !== attempt.token || lease.released || lease.expires_at <= this.leaseNow()) {
      throw new RunError('stale_lease')
    }
    // Optional dispatch metadata must remain effective even if the feature is disabled later.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_remote_bindings'").get()) {
      const binding = this.db.prepare('SELECT executor FROM run_remote_bindings WHERE attempt_id=?').get(attempt.id)
      if (binding && (this.remoteActor?.attemptId !== attempt.id || this.remoteActor.executor !== binding.executor)) throw new RunError('stale_lease')
    }
    return stored
  }
  private newAttempt(runId: string, wakeSeq: number | null): Attempt {
    if (this.attempts(runId).some((a) => ['delivered', 'started'].includes(a.state))) throw new RunError('invalid_transition')
    const id = randomUUID()
    const lease = this.grant(`run:${runId}/exec`, id, this.maxTtl)
    const ordinal = (this.row<{ n: number }>('SELECT MAX(ordinal) AS n FROM run_attempts WHERE run_id=?', runId)?.n ?? 0) + 1
    this.write(`INSERT INTO run_attempts (id,run_id,ordinal,wake_seq,state,epoch,token) VALUES (?,?,?,?,'delivered',?,?)`,
      id, runId, ordinal, wakeSeq, lease.epoch, lease.token)
    this.setState(runId, this.get(runId).state === 'wrapping_up' ? 'wrapping_up' : 'working', 'attempt', id)
    return this.row<Attempt>('SELECT * FROM run_attempts WHERE id=?', id)!
  }
  /** Trusted in-process executor extension. Never expose callbacks over the wire.
   * The home and execution fence, extension rows and K2 trace share one transaction. */
  mutate<T>(attempt: Attempt, body: (db: Db, emit: (event: import('../session-log/log.ts').SessionEventInput) => void) => T): T {
    return this.tx('executor', () => {
      this.fenced(attempt)
      const result = body(this.db, event => {
        const run = this.get(attempt.run_id)
        this.log.appendFromHomeWithin(run.session_id, { kind: 'agent' }, event)
        this.changedSessions.add(run.session_id)
        this.point('trace')
      })
      if (result instanceof Promise) throw new RunError('invalid_input')
      return result
    })
  }
  /** Explicit retry only. Unsafe steps are never replayed by reconciliation. */
  start(runId: string): Attempt {
    return this.tx('start', () => {
      const run = this.get(runId)
      if (!['submitted', 'interrupted', 'wrapping_up'].includes(run.state)) throw new RunError('invalid_transition')
      return this.newAttempt(runId, null)
    })
  }
  /** Fresh remote attempts are bound in the same transaction before their fence is exposed. */
  startRemote<T>(runId: string, executor: string, initialize: (attempt: Attempt, db: Db) => Synchronous<T>): T {
    return this.tx('start_remote', () => {
      if (!this.options.alwaysOn) throw new RunError('no_always_on_home')
      const run = this.get(runId)
      if (!executor || !['submitted', 'interrupted', 'wrapping_up'].includes(run.state)) throw new RunError('invalid_transition')
      const attempt = this.newAttempt(runId, null)
      this.db.prepare('INSERT INTO run_remote_bindings VALUES (?,?,?)').run(runId, attempt.id, executor)
      const result = initialize(attempt, this.db)
      this.syncResult(result)
      return result
    })
  }
  renew<T>(attempt: Attempt, ttl = this.maxTtl, validate?: (db: Db) => Synchronous<T>): { ttlMs: number; expiresAt: number } {
    this.integer(ttl, 1)
    if (ttl > this.maxTtl) throw new RunError('invalid_input')
    return this.tx('renew', () => {
      this.fenced(attempt)
      this.syncCallback(validate)
      const expiresAt = this.leaseNow() + ttl
      this.write('UPDATE leases SET expires_at=? WHERE key=?', expiresAt, `run:${attempt.run_id}/exec`)
      return { ttlMs: ttl, expiresAt }
    })
  }
  /** Called by an executor only after observing its first model call start. */
  modelStarted<T>(attempt: Attempt, receipt?: (db: Db) => Synchronous<T>): void {
    this.tx('model_started', () => {
      const current = this.fenced(attempt)
      this.syncCallback(receipt)
      if (current.first_model_at !== null) return
      this.write("UPDATE run_attempts SET state='started',first_model_at=? WHERE id=?", this.now(), attempt.id)
      this.event(this.get(attempt.run_id), 'model_started', attempt.id, current.wake_seq)
      if (current.wake_seq !== null) {
        this.write(`UPDATE outbox SET acknowledged_at=? WHERE run_id=? AND wake_seq=? AND acknowledged_at IS NULL
          AND suppressed_at IS NULL AND attempt_id=?`, this.now(), attempt.run_id, current.wake_seq, attempt.id)
        this.event(this.get(attempt.run_id), 'acknowledged', attempt.id, current.wake_seq)
      }
    })
  }
  /** The executor's trace and R1 fence commit in the same SQLite transaction. */
  append<T extends SessionEventType>(attempt: Attempt, input: SessionEventInput<T>, options: AppendOptions & { expectedSeq: number }): AppendResult {
    return this.tx('executor_append', () => {
      this.fenced(attempt)
      const run = this.get(attempt.run_id)
      const result = this.log.appendFromHomeWithin(run.session_id, { kind: 'agent' }, input, options)
      this.changedSessions.add(run.session_id)
      return result
    })
  }
  configureExecution(attempt: Attempt, policy: NativeRunBudget): void {
    this.tx('execution_policy', () => {
      this.fenced(attempt)
      this.write('INSERT INTO run_execution(run_id,policy,started_at) VALUES (?,?,?)', attempt.run_id, JSON.stringify(policy), this.now())
    })
  }
  executionReason(runId: string): string | null {
    return this.row<{ terminal_reason: string | null }>('SELECT terminal_reason FROM run_execution WHERE run_id=?', runId)?.terminal_reason ?? null
  }
  /** Checked before model calls, tool effects and periodically while a call is pending. */
  checkExecution(attempt: Attempt, modelCall = false): 'working' | 'wrapping_up' {
    const result = this.tx('execution_check', () => {
      this.fenced(attempt)
      const run = this.get(attempt.run_id)
      const row = this.row<{ policy: string; calls: number; report_calls: number; started_at: number; report_started_at: number | null }>(
        'SELECT * FROM run_execution WHERE run_id=?', run.id)
      if (!row) throw new RunError('invalid_transition')
      const policy = JSON.parse(row.policy) as NativeRunBudget
      const reporting = run.state === 'wrapping_up'
      let reason: 'report_budget_exhausted' | 'budget_exhausted' | null = null
      if (reporting) {
        if (row.report_started_at === null) this.write('UPDATE run_execution SET report_started_at=? WHERE run_id=?', this.now(), run.id)
        if (this.now() - (row.report_started_at ?? this.now()) >= policy.reportMaxDurationMs ||
          (modelCall && row.report_calls >= policy.reportMaxCalls)) reason = 'report_budget_exhausted'
      } else {
        const costs = this.costs(run.id)
        const tokens = costs.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0)
        const money = costs.reduce((n, c) => n + (c.costMicrounits ?? 0), 0)
        if ((modelCall && policy.maxModelCalls !== undefined && row.calls >= policy.maxModelCalls) ||
          (policy.maxTokens !== undefined && tokens >= policy.maxTokens) ||
          (policy.maxCostMicrounits !== undefined && (money >= policy.maxCostMicrounits || costs.some(c => c.costMicrounits === null || c.currency !== 'USD'))) ||
          (policy.maxDurationMs !== undefined && this.now() - row.started_at >= policy.maxDurationMs)) reason = 'budget_exhausted'
      }
      if (reason) {
        this.write('UPDATE run_execution SET terminal_reason=? WHERE run_id=?', reason, run.id)
        this.terminal(run.id, 'canceled')
        return { reason, reporting }
      }
      if (modelCall) this.write(`UPDATE run_execution SET ${reporting ? 'report_calls=report_calls+1' : 'calls=calls+1'} WHERE run_id=?`, run.id)
      return { reason, reporting }
    })
    if (result.reason) throw new RunError(result.reason)
    return result.reporting ? 'wrapping_up' : 'working'
  }
  stopExecution(attempt: Attempt, reason: 'quota_exhausted'): void {
    this.tx('execution_stop', () => {
      this.fenced(attempt)
      this.signalQuotaWithin(attempt)
      this.write('UPDATE run_execution SET terminal_reason=? WHERE run_id=?', reason, attempt.run_id)
      this.terminal(attempt.run_id, 'canceled')
    })
  }
  private signalQuotaWithin(attempt: Attempt): void {
    const promise = this.row<PromiseRecord>('SELECT * FROM promises WHERE child_id=?', attempt.run_id)
    if (promise && !promise.detached && promise.outcome === null) this.wake(promise.parent_id, 'quota', attempt.id)
  }
  delegate(attempt: Attempt, input: DelegateInput): PromiseRecord {
    this.clean(input.key); this.integer(input.deadline)
    const deadlinePolicy = input.deadlinePolicy ?? 'cancel_wrap_up'
    const cancelPolicy = input.cancelPolicy ?? 'cancel'
    if (!['cancel_wrap_up', 'detach'].includes(deadlinePolicy) || !['cancel', 'detach'].includes(cancelPolicy)) {
      throw new RunError('invalid_input')
    }
    return this.tx('hibernate', () => {
      const prior = this.row<PromiseRecord>('SELECT * FROM promises WHERE parent_id=? AND delegation_key=?', attempt.run_id, input.key)
      if (prior) {
        const timer = this.row<{ due_at: number }>('SELECT due_at FROM timers WHERE promise_id=?', prior.id)!
        if (timer.due_at !== input.deadline || prior.deadline_policy !== deadlinePolicy || prior.cancel_policy !== cancelPolicy) {
          throw new RunError('idempotency_conflict')
        }
        return prior
      }
      this.fenced(attempt)
      if (!this.options.alwaysOn) throw new RunError('no_always_on_home')
      const parent = this.get(attempt.run_id)
      if (parent.state !== 'working') throw new RunError('invalid_transition')
      const child: Run = { ...parent, id: randomUUID(), parent_id: parent.id, state: 'submitted', version: 1,
        wake_seq: 0, cancel_count: 0, created_at: this.now(), updated_at: this.now() }
      this.insertRun(child)
      this.event(child, 'created')
      const promiseId = randomUUID()
      this.write(`INSERT INTO promises (id,parent_id,child_id,delegation_key,deadline_policy,cancel_policy) VALUES (?,?,?,?,?,?)`,
        promiseId, parent.id, child.id, input.key, deadlinePolicy, cancelPolicy)
      this.write("INSERT INTO timers VALUES (?,?,'pending')", promiseId, input.deadline)
      this.sleepWithin(attempt)
      this.setState(parent.id, 'waiting_children', 'delegated', child.id)
      return this.row<PromiseRecord>('SELECT * FROM promises WHERE id=?', promiseId)!
    })
  }
  private sleepWithin(attempt: Attempt): void {
    this.write("UPDATE run_attempts SET state='sleeping' WHERE id=?", attempt.id)
    this.release(attempt.run_id)
  }
  /** A lead woken by a signal may sleep again while its child is still pending. */
  hibernate(attempt: Attempt): void {
    this.tx('hibernate', () => {
      this.fenced(attempt)
      const pendingPromise = this.promises(attempt.run_id).some((p) => p.outcome === null && !p.detached)
      const pendingWake = this.wakes(attempt.run_id).some((w) => w.acknowledged_at === null && w.suppressed_at === null)
      if (!pendingPromise && !pendingWake) throw new RunError('invalid_transition')
      this.sleepWithin(attempt)
      this.setState(attempt.run_id, pendingPromise ? 'waiting_children' : 'submitted', 'yielded')
    })
  }
  private wake(runId: string, kind: Wake['kind'], source: string): void {
    if (TERMINAL_RUN_STATES.has(this.get(runId).state)) return
    if (this.row('SELECT 1 FROM outbox WHERE run_id=? AND kind=? AND source_key=?', runId, kind, source)) return
    this.write('UPDATE durable_runs SET wake_seq=wake_seq+1 WHERE id=?', runId)
    const run = this.get(runId)
    this.write('INSERT INTO outbox (run_id,wake_seq,kind,source_key) VALUES (?,?,?,?)', runId, run.wake_seq, kind, source)
    this.event(run, 'wake', source, run.wake_seq)
  }
  private resolve(promise: PromiseRecord, outcome: TerminalRunState | 'deadline'): boolean {
    if (promise.outcome !== null || promise.detached) return false
    this.write('UPDATE promises SET outcome=?,resolved_at=? WHERE id=? AND outcome IS NULL', outcome, this.now(), promise.id)
    this.write("UPDATE timers SET state=? WHERE promise_id=? AND state='pending'", outcome === 'deadline' ? 'fired' : 'canceled', promise.id)
    this.event(this.get(promise.parent_id), 'resolved', promise.id)
    this.wake(promise.parent_id, 'resolution', promise.id)
    return true
  }
  complete<T>(attempt: Attempt, outcome: TerminalRunState, receipt?: (db: Db) => Synchronous<T>, cost?: CostInput): void {
    if (!TERMINAL_RUN_STATES.has(outcome)) throw new RunError('invalid_input')
    if (cost) this.validateCostInput(cost)
    this.tx('complete', () => {
      this.fenced(attempt)
      if (outcome !== 'canceled' && this.wakes(attempt.run_id).some((w) => w.acknowledged_at === null && w.suppressed_at === null)) {
        throw new RunError('invalid_transition')
      }
      const deadline = this.row<PromiseRecord>("SELECT * FROM promises WHERE child_id=? AND outcome='deadline' AND deadline_policy='cancel_wrap_up'", attempt.run_id)
      const reporting = deadline || this.get(attempt.run_id).state === 'wrapping_up'
      if (reporting) this.write("UPDATE run_execution SET terminal_reason=COALESCE(terminal_reason,'wrap_up_requested') WHERE run_id=?", attempt.run_id)
      this.syncCallback(receipt)
      if (cost) this.insertCost(attempt, cost)
      this.terminal(attempt.run_id, reporting ? 'canceled' : outcome)
    })
  }
  private terminal(runId: string, state: TerminalRunState): void {
    const run = this.get(runId)
    if (TERMINAL_RUN_STATES.has(run.state)) return
    this.write("UPDATE run_attempts SET state=? WHERE run_id=? AND state IN ('delivered','started')",
      state === 'canceled' ? 'canceled' : 'completed', runId)
    this.release(runId)
    if (state === 'canceled') this.write('UPDATE durable_runs SET cancel_count=1 WHERE id=?', runId)
    this.setState(runId, state, state === 'canceled' ? 'canceled' : 'terminal')
    this.write('UPDATE outbox SET suppressed_at=? WHERE run_id=? AND acknowledged_at IS NULL AND suppressed_at IS NULL', this.now(), runId)
    const parentPromise = this.row<PromiseRecord>('SELECT * FROM promises WHERE child_id=?', runId)
    if (parentPromise) this.resolve(parentPromise, state)
    for (const child of this.promises(runId)) {
      if (child.detached || TERMINAL_RUN_STATES.has(this.get(child.child_id).state)) continue
      if (child.cancel_policy === 'detach') this.detach(child)
      else this.terminal(child.child_id, 'canceled')
    }
  }
  cancel(runId: string): void { this.tx('cancel', () => this.terminal(runId, 'canceled')) }
  /** F1: compare and apply at the home in the SAME transaction as the receipt.
   * A queued prompt is durable input; this method never starts a model. */
  applyFederatedCommand(input: RoutedCommand, previous: () => string | undefined,
    record: (result: string) => void): string {
    const command = routedCommandSchema.parse(input)
    return this.tx('federation_command', () => {
      const prior = previous()
      if (prior !== undefined) return prior
      const run = this.get(command.runId)
      if (run.session_id !== command.sessionId) throw new RunError('invalid_input')
      let result: string
      if (command.expiresAt <= this.now()) result = 'expired'
      else if (command.stateVersion !== run.version) result = 'stale_version'
      else if (TERMINAL_RUN_STATES.has(run.state)) result = 'invalid_state'
      else if (command.action.kind === 'stop') { this.terminal(run.id, 'canceled'); result = 'applied' }
      else if (command.action.kind === 'decide') {
        if (run.state !== 'input_required') result = 'invalid_state'
        else { this.newAttempt(run.id, null); result = 'applied' }
      } else {
        // Prompt content is not an identifier. The contract and egress gate
        // validate it without imposing the identifier helper's 200-char cap.
        if (this.scrubber.scrub(command.action.text) !== command.action.text) throw new RunError('invalid_input')
        this.log.appendFromHomeWithin(run.session_id, { kind: 'agent' }, { type: 'prompt',
          data: { origin: 'remote', messageId: command.id, text: command.action.text, attachmentCount: 0 } })
        this.setState(run.id, run.state, 'signal', command.id)
        result = 'applied'
      }
      record(result)
      return result
    })
  }
  private detach(promise: PromiseRecord): void {
    this.write('UPDATE promises SET detached=1 WHERE id=?', promise.id)
    this.write("UPDATE timers SET state='canceled' WHERE promise_id=? AND state='pending'", promise.id)
  }
  signal(attempt: Attempt, key: string, kind: 'escalation' | 'quota' = 'escalation'): void {
    this.clean(key)
    if (!['escalation', 'quota'].includes(kind)) throw new RunError('invalid_input')
    this.tx('signal', () => {
      this.fenced(attempt)
      const promise = this.row<PromiseRecord>('SELECT * FROM promises WHERE child_id=?', attempt.run_id)
      if (!promise || promise.detached || promise.outcome !== null) return
      const source = createHash('sha256').update(JSON.stringify([attempt.run_id, key])).digest('hex')
      if (this.row('SELECT 1 FROM outbox WHERE run_id=? AND kind=? AND source_key=?', promise.parent_id, kind, source)) return
      this.event(this.get(attempt.run_id), 'signal', key)
      this.wake(promise.parent_id, kind, source)
    })
  }
  inputRequired(attempt: Attempt): void {
    this.tx('input_required', () => {
      this.fenced(attempt)
      this.sleepWithin(attempt)
      this.setState(attempt.run_id, 'input_required', 'input_required')
      const promise = this.row<PromiseRecord>('SELECT * FROM promises WHERE child_id=?', attempt.run_id)
      if (promise && !promise.detached && promise.outcome === null) this.wake(promise.parent_id, 'escalation', attempt.id)
    })
  }
  /** The caller supplied the required decision; never resume inference at restart. */
  decide(runId: string): Attempt {
    return this.tx('decide', () => {
      if (this.get(runId).state !== 'input_required') throw new RunError('invalid_transition')
      return this.newAttempt(runId, null)
    })
  }
  wrappingUp(attempt: Attempt): void {
    this.tx('wrapping_up', () => { this.fenced(attempt); this.setState(attempt.run_id, 'wrapping_up', 'wrapping_up') })
  }
  heartbeat(): void {
    if (this.closed) throw new RunError('closed')
    if (!this.owner) this.claimHome()
    else if (this.leaseNow() >= this.renewAt) this.tx('heartbeat', () => {}, false)
    else this.assertOwner()
  }
  /** Trusted in-process host extension: bind later metadata work to this home generation.
   * Callers assert before each asynchronous phase and use `transaction` for the final
   * synchronous mutation; a deposed generation can never commit it. */
  homeFence(): HomeFence {
    this.heartbeat()
    const owner = this.owner
    if (!owner) throw new RunError('writer_busy')
    const token = owner.token
    const assert = (): void => {
      if (this.closed) throw new RunError('closed')
      const lease = this.row<Lease>('SELECT * FROM leases WHERE key = ?', HOME_KEY)
      if (!lease || lease.released || lease.holder !== this.ownerId || lease.token !== token) throw new RunError('stale_lease')
    }
    return {
      assert,
      transaction: <T>(operation: string, body: (db: Db) => Synchronous<T>): T => this.tx(operation, () => {
        assert()
        const result = body(this.db) as T
        // Mirror mutate(): a callback that hands back a Promise would commit before await.
        if (result instanceof Promise) throw new RunError('invalid_input')
        return result
      }),
    }
  }
  private lose(attempt: Attempt): void {
    this.write("UPDATE run_attempts SET state='lost' WHERE id=?", attempt.id)
    this.release(attempt.run_id)
    if (this.get(attempt.run_id).state === 'working') this.setState(attempt.run_id, 'interrupted', 'interrupted', attempt.id)
  }
  tick(): void {
    for (const attempt of this.rows<Attempt>(`SELECT a.* FROM run_attempts a JOIN leases l
        ON l.key='run:'||a.run_id||'/exec' WHERE a.state IN ('delivered','started') AND l.expires_at<=?`, this.leaseNow())) {
      this.isolate(attempt.run_id, 'expiry', () => this.tx('expiry', () => this.lose(attempt)))
    }
    for (const timer of this.rows<{ promise_id: string }>("SELECT promise_id FROM timers WHERE state='pending' AND due_at<=? ORDER BY due_at,promise_id", this.now())) {
      const promise = this.row<PromiseRecord>('SELECT * FROM promises WHERE id=?', timer.promise_id)!
      this.isolate(promise.parent_id, 'timers', () => this.tx('timers', () => {
        if (!this.resolve(promise, 'deadline')) return
        if (promise.deadline_policy === 'detach') this.detach(promise)
        else {
          // Durable report request. The executor may finish its report under the existing
          // fence, or an explicit report-only attempt can start after reconciliation.
          if (!TERMINAL_RUN_STATES.has(this.get(promise.child_id).state)) {
            this.setState(promise.child_id, 'wrapping_up', 'wrapping_up', promise.id)
          }
        }
      }))
    }
  }
  /** Retry returns the same live delivery. An unacknowledged lost delivery gets a new attempt. */
  deliver(runId: string, wakeSeq: number): Attempt | null {
    this.integer(wakeSeq, 1)
    return this.tx('wake', () => {
      const wake = this.row<Wake>('SELECT * FROM outbox WHERE run_id=? AND wake_seq=?', runId, wakeSeq)
      if (this.get(runId).state === 'input_required') return null
      if (!wake || wake.acknowledged_at !== null || wake.suppressed_at !== null || TERMINAL_RUN_STATES.has(this.get(runId).state)) return null
      if (wake.attempt_id) {
        const attempt = this.row<Attempt>('SELECT * FROM run_attempts WHERE id=?', wake.attempt_id)!
        if (['delivered', 'started'].includes(attempt.state)) {
          if (this.startupAttempts.has(attempt.id)) return null
          this.fenced(attempt)
          return attempt
        }
      }
      const active = this.attempts(runId).some((a) => ['delivered', 'started'].includes(a.state))
      if (active) return null // Later wake stays durable until the current handler yields.
      const attempt = this.newAttempt(runId, wakeSeq)
      this.write('UPDATE outbox SET attempt_id=?,deliveries=deliveries+1 WHERE run_id=? AND wake_seq=?', attempt.id, runId, wakeSeq)
      return attempt
    })
  }
  /** A synchronous executor claim is required before allocating a delivery attempt. */
  dispatch(claim?: (wake: Readonly<Wake>) => boolean): Attempt[] {
    if (!claim) return []
    const deliveries: Attempt[] = []
    for (const wake of this.rows<Wake>('SELECT * FROM outbox WHERE acknowledged_at IS NULL AND suppressed_at IS NULL ORDER BY run_id,wake_seq')) {
      this.isolate(wake.run_id, 'wake', () => {
        if (!claim(wake)) return
        const attempt = this.deliver(wake.run_id, wake.wake_seq)
        if (attempt) deliveries.push(attempt)
      })
    }
    return deliveries
  }
  /** ADR-0019 table, local only: no inference is started by this operation. */
  reconcile(): void {
    this.reconcileAttempts(true)
    // A native turn never replays work or a report after restart. The user must decide.
    for (const id of this.startupNativeRuns) {
      if (!this.row('SELECT 1 FROM durable_runs WHERE id=?', id)) { this.startupNativeRuns.delete(id); continue }
      this.isolate(id, 'reconcile', () => this.tx('native_reconcile', () => {
        const run = this.get(id)
        if (!TERMINAL_RUN_STATES.has(run.state) && run.state !== 'input_required') {
          if (this.attempts(id).some(a => ['delivered','started'].includes(a.state))) throw new RunError('invalid_transition')
          this.setState(id, 'input_required', 'input_required')
        }
      }))
      if (!this.runFailures.has(`reconcile:${id}`)) this.startupNativeRuns.delete(id)
    }
  }
  private reconcileAttempts(startupOnly: boolean): void {
    for (const attempt of this.rows<Attempt>("SELECT * FROM run_attempts WHERE state IN ('delivered','started')")) {
        // Readiness may open after this activation has admitted new work. Only
        // attempts inherited from its predecessor are lost during startup recovery.
        if (startupOnly && !this.startupAttempts.has(attempt.id)) continue
      this.isolate(attempt.run_id, 'reconcile', () => this.tx('reconcile', () => {
        this.lose(attempt)
        // waiting_children/input_required untouched; wrapping_up remains a report request.
      }))
    }
    this.tick()
  }
  retain(attempt: Attempt, input: { key: string; kind: 'worktree' | 'scratch'; retainUntil: number }): void {
    this.clean(input.key); this.integer(input.retainUntil)
    if (!['worktree', 'scratch'].includes(input.kind)) throw new RunError('invalid_input')
    this.tx('retain', () => {
      this.fenced(attempt)
      const key = `resource:${input.key}`
      if (this.row('SELECT 1 FROM run_resources WHERE key=?', key)) throw new RunError('idempotency_conflict')
      this.grant(key, attempt.run_id, this.maxTtl)
      this.write('INSERT INTO run_resources (key,run_id,kind,retain_until) VALUES (?,?,?,?)', key, attempt.run_id, input.kind, input.retainUntil)
      this.event(this.get(attempt.run_id), 'resource')
    })
  }
  /** Resource owners delete only these released resources, never nonterminal run resources. */
  reapResources(): string[] {
    return this.tx('reap', () => {
      const keys: string[] = []
      for (const resource of this.rows<{ key: string; run_id: string; retain_until: number }>('SELECT * FROM run_resources WHERE released_at IS NULL')) {
        if (!TERMINAL_RUN_STATES.has(this.get(resource.run_id).state) || resource.retain_until > this.now()) continue
        this.write('UPDATE run_resources SET released_at=? WHERE key=?', this.now(), resource.key)
        this.write('UPDATE leases SET released=1 WHERE key=?', resource.key)
        keys.push(resource.key)
      }
      return keys
    })
  }
  private validateCostInput(input: CostInput): void {
    this.clean(input.key); this.integer(input.inputTokens); this.integer(input.outputTokens)
    if (input.costMicrounits !== null) this.integer(input.costMicrounits)
    if (!['USD', 'EUR', 'RUB', 'unknown'].includes(input.currency)) throw new RunError('invalid_input')
  }
  /** Caller holds the transaction and has already checked the attempt fence. */
  private insertCost(attempt: Attempt, input: CostInput): void {
    const prior = this.row<{ attempt_id: string; input_tokens: number; output_tokens: number; cost_microunits: number | null; currency: string }>(
      'SELECT * FROM run_costs WHERE run_id=? AND entry_key=?', attempt.run_id, input.key)
    if (prior) {
      if (prior.attempt_id !== attempt.id || prior.input_tokens !== input.inputTokens || prior.output_tokens !== input.outputTokens ||
        prior.cost_microunits !== input.costMicrounits || prior.currency !== input.currency) throw new RunError('idempotency_conflict')
      return
    }
    this.write('INSERT INTO run_costs VALUES (?,?,?,?,?,?,?,?)', attempt.run_id, input.key, attempt.id,
      input.inputTokens, input.outputTokens, input.costMicrounits, input.currency, this.now())
    this.event(this.get(attempt.run_id), 'cost', attempt.id)
  }
  recordCost(attempt: Attempt, input: CostInput): void {
    this.validateCostInput(input)
    this.tx('cost', () => {
      this.fenced(attempt)
      this.insertCost(attempt, input)
    })
  }
  costs(runId: string): { currency: string; inputTokens: number; outputTokens: number; costMicrounits: number | null }[] {
    return this.rows(`SELECT currency,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
      CASE WHEN COUNT(cost_microunits)=COUNT(*) THEN SUM(cost_microunits) ELSE NULL END AS costMicrounits
      FROM run_costs WHERE run_id=? GROUP BY currency`, runId)
  }
  /** Read-only view of the idempotent cost observations, for consumers that derive a baseline from the ledger. */
  costEntries(runId: string): { key: string; attemptId: string; inputTokens: number; outputTokens: number; costMicrounits: number | null; currency: string }[] {
    return this.rows(`SELECT entry_key AS key, attempt_id AS attemptId, input_tokens AS inputTokens, output_tokens AS outputTokens,
      cost_microunits AS costMicrounits, currency FROM run_costs WHERE run_id=? ORDER BY entry_key`, runId)
  }
  close(): void {
    if (this.closed) return
    try {
      if (this.owner) this.db.prepare('UPDATE leases SET released=1 WHERE key=? AND holder=? AND token=?').run(HOME_KEY, this.ownerId, this.owner.token)
    } finally { this.closed = true }
  }
}
