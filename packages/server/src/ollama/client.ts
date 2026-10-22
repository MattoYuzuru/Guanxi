/**
 * Клиент Ollama HTTP API.
 *
 * Стримовые эндпоинты отдают NDJSON (по JSON-объекту на строку), а не SSE —
 * поэтому здесь свой разборщик строк, а не EventSource.
 */
import type {
  OllamaChatChunk,
  OllamaChatRequest,
  OllamaCreateChunk,
  OllamaPsResponse,
  OllamaPullChunk,
  OllamaShowResponse,
  OllamaTagsResponse,
} from './types.ts'
import { z } from 'zod'

export type OllamaTimeoutPhase = 'connect' | 'load' | 'stream_idle'

const TIMEOUT_MESSAGE: Record<OllamaTimeoutPhase, string> = {
  connect: 'Timed out while connecting to Ollama',
  load: 'Timed out while waiting for Ollama to load the model',
  stream_idle: 'Ollama response stream stopped making progress',
}

export class OllamaError extends Error {
  readonly status: number | null
  readonly reason: unknown

  constructor(message: string, status: number | null, reason?: unknown) {
    super(message)
    this.name = 'OllamaError'
    this.status = status
    this.reason = reason
  }
}

/** Ollama не отвечает — сервис не запущен, не установлен или указан не тот хост. */
export class OllamaUnavailableError extends OllamaError {
  constructor(_host: string, cause?: unknown) {
    // The configured endpoint can contain credentials. Keep it on the client
    // instance for transport only; public errors expose a stable safe summary.
    super('Ollama is unavailable at the configured endpoint', null, cause)
    this.name = 'OllamaUnavailableError'
  }
}

export class OllamaTimeoutError extends OllamaError {
  readonly phase: OllamaTimeoutPhase
  readonly timeoutMs: number

  constructor(phase: OllamaTimeoutPhase, timeoutMs: number) {
    super(TIMEOUT_MESSAGE[phase], null)
    this.name = 'OllamaTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export class OllamaProtocolError extends OllamaError {
  readonly endpoint: string

  constructor(endpoint: string, message = 'Ollama returned an incompatible response') {
    super(message, null)
    this.name = 'OllamaProtocolError'
    this.endpoint = endpoint
  }
}

export interface OllamaClientOptions {
  host: string
  /** Legacy alias for the ordinary connect deadline. */
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  loadTimeoutMs?: number
  streamIdleTimeoutMs?: number
  fetch?: typeof fetch
}

type RequestOptions = RequestInit & {
  onDispatched?: () => void
  connectTimeoutMs?: number
  requestPhase?: Exclude<OllamaTimeoutPhase, 'stream_idle'>
  responseTimeout?: {
    phase: Exclude<OllamaTimeoutPhase, 'stream_idle'>
    timeoutMs: number
  }
  /**
   * `/api/chat` POST only: the caller keeps its transport/model ownership until
   * the actual fetch and any body cleanup settle. Never read from request JSON.
   */
  awaitTransportSettlement?: boolean
}

interface TransportSettlement<T> {
  /** Block until the actual operation and its cleanup settle. */
  awaitSettlement: boolean
  /** Dispose a response that arrives after a control outcome already won. */
  disposeLate?: (value: T) => Promise<void>
}

async function disposeResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // An already errored, locked or absent body is still a settled cleanup.
  }
}

export interface OllamaStreamTimeoutPolicy {
  connectTimeoutMs: number
  loadTimeoutMs: number
  streamIdleTimeoutMs: number
  /** Provider-frame resource bounds; not user-facing output limits. */
  maxLineBytes?: number
  maxFrames?: number
}

const versionResponseSchema = z.object({
  version: z.string().min(1),
})

const modelDetailsSchema = z
  .object({
    parent_model: z.string().optional(),
    format: z.string().optional(),
    family: z.string().optional(),
    families: z.array(z.string()).nullable().optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
    context_length: z.number().int().optional(),
    embedding_length: z.number().int().optional(),
  })
  .passthrough()

const tagsResponseSchema = z.object({
  models: z.array(
    z
      .object({
        name: z.string().min(1),
        model: z.string().catch(''),
        modified_at: z.string().catch(''),
        size: z.number().int().nonnegative().catch(0),
        digest: z.string().catch(''),
        details: modelDetailsSchema.catch({}),
        capabilities: z.unknown().optional(),
      })
      .passthrough(),
  ),
})

