/**
 * SSE поверх POST.
 *
 * Браузерный EventSource умеет только GET и не даёт задать заголовки, а у нас
 * стримящие ручки — POST с телом (`/threads/:id/messages`, `/models/:name/pull`).
 * Поэтому кадры разбираем руками из `response.body`.
 *
 * Что берём на себя:
 *  - разбор кадров `id:` / `event:` / `data:` (в т.ч. многострочный `data`);
 *  - валидацию каждого кадра zod-схемой из контракта;
 *  - `seq`: дедупликация и обнаружение дыр;
 *  - переподключение с `Last-Event-ID` при обрыве соединения;
 *  - отмену через AbortController (кнопка «Стоп»).
 */
import type { ZodType, ZodTypeDef } from 'zod'
import {
  SSE_ERROR_EVENT_NAME,
  SSE_LAST_EVENT_ID_HEADER,
  apiErrorSchema,
  type ApiError,
} from '@guanxi/contract'

/* ──────────────────────────── Разбор кадров ───────────────────────────── */

export type SseFrame = {
  id: string | null
  event: string | null
  data: string
}

/**
 * Инкрементальный разборщик: кормим кусками текста, забираем готовые кадры.
 * Держит хвост незавершённого кадра между вызовами, потому что граница чанка
 * сети никак не связана с границей кадра.
 */
export class SseFrameParser {
  private buffer = ''

  push(chunk: string): SseFrame[] {
    // Нормализуем переводы строк: спек допускает \r\n, \n и одиночный \r.
    this.buffer += chunk.replace(/\r\n?/g, '\n')

    const frames: SseFrame[] = []
    let boundary = this.buffer.indexOf('\n\n')

    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const frame = parseFrame(raw)
      if (frame) frames.push(frame)
      boundary = this.buffer.indexOf('\n\n')
    }

    return frames
  }

  /** Остаток без завершающего разделителя — на случай корректного конца потока. */
  flush(): SseFrame | null {
    if (!this.buffer.trim()) {
      this.buffer = ''
      return null
    }
    const frame = parseFrame(this.buffer)
    this.buffer = ''
    return frame
  }
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | null = null
  let event: string | null = null
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    // Строка-комментарий (`: keepalive`) — служебная, игнорируем.
    if (line === '' || line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // По спеку один ведущий пробел после двоеточия отбрасывается.
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'id':
        id = value
        break
      case 'event':
        event = value
        break
      case 'data':
        dataLines.push(value)
        break
      default:
        break
    }
  }

  if (dataLines.length === 0) return null
  return { id, event, data: dataLines.join('\n') }
}

/* ────────────────────────────── Публичное API ─────────────────────────── */

export type SseStreamOptions<T> = {
  url: string
  schema: ZodType<T, ZodTypeDef, unknown>
  method?: 'POST' | 'GET'
  body?: unknown
  signal?: AbortSignal
  /** Сколько раз пробуем переподключиться после обрыва. 0 — не пробовать. */
  maxRetries?: number
  /** С какого seq продолжать (для возобновления заранее известного стрима). */
  lastEventId?: number
  /** Кадр не прошёл схему или сломан JSON. Стрим при этом не рвём. */
  onInvalidFrame?: (raw: string, error: unknown) => void
  /** Обрыв, после которого будет попытка переподключения. */
  onReconnect?: (attempt: number, lastSeq: number) => void
  /** В seq обнаружена дыра — события между lastSeq и seq потеряны. */
  onGap?: (expected: number, received: number) => void
  /** Contract-specific persisted sequence; defaults to the legacy `seq` field. */
  sequenceOf?: (event: T) => number
  /** Validated HTTP headers/body are available and the command was accepted. */
  onOpen?: () => void
}

export class SseHttpError extends Error {
  readonly status: number
  readonly bodyText: string
  readonly payload: ApiError | null

  constructor(status: number, bodyText: string) {
    super(`SSE ${status}: ${bodyText.slice(0, 400)}`)
    this.name = 'SseHttpError'
    this.status = status
    this.bodyText = bodyText
    let parsed: unknown = null
    try { parsed = JSON.parse(bodyText) } catch { parsed = null }
    const payload = apiErrorSchema.safeParse(parsed)
    this.payload = payload.success ? payload.data : null
  }
}

/**
 * A typed `guanxi-error` frame sent after the stream opened. It is never
 * retried: the cursor was not advanced, so a reconnect would loop.
 */
export class SseServerError extends Error {
  readonly payload: ApiError
  readonly retryable = false

  constructor(payload: ApiError) {
    super(payload.message)
    this.name = 'SseServerError'
    this.payload = payload
  }
}

function serverErrorFrame(frame: SseFrame): SseServerError | null {
  if (frame.event !== SSE_ERROR_EVENT_NAME) return null
  let json: unknown = null
  try { json = JSON.parse(frame.data) } catch { json = null }
  const parsed = apiErrorSchema.safeParse(json)
  return new SseServerError(parsed.success ? parsed.data : {
    code: 'internal_error',
    message: 'The server ended the stream with an unreadable error frame',
    details: null,
  })
}

