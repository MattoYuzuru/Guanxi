import { federationAuthSchema, FEDERATION_VERSION, nodeIdentitySchema, routedCommandSchema, telemetrySchema,
  ATTEMPT_DISPATCH_CAPABILITY, ATTEMPT_DISPATCH_MINOR, signedDispatchGrantSchema, signedDispatchEventSchema, dispatchRefSchema,
  type LocalInferenceJob, type RemoteAttemptReceipt, type SignedDispatchGrant, type SignedDispatchEvent, type DispatchRef,
  ATTEMPT_RESERVATIONS_CAPABILITY, ATTEMPT_RESERVATIONS_MINOR, remoteAttemptOfferSchema, remoteAttemptCancelSchema,
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
  private closed = false
  constructor(options: FederationOptions) {
    this.configOpsPerRequest = options.configOpsPerRequest ?? 256
    if (!Number.isSafeInteger(this.configOpsPerRequest) || this.configOpsPerRequest < 1) throw new FederationError('invalid_config_budget')
    this.#options = options
    this.now = options.clock ?? Date.now
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
  capabilities(): string[] { this.assertOpen(); return [...(this.attemptOffers ? [ATTEMPT_RESERVATIONS_CAPABILITY] : []), ...(this.attemptDispatch ? [ATTEMPT_DISPATCH_CAPABILITY] : [])] }
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
    const binding = this.replicas.binding(offer.runId)
    if (binding.kind !== 'run' || binding.sessionId !== offer.sessionId || binding.ownerAccountId !== peer.accountId ||
      binding.homeNodeId !== peer.id || binding.homeEpoch !== offer.fence.epoch) throw new FederationError('not_home')
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
  prepareDispatch(runId: string, executor: string, job: LocalInferenceJob, reservationMs: number): RemoteAttemptOffer {
    const target = this.peer(executor)
    this.clean(job)
    if (target.trust !== 'owner_device' || target.accountId !== this.identity.accountId || !target.scopes.includes('attempts')) throw new FederationError('owner_mismatch', 403)
    return this.dispatches().prepare(runId, executor, job, reservationMs)
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
  dispatchState(context: PeerContext, raw: DispatchRef, cancel = false) {
    const ref = dispatchRefSchema.parse(raw), dispatch = this.dispatches()
    this.validateDispatchPeer(context, ref, true)
    if (canonical(dispatch.binding(ref.id)) !== canonical(ref)) throw new FederationError('dispatch_binding')
    return cancel ? dispatch.cancel(ref.id) : dispatch.state(ref.id)
  }
  close(): void { if (this.closed) return; this.attemptDispatch?.close(); this.attemptOffers?.close(); this.closed = true }
}
