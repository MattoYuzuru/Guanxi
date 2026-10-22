import { createHash, randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import { RELAY_RUNTIME_PROBE, type CountedRequest, type LocalInferenceJob, type RelayRuntimeBinding } from '@guanxi/contract/federation'
import type { Federation } from '../federation/service.ts'
import type { FederationChannel } from '../federation/channel.ts'
import { FederationError, canonical } from '../federation/crypto.ts'
import type { LocalChatTransport } from '../connections/service.ts'
import type { OllamaChatChunk, OllamaChatRequest } from '../ollama/types.ts'
import type { RunStore } from '../runs/store.ts'
import type { Attempt } from '../runs/types.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { invariant, RelayError } from './types.ts'
import type { RelayExactCounter, RelayRuntimeObservation, RelayRuntimeObserver, RelayRuntimeSession } from './runtime.ts'
import { abortableRead } from './runtime.ts'

export const REMOTE_RELAY_COUNTER_SOURCE = 'federation:llama-server:/apply-template+/tokenize'
export const REMOTE_RELAY_PROPS_SOURCE = 'federation:llama_server_props'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface RemoteRelayRuntimeOptions {
  /** The home node's federation service: its signed channel, its R1 store and its dispatch ledger. */
  federation: Federation
  runs: RunStore
  /** The pinned owner-device executor whose llama-server counts and serves every request. */
  executorNodeId: string
  /** The one model reference that server instance serves. */
  model: string
  /** Same clock as the relay runtime source (observation time is the home send time). */
  clock?: () => number
  /** Wall deadline of one model call, from its grant. Default 30 minutes, as the local `/completion` timeout. */
  callDeadlineMs?: number
  /** How long the executor may take to admit a call (its governor queue). Default one minute. */
  reservationMs?: number
  /** Granularity of the fence heartbeat and executor-loss check while a call is pending. Default 25 ms. */
  pollMs?: number
  /** After a cancel, how long to retry an unconfirmed ACK before relying on the holder's own expiry.
   * Must be at least the dispatch holder TTL for the guarantee to hold; default is the TTL given here. */
  cancelWaitMs: number
  /** Distinct exact answers remembered per session. Default 512. */
  cacheEntries?: number
  /** Host seam called synchronously when the relay run exists, inside its creation transaction. The executor
   * needs the run pinned (F1 explicit pin) before the first bound request; a throw refuses the whole start. */
  onBind?: (run: NonNullable<RelayRuntimeBinding['run']>) => void
}
/** Home-side relay runtime on another node. It is a factory of per-start sessions because every piece of
 * evidence is bound to one relay run and its fence. Used directly it refuses: there is no unbound fallback. */
export class RemoteRelayRuntime implements RelayRuntimeObserver {
  readonly remote: { readonly nodeId: string }
  readonly host: string
  readonly model: string
  private readonly options: RemoteRelayRuntimeOptions
  constructor(options: RemoteRelayRuntimeOptions) {
    const model = normalizeOllamaModelReference(options.model)
    invariant(model && !/:cloud$/i.test(options.model) && options.executorNodeId, 'relay_local_model_required')
    for (const ms of [options.cancelWaitMs, options.callDeadlineMs ?? 1, options.reservationMs ?? 1, options.pollMs ?? 1, options.cacheEntries ?? 1]) {
      invariant(Number.isSafeInteger(ms) && ms > 0, 'relay_policy_invalid')
    }
    this.options = Object.freeze({ ...options }); this.model = model
    this.remote = Object.freeze({ nodeId: options.executorNodeId })
    this.host = `federation://${encodeURIComponent(options.executorNodeId)}`
  }
  get transport(): LocalChatTransport { throw new RelayError('runtime_meter_unavailable') }
  observe(): Promise<RelayRuntimeObservation> { return Promise.reject(new RelayError('runtime_meter_unavailable')) }
  open(): RelayRuntimeSession {
    let channel: FederationChannel
    try { channel = this.options.federation.relayChannel(this.options.executorNodeId) } catch { throw new RelayError('runtime_meter_unavailable') }
    return new RemoteRelaySession(this.options, this.model, this.host, channel)
  }
}

interface Counted { evidence: CountedRequest; identity: string }
class RemoteRelaySession implements RelayRuntimeSession {
  readonly remote: { readonly nodeId: string }
  readonly transport: LocalChatTransport
  readonly model: string
  readonly host: string
  private readonly options: RemoteRelayRuntimeOptions
  private readonly channel: FederationChannel
  private readonly lifetime = new AbortController()
  private readonly clock: () => number
  private readonly cache = new Map<string, Counted>()
  private attempt: Attempt | undefined
  private identity = ''
  private proven = ''
  private fact: RelayRuntimeObservation | undefined
  constructor(options: RemoteRelayRuntimeOptions, model: string, host: string, channel: FederationChannel) {
    this.options = options; this.model = model; this.host = host; this.channel = channel
    this.clock = options.clock ?? Date.now
    this.remote = Object.freeze({ nodeId: options.executorNodeId })
    this.transport = Object.freeze({ id: 'llama-server', host, usageSource: 'federation:llama-server:/completion', remote: this.remote,
      chat: (request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void,
        dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest }) => this.chat(request, signal, onDispatched, dispatch) })
  }
  /** A refusal that is not a cancellation: no unreachable, unsigned or unintelligible executor yields facts. */
  private refuse(error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted) throw signal.reason ?? error
    if (this.lifetime.signal.aborted) throw new RelayError('relay_stopped')
    if (error instanceof RelayError) throw error
    if (error instanceof ZodError) throw new RelayError('runtime_identity_unknown')
    if (error instanceof FederationError) {
      if (['invalid_signature', 'relay_evidence_mismatch', 'not_home'].includes(error.code)) throw new RelayError('runtime_identity_unknown')
      if (error.code === 'peer_refused' && [403, 404, 409].includes(error.status)) throw new RelayError('runtime_identity_unknown')
    }
    if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'stale_lease') throw error
    throw new RelayError('runtime_meter_unavailable')
  }
  private binding(): RelayRuntimeBinding {
    const a = this.attempt
    return { homeNodeId: this.options.federation.identity.id, executorNodeId: this.options.executorNodeId, model: this.model,
      run: a ? { runId: a.run_id, sessionId: this.options.runs.get(a.run_id).session_id, fence: { attemptId: a.id, epoch: a.epoch, token: a.token } } : null }
  }
  /** The home is the only authority on its own run: a lost fence refuses before a request leaves and after
   * every answer arrives, so evidence gathered under a deposed attempt is never used. */
  private fence(): void {
    if (this.lifetime.signal.aborted) throw new RelayError('relay_stopped')
    if (this.attempt) this.options.runs.mutate(this.attempt, () => undefined)
  }
  bind(attempt: Attempt): void {
    invariant(!this.attempt, 'relay_policy_invalid')
    const run = { runId: attempt.run_id, sessionId: this.options.runs.get(attempt.run_id).session_id, fence: { attemptId: attempt.id, epoch: attempt.epoch, token: attempt.token } }
    this.options.onBind?.(run)
    this.attempt = attempt
  }
  async close(): Promise<void> { this.lifetime.abort(new RelayError('relay_stopped')); this.cache.clear() }
  private signalFor(signal: AbortSignal): AbortSignal { return AbortSignal.any([this.lifetime.signal, signal]) }

  async observe(reference: string, signal: AbortSignal): Promise<RelayRuntimeObservation> {
    invariant(reference === this.model, 'runtime_identity_unknown')
    const active = this.signalFor(signal)
    active.throwIfAborted()
    try {
      this.fence()
      const sent = this.clock(), request = { binding: this.binding(), challenge: randomUUID() }
      const evidence = await abortableRead(this.channel.relayObserve(request), active)
      active.throwIfAborted(); this.fence()
      invariant(normalizeOllamaModelReference(evidence.model) === this.model && evidence.digest && evidence.source, 'runtime_identity_unknown')
      const identity = canonical([evidence.digest, evidence.runtimeVersion, evidence.contextTokens])
      // Remembered answers belong to one served identity.
      if (this.identity && this.identity !== identity) { this.cache.clear(); this.proven = '' }
      this.identity = identity
      const observation = { model: this.model, digest: evidence.digest, contextTokens: evidence.contextTokens, runtimeVersion: evidence.runtimeVersion,
        source: REMOTE_RELAY_PROPS_SOURCE, observedAt: sent }
      this.fact = observation
      return observation
    } catch (error) { return this.refuse(error, active) }
  }
  private message(request: Readonly<OllamaChatRequest>): string {
    invariant(request.think === false && request.messages.length === 1 && request.messages[0]!.role === 'user' &&
      typeof request.messages[0]!.content === 'string', 'runtime_request_changed')
    return request.messages[0]!.content
  }
  /** One exact count by the executor's own llama-server. The answer is kept only for this served identity. */
  private async countRemote(content: string, signal: AbortSignal): Promise<Counted> {
    const key = sha256(content), known = this.cache.get(key)
    if (known && known.identity === this.identity) return known
    const active = this.signalFor(signal)
    active.throwIfAborted()
    try {
      this.fence()
      const request = { binding: this.binding(), challenge: randomUUID(), content }
      const evidence = await abortableRead(this.channel.relayCount(request), active)
      active.throwIfAborted(); this.fence()
      const count = evidence.count
      invariant(count && count.contentSha256 === key && normalizeOllamaModelReference(evidence.model) === this.model, 'runtime_counter_mismatch')
      // The count must have been made by the server identity that was observed; anything else is not its count.
      invariant(this.fact && evidence.digest === this.fact.digest && evidence.runtimeVersion === this.fact.runtimeVersion && evidence.contextTokens === this.fact.contextTokens, 'runtime_identity_changed')
      const counted: Counted = { identity: this.identity, evidence: { contentSha256: key, renderedSha256: count.renderedSha256, tokens: count.tokens,
        digest: evidence.digest, contextTokens: evidence.contextTokens } }
      if (this.cache.size >= (this.options.cacheEntries ?? 512)) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, counted)
      return counted
    } catch (error) { return this.refuse(error, active) }
  }
  /** `RelayRuntimePolicy.counter` for this session. It re-observes so its identity is its own evidence and counts
   * the fixed admission probe once per served identity, which makes the executor prove its template round trip. */
  async counter(fact: Readonly<{ model: string; digest: string; runtimeVersion: string; contextTokens: number }>, signal: AbortSignal): Promise<RelayExactCounter> {
    const seen = await this.observe(fact.model, signal)
    if (this.proven !== this.identity) { await this.countRemote(RELAY_RUNTIME_PROBE, signal); this.proven = this.identity }
    return { identity: { model: seen.model, digest: seen.digest, runtimeVersion: seen.runtimeVersion }, placement: 'installed_local',
      source: REMOTE_RELAY_COUNTER_SOURCE, observedAt: seen.observedAt, confidence: 'high',
      count: request => this.lookup(this.message(request)),
      countAsync: async (request, active) => (await this.countRemote(this.message(request), active)).evidence.tokens }
  }
  /** Synchronous exact count: a lookup of an answer the executor already gave for these exact bytes. There is no
   * estimate and no fallback; a string the executor has not counted is refused. */
  private lookup(content: string): number {
    const known = this.cache.get(sha256(content))
    invariant(known && known.identity === this.identity, 'runtime_count_invalid')
    return known.evidence.tokens
  }

  private async chat(request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void,
    dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest }): Promise<OllamaChatChunk> {
    const active = this.signalFor(signal)
    invariant(this.attempt, 'runtime_meter_unavailable')
    const attempt = this.attempt, federation = this.options.federation, runs = this.options.runs
    this.fence()
    await dispatch.authorizeDispatch()
    active.throwIfAborted()
    const first = dispatch.prepare(), content = this.message(first)
    const window = first.options?.num_ctx, limit = first.options?.num_predict
    invariant(Number.isSafeInteger(window) && Number.isSafeInteger(limit) && limit! > 0, 'runtime_request_changed')
    const counted = this.cache.get(sha256(content))
    invariant(counted && counted.identity === this.identity, 'runtime_count_invalid')
    invariant(counted.evidence.tokens + limit! <= window! && window! === counted.evidence.contextTokens, 'context_ceiling')
    const childId = `rc-${randomUUID()}`
    const session = runs.get(attempt.run_id).session_id
    const job: LocalInferenceJob = { kind: 'local_inference', model: request.model, context: window!, outputTokens: limit!,
      deadline: this.clock() + (this.options.callDeadlineMs ?? 30 * 60_000), messages: [{ role: 'user', content }], counted: counted.evidence }
    let offerId: string | undefined, dispatched = false
    const ref = () => ({ id: offerId!, homeNodeId: federation.identity.id, executorNodeId: this.options.executorNodeId })
    try {
      runs.create({ id: childId, sessionId: session })
      const offer = federation.prepareDispatch(childId, this.options.executorNodeId, job, this.options.reservationMs ?? 60_000, attempt.run_id)
      offerId = offer.id
      // The audit link from the relay run to its child, in the same fenced transaction as a fence check.
      runs.mutate(attempt, (_db, emit) => emit({ type: 'agent.note', data: { text: canonical({ relay: 'remote_call', child: childId, offer: offer.id, executor: this.options.executorNodeId }) } }))
      const receipt = await abortableRead(this.channel.offer(offer), active)
      invariant(receipt.status === 'reserved' && receipt.reservation, 'runtime_meter_unavailable')
      const grant = federation.grantDispatch(offer.id, receipt)
      // Negotiation happens first; then the final scrub, fence and shape checks, the R1-fenced start observation and
      // the signed request are one synchronous stretch. Nothing queued on this event loop can run between them.
      dispatched = true
      await abortableRead(this.channel.dispatch(grant, () => {
        active.throwIfAborted()
        invariant(canonical(dispatch.prepare()) === canonical(first), 'runtime_request_changed')
        onDispatched()
      }), active)
      const terminal = await federation.attemptDispatch!.awaitTerminal(offer.id, active, () => {
        // A deposed relay attempt aborts the call; an executor that stopped renewing leaves its child interrupted.
        onDispatched()
        runs.tick()
        const child = runs.get(childId)
        if (child.state === 'interrupted') throw new RelayError('runtime_meter_unavailable')
        if (this.clock() >= job.deadline) throw new RelayError('model_failed')
      }, this.options.pollMs ?? 25)
      active.throwIfAborted()
      if (terminal.outcome !== 'completed') throw new RelayError(terminal.reason ?? (terminal.outcome === 'canceled' ? 'relay_stopped' : 'model_failed'))
      // The executor evaluated the rendering and the token count that were counted, or the call is not accepted.
      invariant(terminal.source === 'llama-server:/completion' && terminal.renderedSha256 === counted.evidence.renderedSha256 &&
        terminal.inputTokens === counted.evidence.tokens && terminal.outputTokens !== null, 'truncation_protocol')
      return { model: request.model, created_at: new Date(this.clock()).toISOString(), done: true, done_reason: terminal.doneReason === 'length' ? 'length' : 'stop',
        message: { role: 'assistant', content: terminal.content }, prompt_eval_count: terminal.inputTokens!, eval_count: terminal.outputTokens! }
    } catch (error) {
      // The call settles only after the executor acknowledged the cancel (or its holder has provably expired).
      await this.stop(childId, offerId ? ref() : undefined, dispatched)
      throw error
    }
  }
  /** Cancel at the home first, so renewals and late results are refused, then ask the executor directly and wait for its
   * ACK. Without an ACK the wait ends when the holder TTL has elapsed: by then the holder has fenced itself. */
  private async stop(childId: string, ref: { id: string; homeNodeId: string; executorNodeId: string } | undefined, dispatched: boolean): Promise<void> {
    // An executor that stopped renewing leaves its child `interrupted` (R1 expiry); that is a loss, not a cancel.
    try { if (this.options.runs.get(childId).state !== 'interrupted') this.options.runs.cancel(childId) } catch { /* A deposed home cannot cancel; the holder fences itself on its next renewal. */ }
    if (!ref) return
    const end = Date.now() + this.options.cancelWaitMs
    const missing = (error: unknown) => error instanceof FederationError && error.code === 'peer_refused' && error.status === 404
    for (;;) {
      try {
        let state: { status: string } | undefined
        // A 404 means the executor never accepted the grant: only its reservation can still be held.
        if (dispatched) try { state = await this.channel.cancelDispatch({ ...ref, expiresAt: this.clock() + 60_000 }) } catch (error) { if (!missing(error)) throw error }
        if (state && ['canceled', 'lost', 'completed', 'failed'].includes(state.status)) return
        if (!state) { await this.channel.cancelOffer({ offerId: ref.id, homeNodeId: ref.homeNodeId, executorNodeId: ref.executorNodeId }); return }
      } catch (error) {
        if (missing(error)) return
      }
      if (Date.now() >= end) return
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, end - Date.now()))))
    }
  }
}
