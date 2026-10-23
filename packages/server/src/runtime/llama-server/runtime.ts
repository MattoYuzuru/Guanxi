import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { LocalChatTransport } from '../../connections/service.ts'
import type { OllamaChatChunk, OllamaChatRequest } from '../../ollama/types.ts'
import { canonical } from '../../relay/handoff.ts'
import { requestSchema, schemaDigest } from '../../relay/json-schema.ts'
import type { RelayExactCounter, RelayRuntimeObservation, RelayRuntimeObserver } from '../../relay/runtime.ts'
import { invariant, RelayError } from '../../relay/types.ts'
import { normalizeOllamaModelReference } from '../observation-key.ts'
import { LlamaServerError, type LlamaServerClient } from './client.ts'
import { SyncTokenCounter } from './sync-count.ts'

export const LLAMA_SERVER_PROPS_SOURCE = 'llama_server_props'
export const LLAMA_SERVER_COUNTER_SOURCE = 'llama-server:/apply-template+/tokenize'
const PROBE = 'guanxi-render-probe-7f3a91c4'

/** What a file was when the owner process opened it. A later replacement under the same path (an atomic
 * rename leaves the server on the old inode) is then a different identity, not a silent swap. */
export interface ModelFileIdentity { path: string; dev: number; ino: number; size: number; mtimeMs: number }
export function modelFileIdentity(path: string): ModelFileIdentity {
  const real = realpathSync(path), entry = statSync(real)
  return { path: real, dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs }
}
export interface LlamaServerRuntimeOptions {
  client: LlamaServerClient
  /** The one model reference this server instance serves; `--alias` must report it. */
  model: string
  /** Spawn mode: the GGUF file the owner process was started with. `/props` and the file itself must agree. */
  expectedModel?: ModelFileIdentity
  /** Throws a relay refusal while the owned process is not usable. Attach mode omits it. */
  ready?: () => void
  clock?: () => number
  countTimeoutMs?: number
  cacheEntries?: number
}

const occurrences = (value: string, part: string): number => value.split(part).length - 1

/** One llama-server process as the relay's observer, exact counter and chat transport. Everything
 * that counts a request and everything that dispatches it talks to this single server, so the
 * rendered text that was counted is the text that is evaluated. The first real dispatch still
 * cross-checks `tokens_evaluated` against the count through the executor's existing protocol. */
