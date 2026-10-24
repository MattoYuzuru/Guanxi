import { fetch as undiciFetch } from 'undici'
import { endpointFetch, type EndpointResolver } from './endpoint.ts'
import { normalizeHost } from '../ollama/normalize-host.ts'
import { ConnectionError } from './errors.ts'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { AssistantMessage, Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { MAX_DISCOVERED_MODELS, providerCatalog, providerModelIdSchema, type Connection, type ConnectionFact, type ConnectionSnapshot, type CreateConnection } from '@guanxi/contract'
import type { OllamaAdapter } from '../ollama/plugin.ts'
import type { OllamaChatRequest, OllamaChatChunk } from '../ollama/types.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'
import type { Vault } from '../vault/vault.ts'
import type { BalanceProbes } from '../probes/balances.ts'
import { ConnectionStore } from './store.ts'
import { assertApiKey, assertOAuthToken, piModels, piTransport, type PiTransport } from './pi.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { modelsDevFacts } from './metadata.ts'
import type { ImportedProvider } from './dotenv.ts'
import { readDiscovery } from './discovery.ts'
import { SafeTextStream } from './safe-stream.ts'
import type { Api, Model } from '@earendil-works/pi-ai'

/** Public display projection never exposes owner API-root paths. */
export function publicConnection(row: Connection): Connection {
  return { ...row, ...(row.baseUrl ? { baseUrl: new URL(row.baseUrl).origin } : {}) }
}
export interface ModelCall {
  model: string; runId: string; requestId: string; background?: boolean
  /** Trusted billing boundary: one K3-visible HTTP attempt, never a provider retry. */
  singleAttempt?: true
  signal?: AbortSignal
  /** Trusted consumer receives only scrubbed, secret-boundary-safe text. */
  onText?: (text: string) => void
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
  private imports: Promise<unknown> = Promise.resolve()
  private closed = false
  private readonly discovered = new Map<string, { checked: number; observedAt: string | null; models: string[]; source: string; state: 'current' | 'stale' | 'unknown'; confidence: 'medium' | 'low' | 'unknown' }>()
  private readonly inUse = new Map<string, number>()
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
  private readonly resolveEndpoint?: EndpointResolver
  private readonly transport: typeof fetch
  constructor(store: ConnectionStore, vault: Vault, probes: BalanceProbes,
    scrubber: EgressScrubber, lifetime: AbortSignal,
    ollama: OllamaAdapter, governor: ResourceGovernor,
    localHost: () => string, pi: PiTransport = piTransport,
    // undici's own fetch: endpointFetch pins the address with an undici Agent, which Node 22's bundled fetch refuses.
    transport: typeof fetch = undiciFetch as unknown as typeof fetch,
    resolveEndpoint?: EndpointResolver) {
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
    this.resolveEndpoint = resolveEndpoint
  }
  private assertOpen() { if (this.closed) throw new Error('Connections plugin unloaded'); this.lifetime.throwIfAborted() }
  /** Only calls that can still consume the credential count; a probe or model listing does not hold a session. */
  private enter(id: string) { this.inUse.set(id, (this.inUse.get(id) ?? 0) + 1) }
  private exit(id: string) {
    const remaining = (this.inUse.get(id) ?? 0) - 1
    if (remaining > 0) this.inUse.set(id, remaining)
    else this.inUse.delete(id)
  }
  private async withUse<T>(id: string, task: () => Promise<T>): Promise<T> {
    this.enter(id)
    try { return await task() } finally { this.exit(id) }
  }
  private track<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const promise = task()
    this.active.add(promise)
    void promise.finally(() => this.active.delete(promise)).catch(() => undefined)
    return promise
  }
  snapshot(accountId: string): ConnectionSnapshot {
    this.assertOpen()
    return this.scrubber.scrub({ connections: this.store.list(accountId).map(publicConnection), costs: this.store.costs(accountId),
      vault: { unlocked: this.#vault.unlocked(accountId), unattendedAvailable: this.#vault.unattendedAvailable } })
  }
  create(accountId: string, input: CreateConnection) {
    this.assertOpen()
    if (input.unattended && !this.#vault.unattendedAvailable) throw new ConnectionError('policy_denied', 'Node unattended access is not enabled')
    return this.store.create(accountId, input)
  }
  /** Refuses while this registry knows of a running model, runtime or agent call. Session ownership
   * stays with the callers; this registry holds no durable relay/lead state and does not inspect it. */
  remove(accountId: string, id: string) {
    this.assertOpen()
    this.store.get(accountId, id)
    if (this.inUse.has(id)) throw new ConnectionError('connection_in_use', 'Connection is in use by a running call')
    return this.store.remove(accountId, id)
  }
  /** One user-visible local Ollama connection per account. No secret, vault or Ollama request is involved.
   * A removed marked row suppresses recreation across restarts; the owner re-adds it from the catalog. */
  ensureLocalOllama(accountId: string): Connection | undefined {
    this.assertOpen()
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      const auto = this.store.findAutoLocalOllama(accountId)
      if (auto) {
        this.store.db.exec('COMMIT')
        return auto.removed ? undefined : auto.connection
      }
      const existing = this.store.list(accountId).find(row => row.kind === 'local_runtime' && row.provider === 'ollama' &&
        row.name === 'Ollama' && !row.unattended)
      if (existing) {
        this.store.db.exec('COMMIT')
        return existing
      }
      const created = this.store.create(accountId,
        { name: 'Ollama', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: false })
      const connection = this.store.observe(accountId, created.id, {
        origin: { value: 'local_runtime_auto', source: 'connection_apply', observedAt: new Date().toISOString(), confidence: 'high' },
      })
      this.store.db.exec('COMMIT')
      return connection
    } catch (error) {
      this.store.db.exec('ROLLBACK')
      throw error
    }
  }
  private importedConnectionName(entry: ImportedProvider) {
    if (entry.provider === 'openai' && entry.baseUrl) return `OpenAI-compatible (${new URL(entry.baseUrl).host})`
    return providerCatalog.find(item => item.provider === entry.provider)?.label ?? entry.provider
  }
  /** Reuse belongs to one dotenv name family; official OpenAI and its compatible name never share a row. */
  private importedFamily(entry: ImportedProvider) {
    if (entry.provider !== 'openai') return entry.provider
    return entry.family === 'OPENAI_COMPAT_API_KEY' ? 'OPENAI_COMPAT_API_KEY' : 'OPENAI_API_KEY'
  }
  private recordImportOrigin(accountId: string, connectionId: string) {
    this.store.observe(accountId, connectionId, {
      origin: { value: 'provider_key_import', source: 'connection_import', observedAt: new Date().toISOString(), confidence: 'high' },
    })
  }
  /** Trusted import keeps one identity per provider/API root. Never grants unattended consent. */
  importKeys(accountId: string, entries: ImportedProvider[]) {
    const task = this.imports.then(() => this.importEntries(accountId, entries))
    this.imports = task.catch(() => undefined)
    return task
  }
  private importEntries(accountId: string, entries: ImportedProvider[]) {
    return this.track(async () => {
      if (!entries.length) return { imported: [] }
      await this.#vault.unlock(accountId)
      const imported: { connectionId: string; provider: string; action: 'created' | 'rotated' | 'unchanged' }[] = []
      // No await inside the transaction: synchronous writers cannot interleave.
      const prepared: { entry: ImportedProvider; row: Connection | undefined; same: boolean }[] = []
      // A row claimed by one entry of this batch is never reused by another entry.
      const claimed = new Set<string>()
      for (const entry of entries) {
        const family = this.importedFamily(entry)
        let row: Connection | undefined
        let same = false
        const mapped = this.store.db.prepare('SELECT connection_id FROM dotenv_imports WHERE account_id=? AND provider=? AND family=? AND endpoint=?')
          .get(accountId, entry.provider, family, entry.baseUrl ?? '')
        if (mapped && !claimed.has(String(mapped.connection_id))) {
          row = this.store.get(accountId, String(mapped.connection_id))
          same = await this.#vault.matches(accountId, row.id, entry.value)
        }
        // An endpoint-only change reuses the imported connection that already holds this
        // family's secret. Another family, or a row already claimed in this batch, is separate.
        if (!row) {
          for (const candidate of this.store.db.prepare('SELECT connection_id FROM dotenv_imports WHERE account_id=? AND provider=? AND family=? ORDER BY rowid')
            .all(accountId, entry.provider, family)) {
            const id = String(candidate.connection_id)
            if (claimed.has(id)) continue
            if (await this.#vault.matches(accountId, id, entry.value)) {
              row = this.store.get(accountId, id)
              same = true
              break
            }
          }
        }
        // A mapping written before migration 4 has no family. Its row still carries the old
        // `<provider> (dotenv)` name and is the official family's identity.
        if (!row && family !== 'OPENAI_COMPAT_API_KEY') {
          for (const candidate of this.store.list(accountId)) {
            if (candidate.provider !== entry.provider || candidate.name !== `${entry.provider} (dotenv)` || claimed.has(candidate.id)) continue
            if (await this.#vault.matches(accountId, candidate.id, entry.value)) {
              row = candidate
              same = true
              break
            }
          }
        }
        if (row) claimed.add(row.id)
        prepared.push({ entry, row, same })
      }
      this.store.db.exec('BEGIN IMMEDIATE')
      try {
        const refs = prepared.map(({ entry, same }) => same ? null : this.#vault.put(accountId, entry.value))
        if (prepared.some(({ entry }) => entry.baseUrl && this.scrubber.scrub(entry.baseUrl) !== entry.baseUrl))
          throw new ConnectionError('validation_failed', 'API root must not contain a registered credential')
        for (const [index, { entry, row, same }] of prepared.entries()) {
          const family = this.importedFamily(entry)
          const name = this.importedConnectionName(entry)
          let connection = row
          if (!connection) {
            // A Claude Code subscription token belongs to an `agent` connection: only K5 can receive it, for the official CLI's environment.
            connection = this.store.create(accountId, entry.provider === 'claude-code'
              ? { name, kind: 'agent', provider: 'claude-code', auth: 'cli_login' }
              : { name, kind: 'model_api', provider: entry.provider, auth: 'api_key' }, entry.baseUrl ? { baseUrl: entry.baseUrl, allowPrivate: entry.allowPrivate ?? false } : undefined)
            this.recordImportOrigin(accountId, connection.id)
          } else {
            if (connection.facts.origin?.value !== 'provider_key_import') this.recordImportOrigin(accountId, connection.id)
            const endpointChanged = (connection.baseUrl ?? undefined) !== entry.baseUrl
            const consentChanged = entry.baseUrl !== undefined && connection.allowPrivate !== (entry.allowPrivate ?? false)
            if (endpointChanged || consentChanged || connection.name !== name)
              this.store.setImportedEndpoint(accountId, connection.id,
                entry.baseUrl ? { baseUrl: entry.baseUrl, allowPrivate: entry.allowPrivate ?? false } : {}, name)
            // The mapping follows the connection's current root. A stale alias must not let a
            // later import with a different secret rotate this connection instead of creating one.
            if (endpointChanged) {
              this.discovered.delete(connection.id)
              this.store.db.prepare('DELETE FROM dotenv_imports WHERE account_id=? AND provider=? AND connection_id=?')
                .run(accountId, entry.provider, connection.id)
            }
          }
          if (!same) this.saveImportedSecret(accountId, connection.id, refs[index]!)
          this.store.db.prepare('INSERT OR REPLACE INTO dotenv_imports(account_id,provider,family,endpoint,connection_id) VALUES(?,?,?,?,?)')
            .run(accountId, entry.provider, family, entry.baseUrl ?? '', connection.id)
          imported.push({ connectionId: connection.id, provider: entry.provider, action: !row ? 'created' : same ? 'unchanged' : 'rotated' })
        }
        this.store.db.exec('COMMIT')
        return { imported }
      } catch { this.store.db.exec('ROLLBACK'); throw new ConnectionError('validation_failed', 'Provider key import failed') }
    })
  }
  private saveImportedSecret(accountId: string, id: string, ref: string) {
    const connection = this.store.get(accountId, id)
    this.#vault.prepareUnattended(accountId, id, connection.unattended && this.#vault.unattendedAvailable, ref)
    this.store.setSecret(accountId, id, ref)
  }
  async chatModels(accountId: string, id: string, signal?: AbortSignal) {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    const fallback = () => ({ models: piModels(connection.provider).map(model => model.id),
      source: '@earendil-works/pi-ai@1.3.0', observedAt: new Date().toISOString(), confidence: 'medium' as const, state: 'current' as const })
    if (!connection.baseUrl) return fallback()
    const cached = this.discovered.get(id)
    if (cached && Date.now() - cached.checked < 60_000) return cached
    try {
      const result = await this.#vault.inject(accountId, id, false, async key => {
        this.#vault.assertScrubbingReady(accountId)
        const response = await endpointFetch(`${connection.baseUrl!.replace(/\/+$/, '')}/models`, {
          headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
          signal: AbortSignal.any([this.lifetime, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
        }, connection.allowPrivate ?? false, this.transport, this.resolveEndpoint)
        if (!response.ok) throw new Error('Model discovery failed')
        const body = await readDiscovery(response) as { data?: { id?: unknown }[] }
        if (!Array.isArray(body.data) || !body.data.length || body.data.length > MAX_DISCOVERED_MODELS || body.data.some(model => !providerModelIdSchema.safeParse(model.id).success)) throw new Error('Invalid model list')
        return [...new Set(body.data.map(model => model.id as string))]
      })
      const at = new Date().toISOString()
      const models = this.scrubber.scrub(result)
      const catalog = { checked: Date.now(), models, source: new URL(connection.baseUrl).host, observedAt: at, confidence: 'medium' as const, state: 'current' as const }
      this.discovered.set(id, catalog)
      return catalog
    } catch {
      signal?.throwIfAborted()
      // Retain only observations from this endpoint, never an unrelated public catalog.
      const catalog = { checked: Date.now(), models: cached?.models ?? [], source: cached?.source ?? new URL(connection.baseUrl).host,
        observedAt: cached?.observedAt ?? null, confidence: cached?.observedAt ? 'low' as const : 'unknown' as const,
        state: cached?.observedAt ? 'stale' as const : 'unknown' as const }
      this.discovered.set(id, catalog)
      return catalog
    }
  }

  /** Chat commands cross this boundary before durable input or title persistence. */
  scrubChat<T>(value: T, requireReady = true): T {
    this.assertOpen()
    if (requireReady) this.#vault.assertScrubbingReady('local')
    return this.scrubber.scrub(value)
  }
  chatContext(accountId: string, id: string, modelId: string) {
    const connection = this.store.get(accountId, id)
    const model = connection.baseUrl ? undefined : piModels(connection.provider).find(item => item.id === modelId)
    return { value: model?.contextWindow ?? null,
      source: connection.baseUrl ? new URL(connection.baseUrl).host : '@earendil-works/pi-ai@1.3.0',
      observedAt: model ? new Date().toISOString() : this.discovered.get(id)?.observedAt ?? null,
      confidence: model ? 'medium' as const : 'unknown' as const }
  }
  async assertChatModel(accountId: string, id: string, modelId: string, signal?: AbortSignal) {
    const connection = this.store.get(accountId, id)
    if (connection.kind !== 'model_api' || !connection.secretRef) throw new ConnectionError('policy_denied', 'A model API key is required')
    if (!this.#vault.unlocked(accountId)) throw new ConnectionError('vault_locked', 'Unlock Connections in Settings')
    const catalog = await this.chatModels(accountId, id, signal)
    if (!catalog.models.includes(modelId)) throw new ConnectionError('connection_not_found', 'Provider model unavailable')
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
  async models(accountId: string, id: string, signal?: AbortSignal): Promise<{ id: string; facts: Record<string, ConnectionFact> }[]> {
    this.assertOpen()
    const connection = this.store.get(accountId, id)
    if (connection.kind === 'local_runtime') return this.localModels(signal)
    if (connection.baseUrl) {
      // A pinned endpoint advertises its own IDs; never substitute the public provider catalog.
      const catalog = await this.chatModels(accountId, id, signal)
      return catalog.models.map(modelId => ({ id: modelId, facts: {
        'endpoint.model': { value: true, source: catalog.source, observedAt: catalog.observedAt, confidence: catalog.confidence },
        'endpoint.discovery': { value: catalog.state, source: catalog.source, observedAt: catalog.observedAt, confidence: catalog.confidence },
      } }))
    }
    const observedAt = new Date().toISOString()
    return piModels(connection.provider).map(model => ({ id: model.id, facts: {
      'pi-ai.context': { value: model.contextWindow, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      'pi-ai.output': { value: model.maxTokens, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      'pi-ai.reasoning': { value: model.reasoning, source: '@earendil-works/pi-ai@1.3.0', observedAt, confidence: 'medium' as const },
      ...modelsDevFacts(connection.provider, model.id),
    } }))
  }
  /** Installed models of the configured local runtime, bounded and never a provider catalog substitute. */
  private async localModels(signal?: AbortSignal) {
    const cancellation = AbortSignal.any([this.lifetime, AbortSignal.timeout(5_000), ...(signal ? [signal] : [])])
    try {
      const tags = await this.ollama.client(normalizeHost(this.localHost())).tags(cancellation)
      const observedAt = new Date().toISOString()
      const models: { id: string; facts: Record<string, ConnectionFact> }[] = []
      const seen = new Set<string>()
      for (const model of tags.models) {
        if (models.length >= MAX_DISCOVERED_MODELS) break
        if (seen.has(model.name) || !providerModelIdSchema.safeParse(model.name).success) continue
        seen.add(model.name)
        models.push({ id: model.name, facts: {
          'ollama.installed': { value: true, source: 'ollama:/api/tags', observedAt, confidence: 'high' },
          'ollama.digest': { value: model.digest || null, source: 'ollama:/api/tags', observedAt, confidence: 'high' },
        } })
      }
      return models
    } catch {
      signal?.throwIfAborted()
      throw new ConnectionError('provider_failed', 'Local runtime models are unavailable')
    }
  }
  complete(accountId: string, id: string, context: Context, call: ModelCall): Promise<AssistantMessage> {
    return this.track(() => this.withUse(id, async () => {
      const connection = this.store.get(accountId, id)
      if (connection.kind !== 'model_api' || connection.auth !== 'api_key') throw new ConnectionError('policy_denied', 'This connection is not a model API')
      const catalogModel = piModels(connection.provider).find(item => item.id === call.model)
      // Admission validates picker membership. An admitted thread can continue during
      // discovery outages; authorization and vault readiness are still checked below.
      const model: Model<Api> | undefined = connection.baseUrl
        ? { id: call.model, name: call.model, provider: 'openai', api: 'openai-completions', baseUrl: connection.baseUrl,
          reasoning: false, input: ['text'], contextWindow: 0, maxTokens: 0,
          compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false,
            supportsStrictMode: false, supportsLongCacheRetention: false, maxTokensField: 'max_tokens',
            requiresReasoningContentOnAssistantMessages: false, thinkingFormat: 'openai',
            sendSessionAffinityHeaders: false, supportsOpenAIGrammarTools: false },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
        : catalogModel
      if (!model) throw new ConnectionError('connection_not_found', 'Model not found in the provider catalog')
      if (call.singleAttempt && !['anthropic-messages', 'openai-responses', 'openai-completions'].includes(model.api))
        throw new ConnectionError('policy_denied', 'Single-attempt transport is unavailable for this wire protocol')
      // Per logical call, including any adapter fallback. Never share this counter
      // between concurrent requests, or trust SDK retry settings as the only guard.
      let httpAttempts = 0
      let boundaryFailure: ConnectionError | undefined
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
          const textStream = new SafeTextStream(this.scrubber)
          let streamed = false
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
                try {
                if (call.singleAttempt && ++httpAttempts > 1) throw new Error('single_attempt_exhausted')
                if (connection.baseUrl) {
                  const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
                  const root = new URL(connection.baseUrl)
                  if (target.origin !== root.origin || target.pathname !== `${root.pathname.replace(/\/+$/, '')}/chat/completions` || target.search || target.hash || target.username || target.password)
                    throw new ConnectionError('policy_denied', 'Request escaped the connection API root')
                }
                const response = connection.baseUrl
                  ? await endpointFetch(String(url), { ...init, redirect: 'error', signal }, connection.allowPrivate ?? false, this.transport, this.resolveEndpoint)
                  : await this.transport(url, { ...init, redirect: 'error', signal })
                quota ||= response.status === 429
                return response
                } catch (error) {
                  if (error instanceof ConnectionError) boundaryFailure = error
                  throw error
                }
              },
            }),
          }, call.onText ? delta => {
            signal.throwIfAborted()
            streamed = true
            const safe = textStream.push(delta)
            if (safe) call.onText!(safe)
          } : undefined)
          try { signal.throwIfAborted(); call.onStarted?.() } catch (error) { dispatchAbort.abort(); void pending.catch(() => undefined); throw error }
          const result = await pending
          if (boundaryFailure) throw boundaryFailure
          if (model.api === 'google-generative-ai' && result.stopReason === 'error') {
            // The SDK serializes its API error JSON into ApiError.message; pi-ai
            // retains that string. Accept only the structured numeric code.
            try { quota ||= JSON.parse(result.errorMessage ?? '').error?.code === 429 } catch { /* An unstructured error remains provider_failed. */ }
          }
          if (quota) throw new ConnectionError('quota_exhausted', 'Connection quota exhausted')
          signal.throwIfAborted()
          if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('Model request failed')
          if (call.onText) {
            const tail = streamed ? textStream.finish() : this.scrubber.scrub(result.content.filter(item => item.type === 'text').map(item => item.text).join(''))
            if (tail) call.onText(tail)
          }
          this.store.record({ accountId, connectionId: id, runId: call.runId, requestId: call.requestId,
            inputTokens: result.usage.input, outputTokens: result.usage.output,
            costUsd: connection.baseUrl ? null : result.usage.cost.total, source: connection.baseUrl ? 'owner_endpoint:usage;cost_unknown' : '@earendil-works/pi-ai@1.3.0:usage:catalog_estimate',
            confidence: 'medium', observedAt: new Date().toISOString() })
          return this.scrubber.scrub(result)
        })
      } catch (error) {
        if (boundaryFailure) throw boundaryFailure
        if (error instanceof ConnectionError) throw error
        if (error && typeof error === 'object' && 'status' in error && error.status === 429) throw new ConnectionError('quota_exhausted', 'Connection quota exhausted')
        throw new ConnectionError('provider_failed', signal.aborted ? 'Model request cancelled' : 'Model request failed')
      }
    }))
  }
  localChat(accountId: string, id: string, request: OllamaChatRequest, call: Omit<ModelCall, 'model'> & { transport?: LocalChatTransport }): Promise<OllamaChatChunk> {
    return this.track(() => this.withUse(id, async () => {
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
        // A trusted runtime transport (llama-server, a remote node) refuses with fixed machine codes. They are not provider text, so the code is
        // kept as the error's `reason`; the message stays generic, and an Ollama or provider error never has one.
        const fixed = (error as { code?: unknown } | null)?.code
        const reason = transport && error instanceof Error && ['RelayError', 'LlamaServerError'].includes(error.name) && typeof fixed === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(fixed) ? fixed : undefined
        throw new ConnectionError('provider_failed', signal.aborted ? 'Runtime request cancelled' : 'Runtime request failed', reason)
      }
      finally { lease?.release() }
    }))
  }
  /** K5's trusted process boundary. Identity is the original prompt author, including delegation.
   * A sharing grant never enables another person's prompt on a subscription connection. */
  dispatchAgent<T>(ownerAccountId: string, id: string, actorAccountId: string, editorAllowed: boolean,
    call: { background?: boolean; signal?: AbortSignal },
    launch: (connection: import('@guanxi/contract').Connection, key: string | undefined, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.track(() => this.withUse(id, async () => {
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
      // D-212: a Claude Code connection that holds the owner's subscription token passes it to K5 and to nothing else.
      if (connection.kind === 'agent' && connection.provider === 'claude-code' && connection.auth === 'cli_login' && connection.secretRef) {
        return this.#vault.inject(ownerAccountId, id, call.background ?? false, key => { assertOAuthToken(key); return launch(connection, key, signal) })
      }
      return launch(connection, undefined, signal)
    }))
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