const showResponseSchema = z
  .object({
    license: z.string().optional().catch(undefined),
    modelfile: z.string().optional().catch(undefined),
    parameters: z.string().optional().catch(undefined),
    template: z.string().optional().catch(undefined),
    system: z.string().optional().catch(undefined),
    details: modelDetailsSchema.optional().catch(undefined),
    model_info: z.record(z.unknown()).optional().catch(undefined),
    capabilities: z.unknown().optional(),
  })
  .passthrough()

const psResponseSchema = z.object({
  models: z.array(
    z
      .object({
        name: z.string().min(1),
        model: z.string().min(1),
        size: z.number().int().nonnegative(),
        digest: z.string().min(1),
        details: modelDetailsSchema,
        size_vram: z.number().int().nonnegative().optional(),
        context_length: z.number().int().nonnegative().optional(),
        expires_at: z.string().optional(),
      })
      .passthrough(),
  ),
})

const pullChunkSchema = z.union([
  z
    .object({
      status: z.string().min(1),
      error: z.never().optional(),
      digest: z.string().min(1).optional(),
      total: z.number().int().nonnegative().optional(),
      completed: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      error: z.string().min(1),
      status: z.never().optional(),
    })
    .passthrough(),
])

const createChunkSchema = z.union([
  z.object({
    status: z.string().min(1),
    error: z.never().optional(),
    digest: z.string().min(1).optional(),
    total: z.number().int().nonnegative().optional(),
    completed: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    error: z.string().min(1),
    status: z.never().optional(),
  }).strict(),
])

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u

