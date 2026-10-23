import { randomUUID } from 'node:crypto'
import { federationAuthSchema, FEDERATION_VERSION, nodeIdentitySchema, routedCommandSchema, telemetrySchema,
  ATTEMPT_DISPATCH_CAPABILITY, ATTEMPT_DISPATCH_MINOR, signedDispatchGrantSchema, signedDispatchEventSchema, dispatchRefSchema, dispatchCancelSchema,
  type LocalInferenceJob, type RemoteAttemptReceipt, type SignedDispatchGrant, type SignedDispatchEvent, type DispatchRef, type DispatchCancel,
  ATTEMPT_RESERVATIONS_CAPABILITY, ATTEMPT_RESERVATIONS_MINOR, remoteAttemptOfferSchema, remoteAttemptCancelSchema,
  RELAY_RUNTIME_CAPABILITY, RELAY_RUNTIME_MINOR, RELAY_RUNTIME_PROBE, RELAY_PIN_PREFIX, relayRuntimePinSchema, relayRuntimeObserveSchema, relayRuntimeCountSchema, type RelayRuntimeBinding,
  type RemoteAttemptOffer, type RemoteAttemptCancel, type FederationAuth, type NodeIdentity, type RoutedCommand, type Telemetry } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import type { EgressScrubber } from '../egress/types.ts'
import type { SessionLog } from '../session-log/log.ts'
import type { RunStore } from '../runs/store.ts'
import { SharedConfig } from './config.ts'
import { canonical, FederationError, hash, publicKey, requestProof, signValue, validSignature } from './crypto.ts'
import { DeviceEnrollment } from './enrollment.ts'
import { Replicas } from './replicas.ts'
import { migrateFederation } from './schema.ts'
import { ReplicatedLayouts } from '../layouts/replication.ts'
import { AttemptOffers, type OfferPolicy } from '../remote-attempts/offers.ts'
import { AttemptDispatch, type DispatchPolicy } from '../remote-attempts/dispatch.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import type { Attempt } from '../runs/types.ts'
import type { FederationChannel } from './channel.ts'
import { sha256Hex, signRuntimeEvidence, signRuntimePinAck } from '../remote-attempts/relay-runtime.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'

