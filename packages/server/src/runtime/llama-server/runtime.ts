import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { LocalChatTransport } from '../../connections/service.ts'
import type { OllamaChatChunk, OllamaChatRequest } from '../../ollama/types.ts'
import { canonical } from '../../relay/handoff.ts'
import type { RelayExactCounter, RelayRuntimeObservation, RelayRuntimeObserver } from '../../relay/runtime.ts'
import { invariant, RelayError } from '../../relay/types.ts'
import { normalizeOllamaModelReference } from '../observation-key.ts'
import { LlamaServerError, type LlamaServerClient } from './client.ts'
import { SyncTokenCounter } from './sync-count.ts'

export const LLAMA_SERVER_PROPS_SOURCE = 'llama_server_props'
export const LLAMA_SERVER_COUNTER_SOURCE = 'llama-server:/apply-template+/tokenize'
const PROBE = 'guanxi-render-probe-7f3a91c4'

export interface LlamaServerRuntimeOptions {
  client: LlamaServerClient
  /** The one model reference this server instance serves; `--alias` must report it. */
  model: string
  /** Spawn mode: the GGUF file the owner process was started with. `/props` must agree. */
  expectedModelPath?: string
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
  private readonly expectedModelPath?: string
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
    this.expectedModelPath = options.expectedModelPath; this.ready = options.ready; this.clock = options.clock ?? Date.now
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
      if (this.expectedModelPath) invariant(await realpath(props.modelPath).catch(() => '') === await realpath(this.expectedModelPath).catch(() => '#'), 'runtime_identity_unknown')
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
    const key = canonical([seen.digest, seen.runtimeVersion, seen.contextTokens])
    if (this.proven !== key) {
      try {
        const rendered = await this.client.render(PROBE, signal)
        invariant(occurrences(rendered, PROBE) === 1 && rendered.length > PROBE.length, 'runtime_counter_mismatch')
        const tokens = await this.client.countTokens(rendered, signal)
        invariant(tokens > 0 && this.bridge.count(PROBE, true) === tokens, 'runtime_counter_mismatch')
      } catch (error) { this.unavailable(error, signal) }
      this.proven = key
    }
    return { identity: { model: seen.model, digest: seen.digest, runtimeVersion: seen.runtimeVersion }, placement: 'installed_local',
      source: LLAMA_SERVER_COUNTER_SOURCE, observedAt: seen.observedAt, confidence: 'high', count: request => this.countRequest(request) }
  }
  private proven = ''
  private message(request: Readonly<OllamaChatRequest>): string {
    invariant(request.think === false && request.messages.length === 1 && request.messages[0]!.role === 'user' &&
      typeof request.messages[0]!.content === 'string', 'runtime_request_changed')
    return request.messages[0]!.content
  }
  private countRequest(request: Readonly<OllamaChatRequest>): number {
    return this.bridge.count(this.message(request))
  }
  private async chat(request: OllamaChatRequest, signal: AbortSignal, onDispatched: () => void,
    dispatch: { authorizeDispatch: () => Promise<void>; prepare: () => OllamaChatRequest }): Promise<OllamaChatChunk> {
    this.ready?.()
    await dispatch.authorizeDispatch()
    signal.throwIfAborted()
    const first = dispatch.prepare(), content = this.message(first)
    const window = first.options?.num_ctx, limit = first.options?.num_predict
    invariant(Number.isSafeInteger(window) && Number.isSafeInteger(limit) && limit! > 0, 'runtime_request_changed')
    // Asynchronous renderer and tokenizer evidence. Any disagreement with the synchronous count the
    // executor used for its ceiling is a refusal before the model sees a token.
    let rendered: string
    try {
      rendered = await this.client.render(content, signal)
      const tokens = await this.client.countTokens(rendered, signal)
      invariant(tokens === this.countRequest(first), 'runtime_counter_mismatch')
      invariant(tokens + limit! <= window!, 'context_ceiling')
    } catch (error) { this.unavailable(error, signal) }
    // The final scrub, fence and shape checks run again and the POST is issued in the same
    // synchronous stretch: nothing can be revoked between them and the request.
    const last = dispatch.prepare()
    invariant(canonical(last) === canonical(first), 'runtime_request_changed')
    const done = await this.client.complete(rendered, limit!, signal, onDispatched).catch((error: unknown) => this.unavailable(error, signal))
    // A truncated prompt is never accepted as the prompt that was counted.
    invariant(!done.truncated, 'truncation_protocol')
    return { model: request.model, created_at: new Date(this.clock()).toISOString(), done: true, done_reason: done.stopType === 'limit' ? 'length' : 'stop',
      message: { role: 'assistant', content: done.content }, prompt_eval_count: done.promptTokens, eval_count: done.completionTokens }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); await this.bridge.close()
    await Promise.allSettled([...this.hashing.values()])
  }
}
