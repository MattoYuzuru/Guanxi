import { relayRuntimeFactSchema, relayMeterFactSchema, type RelayRuntimeFact, type RelayMeterFact } from '@guanxi/contract'
import type { Connections, LocalChatTransport } from '../connections/service.ts'
import type { ModelService } from '../models/service.ts'
import type { OllamaChatRequest } from '../ollama/types.ts'
import type { Attempt } from '../runs/types.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import { invariant } from './types.ts'
import type { RuntimeMeter } from './model.ts'
import { canonical } from './handoff.ts'

/** The server supplies this port only after proving its renderer/tokenizer binding.
 * There is deliberately no stock Ollama, byte-count or catalog fallback. */
export interface RelayExactCounter {
  identity: { model: string; digest: string; runtimeVersion: string }
  placement: 'installed_local'
  source: string
  observedAt: number
  confidence: 'high'
  count(request: Readonly<OllamaChatRequest>): number
  /** F2-d: the exact answer needs a network round trip. `count` is then a lookup of answers already obtained. */
  countAsync?(request: Readonly<OllamaChatRequest>, signal: AbortSignal): Promise<number>
}
/** One loaded-model observation from a non-Ollama runtime (R2-op: llama-server). The observer, the
 * counter and the transport are one trusted host unit: the process that renders and counts the
 * request is the process that is dispatched to. */
export interface RelayRuntimeObservation { model: string; digest: string; contextTokens: number; runtimeVersion: string; source: string; observedAt: number }
export interface RelayRuntimeObserver {
  /** Loopback origin of the runtime, or a `federation://` label when `remote` is set. */
  readonly host: string
  readonly transport: LocalChatTransport
  /** F2-d: the runtime belongs to another owned node and every fact arrives as signed, fenced F2 evidence. */
  readonly remote?: { readonly nodeId: string }
  observe(reference: string, signal: AbortSignal): Promise<RelayRuntimeObservation>
  /** F2-d: one session per relay start, because evidence is bound to the run and its fence. */
  open?(): RelayRuntimeSession
}
export interface RelayRuntimeSession extends RelayRuntimeObserver {
  counter(fact: Readonly<RelayRuntimeFact>, signal: AbortSignal): Promise<RelayExactCounter>
  /** Called once the relay run and its first attempt exist; later evidence carries that fence. */
  bind(attempt: Attempt): void
  close(): Promise<void>
}
export interface RelayRuntimePolicy {
  maximumAgeMs: number
  counter?: (fact: Readonly<RelayRuntimeFact>, signal: AbortSignal) => Promise<RelayExactCounter>
  /** Replaces Ollama `/api/ps`, `/api/tags` and `/api/version` as the loaded-model source and
   * routes dispatch through the observer's transport. Absent for stock Ollama. */
  observer?: RelayRuntimeObserver
}
export type RelayRuntimeModels = Pick<ModelService, 'ps' | 'installedArtifacts' | 'runtimeVersion' | 'runtimeHost'>
export interface PreparedRelayRuntime { fact: RelayRuntimeFact; meterFact: RelayMeterFact; meter: RuntimeMeter; validate(): void
  /** Present for a session-based (remote) runtime. */
  bind?(attempt: Attempt): void
  release?(): Promise<void> }

/** Cancellation releases read-only waits, while observing their late outcomes. Resource-owning
 * operations (workspace allocation/settlement) must acknowledge cleanup instead of using this. */
export async function abortableRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let remove = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Error('relay_stopped'))
    signal.addEventListener('abort', stop, { once: true })
    remove = () => signal.removeEventListener('abort', stop)
    if (signal.aborted) stop()
  })
  try { return await Promise.race([pending, aborted]) } finally { remove() }
}

