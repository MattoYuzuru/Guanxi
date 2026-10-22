import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { sep } from 'node:path'
import { relayStartInputSchema, relayStartStatusSchema, relayReservesSchema,
  type RelayStartInput, type RelayStartStatus } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { RunStore } from '../runs/store.ts'
import type { Attempt } from '../runs/types.ts'
import type { SessionLog, SessionHandle } from '../session-log/log.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { Connections } from '../connections/service.ts'
import type { OllamaChatRequest } from '../ollama/types.ts'
import { type SandboxPolicy } from '../native-agent/sandbox.ts'
import { assertRootsClean } from '../native-agent/cleanup.ts'
import { GitRelayWorkspace } from './workspace.ts'
import { ConnectionRelayModel } from './model.ts'
import { RelayExecutor } from './executor.ts'
import { RelayStore } from './store.ts'
import { RelayRuntimeSource, abortableRead } from './runtime.ts'
import { canonical, hash } from './handoff.ts'
import { DEFAULT_RELAY_LIMITS, invariant, RelayError, type Reserves, type RelayLimits } from './types.ts'

export interface RelayProjectObservation { projectId: string; roots: string[]; source: string; observedAt: number }
export interface RelayStartPolicy {
  input: RelayStartInput; project: RelayProjectObservation; reserves: Reserves; nodePorts: number[]
}
/** A T0 allocator owns cleanup even when it receives an aborted signal. No allocator is built in. */
export interface OwnedRelayCheckout { root: string; scratch: string; runtimeBase: string; close(): Promise<void> }
export interface RelayStartHost {
  runtime?: RelayRuntimeSource
  project(id: string, signal: AbortSignal): Promise<RelayProjectObservation>
  allocate?: (policy: Readonly<RelayStartPolicy>, signal: AbortSignal) => Promise<OwnedRelayCheckout>
  reserves?: Reserves
  nodePorts(): number[]
  limits?: Partial<RelayLimits>
  clock?: () => number
}
interface Row { key: string; input_hash: string; run_id: string; session_id: string; policy: string;
  runtime: string; status: RelayStartStatus['status']; error: string | null }
interface Entry { input: RelayStartInput; digest: string; controller: AbortController; start: Promise<RelayStartStatus>;
  lifetime?: Promise<void>; attempt?: Attempt; executor?: RelayExecutor }
const codes = new Set(['runtime_meter_unavailable', 'relay_workspace_unavailable', 'relay_local_connection_required',
  'relay_local_model_required', 'runtime_observation_stale', 'runtime_identity_unknown', 'runtime_identity_changed',
  'runtime_counter_mismatch', 'runtime_count_invalid', 'runtime_request_changed', 'relay_project_unavailable', 'relay_project_changed',
  'relay_checkout_invalid', 'relay_policy_invalid', 'relay_idempotency_conflict', 'relay_stopped', 'content_withheld',
  'cleanup_unconfirmed', 'stale_lease', 'writer_busy', 'egress_not_ready', 'relay_closed', 'relay_not_found'])
export function relayStartCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.message : ''
  return codes.has(code) ? code : 'relay_start_failed'
}
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep)
function immutable<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (part: unknown): void => { if (part && typeof part === 'object') { for (const v of Object.values(part)) freeze(v); Object.freeze(part) } }
  freeze(copy); return copy
}

