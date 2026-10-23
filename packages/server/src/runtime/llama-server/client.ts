import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'

/** Loopback-only client for one llama.cpp `llama-server` instance (ADR-0031 Tier 1 runtime).
 * It follows no redirect, carries no credential, retries nothing and never returns response text
 * in an error: a model prompt, completion or filesystem path must not reach a log. */
export type LlamaServerErrorCode = 'llama_server_unavailable' | 'llama_server_protocol' | 'llama_server_timeout' | 'llama_server_refused' | 'llama_server_schema_rejected'
export class LlamaServerError extends Error {
  readonly code: LlamaServerErrorCode
  constructor(code: LlamaServerErrorCode) { super(code); this.name = 'LlamaServerError'; this.code = code }
}

/** Upper bound for one JSON response, so a misbehaving local peer cannot exhaust memory. A
 * 128k-token tokenization is about one megabyte; this leaves an order of magnitude of headroom. */
export const LLAMA_SERVER_MAX_JSON_BYTES = 16 * 1024 * 1024
export const LLAMA_SERVER_TEMPLATE_KWARGS = Object.freeze({ enable_thinking: false })

export interface LlamaServerProps { modelPath: string; alias: string | null; contextTokens: number; slots: number; buildInfo: string }
export interface LlamaServerCompletion { content: string; promptTokens: number; completionTokens: number; stopType: string; truncated: boolean }
export interface LlamaServerClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  /** Short reads (`/health`, `/props`, `/apply-template`, `/tokenize`). */
  requestTimeoutMs?: number
  /** One `/completion` call, including prompt processing. Generation is not capped by Guanxi. */
  completionTimeoutMs?: number
  /** llama-server prefix reuse between calls. On by default; the reply's `tokens_evaluated` must still be the whole prompt. */
  cachePrompt?: boolean
}

const propsSchema = z.object({
  model_path: z.string().min(1),
  model_alias: z.string().nullish(),
  build_info: z.string().min(1),
  total_slots: z.number().int().positive().optional(),
  default_generation_settings: z.object({ n_ctx: z.number().int().positive().safe() }).passthrough(),
}).passthrough()
const templateSchema = z.object({ prompt: z.string() }).passthrough()
const tokenizeSchema = z.object({ tokens: z.array(z.unknown()) }).passthrough()
const completionSchema = z.object({
  content: z.string(),
  tokens_evaluated: z.number().int().nonnegative().safe(),
  tokens_predicted: z.number().int().nonnegative().safe(),
  stop_type: z.string().min(1),
  truncated: z.boolean(),
}).passthrough()

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** The single admission check for a llama-server address. The origin is normalised so that a path,
 * query, fragment or credential can never ride along. */
export function loopbackOrigin(baseUrl: string): string {
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new LlamaServerError('llama_server_refused') }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash ||
    !['', '/'].includes(url.pathname) || !url.port) throw new LlamaServerError('llama_server_refused')
  return url.origin
}

/** undici timeouts for llama-server requests: never shorter than the client's own deadlines. */
export function llamaServerDispatcherTimeouts(requestTimeoutMs: number, completionTimeoutMs: number): { headersTimeout: number; bodyTimeout: number } {
  const longest = Math.max(requestTimeoutMs, completionTimeoutMs) + 5_000
  return { headersTimeout: longest, bodyTimeout: longest }
}