export interface FederationOptions {
  db: Db
  identity: NodeIdentity
  /** PKCS8 PEM, injected by the host. Never persisted here or passed through a route. */
  privateKey: string
  peers?: readonly NodeIdentity[]
  scrubber: EgressScrubber
  log: SessionLog
  runs: RunStore
  /** Maximum operations per POST /config; default 256. Split larger batches. */
  configOpsPerRequest?: number
  clock?: () => number
  attempts?: OfferPolicy & { governor: ResourceGovernor }
  dispatch?: DispatchPolicy
}
export interface RelayPinReconciliation { released: number; kept: number; failed: number }
const PIN_TTL_DEFAULT_MS = 10 * 60_000
const UNPIN_TIMEOUT_MS = 5000
/** Node clamps a longer timer delay to 1 ms, which would turn a period into a tight loop. */
export const MAX_TIMER_MS = 2 ** 31 - 1
export interface PeerContext { identity: NodeIdentity; readOnly: boolean; version: { major: number; minor: number } }
export class Federation {
  readonly configOpsPerRequest: number
  readonly config: SharedConfig
  readonly layouts: ReplicatedLayouts
  readonly replicas: Replicas
  readonly enrollment: DeviceEnrollment
  readonly identity: NodeIdentity
  readonly attemptOffers: AttemptOffers | null
  readonly attemptDispatch: AttemptDispatch | null
  #options: FederationOptions
  private readonly now: () => number
  /** F2-reap: the clock of relay pin leases. The monotonic-anchored lease clock of dispatch and offers, never the wall clock, so a
   * clock step or a resume cannot lapse a live pin. */
  private readonly leaseNow: () => number
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly counting = new Map<string, number>()
  /** F2-reap, home side: relay runs whose session in THIS process still needs its executor pin. Everything else in the journal is dead. */
  private readonly livePins = new Set<string>()
  private reconciling: Promise<RelayPinReconciliation> | undefined
  readonly #maintenance: Array<ReturnType<typeof setTimeout>> = []
  constructor(options: FederationOptions) {
    this.configOpsPerRequest = options.configOpsPerRequest ?? 256
    if (!Number.isSafeInteger(this.configOpsPerRequest) || this.configOpsPerRequest < 1) throw new FederationError('invalid_config_budget')
    this.#options = options
    this.now = options.clock ?? Date.now
    const wall = Date.now(), monotonic = performance.now()
    this.leaseNow = options.dispatch?.leaseClock ?? (() => Math.floor(wall + performance.now() - monotonic))
    this.identity = nodeIdentitySchema.parse(options.identity)
    publicKey(this.identity.publicKey)
    // Validate that the host actually owns the pinned key, without serializing private bytes.
    const { privateKey } = options
    if (!validSignature(this.identity.publicKey, { domain: 'key-check' }, signValue(privateKey, { domain: 'key-check' }))) throw new FederationError('invalid_key')
    migrateFederation(options.db)
    const existing = options.db.prepare('SELECT identity FROM federation_local WHERE id=1').get()
    if (existing && existing.identity !== canonical(this.identity)) throw new FederationError('local_identity_changed')
    options.db.prepare('INSERT OR IGNORE INTO federation_local VALUES (1,?)').run(canonical(this.identity))
    this.trust(this.identity)
    for (const peer of options.peers ?? []) this.trust(peer)
    this.config = new SharedConfig(options.db, this.identity, privateKey, (id) => this.peer(id), this.now,
      (v) => this.clean(v), operation => this.layouts.project(operation))
    this.layouts = new ReplicatedLayouts(options.db, this.identity.accountId, this.config, () => this.clean(null))
    this.replicas = new Replicas(options.db, this.identity, privateKey, options.log, (id) => this.peer(id), (v) => this.clean(v))
    this.enrollment = new DeviceEnrollment(options.db, this.identity, this.now, (id) => this.trust(id), () => this.assertOpen())
    if (options.attempts && this.identity.trust !== 'owner_device') throw new FederationError('owner_device_required', 403)
    this.attemptOffers = options.attempts ? new AttemptOffers(options.db, options.runs, this.identity.id,
      options.attempts.governor, options.attempts, this.now) : null
    if (options.dispatch && !this.attemptOffers) throw new FederationError('attempts_required')
    this.attemptDispatch = options.dispatch ? new AttemptDispatch(options.db, options.runs, this.attemptOffers!, this.identity.id,
      this.identity.accountId, privateKey, options.dispatch, this.now) : null
    if (options.dispatch) this.graceRelayPins()
    if (options.dispatch) this.startPinMaintenance(options.dispatch.relayPinMaintenanceMs ?? 60_000)
  }
  private assertOpen() { if (this.closed) throw new FederationError('closed', 503) }
  private clean(value: unknown): void {
    this.assertOpen()
    if (!this.#options.scrubber.isReady()) throw new FederationError('egress_not_ready', 503)
    if (canonical(this.#options.scrubber.scrub(value)) !== canonical(value)) throw new FederationError('content_withheld', 403)
  }
  /** Host-provisioned trust, never a peer-controlled write. Existing credentials are immutable. */
  trust(input: NodeIdentity): void {
    this.assertOpen()
    const identity = nodeIdentitySchema.parse(input)
    publicKey(identity.publicKey)
    const old = this.#options.db.prepare('SELECT identity,revoked FROM federation_peers WHERE id=?').get(identity.id)
    if (old && old.identity !== canonical(identity)) throw new FederationError('identity_conflict')
    // Reopening a host pin is idempotent; INSERT OR IGNORE never clears revocation.
    this.#options.db.prepare('INSERT OR IGNORE INTO federation_peers(id,identity) VALUES (?,?)').run(identity.id, canonical(identity))
  }
  revokePeer(id: string): void {
    this.assertOpen()
    this.#options.db.prepare('UPDATE federation_peers SET revoked=1 WHERE id=?').run(id)
  }
  peer(id: string): NodeIdentity {
    this.assertOpen()
    const row = this.#options.db.prepare('SELECT identity FROM federation_peers WHERE id=? AND revoked=0').get(id)
    if (!row) throw new FederationError('unauthenticated', 401)
    return nodeIdentitySchema.parse(JSON.parse(row.identity as string))
  }
  authenticate(method: string, path: string, body: unknown, input: FederationAuth): PeerContext {
    this.assertOpen()
    const auth = federationAuthSchema.parse(input)
    const identity = this.peer(auth.nodeId)
    if (auth.audience !== this.identity.id || Math.abs(auth.issuedAt - this.now()) > 60_000 || !validSignature(identity.publicKey, requestProof(method, path, body, auth), auth.signature)) throw new FederationError('unauthenticated', 401)
    if (auth.version.major > FEDERATION_VERSION.major) throw new FederationError('contract_incompatible', 426)
    // Keep nonces for the full acceptance window including a future-skewed timestamp.
    this.#options.db.prepare('DELETE FROM federation_nonces WHERE expires_at<?').run(this.now())
    try { this.#options.db.prepare('INSERT INTO federation_nonces VALUES (?,?,?)').run(identity.id, auth.nonce, auth.issuedAt + 60_000) }
    catch { throw new FederationError('request_replayed', 401) }
    return { identity, readOnly: auth.version.major < FEDERATION_VERSION.major,
      version: { major: Math.min(auth.version.major, FEDERATION_VERSION.major), minor: Math.min(auth.version.minor, FEDERATION_VERSION.minor) } }
  }
  authorize(context: PeerContext, scope: NodeIdentity['scopes'][number], write = false): NodeIdentity {
    const identity = this.peer(context.identity.id) // Revocation takes effect on held contexts too.
    if (!identity.scopes.includes(scope)) throw new FederationError('scope_denied', 403)
    if (write && context.readOnly) throw new FederationError('contract_read_only', 403)
    return identity
  }
  receiveTelemetry(context: PeerContext, input: Telemetry): void {
    const peer = this.authorize(context, 'telemetry', true)
    const sample = telemetrySchema.parse(input)
    this.clean(sample)
    if (sample.nodeId !== peer.id || sample.observedAt > this.now() + 60_000) throw new FederationError('invalid_telemetry')
    const old = this.#options.db.prepare('SELECT data FROM federation_telemetry WHERE node_id=?').get(peer.id)
    if (old && (JSON.parse(old.data as string) as Telemetry).observedAt >= sample.observedAt) return
    this.#options.db.prepare('INSERT INTO federation_telemetry VALUES (?,?) ON CONFLICT(node_id) DO UPDATE SET data=excluded.data').run(peer.id, canonical(sample))
  }
  telemetry(accountId = this.identity.accountId): (Telemetry & { ageMs: number })[] {
    this.clean(null)
    return this.#options.db.prepare(`SELECT t.data FROM federation_telemetry t
      JOIN federation_peers p ON p.id=t.node_id
      WHERE json_extract(p.identity,'$.accountId')=? ORDER BY t.node_id`).all(accountId).map((row) => {
      const sample = telemetrySchema.parse(JSON.parse(row.data as string)); this.clean(sample)
      return { ...sample, ageMs: Math.max(0, this.now() - sample.observedAt) }
    })
  }
  receiveCommand(context: PeerContext, input: RoutedCommand): string {
    const peer = this.authorize(context, 'commands', true)
    const command = routedCommandSchema.parse(input)
    this.clean(command)
    if (command.homeNodeId !== this.identity.id) throw new FederationError('not_home')
    const binding = this.replicas.binding(command.runId)
    if (binding.kind !== 'run' || binding.homeNodeId !== this.identity.id || binding.sessionId !== command.sessionId || binding.ownerAccountId !== peer.accountId) throw new FederationError('owner_mismatch', 403)
    return this.#options.runs.applyFederatedCommand(command, () => {
      const previous = this.#options.db.prepare('SELECT * FROM federation_command_receipts WHERE node_id=? AND command_id=?').get(peer.id, command.id)
      if (previous && previous.digest !== hash(command)) throw new FederationError('command_conflict')
      return previous?.result as string | undefined
    }, (result) => {
      this.#options.db.prepare('INSERT INTO federation_command_receipts VALUES (?,?,?,?)').run(peer.id, command.id, hash(command), result)
      if (result === 'applied' && command.action.kind === 'prompt') this.#options.db.prepare('INSERT INTO federation_prompts(node_id,command_id,run_id,command) VALUES (?,?,?,?)').run(peer.id, command.id, command.runId, canonical(command))
    })
  }
  enqueue(input: RoutedCommand): void {
    const command = routedCommandSchema.parse(input)
    this.clean(command)
    const binding = this.replicas.binding(command.runId)
    if (binding.ownerAccountId !== this.identity.accountId || binding.homeNodeId !== command.homeNodeId || binding.sessionId !== command.sessionId) throw new FederationError('owner_mismatch', 403)
    const prior = this.#options.db.prepare('SELECT command FROM federation_outbox WHERE id=?').get(command.id)
    if (prior && prior.command !== canonical(command)) throw new FederationError('command_conflict')
    this.#options.db.prepare('INSERT OR IGNORE INTO federation_outbox VALUES (?,?,NULL)').run(command.id, canonical(command))
  }
  async flush(send: (command: RoutedCommand) => Promise<string>): Promise<void> {
    this.clean(null)
    const rows = this.#options.db.prepare('SELECT id,command FROM federation_outbox WHERE result IS NULL ORDER BY id').all()
    for (const row of rows) {
      const command = routedCommandSchema.parse(JSON.parse(row.command as string))
      this.clean(command)
      let result: string
      if (command.expiresAt <= this.now()) result = 'expired'
      else {
        try { result = await send(command) } catch { continue } // Durable until reconnection or expiry.
        this.assertOpen()
      }
      if (!['applied', 'stale_version', 'expired', 'invalid_state'].includes(result)) continue
      this.#options.db.prepare('UPDATE federation_outbox SET result=? WHERE id=?').run(result, row.id as string)
    }
  }
  pendingPrompts(runId: string): RoutedCommand[] {
    this.clean(null)
    return this.#options.db.prepare("SELECT command FROM federation_prompts WHERE run_id=? AND consumed=0 ORDER BY json_extract(command,'$.stateVersion')").all(runId)
      .map((r) => { const command = routedCommandSchema.parse(JSON.parse(r.command as string)); this.clean(command); return command })
  }
  acknowledgePrompt(nodeId: string, commandId: string): void {
    this.assertOpen()
    this.#options.db.prepare('UPDATE federation_prompts SET consumed=1 WHERE node_id=? AND command_id=?').run(nodeId, commandId)
  }
  capabilities(): string[] {
    this.assertOpen()
    return [...(this.attemptOffers ? [ATTEMPT_RESERVATIONS_CAPABILITY] : []), ...(this.attemptDispatch ? [ATTEMPT_DISPATCH_CAPABILITY] : []),
      ...(this.attemptDispatch && this.#options.dispatch?.relayRuntime ? [RELAY_RUNTIME_CAPABILITY] : [])]
  }
  private offers(): AttemptOffers {
    this.clean(null)
    if (!this.attemptOffers) throw new FederationError('contract_feature_unavailable', 426)
    return this.attemptOffers
  }
  createAttemptOffer(a: Attempt, input: Parameters<AttemptOffers['create']>[1]): RemoteAttemptOffer {
    const offers = this.offers(), target = this.peer(input.executorNodeId)
    this.clean(input)
    if (target.trust !== 'owner_device' || target.accountId !== this.identity.accountId) throw new FederationError('owner_mismatch', 403)
    return offers.create(a, input)
  }
  private validateAttemptOffer(context: PeerContext, offer: RemoteAttemptOffer): void {
    const peer = this.authorize(context, 'attempts', true)
    if (context.version.minor < ATTEMPT_RESERVATIONS_MINOR) throw new FederationError('contract_feature_unavailable', 426)
    this.clean(offer)
    if (peer.trust !== 'owner_device' || peer.accountId !== this.identity.accountId || offer.homeNodeId !== peer.id || offer.executorNodeId !== this.identity.id)
      throw new FederationError('owner_mismatch', 403)
    // A relay model call is a child run: its pin derives from the already pinned relay run (same session, owner, home and
    // epoch). The child is a different run id, and never one that is pinned in its own right (that is some other run's state).
    if (offer.parent) {
      if (!this.#options.dispatch?.relayRuntime || context.version.minor < RELAY_RUNTIME_MINOR) throw new FederationError('contract_feature_unavailable', 426)
      let own = true
      try { this.replicas.binding(offer.runId) } catch { own = false }
      if (own || offer.runId === offer.parent.runId) throw new FederationError('not_home')   // a child is neither the relay run nor another pinned run
    }
    const binding = this.replicas.binding(offer.parent ? RELAY_PIN_PREFIX + offer.parent.runId : offer.runId)
    if (binding.kind !== 'run' || binding.sessionId !== offer.sessionId || binding.ownerAccountId !== peer.accountId ||
      binding.homeNodeId !== peer.id || binding.homeEpoch !== offer.fence.epoch || (offer.parent && binding.homeEpoch !== offer.parent.epoch)) throw new FederationError('not_home')
  }
  async receiveAttemptOffer(context: PeerContext, input: RemoteAttemptOffer) {
    const offers = this.offers(), offer = remoteAttemptOfferSchema.parse(input)
    this.validateAttemptOffer(context, offer)
    return offers.receive(offer, () => this.validateAttemptOffer(context, offer))
  }
  cancelAttemptOffer(context: PeerContext, raw: RemoteAttemptCancel) {
    const offers = this.offers(), input = remoteAttemptCancelSchema.parse(raw), peer = this.authorize(context, 'attempts', true)
    if (context.version.minor < ATTEMPT_RESERVATIONS_MINOR) throw new FederationError('contract_feature_unavailable', 426)
    if (input.homeNodeId !== peer.id || input.executorNodeId !== this.identity.id || peer.accountId !== this.identity.accountId) throw new FederationError('owner_mismatch', 403)
    return offers.cancel(peer.id, input.offerId)
  }
  private dispatches(): AttemptDispatch {
    this.clean(null)
    if (!this.attemptDispatch) throw new FederationError('contract_feature_unavailable', 426)
    return this.attemptDispatch
  }
  prepareDispatch(runId: string, executor: string, job: LocalInferenceJob, reservationMs: number, parent?: { runId: string; epoch: number }): RemoteAttemptOffer {
    const target = this.peer(executor)
    this.clean(job)
    if (target.trust !== 'owner_device' || target.accountId !== this.identity.accountId || !target.scopes.includes('attempts')) throw new FederationError('owner_mismatch', 403)
    if (!!job.counted !== !!parent) throw new FederationError('dispatch_binding')
    return this.dispatches().prepare(runId, executor, job, reservationMs, parent)
  }
  /** How long a holder can outlive the last renewal the home granted it: the window a cancel without ACK must wait out. */
  holderTtlMs(): number {
    const dispatch = this.#options.dispatch
    if (!dispatch) throw new FederationError('contract_feature_unavailable', 426)
    return dispatch.ttlMs
  }
  /** F2-d home side: the signed channel to a pinned owner-device executor that may serve relay inference. */
  relayChannel(executorNodeId: string): FederationChannel {
    const dispatch = this.#options.dispatch
    if (!dispatch) throw new FederationError('contract_feature_unavailable', 426)
    const target = this.peer(executorNodeId)
    if (target.trust !== 'owner_device' || target.accountId !== this.identity.accountId || !target.scopes.includes('attempts')) throw new FederationError('owner_mismatch', 403)
    return dispatch.channel(executorNodeId)
  }
  /** F2-d executor side. Nothing here starts inference, takes a permit or writes metadata; the only write is the pin's own lease. */
  private relayRuntime(context: PeerContext, binding: RelayRuntimeBinding) {
    this.clean(null)
    const runtime = this.#options.dispatch?.relayRuntime
    if (!runtime || !this.attemptDispatch) throw new FederationError('contract_feature_unavailable', 426)
    const peer = this.authorize(context, 'attempts', true)
    if (context.version.major !== FEDERATION_VERSION.major || context.version.minor < RELAY_RUNTIME_MINOR) throw new FederationError('contract_feature_unavailable', 426)
    this.clean(binding)
    if (peer.trust !== 'owner_device' || peer.accountId !== this.identity.accountId || binding.homeNodeId !== peer.id || binding.executorNodeId !== this.identity.id) throw new FederationError('owner_mismatch', 403)
    if (normalizeOllamaModelReference(binding.model) !== runtime.model) throw new FederationError('relay_model_mismatch')
    // F2-reap: an expired pin is gone before it is looked up, on this node's own transaction.
    this.sweepRelayPins()
    if (binding.run) {
      const streamId = RELAY_PIN_PREFIX + binding.run.runId
      const pinned = this.replicas.binding(streamId)
      if (pinned.kind !== 'run' || pinned.sessionId !== binding.run.sessionId || pinned.ownerAccountId !== peer.accountId ||
        pinned.homeNodeId !== peer.id || pinned.homeEpoch !== binding.run.fence.epoch) throw new FederationError('not_home')
      this.leaseRelayPin(streamId)   // a valid use of the pin renews its lease
    }
    return runtime
  }
  async receiveRelayObserve(context: PeerContext, raw: unknown) {
    const request = relayRuntimeObserveSchema.parse(raw), runtime = this.relayRuntime(context, request.binding)
    const observation = await runtime.observe(runtime.model, this.lifetime.signal)
    this.relayRuntime(context, request.binding) // revocation or closure during the await
    return signRuntimeEvidence(this.#options.privateKey, { kind: 'observe', binding: request.binding, challenge: request.challenge, executorNodeId: this.identity.id,
      model: observation.model, digest: observation.digest, contextTokens: observation.contextTokens, runtimeVersion: observation.runtimeVersion,
      source: observation.source, observedAt: observation.observedAt, count: null })
  }
  /** Named policy (`DispatchPolicy.relayLimits`), documented defaults; the home counts one string at a time per relay. */
  private relayLimit(name: 'maxConcurrentCountsPerPeer' | 'maxPinsPerPeer'): number {
    const value = this.#options.dispatch?.relayLimits?.[name] ?? (name === 'maxConcurrentCountsPerPeer' ? 4 : 16)
    if (!Number.isSafeInteger(value) || value < 1) throw new FederationError('invalid_relay_limits')
    return value
  }
  /** Pins (and unpins) the relay run in the relay namespace, for the asking home only. */
  receiveRelayPin(context: PeerContext, raw: unknown) {
    const request = relayRuntimePinSchema.parse(raw)
    this.relayRuntime(context, { homeNodeId: request.homeNodeId, executorNodeId: request.executorNodeId, model: request.model, run: null })
    const streamId = RELAY_PIN_PREFIX + request.runId, db = this.#options.db
    this.transaction(() => {
      if (request.action === 'pin') {
        const held = db.prepare("SELECT COUNT(*) n FROM federation_streams WHERE id LIKE 'relay:%' AND json_extract(binding,'$.homeNodeId')=?").get(context.identity.id)!.n as number
        // A released run id stays released for one TTL: an unpin can overtake a pin or heartbeat that was slower than the home's
        // own bound (run ids are fresh UUIDs, so no honest pin follows its unpin).
        if (db.prepare('SELECT 1 FROM federation_relay_pin_tombstones WHERE stream_id=? AND expires_at>?').get(streamId, this.leaseNow())) throw new FederationError('relay_pin_released')
        const existing = db.prepare('SELECT 1 FROM federation_streams WHERE id=?').get(streamId)
        if (!existing && held >= this.relayLimit('maxPinsPerPeer')) throw new FederationError('relay_pin_limit', 429)
        this.replicas.bind({ streamId, kind: 'run', sessionId: request.sessionId, ownerAccountId: context.identity.accountId, homeNodeId: context.identity.id, homeEpoch: request.epoch })
        this.leaseRelayPin(streamId)    // a pin and its lease commit together; asking again renews
      } else {
        const existed = !!db.prepare('SELECT 1 FROM federation_streams WHERE id=?').get(streamId)
        const removed = this.replicas.unbind(streamId, context.identity.id, request.epoch)
        if (removed) db.prepare('DELETE FROM federation_relay_pin_leases WHERE stream_id=?').run(streamId)
        // Released, or never arrived: either way nothing may pin it later. A fenced-out unpin (a newer pin exists) records nothing.
        if (removed || !existed) db.prepare('INSERT INTO federation_relay_pin_tombstones VALUES (?,?) ON CONFLICT(stream_id) DO UPDATE SET expires_at=excluded.expires_at')
          .run(streamId, this.leaseNow() + this.pinTtl())
      }
    })
    const { model: _model, ...ack } = request
    return signRuntimePinAck(this.#options.privateKey, ack)
  }
  private transaction<T>(body: () => T): T {
    const db = this.#options.db
    db.exec('BEGIN IMMEDIATE')
    try { const result = body(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  /** Executor: how long a pin outlives the last time its home used or renewed it. */
  private pinTtl(): number {
    const value = this.#options.dispatch?.relayLimits?.pinTtlMs ?? PIN_TTL_DEFAULT_MS
    if (!Number.isSafeInteger(value) || value < 1) throw new FederationError('invalid_relay_limits')
    return value
  }
  private leaseRelayPin(streamId: string): void {
    this.#options.db.prepare('INSERT INTO federation_relay_pin_leases VALUES (?,?) ON CONFLICT(stream_id) DO UPDATE SET expires_at=excluded.expires_at')
      .run(streamId, this.leaseNow() + this.pinTtl())
  }
  /** Boot grace (ADR-0018: a restart never makes a live holder lose to its own downtime). Every relay pin gets at least one full
   * TTL from this boot, and a pin without a lease gets one, so the homes can renew before anything is swept. */
  private graceRelayPins(): void {
    const db = this.#options.db, until = this.leaseNow() + this.pinTtl()
    this.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO federation_relay_pin_leases SELECT id,? FROM federation_streams WHERE id LIKE 'relay:%'").run(until)
      db.prepare('UPDATE federation_relay_pin_leases SET expires_at=MAX(expires_at,?)').run(until)
    })
  }
  /** Executor backstop: a relay pin whose lease lapsed (its home crashed or never returned) is released on this node's own
   * transaction. It removes a permission and grants none, so it cannot create a second holder of anything. A pin without a
   * lease (made after boot by a path other than the pin message) is released at once. */
  sweepRelayPins(): number {
    const db = this.#options.db, now = this.leaseNow()
    const lapsed = `FROM federation_streams WHERE id LIKE 'relay:%'
        AND NOT EXISTS (SELECT 1 FROM federation_replicas r WHERE r.stream_id=federation_streams.id)
        AND NOT EXISTS (SELECT 1 FROM federation_relay_pin_leases l WHERE l.stream_id=federation_streams.id AND l.expires_at>?)`
    const stale = !!db.prepare(`SELECT 1 ${lapsed} LIMIT 1`).get(now), tombs = !!db.prepare('SELECT 1 FROM federation_relay_pin_tombstones WHERE expires_at<=? LIMIT 1').get(now)
    if (!stale && !tombs) return 0                                       // the common case takes no write lock
    return this.transaction(() => {
      db.prepare('DELETE FROM federation_relay_pin_tombstones WHERE expires_at<=?').run(now)
      const removed = Number(db.prepare(`DELETE ${lapsed}`).run(now).changes)
      if (removed) db.exec('DELETE FROM federation_relay_pin_leases WHERE stream_id NOT IN (SELECT id FROM federation_streams)')
      return removed
    })
  }

  // ---- F2-reap, home side: the durable journal of pins this node asked executors to make --------------------------------------------
  /** Written before the signed `pin` leaves, so a crash after the executor's acknowledgement still leaves a record. The run
   * is live in this process until it is settled or retired. */
  journalRelayPin(executorNodeId: string, pin: { runId: string; sessionId: string; epoch: number; model: string }): void {
    this.assertOpen()
    this.#options.db.prepare('INSERT OR IGNORE INTO federation_relay_pin_journal VALUES (?,?,?,?,?,?)')
      .run(pin.runId, executorNodeId, pin.model, pin.sessionId, pin.epoch, this.now())
    this.livePins.add(pin.runId)
  }
  /** The executor acknowledged the unpin: nothing is left to reap. */
  settleRelayPin(runId: string): void {
    this.livePins.delete(runId)
    if (!this.closed) this.#options.db.prepare('DELETE FROM federation_relay_pin_journal WHERE run_id=?').run(runId)
  }
  /** The session ended without an acknowledged unpin: the row stays, and now belongs to the reconciliation. */
  retireRelayPin(runId: string): void { this.livePins.delete(runId) }
  /** Signed, fenced `unpin` for every journaled pin that no session of this process still needs. Idempotent, single-flight,
   * bounded per executor: an unreachable executor is tried once per pass and its rows wait for the next. */
  reconcileRelayPins(): Promise<RelayPinReconciliation> {
    this.reconciling ??= this.reconcile().finally(() => { this.reconciling = undefined })
    return this.reconciling
  }
  private async reconcile(): Promise<RelayPinReconciliation> {
    const result: RelayPinReconciliation = { released: 0, kept: 0, failed: 0 }, down = new Set<string>()
    const rows = this.#options.db.prepare('SELECT * FROM federation_relay_pin_journal ORDER BY journaled_at, run_id').all()
    for (const row of rows) {
      const runId = String(row.run_id), executor = String(row.executor_node_id)
      if (this.closed) break
      if (this.livePins.has(runId)) { result.kept++; continue }
      if (down.has(executor)) { result.failed++; continue }
      let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined
      try {
        const unpin = this.relayChannel(executor).relayPin({ action: 'unpin', homeNodeId: this.identity.id, executorNodeId: executor, model: String(row.model),
          runId, sessionId: String(row.session_id), epoch: Number(row.epoch), challenge: randomUUID() })
        unpin.catch(() => undefined)
        await Promise.race([unpin, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new FederationError('relay_unpin_timeout', 504)), UNPIN_TIMEOUT_MS); timer.unref()
          stop = () => reject(new FederationError('closed', 503)); this.lifetime.signal.addEventListener('abort', stop, { once: true })   // close() ends the wait
        })])
        // A pin that became live in the meantime (it cannot: run ids are fresh) would be left alone by the settle below.
        if (!this.livePins.has(runId)) this.settleRelayPin(runId)
        result.released++
      } catch (error) {
        // Only an unreachable executor ends the pass for it. A definitive refusal (another model, a stranger's pin, an executor
        // without the runtime) concerns this row alone; the executor's lease frees that pin.
        const refused = error instanceof FederationError && error.status < 500 && error.code !== 'relay_unpin_timeout'
        if (!refused) down.add(executor)
        result.failed++
      } finally { clearTimeout(timer); if (stop) this.lifetime.signal.removeEventListener('abort', stop) }
    }
    return result
  }
  private startPinMaintenance(periodMs: number): void {
    if (!Number.isSafeInteger(periodMs) || periodMs < 0 || periodMs > MAX_TIMER_MS) throw new FederationError('invalid_relay_limits')
    if (periodMs === 0) return
    const tick = async () => {
      if (this.closed) return
      try { this.sweepRelayPins() } catch { /* a closed database ends the maintenance */ }
      try { await this.reconcileRelayPins() } catch { /* retried at the next tick */ }
    }
    const first = setTimeout(() => { void tick() }, 0), every = setInterval(() => { void tick() }, periodMs)
    first.unref(); every.unref(); this.#maintenance.push(first, every)
  }
  async receiveRelayCount(context: PeerContext, raw: unknown) {
    const request = relayRuntimeCountSchema.parse(raw), runtime = this.relayRuntime(context, request.binding)
    const peerId = context.identity.id, inFlight = this.counting.get(peerId) ?? 0
    if (inFlight >= this.relayLimit('maxConcurrentCountsPerPeer')) throw new FederationError('relay_busy', 429)
    this.counting.set(peerId, inFlight + 1)
    try { return await this.countAdmitted(context, request, runtime) } finally { this.counting.set(peerId, (this.counting.get(peerId) ?? 1) - 1) }
  }
  private async countAdmitted(context: PeerContext, request: ReturnType<typeof relayRuntimeCountSchema.parse>, runtime: NonNullable<ReturnType<Federation['relayRuntime']>>) {
    // Before a run exists only the fixed admission probe may be counted; real content needs a pinned run.
    if (!request.binding.run && request.content !== RELAY_RUNTIME_PROBE) throw new FederationError('relay_run_required', 403)
    this.clean(request.content)
    const measured = await runtime.measure(request.content, this.lifetime.signal)
    this.relayRuntime(context, request.binding)
    const o = measured.observation
    return signRuntimeEvidence(this.#options.privateKey, { kind: 'count', binding: request.binding, challenge: request.challenge, executorNodeId: this.identity.id,
      model: o.model, digest: o.digest, contextTokens: o.contextTokens, runtimeVersion: o.runtimeVersion, source: o.source, observedAt: o.observedAt,
      count: { contentSha256: sha256Hex(request.content), renderedSha256: sha256Hex(measured.rendered), tokens: measured.tokens } })
  }
  grantDispatch(id: string, receipt: RemoteAttemptReceipt): SignedDispatchGrant {
    this.clean(receipt)
    const dispatch = this.dispatches(), target = this.peer(dispatch.homeExecutor(id))
    if (target.trust !== 'owner_device' || target.accountId !== this.identity.accountId || !target.scopes.includes('attempts')) throw new FederationError('owner_mismatch', 403)
    return dispatch.grant(id, receipt)
  }
  private validateDispatchPeer(context: PeerContext, ref: DispatchRef, incomingHome: boolean): NodeIdentity {
    const peer = this.authorize(context, 'attempts', true)
    if (context.version.major !== FEDERATION_VERSION.major || context.version.minor < ATTEMPT_DISPATCH_MINOR) throw new FederationError('contract_feature_unavailable', 426)
    this.clean(ref)
    if (peer.trust !== 'owner_device' || peer.accountId !== this.identity.accountId ||
      (incomingHome ? ref.homeNodeId !== peer.id || ref.executorNodeId !== this.identity.id : ref.executorNodeId !== peer.id || ref.homeNodeId !== this.identity.id)) throw new FederationError('owner_mismatch', 403)
    return peer
  }
  async receiveDispatch(context: PeerContext, raw: SignedDispatchGrant) {
    const signed = signedDispatchGrantSchema.parse(raw), g = signed.grant
    const validate = () => {
      const peer = this.validateDispatchPeer(context, { id: g.id, homeNodeId: g.offer.homeNodeId, executorNodeId: g.offer.executorNodeId }, true)
      this.validateAttemptOffer(context, g.offer); this.clean(signed)
      if (!validSignature(peer.publicKey, g, signed.signature)) throw new FederationError('invalid_signature', 403)
    }
    validate()
    return this.dispatches().receive(signed, validate)
  }
  renewDispatch(context: PeerContext, raw: DispatchRef) {
    const ref = dispatchRefSchema.parse(raw), validate = () => { this.validateDispatchPeer(context, ref, false) }
    validate(); return this.dispatches().renew(ref, validate)
  }
  receiveDispatchEvent(context: PeerContext, raw: SignedDispatchEvent): void {
    const signed = signedDispatchEventSchema.parse(raw), validate = () => {
      const peer = this.validateDispatchPeer(context, signed.entry.ref, false); this.clean(signed)
      if (!validSignature(peer.publicKey, signed.entry, signed.signature)) throw new FederationError('invalid_signature', 403)
    }
    validate(); this.dispatches().ingest(signed, validate)
  }
  dispatchState(context: PeerContext, raw: DispatchRef) {
    const ref = dispatchRefSchema.parse(raw), dispatch = this.dispatches()
    this.validateDispatchPeer(context, ref, true)
    if (canonical(dispatch.binding(ref.id)) !== canonical(ref)) throw new FederationError('dispatch_binding')
    return dispatch.state(ref.id)
  }
  cancelDispatch(context: PeerContext, raw: DispatchCancel) {
    const input = dispatchCancelSchema.parse(raw), peer = this.authorize(context, 'attempts', true), dispatch = this.dispatches()
    if (context.version.major !== FEDERATION_VERSION.major || context.version.minor < ATTEMPT_DISPATCH_MINOR) throw new FederationError('contract_feature_unavailable', 426)
    this.clean(input)
    if (peer.trust !== 'owner_device' || peer.accountId !== this.identity.accountId || input.executorNodeId !== this.identity.id) throw new FederationError('owner_mismatch', 403)
    if (input.expiresAt <= this.now()) throw new FederationError('command_expired')
    const ref = dispatchRefSchema.parse({ id: input.id, homeNodeId: input.homeNodeId, executorNodeId: input.executorNodeId })
    if (canonical(dispatch.binding(input.id)) !== canonical(ref)) throw new FederationError('dispatch_binding')
    return dispatch.cancel(input.id)
  }
  close(): void { if (this.closed) return; for (const timer of this.#maintenance) { clearTimeout(timer); clearInterval(timer) } this.lifetime.abort(); this.attemptDispatch?.close(); this.attemptOffers?.close(); this.closed = true }
}
