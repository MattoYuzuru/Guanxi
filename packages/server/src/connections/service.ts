import { normalizeHost } from '../ollama/normalize-host.ts'
import { ConnectionError } from './errors.ts'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { AssistantMessage, Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ConnectionSnapshot, CreateConnection } from '@guanxi/contract'
import type { OllamaAdapter } from '../ollama/plugin.ts'
import type { OllamaChatRequest, OllamaChatChunk } from '../ollama/types.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import type { Vault } from '../vault/vault.ts'
import type { BalanceProbes } from '../probes/balances.ts'
import { ConnectionStore } from './store.ts'
import { assertApiKey, piModels, piTransport, type PiTransport } from './pi.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { modelsDevFacts } from './metadata.ts'

export interface ModelCall {
  model: string; runId: string; requestId: string; background?: boolean
  /** Trusted billing boundary: one K3-visible HTTP attempt, never a provider retry. */
  singleAttempt?: true
  signal?: AbortSignal
  /** Trusted executor observation after dispatch starts; never supplied by HTTP/model input. */
  onStarted?: () => void
  /** API response/chunk observation for native inference acknowledgment. */
  onResponseObserved?: () => void
  /** Trusted validation of the final scrubbed request, immediately before dispatch. */
  onPrepared?: (request: Context | OllamaChatRequest) => void
  /** T0 local authorization after governor and adapter preflight, before final preparation. */
  authorizeDispatch?: () => Promise<void>
  /** Adapter parameters, not arbitrary transport/auth headers. */
  options?: Pick<SimpleStreamOptions, 'temperature' | 'maxTokens' | 'reasoning'>
}
/** A trusted T0 chat transport for a loopback runtime that is not the configured Ollama host (R2-op:
 * llama-server). It is supplied by an execution host through `localChat`, never by HTTP or model
 * input. K3 keeps scrubbing, unattended consent, the governor permit, the loopback check and the
 * usage receipt; the transport only replaces the wire call. It must not return or throw before its
 * own request has settled, because the governor permit is released when it does. */