/** Public start ownership, separate from the compatible trusted internal relay service. */
export class RelayStarts {
  private closed = false
  private readonly entries = new Map<string, Entry>()
  private readonly host: RelayStartHost
  private readonly clock: () => number
  private readonly db: Db
  private readonly runs: RunStore
  private readonly log: SessionLog
  private readonly connections: Connections
  private readonly scrubber: EgressScrubber
  private readonly store: RelayStore
  constructor(db: Db, runs: RunStore, log: SessionLog,
    connections: Connections, scrubber: EgressScrubber, store: RelayStore,
    host: RelayStartHost) {
    this.db = db; this.runs = runs; this.log = log; this.connections = connections; this.scrubber = scrubber; this.store = store
    this.host = { ...host, ...(host.reserves ? { reserves: immutable(relayReservesSchema.parse(host.reserves)) } : {}),
      limits: { ...DEFAULT_RELAY_LIMITS, ...host.limits } }
    this.clock = host.clock ?? Date.now
  }
  private ready(): void { invariant(!this.closed, 'relay_closed'); invariant(this.scrubber.isReady(), 'egress_not_ready') }
  private row(key: string): Row | undefined {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_public_starts'").get()) return
    return this.db.prepare('SELECT * FROM relay_public_starts WHERE key=?').get(key) as unknown as Row | undefined
  }
  private projected(row: Row): RelayStartStatus {
    const run = this.runs.get(row.run_id), active = this.entries.has(row.key)
    // The R1 terminal transition does not acknowledge this owner's checkout/transport cleanup.
    // Only the settled start row can publish public completion; a lost process cannot infer it.
    const status = row.status !== 'running' ? row.status : active ? 'running' : 'interrupted'
    const evidence = JSON.parse(row.runtime), runtime = evidence.runtime, policy = JSON.parse(row.policy) as RelayStartPolicy
    return relayStartStatusSchema.parse(this.scrubber.scrub({ key: row.key, runId: row.run_id, sessionId: row.session_id,
      status, error: status === 'interrupted' ? 'process_restarted' : row.error, source: 'run-home',
      observedAt: new Date(Number(run.updated_at)).toISOString(), confidence: 'observed', runtime, meter: evidence.meter,
      runtimeAgeMs: Math.max(0, this.clock() - runtime.observedAt), reserves: policy.reserves }))
  }
  status(key: string): RelayStartStatus {
    this.ready()
    const row = this.row(key)
    if (row) return this.projected(row)
    invariant(this.entries.has(key), 'relay_not_found')
    return { key, runId: null, sessionId: null, status: 'preparing', error: null, source: 'start-owner',
      observedAt: new Date(this.clock()).toISOString(), confidence: 'observed', runtime: null, meter: null, runtimeAgeMs: null, reserves: null }
  }
  keyForRun(id: string): string {
    this.ready()
    invariant(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='relay_public_starts'").get(), 'relay_not_found')
    const row = this.db.prepare('SELECT key FROM relay_public_starts WHERE run_id=?').get(id)
    invariant(row, 'relay_not_found'); return String(row.key)
  }
  start(raw: unknown): Promise<RelayStartStatus> {
    this.ready()
    const input = immutable(relayStartInputSchema.parse(raw)), digest = hash(input), old = this.row(input.key)
    invariant(canonical(this.scrubber.scrub(input)) === canonical(input), 'content_withheld')
    if (old) { invariant(old.input_hash === digest, 'relay_idempotency_conflict'); return Promise.resolve(this.projected(old)) }
    const prior = this.entries.get(input.key)
    if (prior) { invariant(prior.digest === digest, 'relay_idempotency_conflict'); return prior.start }
    // Default refusals precede home heartbeat, metadata DDL, allocation or execution.
    invariant(this.host.runtime, 'runtime_meter_unavailable')
    invariant(this.host.allocate, 'relay_workspace_unavailable')
    invariant(this.host.reserves, 'relay_policy_invalid')
    const entry: Entry = { input, digest, controller: new AbortController(), start: undefined! }
    this.entries.set(input.key, entry)
    entry.start = this.prepare(entry)
    void entry.start.finally(() => { if (!entry.lifetime) this.entries.delete(input.key) }).catch(() => undefined)
    return entry.start
  }
  private async prepare(entry: Entry): Promise<RelayStartStatus> {
    const { input, controller } = entry, signal = controller.signal, home = this.runs.homeFence()
    const check = () => { this.ready(); home.assert(); signal.throwIfAborted() }
    let owned: OwnedRelayCheckout | undefined
    let ownedRuntimeBase: string | undefined
    try {
      const runtime = await this.host.runtime!.prepare(input.connectionId, input.model, this.host.reserves!.turn, signal)
      check()
      const project = await abortableRead(this.host.project(input.projectId, signal), signal)
      check()
      invariant(project.projectId === input.projectId && project.source && Number.isSafeInteger(project.observedAt) &&
        project.observedAt <= this.clock() && project.roots.length === 1, 'relay_project_unavailable')
      const sourceRoot = await realpath(project.roots[0]!)
      check(); const sourceIdentity = await stat(sourceRoot)
      invariant(sourceIdentity.isDirectory() && sourceRoot !== '/', 'relay_project_unavailable'); check()
      const policy = immutable({ input, project: { ...project, roots: [sourceRoot] }, reserves: this.host.reserves!, nodePorts: [...this.host.nodePorts()] })
      // Resource-owning allocation is NOT raced: stop waits for its cleanup acknowledgement.
      owned = await this.host.allocate!(policy, signal)
      check()
      const root = await realpath(owned.root), scratch = await realpath(owned.scratch), runtimeBase = await realpath(owned.runtimeBase)
      ownedRuntimeBase = runtimeBase
      check()
      invariant(root !== '/' && !inside(sourceRoot, root) && !inside(root, sourceRoot) && root !== scratch &&
        !inside(runtimeBase, root) && !inside(root, runtimeBase) && scratch !== runtimeBase && inside(runtimeBase, scratch) &&
        !inside(sourceRoot, runtimeBase) && !inside(runtimeBase, sourceRoot), 'relay_checkout_invalid')
      assertRootsClean(runtimeBase, [runtimeBase, root, scratch])
      const again = await abortableRead(this.host.project(input.projectId, signal), signal)
      check(); invariant(canonical(again.roots) === canonical(project.roots) && again.projectId === project.projectId, 'relay_project_changed')
      const checkedRoot = await realpath(again.roots[0]!), checkedIdentity = await stat(checkedRoot)
      check(); invariant(checkedRoot === sourceRoot && checkedIdentity.dev === sourceIdentity.dev && checkedIdentity.ino === sourceIdentity.ino, 'relay_project_changed')
      let attempt: Attempt | undefined
      const id = randomUUID(), sessionId = randomUUID()
      let handleClosed = false
      const handle: SessionHandle = { sessionId, epoch: 0, get closed() { return handleClosed }, close() { handleClosed = true },
        append: (event, options = {}) => { check(); invariant(attempt && !handleClosed, 'relay_stopped')
          return this.runs.append(attempt, event, { ...options, expectedSeq: options.expectedSeq ?? this.log.session(sessionId)!.lastSeq + 1 }) } }
      const sandbox: SandboxPolicy = { mode: 'full-access', roots: [root], scratch, runtimeBase,
        protectedPaths: [], domains: [...input.domains], nodePorts: [...policy.nodePorts], attachments: [], hiddenPaths: [sourceRoot, runtimeBase] }
      const guard = () => { check(); assertRootsClean(runtimeBase, [runtimeBase, root, scratch]); invariant(attempt, 'relay_stopped'); this.runs.mutate(attempt, () => undefined) }
      const workspace = await GitRelayWorkspace.create(root, input.plan, { policy: sandbox, log: this.log, handle, scrubber: this.scrubber,
        guard,
        queue: () => { throw new RelayError('relay_queue_unavailable') } })
      await runtime.meter.observe(signal)
      check(); runtime.validate()
      this.runs.createStarted({ id, sessionId }, (a, db, emit) => {
        check(); runtime.validate()
        const evidence = { runtime: runtime.fact, meter: runtime.meterFact }
        // Preparation awaited trusted observations/allocation. New secret registrations must
        // refuse immutable values at commit, before extension DDL or raw ledger writes.
        const persisted = { policy, evidence }
        invariant(canonical(this.scrubber.scrub(persisted)) === canonical(persisted), 'content_withheld')
        db.exec(`CREATE TABLE IF NOT EXISTS relay_start_migrations(version INTEGER PRIMARY KEY);
          INSERT OR IGNORE INTO relay_start_migrations VALUES (39);
          CREATE TABLE IF NOT EXISTS relay_public_starts(key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE REFERENCES durable_runs(id),
            session_id TEXT NOT NULL,policy TEXT NOT NULL,runtime TEXT NOT NULL,status TEXT NOT NULL,error TEXT);`)
        const versions = db.prepare('SELECT version FROM relay_start_migrations').all()
        invariant(versions.length === 1 && versions[0]!.version === 39, 'relay_schema_version')
        this.store.initWithin(a, input.plan, input.caps, db, emit)
        db.prepare("INSERT INTO relay_public_starts VALUES (?,?,?,?,?,?,'running',NULL)").run(input.key, entry.digest, id, sessionId, canonical(policy), canonical(evidence))
        attempt = a
      })
      entry.attempt = attempt!
      const meter = { ...runtime.meter,
        async authorizeDispatch(signal?: AbortSignal) { guard(); await runtime.meter.authorizeDispatch?.(signal); guard() },
        validatePrepared(request: OllamaChatRequest) { runtime.meter.validatePrepared?.(request); guard() },
      }
      const executor = new RelayExecutor(this.store, new ConnectionRelayModel(this.connections, input.connectionId, input.model, meter), workspace,
        policy.reserves, this.scrubber, this.host.limits as RelayLimits)
      // Integration seam: the optional T0 R3 cascade follows judgeSignals when that module merges.
      entry.executor = executor
      const owner = owned; owned = undefined
      entry.lifetime = (async () => {
        let error: string | null = null
        try { await executor.run(attempt!, signal) } catch (failure) { error = relayStartCode(failure) }
        try { assertRootsClean(runtimeBase, [runtimeBase, root, scratch]); await owner.close() } catch { error = 'cleanup_unconfirmed' }
        handle.close()
        try {
          home.transaction('relay.start.settled', db => {
            const run = this.runs.get(id)
            const status = error ? 'failed' : run.state === 'completed' ? 'completed' : run.state === 'canceled' ? 'canceled'
              : run.state === 'wrapping_up' ? 'wrapping_up' : run.state === 'input_required' ? 'input_required' : 'interrupted'
            db.prepare('UPDATE relay_public_starts SET status=?,error=? WHERE key=?').run(status, error, input.key)
          })
        } catch { /* A lost home generation cannot publish cleanup status. */ }
      })().finally(() => this.entries.delete(input.key))
      void entry.lifetime.catch(() => undefined)
      return this.status(input.key)
    } catch (error) {
      if (owned) { try { if (ownedRuntimeBase) assertRootsClean(ownedRuntimeBase, [ownedRuntimeBase]); await owned.close() } catch { throw new RelayError('cleanup_unconfirmed') } }
      throw new RelayError(signal.aborted ? 'relay_stopped' : relayStartCode(error))
    }
  }
  async stop(key: string): Promise<RelayStartStatus> {
    this.ready()
    const entry = this.entries.get(key), row = this.row(key)
    invariant(entry || row, 'relay_not_found')
    if (row) this.runs.cancel(row.run_id)
    entry?.controller.abort(); entry?.executor?.stop()
    let cleanupUnconfirmed = false
    await entry?.start.catch(error => { cleanupUnconfirmed = relayStartCode(error) === 'cleanup_unconfirmed' })
    await entry?.lifetime
    if (this.row(key)) return this.status(key)
    return { key, runId: null, sessionId: null, status: cleanupUnconfirmed ? 'failed' : 'canceled',
      error: cleanupUnconfirmed ? 'cleanup_unconfirmed' : null, source: 'start-owner',
      observedAt: new Date(this.clock()).toISOString(), confidence: 'observed', runtime: null, meter: null, runtimeAgeMs: null, reserves: null }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const entries = [...this.entries.values()]
    for (const entry of entries) { entry.controller.abort(); entry.executor?.stop() }
    await Promise.allSettled(entries.map(async entry => { await entry.start.catch(() => undefined); await entry.lifetime }))
  }
}
