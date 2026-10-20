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
import type { EgressScrubber } from './egress.ts'
import { modelsDevFacts } from './metadata.ts'

export interface ModelCall {
  model: string; runId: string; requestId: string; background?: boolean
  signal?: AbortSignal
  /** Adapter parameters, not arbitrary transport/auth headers. */
  options?: Pick<SimpleStreamOptions, 'temperature' | 'maxTokens' | 'reasoning'>
}
export class Connections {
  private closed = false
  private active = new Set<Promise<unknown>>()
  readonly store: ConnectionStore
  readonly vault: Vault
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
    this.vault = vault
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
      vault: { unlocked: this.vault.unlocked(accountId), unattendedAvailable: this.vault.unattendedAvailable } })
  }
  create(accountId: string, input: CreateConnection) {
    this.assertOpen()
    if (input.unattended && !this.vault.unattendedAvailable) throw new Error('Node unattended access is not enabled')
    return this.store.create(accountId, input)
  }
  setUnattended(accountId: string, id: string, unattended: boolean) {
    this.assertOpen()
    if (unattended && !this.vault.unattendedAvailable) throw new Error('Node unattended access is not enabled')
    return this.store.setUnattended(accountId, id, unattended)
  }
  saveSecret(accountId: string, id: string, value: string) {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    if (connection.auth !== 'api_key') throw new Error('CLI logins are managed by the official CLI')
    assertApiKey(connection.provider, value)
    const ref = this.vault.put(accountId, value)
    return this.store.setSecret(accountId, id, ref)
  }
  unlockVault(accountId: string) { return this.track(() => this.vault.unlock(accountId)) }
  lockVault(accountId: string) { this.assertOpen(); this.vault.lock(accountId) }
  probe(accountId: string, id: string, signal?: AbortSignal) {
    return this.track(() => this.probes.probe(this.store.get(accountId, id), signal
      ? AbortSignal.any([this.lifetime, signal]) : this.lifetime))
  }
  models(accountId: string, id: string) {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    return piModels(connection.provider).map(model => ({ id: model.id, facts: {
      'pi-ai.context': { value: model.contextWindow, source: '@earendil-works/pi-ai@1.3.0', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'medium' as const },
      'pi-ai.output': { value: model.maxTokens, source: '@earendil-works/pi-ai@1.3.0', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'medium' as const },
      'pi-ai.reasoning': { value: model.reasoning, source: '@earendil-works/pi-ai@1.3.0', observedAt: '2026-10-20T00:00:00.000Z', confidence: 'medium' as const },
      ...modelsDevFacts(connection.provider, model.id),
    } }))
  }
  complete(accountId: string, id: string, context: Context, call: ModelCall): Promise<AssistantMessage> {
    return this.track(async () => {
      const connection = this.store.get(accountId, id)
      if (connection.kind !== 'model_api' || connection.auth !== 'api_key') throw new Error('This connection is not a model API')
      const model = piModels(connection.provider).find(item => item.id === call.model)
      if (!model) throw new Error('Model not found in the provider catalog')
      const signal = call.signal ? AbortSignal.any([this.lifetime, call.signal]) : this.lifetime
      try {
        return await this.vault.inject(connection, call.background ?? false, async key => {
          assertApiKey(connection.provider, key)
          this.vault.assertScrubbingReady(accountId)
          signal.throwIfAborted()
          // Scrub the complete context, including tool results and tool schemas,
          // before pi-ai turns it into a provider-specific request.
          const clean = this.scrubber.scrub(context)
          const result = await this.pi.complete(model, clean, {
            temperature: call.options?.temperature, maxTokens: call.options?.maxTokens,
            reasoning: call.options?.reasoning, apiKey: key, signal,
            // Redirects must not forward the credential to a different host.
            ...(model.api === 'google-generative-ai' ? {} : {
              fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) => this.transport(url, { ...init, redirect: 'error', signal }),
            }),
          })
          signal.throwIfAborted()
          if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('Model request failed')
          this.store.record({ accountId, connectionId: id, runId: call.runId, requestId: call.requestId,
            inputTokens: result.usage.input, outputTokens: result.usage.output,
            costUsd: result.usage.cost.total, source: '@earendil-works/pi-ai@1.3.0:usage',
            confidence: 'medium', observedAt: new Date().toISOString() })
          return this.scrubber.scrub(result)
        })
      } catch { throw new Error(signal.aborted ? 'Model request cancelled' : 'Model request failed; check the connection and unlock the vault') }
    })
  }
  localChat(accountId: string, id: string, request: OllamaChatRequest, call: Omit<ModelCall, 'model'>): Promise<OllamaChatChunk> {
    return this.track(async () => {
      const connection = this.store.get(accountId, id)
      if (connection.kind !== 'local_runtime') throw new Error('Not a local runtime connection')
      if (call.background && (!connection.unattended || !this.vault.unattendedAvailable)) throw new Error('Unattended access disabled')
      this.vault.assertScrubbingReady(accountId)
      const host = new URL(this.localHost())
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(host.hostname) || !['http:', 'https:'].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw new Error('Local runtime must be on this node')
      const context = request.options?.num_ctx
      if (!context || !Number.isSafeInteger(context) || context <= 0) throw new Error('Explicit runtime context is required')
      const signal = call.signal ? AbortSignal.any([this.lifetime, call.signal]) : this.lifetime
      const ticket = this.governor.enqueue({ owner: { kind: 'operation', operationId: call.requestId },
        operation: 'chat', model: { provider: 'ollama', name: request.model }, requestedContext: context,
        priority: 'normal', enqueuedAt: new Date().toISOString() })
      const lease = await this.governor.acquire(ticket, { signal })
      try {
        const result = await this.ollama.client(host.href).chat(this.scrubber.scrub(request), signal)
        signal.throwIfAborted()
        this.store.record({ accountId, connectionId: id, runId: call.runId, requestId: call.requestId,
          inputTokens: result.prompt_eval_count ?? null, outputTokens: result.eval_count ?? null,
          costUsd: null, source: 'ollama:/api/chat', confidence: 'medium', observedAt: new Date().toISOString() })
        return this.scrubber.scrub(result)
      } catch { throw new Error(signal.aborted ? 'Runtime request cancelled' : 'Runtime request failed') }
      finally { lease.release() }
    })
  }
  /** Caller supplies a pre-authorized destination; scrubbing precedes hashing. */
  writeArtifact(accountId: string, destination: string, value: unknown) {
    return this.track(async () => {
      this.vault.assertScrubbingReady(accountId)
      const bytes = Buffer.from(JSON.stringify(this.scrubber.scrub(value)))
      await writeFile(destination, bytes, { mode: 0o600, flag: 'wx', signal: this.lifetime })
      return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    })
  }
  async close() { this.closed = true; await Promise.allSettled([...this.active]) }
}