export class OllamaClient {
  readonly host: string
  private readonly connectTimeoutMs: number
  private readonly loadTimeoutMs: number
  private readonly streamIdleTimeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OllamaClientOptions) {
    this.host = options.host.replace(/\/+$/, '')
    this.connectTimeoutMs = options.connectTimeoutMs ?? options.requestTimeoutMs ?? 15_000
    this.loadTimeoutMs = options.loadTimeoutMs ?? 300_000
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 30_000
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /* ─────────────────────────────── Основа ───────────────────────────────── */

  private async withinDeadline<T>(
    phase: OllamaTimeoutPhase,
    timeoutMs: number,
    controller: AbortController,
    externalSignal: AbortSignal | null,
    operation: () => Promise<T>,
    reportedTimeoutMs = timeoutMs,
    settlement?: TransportSettlement<T>,
  ): Promise<T> {
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeExternalAbortListener: (() => void) | undefined
    const abortError = () => new DOMException('Aborted', 'AbortError')
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (externalSignal?.aborted) {
          reject(abortError())
          return
        }
        timedOut = true
        controller.abort(`guanxi:ollama-${phase}-timeout`)
        // Abort handlers run synchronously. Check the caller-owned signal after
        // them so an explicit Stop observed in the same turn stays authoritative.
        if (externalSignal?.aborted) {
          reject(abortError())
          return
        }
        reject(new OllamaTimeoutError(phase, reportedTimeoutMs))
      }, timeoutMs)
    })
    const externalAbort = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(abortError())
          if (externalSignal.aborted) {
            onAbort()
            return
          }
          externalSignal.addEventListener('abort', onAbort, { once: true })
          removeExternalAbortListener = () =>
            externalSignal.removeEventListener('abort', onAbort)
        })
      : null

    // Dispatch can synchronously abort and throw before Promise.race attaches handlers.
    // Consume those control rejections while preserving the dispatch observer's own error.
    void deadline.catch(() => undefined)
    void externalAbort?.catch(() => undefined)

    let operationPromise: Promise<T>
    try {
      operationPromise = operation()
    } catch (error) {
      operationPromise = Promise.reject(error)
    }

    // A late provider outcome is either disposed (responses) or consumed
    // (rejections). Settled transport cleanup is the only point where the caller
    // may release its permit; if the transport never acknowledges, this stays
    // pending honestly rather than reporting a false cancellation.
    const settleOperation = async (): Promise<void> => {
      try {
        const value = await operationPromise
        await settlement?.disposeLate?.(value)
      } catch {
        // The control outcome is authoritative; consume the late failure.
      }
    }

    try {
      return await Promise.race([
        operationPromise,
        deadline,
        ...(externalAbort ? [externalAbort] : []),
      ])
    } catch (error) {
      // The caller-owned signal is authoritative even when its abort and the
      // deadline become observable in the same event-loop turn.
      const controlError = externalSignal?.aborted
        ? error
        : timedOut
          ? new OllamaTimeoutError(phase, reportedTimeoutMs)
          : error
      if (timer) clearTimeout(timer)
      removeExternalAbortListener?.()
      if (settlement?.awaitSettlement) await settleOperation()
      else void settleOperation()
      throw controlError
    } finally {
      if (timer) clearTimeout(timer)
      removeExternalAbortListener?.()
    }
  }

  private async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const {
      onDispatched,
      connectTimeoutMs = this.connectTimeoutMs,
      requestPhase = 'connect',
      responseTimeout = { phase: 'connect' as const, timeoutMs: connectTimeoutMs },
      awaitTransportSettlement = false,
      ...requestInit
    } = init
    const controller = new AbortController()
    const externalSignal = requestInit.signal ?? null
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal

    let pending: Promise<Response>
    try {
      pending = this.fetchImpl(`${this.host}${path}`, {
        ...requestInit,
        signal,
        headers: {
          'content-type': 'application/json',
          ...(requestInit.headers ?? {}),
        },
      })
    } catch (error) {
      if (externalSignal?.aborted) throw error
      throw new OllamaUnavailableError(this.host, error)
    }

    // A synchronous observer throw still leaves a started transport behind. Keep
    // the initiator owned until that exact fetch settles and any response body is
    // disposed, then surface the observer failure.
    let dispatchFailure: unknown
    let dispatchFailed = false
    try {
      onDispatched?.()
    } catch (error) {
      dispatchFailed = true
      dispatchFailure = error
      controller.abort('guanxi:ollama-dispatch-observer')
    }
    if (dispatchFailed) {
      try {
        const late = await pending
        await disposeResponseBody(late)
      } catch {
        // The observer failure is authoritative; the started transport is settled.
      }
      if (externalSignal?.aborted) throw dispatchFailure
      throw new OllamaUnavailableError(this.host, dispatchFailure)
    }

    let response: Response
    try {
      response = await this.withinDeadline(
        requestPhase,
        connectTimeoutMs,
        controller,
        externalSignal,
        () => pending,
        connectTimeoutMs,
        {
          awaitSettlement: awaitTransportSettlement,
          disposeLate: disposeResponseBody,
        },
      )
    } catch (error) {
      if (externalSignal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }

    if (!response.ok) {
      await disposeResponseBody(response)
      throw new OllamaError(`Ollama returned HTTP ${response.status} on ${path}`, response.status)
    }

    let text: string
    try {
      text = await this.withinDeadline(
        responseTimeout.phase,
        responseTimeout.timeoutMs,
        controller,
        externalSignal,
        () => response.text(),
        responseTimeout.timeoutMs,
        { awaitSettlement: awaitTransportSettlement },
      )
    } catch (error) {
      if (externalSignal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaError(`Ollama response body failed on ${path}`, response.status, error)
    }

    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new OllamaProtocolError(path, `Ollama returned invalid JSON on ${path}`)
    }
  }

  /**
   * Разбирает NDJSON-поток в объекты. Держит хвост неполной строки между чтениями,
   * иначе объект, разорванный границей чанка, потеряется.
   */
  private async *streamNdjson<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    timeoutPolicy?: OllamaStreamTimeoutPolicy,
    awaitTransportSettlement = false,
  ): AsyncGenerator<T> {
    const controller = new AbortController()
    const externalSignal = signal ?? null
    const requestSignal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal
    let response: Response
    try {
      response = await this.withinDeadline(
        'connect',
        timeoutPolicy?.connectTimeoutMs ?? this.connectTimeoutMs,
        controller,
        externalSignal,
        () =>
          this.fetchImpl(`${this.host}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: requestSignal,
          }),
        timeoutPolicy?.connectTimeoutMs ?? this.connectTimeoutMs,
        {
          awaitSettlement: awaitTransportSettlement,
          disposeLate: disposeResponseBody,
        },
      )
    } catch (error) {
      if (signal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }

    if (!response.ok || !response.body) {
      await disposeResponseBody(response)
      throw new OllamaError(`Ollama returned HTTP ${response.status} on ${path}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let observedProgress = false
    let frames = 0
    const maxLineBytes = timeoutPolicy?.maxLineBytes ?? 64 * 1024
    const maxFrames = timeoutPolicy?.maxFrames ?? 10_000
    const loadTimeoutMs = timeoutPolicy?.loadTimeoutMs ?? this.loadTimeoutMs
    const streamIdleTimeoutMs =
      timeoutPolicy?.streamIdleTimeoutMs ?? this.streamIdleTimeoutMs
    let progressDeadline = Date.now() + loadTimeoutMs

    try {
      while (true) {
        const phase: OllamaTimeoutPhase = observedProgress ? 'stream_idle' : 'load'
        const policyTimeoutMs = observedProgress
          ? streamIdleTimeoutMs
          : loadTimeoutMs
        const remainingMs = Math.max(1, progressDeadline - Date.now())
        const { done, value } = await this.withinDeadline(
          phase,
          remainingMs,
          controller,
          externalSignal,
          () => reader.read(),
          policyTimeoutMs,
          { awaitSettlement: awaitTransportSettlement },
        )
        if (done) break
        if (!value || value.byteLength === 0) continue

        buffer += decoder.decode(value, { stream: true })
        if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes && !buffer.includes('\n')) {
          throw new OllamaProtocolError(path, 'Ollama NDJSON frame exceeded the safe bound')
        }
        const lines = buffer.split('\n')
        // Последний элемент — возможно неполная строка, оставляем в буфере.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (Buffer.byteLength(trimmed, 'utf8') > maxLineBytes || ++frames > maxFrames) {
            throw new OllamaProtocolError(path, 'Ollama NDJSON stream exceeded the safe bound')
          }
          let parsed: T
          try {
            parsed = JSON.parse(trimmed) as T
          } catch {
            throw new OllamaProtocolError(path, 'Ollama returned malformed NDJSON')
          }
          observedProgress = true
          progressDeadline = Date.now() + streamIdleTimeoutMs
          yield parsed
        }
      }

      const tail = buffer.trim()
      if (tail) {
        if (Buffer.byteLength(tail, 'utf8') > maxLineBytes || ++frames > maxFrames) {
          throw new OllamaProtocolError(path, 'Ollama NDJSON stream exceeded the safe bound')
        }
        try {
          yield JSON.parse(tail) as T
        } catch {
          throw new OllamaProtocolError(path, 'Ollama returned malformed NDJSON')
        }
      }
    } catch (error) {
      // Preserve abort identity for runTurn's authoritative cancellation
      // classification. Other body/read/parse failures came from the provider
      // stream and must not be mistaken for an internal application failure.
      if (
        signal?.aborted
        || error instanceof OllamaTimeoutError
        || error instanceof OllamaProtocolError
      ) throw error
      throw new OllamaError('Ollama response stream failed', response.status, error)
    } finally {
      if (!controller.signal.aborted) controller.abort('guanxi:ollama-stream-cleanup')
      const cancelled = reader.cancel().catch(() => undefined)
      if (awaitTransportSettlement) await cancelled
      else void cancelled
    }
  }

  /* ─────────────────────────────── Эндпоинты ────────────────────────────── */

  async version(signal?: AbortSignal): Promise<string> {
    const result = await this.request<unknown>('/api/version', {
      connectTimeoutMs: Math.min(this.connectTimeoutMs, 3_000),
      ...(signal ? { signal } : {}),
    })
    const parsed = versionResponseSchema.safeParse(result)
    if (!parsed.success) throw new OllamaProtocolError('/api/version')
    return parsed.data.version
  }

  async tags(signal?: AbortSignal): Promise<OllamaTagsResponse> {
    const result = await this.request<unknown>('/api/tags', signal ? { signal } : {})
    const parsed = tagsResponseSchema.safeParse(result)
    if (!parsed.success) throw new OllamaProtocolError('/api/tags')
    return parsed.data satisfies OllamaTagsResponse
  }

  async ps(signal?: AbortSignal): Promise<OllamaPsResponse> {
    const result = await this.request<unknown>('/api/ps', {
      connectTimeoutMs: Math.min(this.connectTimeoutMs, 5_000),
      ...(signal ? { signal } : {}),
    })
    const parsed = psResponseSchema.safeParse(result)
    if (!parsed.success) throw new OllamaProtocolError('/api/ps')
    return parsed.data satisfies OllamaPsResponse
  }

  async show(name: string, signal?: AbortSignal): Promise<OllamaShowResponse> {
    const result = await this.request<unknown>('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: name }),
      ...(signal ? { signal } : {}),
    })
    const parsed = showResponseSchema.safeParse(result)
    if (!parsed.success) throw new OllamaProtocolError('/api/show')
    return parsed.data satisfies OllamaShowResponse
  }

  async deleteModel(name: string): Promise<void> {
    await this.request<unknown>('/api/delete', {
      method: 'DELETE',
      body: JSON.stringify({ model: name }),
    })
  }

  async *pull(name: string, signal?: AbortSignal): AsyncGenerator<OllamaPullChunk> {
    for await (const raw of this.streamNdjson<unknown>(
      '/api/pull',
      { model: name, stream: true },
      signal,
    )) {
      const parsed = pullChunkSchema.safeParse(raw)
      if (!parsed.success) throw new OllamaProtocolError('/api/pull')
      yield parsed.data
    }
  }

  async blobExists(digest: string, signal?: AbortSignal): Promise<boolean> {
    if (!SHA256_DIGEST.test(digest)) throw new OllamaProtocolError('/api/blobs/:digest')
    const controller = new AbortController()
    const externalSignal = signal ?? null
    const composed = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal
    let response: Response
    try {
      response = await this.withinDeadline(
        'connect',
        Math.min(this.connectTimeoutMs, 10_000),
        controller,
        externalSignal,
        () => this.fetchImpl(`${this.host}/api/blobs/${digest}`, {
          method: 'HEAD', signal: composed,
        }),
      )
    } catch (error) {
      if (externalSignal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }
    await response.body?.cancel().catch(() => {})
    if (response.status === 200) return true
    if (response.status === 404) return false
    throw new OllamaError('Ollama could not check the import blob', response.status)
  }

  async pushBlob(
    digest: string,
    body: NonNullable<RequestInit['body']>,
    contentLength: number,
    signal: AbortSignal,
    overallTimeoutMs: number,
  ): Promise<void> {
    if (!SHA256_DIGEST.test(digest)) throw new OllamaProtocolError('/api/blobs/:digest')
    const controller = new AbortController()
    const composed = AbortSignal.any([signal, controller.signal])
    let response: Response
    try {
      response = await this.withinDeadline(
        'load',
        overallTimeoutMs,
        controller,
        signal,
        () => this.fetchImpl(`${this.host}/api/blobs/${digest}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(contentLength),
          },
          body,
          signal: composed,
          duplex: 'half',
        } as RequestInit),
      )
    } catch (error) {
      if (signal.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }
    await response.body?.cancel().catch(() => {})
    if (response.status !== 201) {
      throw new OllamaError('Ollama rejected the import blob', response.status)
    }
  }

  async *createModelFromBlob(
    model: string,
    filename: string,
    digest: string,
    signal?: AbortSignal,
    timeoutPolicy?: OllamaStreamTimeoutPolicy,
  ): AsyncGenerator<OllamaCreateChunk> {
    if (!SHA256_DIGEST.test(digest)) throw new OllamaProtocolError('/api/create')
    for await (const raw of this.streamNdjson<unknown>(
      '/api/create',
      { model, files: { [filename]: digest }, stream: true },
      signal,
      timeoutPolicy,
    )) {
      const parsed = createChunkSchema.safeParse(raw)
      if (!parsed.success) throw new OllamaProtocolError('/api/create')
      yield parsed.data
    }
  }

  chatStream(
    request: OllamaChatRequest,
    signal?: AbortSignal,
    timeoutPolicy?: OllamaStreamTimeoutPolicy,
  ): AsyncGenerator<OllamaChatChunk> {
    return this.streamNdjson<OllamaChatChunk>(
      '/api/chat',
      { ...request, stream: true },
      signal,
      timeoutPolicy,
      true,
    )
  }

  async chat(request: OllamaChatRequest, signal?: AbortSignal, onDispatched?: () => void): Promise<OllamaChatChunk> {
    // A non-stream Ollama response can withhold HTTP headers while loading the
    // model. A bounded version preflight establishes connect separately; the
    // model request that follows owns the load deadline.
    await this.version(signal)
    return this.request<OllamaChatChunk>('/api/chat', {
      onDispatched,
      method: 'POST',
      body: JSON.stringify({ ...request, stream: false }),
      ...(signal ? { signal } : {}),
      awaitTransportSettlement: true,
      connectTimeoutMs: this.loadTimeoutMs,
      requestPhase: 'load',
      responseTimeout: {
        phase: 'load',
        timeoutMs: this.loadTimeoutMs,
      },
    })
  }

  /**
   * Загружает модель в память с нужным окном, ничего не генерируя.
   * Пустой список сообщений — штатный способ прогрева в Ollama.
   */
  async warm(
    name: string,
    numCtx: number,
    keepAlive = '10m',
    signal?: AbortSignal,
  ): Promise<void> {
    await this.version(signal)
    await this.request<unknown>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: name,
        messages: [],
        stream: false,
        keep_alive: keepAlive,
        options: { num_ctx: numCtx },
      }),
      connectTimeoutMs: this.loadTimeoutMs,
      requestPhase: 'load',
      responseTimeout: {
        phase: 'load',
        timeoutMs: this.loadTimeoutMs,
      },
      awaitTransportSettlement: true,
      ...(signal ? { signal } : {}),
    })
  }

  /** Выгружает модель из памяти: keep_alive = 0. */
  async unload(name: string): Promise<void> {
    await this.request<unknown>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ model: name, messages: [], stream: false, keep_alive: 0 }),
      connectTimeoutMs: 30_000,
      responseTimeout: { phase: 'connect', timeoutMs: 30_000 },
      awaitTransportSettlement: true,
    })
  }
}