export class LlamaServerRuntime implements RelayRuntimeObserver {
  readonly host: string
  readonly transport: LocalChatTransport
  readonly model: string
  private readonly client: LlamaServerClient
  private readonly expectedModel?: ModelFileIdentity
  private readonly ready?: () => void
  private readonly clock: () => number
  private readonly bridge: SyncTokenCounter
  private readonly lifetime = new AbortController()
  private readonly digests = new Map<string, { size: number; mtimeMs: number; ino: number; dev: number; digest: string }>()
  private readonly hashing = new Map<string, Promise<string>>()
  private verified = ''
  constructor(options: LlamaServerRuntimeOptions) {
    const model = normalizeOllamaModelReference(options.model)
    invariant(model && !/:cloud$/i.test(options.model), 'relay_local_model_required')
    this.model = model; this.client = options.client; this.host = options.client.baseUrl
    this.expectedModel = options.expectedModel; this.ready = options.ready; this.clock = options.clock ?? Date.now
    this.bridge = new SyncTokenCounter({ baseUrl: this.host, timeoutMs: options.countTimeoutMs, cacheEntries: options.cacheEntries })
    const transport: LocalChatTransport = { id: 'llama-server', host: this.host, usageSource: 'llama-server:/completion',
      chat: (request, signal, onDispatched, dispatch) => this.chat(request, signal, onDispatched, dispatch) }
    this.transport = Object.freeze(transport)
  }
  /** A refusal that is not a cancellation: an absent, loading or unintelligible server never yields facts. */
  private unavailable(error: unknown, signal?: AbortSignal): never {
    if (signal?.aborted) throw signal.reason ?? error
    if (error instanceof RelayError) throw error
    if (error instanceof LlamaServerError && error.code === 'llama_server_protocol') throw new RelayError('runtime_identity_unknown')
    throw new RelayError('runtime_meter_unavailable')
  }
  /** SHA-256 of the GGUF file the server reports, identified by path, size, mtime and inode so it is
   * computed once and recomputed after any change. Hashing is not tied to one caller's signal. */
  private async digest(path: string): Promise<string> {
    const real = await realpath(path), before = await stat(real)
    invariant(before.isFile(), 'runtime_identity_unknown')
    const known = this.digests.get(real)
    if (known && known.size === before.size && known.mtimeMs === before.mtimeMs && known.ino === before.ino && known.dev === before.dev) return known.digest
    const running = this.hashing.get(real)
    if (running) return running
    const computing = (async () => {
      const hash = createHash('sha256')
      const stream = createReadStream(real, { signal: this.lifetime.signal })
      for await (const chunk of stream) hash.update(chunk as Buffer)
      const after = await stat(real)
      // A file that changed while it was read has no single identity.
      invariant(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino, 'runtime_identity_unknown')
      const digest = `sha256:${hash.digest('hex')}`
      this.digests.set(real, { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino, dev: before.dev, digest })
      return digest
    })().finally(() => this.hashing.delete(real))
    this.hashing.set(real, computing)
    return computing
  }
  async observe(reference: string, signal: AbortSignal): Promise<RelayRuntimeObservation> {
    signal.throwIfAborted()
    invariant(reference === this.model, 'runtime_identity_unknown')
    try {
      this.ready?.()
      const props = await this.client.props(signal)
      signal.throwIfAborted()
      invariant(normalizeOllamaModelReference(props.alias ?? '') === this.model, 'runtime_identity_unknown')
      if (this.expectedModel) {
        const real = await realpath(props.modelPath), entry = await stat(real), expected = this.expectedModel
        invariant(real === expected.path && entry.dev === expected.dev && entry.ino === expected.ino && entry.size === expected.size && entry.mtimeMs === expected.mtimeMs, 'runtime_identity_unknown')
      }
      const digest = await this.digest(props.modelPath)
      signal.throwIfAborted()
      const observation = { model: this.model, digest, contextTokens: props.contextTokens, runtimeVersion: `llama-server/${props.buildInfo}`,
        source: LLAMA_SERVER_PROPS_SOURCE, observedAt: this.clock() }
      const identity = canonical([observation.digest, observation.runtimeVersion, observation.contextTokens])
      // Remembered answers belong to one served identity.
      if (this.verified && this.verified !== identity) this.bridge.clear()
      this.verified = identity
      return observation
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') throw new RelayError('runtime_identity_unknown')
      return this.unavailable(error, signal)
    }
  }
  /** `RelayRuntimePolicy.counter`. The counter re-observes so its identity is its own evidence,
   * and proves once per served identity that the template round trip is real and agrees with the
   * worker bridge. A server whose template adds no framing, or echoes the message twice, is refused. */
  counter = async (fact: Readonly<{ model: string; digest: string; runtimeVersion: string; contextTokens: number }>, signal: AbortSignal): Promise<RelayExactCounter> => {
    const seen = await this.observe(fact.model, signal)
    await this.prove(seen, signal)
    return { identity: { model: seen.model, digest: seen.digest, runtimeVersion: seen.runtimeVersion }, placement: 'installed_local',
      source: LLAMA_SERVER_COUNTER_SOURCE, observedAt: seen.observedAt, confidence: 'high', count: request => this.countRequest(request) }
  }
  /** The template proof, once per served identity. */
  private async prove(seen: RelayRuntimeObservation, signal: AbortSignal, bridge = true): Promise<void> {
    const key = canonical([seen.digest, seen.runtimeVersion, seen.contextTokens])
    if ((bridge ? this.proven : this.provenAsync) === key) return
    try {
      const rendered = await this.client.render(PROBE, signal)
      invariant(occurrences(rendered, PROBE) === 1 && rendered.length > PROBE.length, 'runtime_counter_mismatch')
      const tokens = await this.client.countTokens(rendered, signal)
      // The worker bridge is the local counter's own implementation, so only that path proves it agrees.
      invariant(tokens > 0 && (!bridge || this.bridge.count(PROBE, true) === tokens), 'runtime_counter_mismatch')
    } catch (error) { this.unavailable(error, signal) }
    if (bridge) this.proven = key; else this.provenAsync = key
  }
  /** F2-d executor side: identity, template proof, rendering and exact token count of one user message in
   * one asynchronous step. The caller keeps the rendered text only to hash it; a dispatch re-renders. */
  async measure(content: string, signal: AbortSignal): Promise<{ observation: RelayRuntimeObservation; rendered: string; tokens: number }> {
    const observation = await this.observe(this.model, signal)
    // No synchronous bridge here: this runs inside a federation request handler on a node that must keep renewing leases.
    await this.prove(observation, signal, false)
    try {
      const rendered = await this.client.render(content, signal)
      const tokens = await this.client.countTokens(rendered, signal)
      return { observation, rendered, tokens }
    } catch (error) { return this.unavailable(error, signal) }
  }
  private proven = ''
  private provenAsync = ''
  private message(request: Readonly<OllamaChatRequest>): string {
    invariant(request.think === false && request.messages.length === 1 && request.messages[0]!.role === 'user' &&
      typeof request.messages[0]!.content === 'string', 'runtime_request_changed')
    return request.messages[0]!.content
  }
  private countRequest(request: Readonly<OllamaChatRequest>): number {
    return this.bridge.count(this.message(request))
  }
  /** F2-d: a one-call transport that additionally pins the rendered prompt and its token count to the evidence
   * the home counted. `evidence()` reports the hash of the prompt that was actually evaluated. */
  expectedTransport(expected: { renderedSha256: string; tokens: number; digest: string; contextTokens: number; responseSchemaSha256?: string }): LocalChatTransport & { evidence(): { renderedSha256?: string; responseSchemaSha256?: string; failure?: string } | undefined } {
    const seen: { renderedSha256?: string; responseSchemaSha256?: string; failure?: string } = {}
    const transport = { id: 'llama-server', host: this.host, usageSource: 'llama-server:/completion',
      chat: (request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void, dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest }) =>
        this.chat(request, signal, onDispatched, dispatch, expected, seen).catch((error: unknown) => {
          // K3 hides the cause behind a generic provider failure; keep the fixed code for the signed terminal event.
          if (error instanceof RelayError) seen.failure = error.code
          throw error
        }),
      evidence: () => seen.renderedSha256 || seen.failure ? { ...(seen.renderedSha256 ? { renderedSha256: seen.renderedSha256 } : {}),
        ...(seen.responseSchemaSha256 ? { responseSchemaSha256: seen.responseSchemaSha256 } : {}), ...(seen.failure ? { failure: seen.failure } : {}) } : undefined }
    return Object.freeze(transport)
  }
  private async chat(request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void,
    dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest },
    expected?: { renderedSha256: string; tokens: number; digest: string; contextTokens: number; responseSchemaSha256?: string }, seen?: { renderedSha256?: string; responseSchemaSha256?: string }): Promise<OllamaChatChunk> {
    this.ready?.()
    await dispatch.authorizeDispatch()
    signal.throwIfAborted()
    const first = dispatch.prepare(), content = this.message(first)
    const window = first.options?.num_ctx, limit = first.options?.num_predict
    invariant(Number.isSafeInteger(window) && Number.isSafeInteger(limit) && limit! > 0, 'runtime_request_changed')
    const schema = requestSchema(first.format)
    // The home pinned one schema to this counted request; a different one, or none, is another request.
    if (expected) invariant((schema ? schemaDigest(schema) : undefined) === expected.responseSchemaSha256, 'runtime_request_changed')
    if (expected) {
      // The count was made under one served model and window; this dispatch must run on exactly that one, and the
      // window it claims is the loaded one, whatever the home asked for.
      try {
        const now = await this.observe(this.model, signal)
        invariant(now.digest === expected.digest && now.contextTokens === expected.contextTokens, 'runtime_identity_changed')
        invariant(window === now.contextTokens, 'context_ceiling')
      } catch (error) { this.unavailable(error, signal) }
    }
    // Asynchronous renderer and tokenizer evidence. Any disagreement with the count the dispatch is bound to is a
    // refusal before the model sees a token. A remote job is bound to the home's exact count; the synchronous worker
    // bridge would block this node's event loop, which also carries its lease renewals, so it is not used for it.
    let rendered: string
    try {
      rendered = await this.client.render(content, signal)
      const tokens = await this.client.countTokens(rendered, signal)
      invariant(tokens === (expected ? expected.tokens : this.countRequest(first)), 'runtime_counter_mismatch')
      invariant(tokens + limit! <= window!, 'context_ceiling')
      // The home counted this exact rendering; anything else is not the request it admitted.
      if (expected) invariant(createHash('sha256').update(rendered).digest('hex') === expected.renderedSha256, 'runtime_counter_mismatch')
    } catch (error) { this.unavailable(error, signal) }
    // The final scrub, fence and shape checks run again and the POST is issued in the same
    // synchronous stretch: nothing can be revoked between them and the request.
    const last = dispatch.prepare()
    invariant(canonical(last) === canonical(first), 'runtime_request_changed')
    const done = await this.client.complete(rendered, limit!, signal, onDispatched, schema).catch((error: unknown) => this.unavailable(error, signal))
    // A truncated prompt is never accepted as the prompt that was counted.
    invariant(!done.truncated, 'truncation_protocol')
    if (expected) {
      invariant(done.promptTokens === expected.tokens, 'truncation_protocol')
      seen!.renderedSha256 = expected.renderedSha256
      if (schema) seen!.responseSchemaSha256 = expected.responseSchemaSha256
    }
    // Only a finished generation is a reply: `none` (still running) or an unknown stop type is refused.
    invariant(done.stopType === 'limit' || done.stopType === 'eos' || done.stopType === 'word', 'truncation_protocol')
    return { model: request.model, created_at: new Date(this.clock()).toISOString(), done: true, done_reason: done.stopType === 'limit' ? 'length' : 'stop',
      message: { role: 'assistant', content: done.content }, prompt_eval_count: done.promptTokens, eval_count: done.completionTokens }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); await this.bridge.close()
    await Promise.allSettled([...this.hashing.values()])
  }
}
