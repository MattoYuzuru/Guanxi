/**
 * Клиент Ollama HTTP API.
 *
 * Стримовые эндпоинты отдают NDJSON (по JSON-объекту на строку), а не SSE —
 * поэтому здесь свой разборщик строк, а не EventSource.
 */
import type {
  OllamaChatChunk,
  OllamaChatRequest,
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
  connectTimeoutMs?: number
  requestPhase?: Exclude<OllamaTimeoutPhase, 'stream_idle'>
  responseTimeout?: {
    phase: Exclude<OllamaTimeoutPhase, 'stream_idle'>
    timeoutMs: number
  }
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
        controller.abort(`alamo:ollama-${phase}-timeout`)
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

    try {
      return await Promise.race([
        operation(),
        deadline,
        ...(externalAbort ? [externalAbort] : []),
      ])
    } catch (error) {
      // The caller-owned signal is authoritative even when its abort and the
      // deadline become observable in the same event-loop turn.
      if (externalSignal?.aborted) throw error
      if (timedOut) throw new OllamaTimeoutError(phase, reportedTimeoutMs)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      removeExternalAbortListener?.()
    }
  }

  private async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const {
      connectTimeoutMs = this.connectTimeoutMs,
      requestPhase = 'connect',
      responseTimeout = { phase: 'connect' as const, timeoutMs: connectTimeoutMs },
      ...requestInit
    } = init
    const controller = new AbortController()
    const externalSignal = requestInit.signal ?? null
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal

    let response: Response
    try {
      response = await this.withinDeadline(
        requestPhase,
        connectTimeoutMs,
        controller,
        externalSignal,
        () =>
          this.fetchImpl(`${this.host}${path}`, {
            ...requestInit,
            signal,
            headers: {
              'content-type': 'application/json',
              ...(requestInit.headers ?? {}),
            },
          }),
      )
    } catch (error) {
      if (externalSignal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
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
        this.connectTimeoutMs,
        controller,
        externalSignal,
        () =>
          this.fetchImpl(`${this.host}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: requestSignal,
          }),
      )
    } catch (error) {
      if (signal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaUnavailableError(this.host, error)
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new OllamaError(`Ollama returned HTTP ${response.status} on ${path}`, response.status)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let observedProgress = false
    let progressDeadline = Date.now() + this.loadTimeoutMs

    try {
      while (true) {
        const phase: OllamaTimeoutPhase = observedProgress ? 'stream_idle' : 'load'
        const policyTimeoutMs = observedProgress
          ? this.streamIdleTimeoutMs
          : this.loadTimeoutMs
        const remainingMs = Math.max(1, progressDeadline - Date.now())
        const { done, value } = await this.withinDeadline(
          phase,
          remainingMs,
          controller,
          externalSignal,
          () => reader.read(),
          policyTimeoutMs,
        )
        if (done) break
        if (!value || value.byteLength === 0) continue

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Последний элемент — возможно неполная строка, оставляем в буфере.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const parsed = JSON.parse(trimmed) as T
          observedProgress = true
          progressDeadline = Date.now() + this.streamIdleTimeoutMs
          yield parsed
        }
      }

      const tail = buffer.trim()
      if (tail) yield JSON.parse(tail) as T
    } catch (error) {
      // Preserve abort identity for runTurn's authoritative cancellation
      // classification. Other body/read/parse failures came from the provider
      // stream and must not be mistaken for an internal application failure.
      if (signal?.aborted || error instanceof OllamaTimeoutError) throw error
      throw new OllamaError('Ollama response stream failed', response.status, error)
    } finally {
      if (!controller.signal.aborted) controller.abort('alamo:ollama-stream-cleanup')
      // Provider cleanup must not hold the P0-C permit indefinitely if a
      // transport implements a stuck cancel promise.
      void reader.cancel().catch(() => {})
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

  async tags(): Promise<OllamaTagsResponse> {
    return this.request<OllamaTagsResponse>('/api/tags')
  }

  async ps(): Promise<OllamaPsResponse> {
    const result = await this.request<unknown>('/api/ps', {
      connectTimeoutMs: Math.min(this.connectTimeoutMs, 5_000),
    })
    const parsed = psResponseSchema.safeParse(result)
    if (!parsed.success) throw new OllamaProtocolError('/api/ps')
    return parsed.data satisfies OllamaPsResponse
  }

  async show(name: string): Promise<OllamaShowResponse> {
    return this.request<OllamaShowResponse>('/api/show', {
      method: 'POST',
      body: JSON.stringify({ model: name }),
    })
  }

  async deleteModel(name: string): Promise<void> {
    await this.request<unknown>('/api/delete', {
      method: 'DELETE',
      body: JSON.stringify({ model: name }),
    })
  }

  pull(name: string, signal?: AbortSignal): AsyncGenerator<OllamaPullChunk> {
    return this.streamNdjson<OllamaPullChunk>('/api/pull', { model: name, stream: true }, signal)
  }

  chatStream(request: OllamaChatRequest, signal?: AbortSignal): AsyncGenerator<OllamaChatChunk> {
    return this.streamNdjson<OllamaChatChunk>('/api/chat', { ...request, stream: true }, signal)
  }

  async chat(request: OllamaChatRequest, signal?: AbortSignal): Promise<OllamaChatChunk> {
    // A non-stream Ollama response can withhold HTTP headers while loading the
    // model. A bounded version preflight establishes connect separately; the
    // model request that follows owns the load deadline.
    await this.version(signal)
    return this.request<OllamaChatChunk>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...request, stream: false }),
      ...(signal ? { signal } : {}),
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
    })
  }
}