export interface LocalChatTransport {
  /** Short runtime label; prefixes the governor model name and never appears in HTTP. */
  readonly id: string
  /** Loopback origin the transport talks to. */
  readonly host: string
  /** Receipt source label recorded with the usage observation. */
  readonly usageSource: string
  /** F2-d: the runtime is on another owned node (`host` is then a `federation://` label). That node's own
   * governor admits the call through its F2 reservation, so this node neither requires a loopback origin nor
   * takes a permit of its own hardware. Scrubbing, consent and the usage receipt are unchanged. */
  readonly remote?: { readonly nodeId: string }
  chat(request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void,
    dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest }): Promise<OllamaChatChunk>
}
export class Connections {
  private closed = false
  private active = new Set<Promise<unknown>>()
  readonly store: ConnectionStore
  #vault: Vault
  private readonly probes: BalanceProbes
  private readonly scrubber: EgressScrubber
  private readonly lifetime: AbortSignal
  private readonly ollama: OllamaAdapter
  private readonly governor: ResourceGovernor
  private readonly localHost: () => string
  private readonly pi: PiTransport
  private readonly transport: typeof fetch
  constructor(store: ConnectionStore, vault: Vault, probes: BalanceProbes,
    scrubber: EgressScrubber, lifetime: AbortSignal,
    ollama: OllamaAdapter, governor: ResourceGovernor,
    localHost: () => string, pi: PiTransport = piTransport,
    transport: typeof fetch = globalThis.fetch) {
    this.store = store
    this.#vault = vault
    this.probes = probes
    this.scrubber = scrubber
    this.lifetime = lifetime
    this.ollama = ollama
    this.governor = governor
    this.localHost = localHost
    this.pi = pi
    this.transport = transport
  }
  private assertOpen() { if (this.closed) throw new Error('Connections plugin unloaded'); this.lifetime.throwIfAborted() }
  private track<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const promise = task()
    this.active.add(promise)
    void promise.finally(() => this.active.delete(promise)).catch(() => undefined)
    return promise
  }
  snapshot(accountId: string): ConnectionSnapshot {
    this.assertOpen()
    return this.scrubber.scrub({ connections: this.store.list(accountId), costs: this.store.costs(accountId),
      vault: { unlocked: this.#vault.unlocked(accountId), unattendedAvailable: this.#vault.unattendedAvailable } })
  }
  create(accountId: string, input: CreateConnection) {
    this.assertOpen()
    if (input.unattended && !this.#vault.unattendedAvailable) throw new ConnectionError('policy_denied', 'Node unattended access is not enabled')
    return this.store.create(accountId, input)
  }
  setUnattended(accountId: string, id: string, unattended: boolean) {
    this.assertOpen()
    if (unattended && !this.#vault.unattendedAvailable) throw new ConnectionError('policy_denied', 'Node unattended access is not enabled')
    this.store.get(accountId, id)
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      this.#vault.prepareUnattended(accountId, id, unattended)
      const result = this.store.setUnattended(accountId, id, unattended)
      this.store.db.exec('COMMIT')
      return result
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
  }
  saveSecret(accountId: string, id: string, value: string) {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    if (connection.auth !== 'api_key') throw new ConnectionError('policy_denied', 'CLI logins are managed by the official CLI')
    assertApiKey(connection.provider, value)
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      const ref = this.#vault.put(accountId, value)
      this.#vault.prepareUnattended(accountId, id, connection.unattended && this.#vault.unattendedAvailable, ref)
      const result = this.store.setSecret(accountId, id, ref)
      this.store.db.exec('COMMIT')
      return result
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
  }
  unlockVault(accountId: string) { return this.track(() => this.#vault.unlock(accountId)) }
  lockVault(accountId: string) { this.assertOpen(); this.#vault.lock(accountId) }
  probe(accountId: string, id: string, signal?: AbortSignal) {
    return this.track(() => this.probes.probe(this.store.get(accountId, id), signal
      ? AbortSignal.any([this.lifetime, signal]) : this.lifetime))
  }
  models(accountId: string, id: string) {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    const observedAt = new Date().toISOString()
    return piModels(connection.provider).map(model => ({ id: model.id, facts: {
      'pi-ai.context': { value: model.contextWindow, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      'pi-ai.output': { value: model.maxTokens, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      'pi-ai.reasoning': { value: model.reasoning, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      ...modelsDevFacts(connection.provider, model.id),
    } }))
  }
  complete(accountId: string, id: string, context: Context, call: ModelCall): Promise<AssistantMessage> {
    return this.track(async () => {
      const connection = this.store.get(accountId, id)
      if (connection.kind !== 'model_api' || connection.auth !== 'api_key') throw new ConnectionError('policy_denied', 'This connection is not a model API')
      const model = piModels(connection.provider).find(item => item.id === call.model)
      if (!model) throw new ConnectionError('connection_not_found', 'Model not found in the provider catalog')
      if (call.singleAttempt && !['anthropic-messages', 'openai-responses', 'openai-completions'].includes(model.api))
        throw new ConnectionError('policy_denied', 'Single-attempt transport is unavailable for this wire protocol')
      // Per logical call, including any adapter fallback. Never share this counter
      // between concurrent requests, or trust SDK retry settings as the only guard.
      let httpAttempts = 0
      const dispatchAbort = new AbortController()
      const signal = AbortSignal.any([this.lifetime, dispatchAbort.signal, ...(call.signal ? [call.signal] : [])])
      try {
        return await this.#vault.inject(accountId, id, call.background ?? false, async key => {
          assertApiKey(connection.provider, key)
          this.#vault.assertScrubbingReady(accountId)
          signal.throwIfAborted()
          // Scrub the complete context, including tool results and tool schemas,
          // before pi-ai turns it into a provider-specific request.
          const clean = this.scrubber.scrub(context)
          call.onPrepared?.(clean)
          let quota = false
          const observeResponse = () => {
            try { call.onResponseObserved?.() } catch (error) { dispatchAbort.abort(); throw error }
          }
          const pending = this.pi.complete(model, clean, {
            temperature: call.options?.temperature, maxTokens: call.options?.maxTokens,
            reasoning: call.options?.reasoning, apiKey: key, signal, maxRetries: 0,
            onResponse: observeResponse,
            // pi-ai's Google adapter has no response hook; a provider chunk is
            // an observation of a started request, not preparation.
            onProviderStreamEvent: model.api === 'google-generative-ai' ? observeResponse : undefined,
            // Redirects must not forward the credential to a different host.
            ...(model.api === 'google-generative-ai' ? {} : {
              fetch: async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (call.singleAttempt && ++httpAttempts > 1) throw new Error('single_attempt_exhausted')
                const response = await this.transport(url, { ...init, redirect: 'error', signal })
                quota ||= response.status === 429
                return response
              },
            }),
          })
          try { signal.throwIfAborted(); call.onStarted?.() } catch (error) { dispatchAbort.abort(); void pending.catch(() => undefined); throw error }
          const result = await pending
          if (model.api === 'google-generative-ai' && result.stopReason === 'error') {
            // The SDK serializes its API error JSON into ApiError.message; pi-ai
            // retains that string. Accept only the structured numeric code.
            try { quota ||= JSON.parse(result.errorMessage ?? '').error?.code === 429 } catch { /* An unstructured error remains provider_failed. */ }
          }
          if (quota) throw new ConnectionError('quota_exhausted', 'Connection quota exhausted')
          signal.throwIfAborted()
          if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('Model request failed')
          this.store.record({ accountId, connectionId: id, runId: call.runId, requestId: call.requestId,
            inputTokens: result.usage.input, outputTokens: result.usage.output,
            costUsd: result.usage.cost.total, source: '@earendil-works/pi-ai@1.3.0:usage',
            confidence: 'medium', observedAt: new Date().toISOString() })
          return this.scrubber.scrub(result)
        })
      } catch (error) {
        if (error instanceof ConnectionError) throw error
        if (error && typeof error === 'object' && 'status' in error && error.status === 429) throw new ConnectionError('quota_exhausted', 'Connection quota exhausted')
        throw new ConnectionError('provider_failed', signal.aborted ? 'Model request cancelled' : 'Model request failed')
      }
    })
  }
  localChat(accountId: string, id: string, request: OllamaChatRequest, call: Omit<ModelCall, 'model'> & { transport?: LocalChatTransport }): Promise<OllamaChatChunk> {
    return this.track(async () => {
      const connection = this.store.get(accountId, id)
      if (connection.kind !== 'local_runtime') throw new Error('Not a local runtime connection')
      if (call.background && (!connection.unattended || !this.#vault.unattendedAvailable)) throw new ConnectionError('policy_denied', 'Unattended access disabled')
      this.#vault.assertScrubbingReady(accountId)
      const transport = call.transport
      const host = new URL(transport ? transport.host : normalizeHost(this.localHost()))
      const remote = transport?.remote
      if (remote) {
        if (host.protocol !== 'federation:' || host.hostname !== encodeURIComponent(remote.nodeId) || (host.pathname !== '' && host.pathname !== '/') || host.username || host.password || host.search || host.hash) throw new Error('Remote runtime must be a pinned federation node')
      } else if (!['127.0.0.1', '[::1]', 'localhost'].includes(host.hostname) || !['http:', 'https:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw new Error('Local runtime must be on this node')
      const context = request.options?.num_ctx
      if (!context || !Number.isSafeInteger(context) || context <= 0) throw new Error('Explicit runtime context is required')
      const dispatchAbort = new AbortController()
      const signal = AbortSignal.any([this.lifetime, dispatchAbort.signal, ...(call.signal ? [call.signal] : [])])
      const ticket = remote ? undefined : this.governor.enqueue({ owner: { kind: 'operation', operationId: call.requestId },
        // The governor vocabulary is Ollama-only (R2-op residual): a foreign runtime takes the same
        // single permit under a prefixed name, so it is never mistaken for the Ollama model of that name.
        operation: 'chat', model: { provider: 'ollama', name: transport ? `${transport.id}:${request.model}` : request.model }, requestedContext: context,
        priority: 'normal', enqueuedAt: new Date().toISOString() })
      const lease = ticket ? await this.governor.acquire(ticket, { signal }) : undefined
      try {
        const current = this.store.get(accountId, id)
        if (call.background && (!current.unattended || !this.#vault.unattendedAvailable)) throw new ConnectionError('policy_denied', 'Unattended access disabled')
        const dispatched = (transport ?? this.ollama.client(host.href)).chat(request, signal, () => {
          try { call.onStarted?.() } catch (error) { dispatchAbort.abort(); throw error }
        }, {
          authorizeDispatch: async () => {
            signal.throwIfAborted()
            await call.authorizeDispatch?.()
            signal.throwIfAborted()
            this.assertOpen()
            const current = this.store.get(accountId, id)
            if (current.kind !== 'local_runtime' || call.background && (!current.unattended || !this.#vault.unattendedAvailable)) throw new ConnectionError('policy_denied', 'Local runtime admission changed')
            if (call.authorizeDispatch && !transport && new URL(normalizeHost(this.localHost())).href !== host.href) throw new ConnectionError('policy_denied', 'Local runtime admission changed')
          },
          prepare: () => {
            signal.throwIfAborted()
            const clean = this.scrubber.scrub(request)
            call.onPrepared?.(clean)
            signal.throwIfAborted()
            return clean
          },
        })
        const result = await dispatched
        signal.throwIfAborted()
        this.store.record({ accountId, connectionId: id, runId: call.runId, requestId: call.requestId,
          inputTokens: result.prompt_eval_count ?? null, outputTokens: result.eval_count ?? null,
          costUsd: null, source: transport?.usageSource ?? 'ollama:/api/chat', confidence: 'medium', observedAt: new Date().toISOString() })
        return this.scrubber.scrub(result)
      } catch (error) {
        if (error instanceof ConnectionError) throw error
        if (error && typeof error === 'object' && 'status' in error && error.status === 429) throw new ConnectionError('quota_exhausted', 'Connection quota exhausted')
        throw new ConnectionError('provider_failed', signal.aborted ? 'Runtime request cancelled' : 'Runtime request failed')
      }
      finally { lease?.release() }
    })
  }
  /** K5's trusted process boundary. Identity is the original prompt author, including delegation.
   * A sharing grant never enables another person's prompt on a subscription connection. */
  dispatchAgent<T>(ownerAccountId: string, id: string, actorAccountId: string, editorAllowed: boolean,
    call: { background?: boolean; signal?: AbortSignal },
    launch: (connection: import('@guanxi/contract').Connection, key: string | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.track(async () => {
      const connection = this.store.get(ownerAccountId, id)
      if (actorAccountId !== ownerAccountId &&
        (connection.auth === 'cli_login' || !editorAllowed || !['model_api', 'local_runtime'].includes(connection.kind))) {
        throw new ConnectionError('policy_denied', 'Connection cannot pay for this prompt author')
      }
      const signal = call.signal ? AbortSignal.any([this.lifetime, call.signal]) : this.lifetime
      this.#vault.assertScrubbingReady(ownerAccountId)
      signal.throwIfAborted()
      if (call.background && (!connection.unattended || !this.#vault.unattendedAvailable)) {
        throw new ConnectionError('policy_denied', 'Unattended access disabled')
      }
      if (connection.kind === 'service') throw new ConnectionError('policy_denied', 'Not an agent payment connection')
      if (connection.auth === 'api_key') return this.#vault.inject(ownerAccountId, id, call.background ?? false,
        key => { assertApiKey(connection.provider, key); return launch(connection, key, signal) })
      return launch(connection, undefined, signal)
    })
  }
  /** Caller supplies a pre-authorized destination; scrubbing precedes hashing. */
  writeArtifact(accountId: string, destination: string, value: unknown) {
    return this.track(async () => {
      this.#vault.assertScrubbingReady(accountId)
      const bytes = Buffer.from(JSON.stringify(this.scrubber.scrub(value)))
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx', signal: this.lifetime })
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    })
  }
  async close() { this.closed = true; await Promise.allSettled([...this.active]) }
}