export class LlamaServerClient {
  readonly baseUrl: string
  private readonly transport: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly completionTimeoutMs: number
  private readonly cachePrompt: boolean
  constructor(options: LlamaServerClientOptions) {
    this.baseUrl = loopbackOrigin(options.baseUrl)
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30 * 60_000
    if (options.fetch) this.transport = options.fetch
    else {
      // A non-streamed completion sends its headers only when generation ends. Node's fetch (undici) gives up waiting for
      // headers after 300 s by default, so every call longer than five minutes failed on a real executor (a 4096-token turn
      // takes ~13 min at ~5 tokens/s). Our own deadline (completionTimeoutMs) stays the authority.
      const dispatcher = new Agent(llamaServerDispatcherTimeouts(this.requestTimeoutMs, this.completionTimeoutMs))
      // undici's own fetch with its own Agent: the fetch bundled in Node 22 (undici 6) refuses an Agent from the undici
      // package (UND_ERR_INVALID_ARG), so the two must come from the same copy.
      this.transport = ((url: string | URL, init?: RequestInit) => undiciFetch(url, { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch
    }
    this.cachePrompt = options.cachePrompt ?? true
    for (const ms of [this.requestTimeoutMs, this.completionTimeoutMs]) {
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new LlamaServerError('llama_server_refused')
    }
  }
  private async json(path: string, init: { method: 'GET' | 'POST'; body?: unknown }, signal: AbortSignal | undefined, timeoutMs: number,
    onDispatched?: () => void): Promise<{ status: number; body: unknown }> {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(timeoutMs), observer = new AbortController()
    const composed = AbortSignal.any([...(signal ? [signal] : []), deadline, observer.signal])
    try {
      // The transport is awaited, never raced: a returned or thrown call has finished with its socket.
      const pending = this.transport(this.baseUrl + path, { method: init.method, redirect: 'error', signal: composed,
        headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
      try { onDispatched?.() } catch (failure) {
        // A started transport stays owned until it has settled; the observer failure stays authoritative.
        observer.abort(); await pending.then(late => late.body?.cancel(), () => undefined).catch(() => undefined); throw failure
      }
      const response = await pending
      const type = response.headers.get('content-type') ?? ''
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > LLAMA_SERVER_MAX_JSON_BYTES) { await response.body?.cancel().catch(() => undefined); throw new LlamaServerError('llama_server_protocol') }
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength
        if (size > LLAMA_SERVER_MAX_JSON_BYTES) throw new LlamaServerError('llama_server_protocol')
        chunks.push(chunk)
      }
      if (!type.toLowerCase().startsWith('application/json')) {
        if (response.status === 503) return { status: 503, body: null }
        throw new LlamaServerError('llama_server_protocol')
      }
      try { return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } }
      catch { throw new LlamaServerError('llama_server_protocol') }
    } catch (error) {
      if (error instanceof LlamaServerError || observer.signal.aborted) throw error
      if (signal?.aborted) throw signal.reason ?? error
      if (deadline.aborted) throw new LlamaServerError('llama_server_timeout')
      throw new LlamaServerError('llama_server_unavailable')
    }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new LlamaServerError('llama_server_protocol')
    return parsed.data
  }
  /** `loading` is the documented 503 while the model file is being read. */
  async health(signal?: AbortSignal): Promise<'ok' | 'loading'> {
    const { status, body } = await this.json('/health', { method: 'GET' }, signal, this.requestTimeoutMs)
    if (status === 200 && body && typeof body === 'object' && (body as { status?: unknown }).status === 'ok') return 'ok'
    if (status === 503) return 'loading'
    throw new LlamaServerError('llama_server_protocol')
  }
  async props(signal?: AbortSignal): Promise<LlamaServerProps> {
    const { status, body } = await this.json('/props', { method: 'GET' }, signal, this.requestTimeoutMs)
    if (status !== 200) throw new LlamaServerError(status === 503 ? 'llama_server_unavailable' : 'llama_server_protocol')
    const props = this.parse(propsSchema, body)
    return { modelPath: props.model_path, alias: props.model_alias ?? null, contextTokens: props.default_generation_settings.n_ctx,
      slots: props.total_slots ?? 1, buildInfo: props.build_info }
  }
  /** The server's own Jinja rendering of one user message, the same text `/completion` receives. */
  async render(content: string, signal?: AbortSignal): Promise<string> {
    const { status, body } = await this.json('/apply-template', { method: 'POST',
      body: { messages: [{ role: 'user', content }], chat_template_kwargs: LLAMA_SERVER_TEMPLATE_KWARGS } }, signal, this.requestTimeoutMs)
    if (status !== 200) throw new LlamaServerError('llama_server_protocol')
    return this.parse(templateSchema, body).prompt
  }
  /** Token count of a string prompt with the flags `/completion` itself applies to one. */
  async countTokens(prompt: string, signal?: AbortSignal): Promise<number> {
    const { status, body } = await this.json('/tokenize', { method: 'POST', body: { content: prompt, add_special: true, parse_special: true } },
      signal, this.requestTimeoutMs)
    if (status !== 200) throw new LlamaServerError('llama_server_protocol')
    return this.parse(tokenizeSchema, body).tokens.length
  }
  /** `jsonSchema` constrains decoding (llama.cpp turns it into a grammar). It changes no prompt token: `tokens_evaluated` is the same with and without. */
  async complete(prompt: string, maxTokens: number, signal: AbortSignal, onDispatched?: () => void, jsonSchema?: Record<string, unknown>): Promise<LlamaServerCompletion> {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new LlamaServerError('llama_server_refused')
    const { status, body } = await this.json('/completion', { method: 'POST',
      body: { prompt, n_predict: maxTokens, stream: false, cache_prompt: this.cachePrompt, ...(jsonSchema ? { json_schema: jsonSchema } : {}) } }, signal, this.completionTimeoutMs, onDispatched)
    // A server that cannot build the grammar answers a request error (4xx, or 500 from the grammar builder). Which schema and why stays in its
    // own log: no response text is returned, so the cause is only named, not quoted.
    if (status !== 200) throw new LlamaServerError(status === 503 ? 'llama_server_unavailable' : jsonSchema && status >= 400 ? 'llama_server_schema_rejected' : 'llama_server_protocol')
    const completion = this.parse(completionSchema, body)
    return { content: completion.content, promptTokens: completion.tokens_evaluated, completionTokens: completion.tokens_predicted,
      stopType: completion.stop_type, truncated: completion.truncated }
  }
}
