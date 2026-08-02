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
  OllamaVersionResponse,
} from './types.ts'

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
  constructor(host: string, cause?: unknown) {
    super(`Ollama недоступна по адресу ${host}`, null, cause)
    this.name = 'OllamaUnavailableError'
  }
}

export interface OllamaClientOptions {
  host: string
  /** Таймаут обычных запросов. Стримы не ограничиваем — генерация бывает долгой. */
  requestTimeoutMs?: number
}

export class OllamaClient {
  readonly host: string
  private readonly requestTimeoutMs: number

  constructor(options: OllamaClientOptions) {
    this.host = options.host.replace(/\/+$/, '')
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
  }

  /* ─────────────────────────────── Основа ───────────────────────────────── */

  private async request<T>(
    path: string,
    init?: RequestInit & { timeoutMs?: number },
  ): Promise<T> {
    const controller = new AbortController()
    const timeoutMs = init?.timeoutMs ?? this.requestTimeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal

    let response: Response
    try {
      response = await fetch(`${this.host}${path}`, {
        ...init,
        signal,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (error) {
      throw new OllamaUnavailableError(this.host, error)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new OllamaError(
        `Ollama вернула ${response.status} на ${path}${body ? `: ${body.slice(0, 300)}` : ''}`,
        response.status,
      )
    }

    return (await response.json()) as T
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
    let response: Response
    try {
      response = await fetch(`${this.host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) return
      throw new OllamaUnavailableError(this.host, error)
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new OllamaError(
        `Ollama вернула ${response.status} на ${path}${text ? `: ${text.slice(0, 300)}` : ''}`,
        response.status,
      )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Последний элемент — возможно неполная строка, оставляем в буфере.
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          yield JSON.parse(trimmed) as T
        }
      }

      const tail = buffer.trim()
      if (tail) yield JSON.parse(tail) as T
    } catch (error) {
      // Preserve abort identity for runTurn's authoritative cancellation
      // classification. Other body/read/parse failures came from the provider
      // stream and must not be mistaken for an internal application failure.
      if (signal?.aborted) throw error
      throw new OllamaError('Ollama response stream failed', response.status, error)
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  /* ─────────────────────────────── Эндпоинты ────────────────────────────── */

  async version(): Promise<string> {
    const result = await this.request<OllamaVersionResponse>('/api/version', {
      timeoutMs: 3_000,
    })
    return result.version
  }

  async tags(): Promise<OllamaTagsResponse> {
    return this.request<OllamaTagsResponse>('/api/tags')
  }

  async ps(): Promise<OllamaPsResponse> {
    return this.request<OllamaPsResponse>('/api/ps', { timeoutMs: 5_000 })
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
    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: false }),
      signal,
    }).catch((error) => {
      throw new OllamaUnavailableError(this.host, error)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OllamaError(`Ollama вернула ${response.status}: ${text.slice(0, 300)}`, response.status)
    }

    return (await response.json()) as OllamaChatChunk
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
    await this.request<unknown>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: name,
        messages: [],
        stream: false,
        keep_alive: keepAlive,
        options: { num_ctx: numCtx },
      }),
      // Холодная загрузка 7B заняла 6 секунд, крупные модели — заметно дольше.
      timeoutMs: 300_000,
      ...(signal ? { signal } : {}),
    })
  }

  /** Выгружает модель из памяти: keep_alive = 0. */
  async unload(name: string): Promise<void> {
    await this.request<unknown>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ model: name, messages: [], stream: false, keep_alive: 0 }),
      timeoutMs: 30_000,
    })
  }
}