/**
 * Async-итератор по событиям стрима.
 *
 * `seq` из контракта используем двояко: отбрасываем уже виденные события
 * (в т.ч. повторы после переподключения) и отдаём в `Last-Event-ID`, чтобы
 * сервер продолжил с нужного места.
 */
export async function* sseStream<T>(
  options: SseStreamOptions<T>,
): AsyncGenerator<T, void, void> {
  const {
    url,
    schema,
    method = 'POST',
    body,
    signal,
    maxRetries = 3,
    onInvalidFrame,
    onReconnect,
    onGap,
    onOpen,
    sequenceOf = (event) => (event as { seq: number }).seq,
  } = options

  // seq начинается с 0; -1 означает, что ни одного кадра ещё не видели.
  let lastSeq = options.lastEventId ?? -1
  let attempt = 0

  // Внешняя отмена (кнопка «Стоп») прекращает и попытки переподключения.
  while (true) {
    if (signal?.aborted) return

    let response: Response
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (lastSeq >= 0) headers[SSE_LAST_EVENT_ID_HEADER] = String(lastSeq)

      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        // Стрим не должен попадать в кэш ни на каком уровне.
        cache: 'no-store',
      })
    } catch (error) {
      if (isAbort(error, signal)) return
      if (error instanceof SseServerError) throw error
      if (attempt >= maxRetries) throw error
      attempt += 1
      onReconnect?.(attempt, lastSeq)
      await backoff(attempt, signal)
      continue
    }

    if (!response.ok) {
      // 4xx — ошибка запроса, повторять смысла нет. 5xx может быть временной.
      const text = await response.text().catch(() => '')
      if (response.status < 500 || attempt >= maxRetries) {
        throw new SseHttpError(response.status, text)
      }
      attempt += 1
      onReconnect?.(attempt, lastSeq)
      await backoff(attempt, signal)
      continue
    }

    if (!response.body) throw new Error(translate('error.streamBodyMissing'))
    onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseFrameParser()
    let completed = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          const tail = parser.flush()
          if (tail) {
            const typed = serverErrorFrame(tail)
            if (typed) throw typed
            const event = decodeFrame(tail, schema, onInvalidFrame)
            const sequence = event ? sequenceOf(event) : -1
            if (event && sequence > lastSeq) {
              lastSeq = sequence
              yield event
            }
          }
          completed = true
          break
        }

        // stream: true обязателен — многобайтовый символ может быть разрезан чанком.
        const frames = parser.push(decoder.decode(value, { stream: true }))

        for (const frame of frames) {
          const typed = serverErrorFrame(frame)
          if (typed) throw typed
          const event = decodeFrame(frame, schema, onInvalidFrame)
          if (!event) continue

          // Повтор после переподключения — молча пропускаем.
          const sequence = sequenceOf(event)
          if (sequence <= lastSeq) continue

          if (lastSeq >= 0 && sequence > lastSeq + 1) {
            onGap?.(lastSeq + 1, sequence)
          }

          lastSeq = sequence
          yield event
        }
      }
    } catch (error) {
      if (isAbort(error, signal)) return
      if (error instanceof SseServerError) throw error
      if (attempt >= maxRetries) throw error
      attempt += 1
      onReconnect?.(attempt, lastSeq)
      await backoff(attempt, signal)
      continue
    } finally {
      // Итератор могли бросить через `break` в потребителе — освобождаем сокет.
      reader.cancel().catch(() => {})
    }

    if (completed) return
  }
}

/**
 * Колбэчный фасад над итератором — удобнее там, где события расходятся
 * по разным обработчикам (чат) и не нужен `for await`.
 */
export function consumeSse<T>(
  options: SseStreamOptions<T> & {
    onEvent: (event: T) => void
    onDone?: () => void
    onError?: (error: unknown) => void
  },
): { abort: () => void; finished: Promise<void> } {
  const controller = new AbortController()
  // Отмена снаружи и отмена изнутри должны работать одинаково.
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const finished = (async () => {
    try {
      for await (const event of sseStream({ ...options, signal: controller.signal })) {
        options.onEvent(event)
      }
      options.onDone?.()
    } catch (error) {
      if (isAbort(error, controller.signal)) {
        options.onDone?.()
        return
      }
      options.onError?.(error)
    }
  })()

  return { abort: () => controller.abort(), finished }
}

/* ─────────────────────────────── Внутреннее ───────────────────────────── */

function decodeFrame<T>(
  frame: SseFrame,
  schema: ZodType<T, ZodTypeDef, unknown>,
  onInvalidFrame?: (raw: string, error: unknown) => void,
): T | null {
  let json: unknown
  try {
    json = JSON.parse(frame.data)
  } catch (error) {
    onInvalidFrame?.(frame.data, error)
    return null
  }

  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    // Кадр не по контракту. Роняя весь стрим, мы потеряли бы уже полученный
    // ответ модели, поэтому сообщаем и продолжаем.
    onInvalidFrame?.(frame.data, parsed.error)
    return null
  }
  return parsed.data
}

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true
  return error instanceof DOMException && error.name === 'AbortError'
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(500 * 2 ** (attempt - 1), 5_000)
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delay)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
import { translate } from './locale.ts'
