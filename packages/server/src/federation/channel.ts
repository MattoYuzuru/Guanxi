/** Signed node channel with an injected transport. No network is opened by construction. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FEDERATION_VERSION, federationVersionSchema, replicaEntrySchema, signedConfigOperationSchema,
  ATTEMPT_DISPATCH_CAPABILITY, ATTEMPT_DISPATCH_MINOR, dispatchRenewalSchema, dispatchStateSchema, dispatchCancelSchema,
  type SignedDispatchGrant, type SignedDispatchEvent, type DispatchRef, type DispatchCancel,
  ATTEMPT_RESERVATIONS_CAPABILITY, ATTEMPT_RESERVATIONS_MINOR, remoteAttemptReceiptSchema,
  RELAY_RUNTIME_CAPABILITY, RELAY_RUNTIME_MINOR, signedRelayRuntimeEvidenceSchema, type RelayRuntimeObserveRequest, type RelayRuntimeCountRequest,
  type RemoteAttemptOffer, type RemoteAttemptCancel, type FederationAuth, type NodeIdentity, type RoutedCommand } from '@guanxi/contract/federation'
import { canonical, FederationError, requestProof, signValue, validSignature } from './crypto.ts'
import type { SharedConfig } from './config.ts'
import type { Federation } from './service.ts'

const handshakeSchema = z.object({ version: federationVersionSchema, negotiated: federationVersionSchema, readOnly: z.boolean(), capabilities: z.array(z.string()).optional() }).strict()
const resultSchema = z.object({ result: z.enum(['applied','stale_version','expired','invalid_state']) }).strict()
export interface ChannelOptions {
  local: NodeIdentity
  privateKey: string
  peer: NodeIdentity
  /** Transport must provide a private authenticated link (Tailscale/Headscale or TLS).
   * The URL is logical; the host maps it to a configured, pinned peer. */
  transport: (request: Request) => Promise<Response>
  clock?: () => number
}
export class FederationChannel {
  #options: ChannelOptions
  constructor(options: ChannelOptions) { this.#options = options }
  /** `beforeSend` runs after negotiation and signing and immediately before the transport is invoked, in the same
   * synchronous stretch: a fence check there cannot be overtaken by anything queued on this event loop. */
  private async request(method: string, path: string, body: unknown = null, beforeSend?: () => void): Promise<unknown> {
    const options = this.#options
    const route = `/api/federation${path}`
    const auth: FederationAuth = { nodeId: options.local.id, audience: options.peer.id, version: FEDERATION_VERSION,
      issuedAt: (options.clock ?? Date.now)(), nonce: randomUUID(), signature: '' }
    auth.signature = signValue(options.privateKey, requestProof(method, route, body, auth))
    beforeSend?.()
    const response = await options.transport(new Request(`https://federation.invalid${route}`, {
      method, headers: { 'X-Guanxi-Node': canonical(auth), 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: canonical(body) }), redirect: 'error',
    }))
    if (!response.ok) {
      const error = await response.json().catch(() => null) as {code?: unknown} | null
      if (response.status === 409 && error?.code === 'not_home') throw new FederationError('not_home')
      throw new FederationError('peer_refused', response.status)
    }
    return response.json()
  }
  private async negotiate(): Promise<{ readOnly: boolean; minor: number; capabilities: string[] }> {
    const handshake = handshakeSchema.parse(await this.request('GET','/handshake'))
    if (handshake.version.major > FEDERATION_VERSION.major) throw new FederationError('contract_incompatible',426)
    return { readOnly: handshake.version.major < FEDERATION_VERSION.major || handshake.readOnly,
      minor: handshake.version.minor, capabilities: handshake.capabilities ?? [] }
  }
  /** Anti-entropy pull; each peer is independent, and retries are idempotent. */
  async synchronize(local: Federation, streamIds: readonly string[] = []): Promise<{ readOnly: boolean } & ReturnType<SharedConfig['ingest']>> {
    // Verify the host's pin before accepting any remote data.
    const peer = local.peer(this.#options.peer.id)
    if (canonical(peer) !== canonical(this.#options.peer)) throw new FederationError('identity_conflict')
    const { readOnly } = await this.negotiate()
    // An older peer is a reader: it may pull our state, but cannot author imports into us.
    const config = { accepted: 0, duplicates: 0, deferred: 0, skipped: 0, reasons: {} as Record<string, number> }
    if (readOnly) return { readOnly: true, ...config }
    if (peer.scopes.includes('config')) {
      const result = z.object({operations:z.array(signedConfigOperationSchema)}).strict().parse(await this.request('GET','/config'))
      if (result.operations.some((op)=>op.operation.accountId!==local.identity.accountId)) throw new FederationError('owner_mismatch',403)
      Object.assign(config, local.config.ingest(result.operations))
    }
    for (const stream of streamIds) {
      if (local.replicas.binding(stream).homeNodeId !== peer.id) continue
      try {
        const result=z.object({entries:z.array(replicaEntrySchema)}).strict().parse(await this.request('GET',`/replicas/${encodeURIComponent(stream)}`))
        local.replicas.ingest(peer,result.entries)
      } catch (error) {
        if (!(error instanceof FederationError) || error.code !== 'not_home') throw error
      }
    }
    return { readOnly: false, ...config }
  }
  async command(command: RoutedCommand): Promise<string> {
    if (command.homeNodeId!==this.#options.peer.id) throw new FederationError('not_home')
    if ((await this.negotiate()).readOnly) throw new FederationError('contract_read_only',403)
    return resultSchema.parse(await this.request('POST','/commands',command)).result
  }
  private async attemptReady(executorNodeId: string): Promise<void> {
    if (executorNodeId !== this.#options.peer.id) throw new FederationError('wrong_executor')
    const negotiated = await this.negotiate()
    if (negotiated.readOnly) throw new FederationError('contract_read_only', 403)
    if (negotiated.minor < ATTEMPT_RESERVATIONS_MINOR || !negotiated.capabilities.includes(ATTEMPT_RESERVATIONS_CAPABILITY)) throw new FederationError('contract_feature_unavailable', 426)
  }
  async offer(offer: RemoteAttemptOffer) {
    if (offer.homeNodeId !== this.#options.local.id) throw new FederationError('not_home')
    await this.attemptReady(offer.executorNodeId)
    const receipt = remoteAttemptReceiptSchema.parse(await this.request('POST', '/attempts/offers', offer))
    if (receipt.offerId !== offer.id || receipt.runId !== offer.runId || receipt.homeNodeId !== offer.homeNodeId ||
      receipt.executorNodeId !== offer.executorNodeId || canonical(receipt.fence) !== canonical(offer.fence)) throw new FederationError('offer_receipt_mismatch')
    return receipt
  }
  async cancelOffer(input: RemoteAttemptCancel) {
    if (input.homeNodeId !== this.#options.local.id) throw new FederationError('not_home')
    await this.attemptReady(input.executorNodeId)
    const receipt = remoteAttemptReceiptSchema.parse(await this.request('POST', '/attempts/cancel', input))
    if (receipt.offerId !== input.offerId || receipt.homeNodeId !== input.homeNodeId || receipt.executorNodeId !== input.executorNodeId) throw new FederationError('offer_receipt_mismatch')
    return receipt
  }
  private async dispatchReady(ref: DispatchRef, toHome: boolean, ownerCancel = false): Promise<void> {
    if ((toHome ? ref.homeNodeId : ref.executorNodeId) !== this.#options.peer.id ||
      !ownerCancel && (toHome ? ref.executorNodeId : ref.homeNodeId) !== this.#options.local.id) throw new FederationError('dispatch_binding')
    const negotiated = await this.negotiate()
    if (negotiated.readOnly || negotiated.minor < ATTEMPT_DISPATCH_MINOR || !negotiated.capabilities.includes(ATTEMPT_DISPATCH_CAPABILITY)) throw new FederationError('contract_feature_unavailable', 426)
  }
  async dispatch(signed: SignedDispatchGrant, beforeSend?: () => void) {
    const g = signed.grant, ref = { id: g.id, homeNodeId: g.offer.homeNodeId, executorNodeId: g.offer.executorNodeId }
    await this.dispatchReady(ref, false)
    const state = dispatchStateSchema.parse(await this.request('POST', '/attempts/dispatch', signed, beforeSend))
    if (state.id !== ref.id) throw new FederationError('dispatch_binding')
    return state
  }
  async renewDispatch(ref: DispatchRef) {
    await this.dispatchReady(ref, true)
    const result = dispatchRenewalSchema.parse(await this.request('POST', '/attempts/renew', ref))
    if (result.id !== ref.id) throw new FederationError('dispatch_binding')
    return result
  }
  async dispatchEvent(signed: SignedDispatchEvent): Promise<void> {
    await this.dispatchReady(signed.entry.ref, true)
    z.object({ applied: z.literal(true) }).strict().parse(await this.request('POST', '/attempts/events', signed))
  }
  async dispatchState(ref: DispatchRef, cancel = false) {
    if (cancel) return this.cancelDispatch({ ...ref, expiresAt: (this.#options.clock ?? Date.now)() + 60_000 })
    await this.dispatchReady(ref, false)
    const state = dispatchStateSchema.parse(await this.request('POST', '/attempts/state', ref))
    if (state.id !== ref.id) throw new FederationError('dispatch_binding')
    return state
  }

  async cancelDispatch(raw: DispatchCancel) {
    const input = dispatchCancelSchema.parse(raw)
    await this.dispatchReady(input, false, true)
    const state = dispatchStateSchema.parse(await this.request('POST', '/attempts/dispatch-cancel', input))
    if (state.id !== input.id) throw new FederationError('dispatch_binding')
    return state
  }

  /** F2-d: the executor must advertise the relay runtime; an older minor or a missing capability is unavailable. */
  private async relayRuntimeReady(binding: { homeNodeId: string; executorNodeId: string }): Promise<void> {
    if (binding.homeNodeId !== this.#options.local.id || binding.executorNodeId !== this.#options.peer.id) throw new FederationError('wrong_executor')
    const negotiated = await this.negotiate()
    if (negotiated.readOnly || negotiated.minor < RELAY_RUNTIME_MINOR || !negotiated.capabilities.includes(RELAY_RUNTIME_CAPABILITY)) throw new FederationError('contract_feature_unavailable', 426)
  }
  /** The evidence must be signed by the pinned executor key and echo exactly what was asked, including the fresh
   * challenge, or it is not evidence for this request. */
  private relayEvidence(raw: unknown, request: RelayRuntimeObserveRequest, kind: 'observe' | 'count') {
    const signed = signedRelayRuntimeEvidenceSchema.parse(raw), entry = signed.entry
    if (!validSignature(this.#options.peer.publicKey, entry, signed.signature)) throw new FederationError('invalid_signature', 403)
    if (entry.kind !== kind || entry.executorNodeId !== this.#options.peer.id || entry.challenge !== request.challenge ||
      canonical(entry.binding) !== canonical(request.binding)) throw new FederationError('relay_evidence_mismatch')
    return entry
  }
  async relayObserve(request: RelayRuntimeObserveRequest) {
    await this.relayRuntimeReady(request.binding)
    return this.relayEvidence(await this.request('POST', '/attempts/runtime/observe', request), request, 'observe')
  }
  async relayCount(request: RelayRuntimeCountRequest) {
    await this.relayRuntimeReady(request.binding)
    return this.relayEvidence(await this.request('POST', '/attempts/runtime/count', request), request, 'count')
  }
}