export class RelayRuntimeSource {
  private readonly maximumAge: number
  private readonly counter: RelayRuntimePolicy['counter']
  private readonly observer: RelayRuntimePolicy['observer']
  private readonly connections: Connections
  private readonly models: () => RelayRuntimeModels
  private readonly clock: () => number
  constructor(connections: Connections, models: () => RelayRuntimeModels,
    policy: RelayRuntimePolicy, clock = Date.now) {
    this.connections = connections; this.models = models; this.clock = clock
    invariant(Number.isSafeInteger(policy.maximumAgeMs) && policy.maximumAgeMs > 0, 'runtime_policy_invalid')
    this.maximumAge = policy.maximumAgeMs; this.counter = policy.counter; this.observer = policy.observer
  }
  private fresh(observedAt: number): void {
    const now = this.clock()
    invariant(Number.isSafeInteger(now) && Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt <= now && now - observedAt <= this.maximumAge, 'runtime_observation_stale')
  }
  private connection(id: string): void {
    const snapshot = this.connections.snapshot('local'), c = snapshot.connections.find(c => c.id === id)
    invariant(c?.kind === 'local_runtime' && c.unattended && snapshot.vault.unattendedAvailable, 'relay_local_connection_required')
  }
  async prepare(connectionId: string, model: string, turn: number, signal: AbortSignal): Promise<PreparedRelayRuntime> {
    invariant(this.counter || this.observer?.open, 'runtime_meter_unavailable')
    this.connection(connectionId)
    const reference = normalizeOllamaModelReference(model)
    invariant(reference && !/:cloud$/i.test(model), 'relay_local_model_required')
    const session = this.observer?.open?.()
    try { return await this.prepared(connectionId, model, turn, signal, reference, session) } catch (error) { await session?.close().catch(() => undefined); throw error }
  }
  private async prepared(connectionId: string, model: string, turn: number, signal: AbortSignal, reference: string, session: RelayRuntimeSession | undefined): Promise<PreparedRelayRuntime> {
    const observer = session ?? this.observer
    const counterPort = session ? (fact: Readonly<RelayRuntimeFact>, s: AbortSignal) => session.counter(fact, s) : this.counter!
    const runtimeHost = () => observer ? observer.host : this.models().runtimeHost
    const admittedHost = runtimeHost()
    const sample = async (activeSignal = signal): Promise<RelayRuntimeFact> => {
      activeSignal.throwIfAborted(); this.connection(connectionId)
      const host = new URL(runtimeHost())
      invariant(runtimeHost() === admittedHost, 'runtime_identity_changed')
      // A remote runtime has no loopback origin: its identity is the signed executor node, checked by its session.
      if (observer?.remote) invariant(host.protocol === 'federation:' && host.hostname === encodeURIComponent(observer.remote.nodeId) && (host.pathname === '' || host.pathname === '/') && !host.username && !host.password && !host.search && !host.hash, 'relay_local_connection_required')
      else invariant(['http:', 'https:'].includes(host.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) &&
        !host.username && !host.password && !host.search && !host.hash, 'relay_local_connection_required')
      if (observer) {
        const seen = await abortableRead(observer.observe(reference, activeSignal), activeSignal)
        activeSignal.throwIfAborted(); this.connection(connectionId)
        invariant(runtimeHost() === admittedHost, 'runtime_identity_changed')
        invariant(seen.model === reference && seen.digest && seen.source, 'runtime_identity_unknown')
        this.fresh(seen.observedAt)
        return relayRuntimeFactSchema.parse({ model: reference, digest: seen.digest, contextTokens: seen.contextTokens,
          runtimeVersion: seen.runtimeVersion, source: seen.source, observedAt: seen.observedAt, confidence: 'high' })
      }
      const source = this.models()
      const [running, installed, version] = await abortableRead(Promise.all([
        source.ps(activeSignal), source.installedArtifacts(activeSignal), source.runtimeVersion(activeSignal),
      ]), activeSignal)
      activeSignal.throwIfAborted(); this.connection(connectionId)
      invariant(this.models().runtimeHost === source.runtimeHost, 'runtime_identity_changed')
      const rows = running.filter(row => normalizeOllamaModelReference(row.name) === reference)
      const artifacts = installed.filter(row => normalizeOllamaModelReference(row.name) === reference)
      invariant(rows.length === 1 && artifacts.length === 1 && rows[0]!.digest && rows[0]!.digest === artifacts[0]!.digest, 'runtime_identity_unknown')
      const row = rows[0]!
      invariant(row.source === 'ollama_api_ps' && typeof row.observedAt === 'string', 'runtime_identity_unknown')
      const observedAt = Date.parse(row.observedAt)
      this.fresh(observedAt)
      return relayRuntimeFactSchema.parse({ model: reference, digest: row.digest, contextTokens: row.contextLength,
        runtimeVersion: version, source: row.source, observedAt, confidence: 'high' })
    }
    const fact = Object.freeze(await sample())
    let current = fact, counterTime = 0, counterSource = '', count!: RelayExactCounter['count'], countAsyncPort: RelayExactCounter['countAsync']
    const bind = async (next: RelayRuntimeFact, activeSignal = signal) => {
      const counter = await abortableRead(counterPort(Object.freeze({ ...next }), activeSignal), activeSignal)
      activeSignal.throwIfAborted()
      invariant(counter.placement === 'installed_local' && counter.confidence === 'high' && counter.source &&
        (!counterSource || counter.source === counterSource) &&
        counter.identity.model === fact.model && counter.identity.digest === fact.digest && counter.identity.runtimeVersion === fact.runtimeVersion,
      'runtime_counter_mismatch')
      this.fresh(counter.observedAt); current = next; counterTime = counter.observedAt; counterSource = counter.source; count = counter.count.bind(counter); countAsyncPort = counter.countAsync?.bind(counter)
    }
    await bind(fact)
    const meterFact = Object.freeze(relayMeterFactSchema.parse({ source: counterSource, observedAt: counterTime, confidence: 'high',
      measurement: 'exact_rendered_request', framing: 'included', computeCost: 'host_local_compute_policy' }))
    const validate = () => { signal.throwIfAborted(); this.connection(connectionId)
      invariant(runtimeHost() === admittedHost, 'runtime_identity_changed')
      this.fresh(current.observedAt); this.fresh(counterTime) }
    validate()
    const render = (prompt: string): OllamaChatRequest => ({ model, stream: false, think: false,
      messages: [{ role: 'user', content: prompt }], options: { num_ctx: fact.contextTokens, num_predict: turn } })
    const meter: RuntimeMeter = {
      countIsExact: true, localOnly: true, ...(observer ? { transport: observer.transport } : {}),
      count(prompt) { validate(); const n = count(render(prompt)); invariant(Number.isSafeInteger(n) && n >= 0, 'runtime_count_invalid'); return n },
      ...(countAsyncPort ? { async countAsync(prompt: string, callSignal?: AbortSignal) {
        const activeSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal
        validate(); const n = await abortableRead(countAsyncPort!(render(prompt), activeSignal), activeSignal)
        activeSignal.throwIfAborted(); validate(); invariant(Number.isSafeInteger(n) && n >= 0, 'runtime_count_invalid'); return n } } : {}),
      async observe(callSignal) { const activeSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal
        activeSignal.throwIfAborted(); const next = await sample(activeSignal); invariant(next.digest === fact.digest && next.contextTokens === fact.contextTokens &&
        next.runtimeVersion === fact.runtimeVersion && next.source === fact.source, 'runtime_identity_changed')
        await bind(next, activeSignal); activeSignal.throwIfAborted(); validate()
        return { tokens: fact.contextTokens, source: fact.source, observedAt: next.observedAt, confidence: 'high', framingTokens: 0 } },
      authorizeDispatch: async callSignal => { await meter.observe(callSignal); validate() },
      validatePrepared: request => { validate(); invariant(canonical(request) === canonical(render(request.messages[0]!.content)), 'runtime_request_changed') },
      // Explicit trusted local-compute policy, not an observed provider bill.
      maxCostMicros: () => { validate(); return 0 },
    }
    return { fact, meterFact, meter, validate, ...(session ? { bind: (attempt: Attempt) => session.bind(attempt), release: () => session.close() } : {}) }
  }
}
