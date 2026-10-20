/**
 * Отправка событий по SSE.
 *
 * Формат кадра фиксирован контрактом: `{ type, seq, data }`, поле `id:` дублирует
 * `seq`, чтобы браузер мог переподключиться с заголовком Last-Event-ID.
 *
 * Стрим отдаётся в ответ на POST — браузерный EventSource умеет только GET,
 * поэтому клиент читает тело ответа через fetch и разбирает кадры сам.
 */
import { SSE_EVENT_NAME } from '@guanxi/contract'

export interface SseEnvelope {
  type: string
  seq: number
  data: unknown
}

const encoder = new TextEncoder()

function frame(event: SseEnvelope): Uint8Array {
  const payload = JSON.stringify(event)
  return encoder.encode(`id: ${event.seq}\nevent: ${SSE_EVENT_NAME}\ndata: ${payload}\n\n`)
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Обязательно за nginx: иначе прокси буферизует стрим и токены приходят пачкой в конце.
  'x-accel-buffering': 'no',
} as const

/**
 * Оборачивает асинхронный генератор событий в HTTP-ответ.
 *
 * @param source генератор событий
 * @param options.onAbort очищает ownership конкретного subscriber; решение об
 * остановке producer остаётся у вызывающего lifecycle boundary
 * @param options.skipUntilSeq пропустить события до этого номера при переподключении
 */
export function sseResponse(
  source: AsyncGenerator<SseEnvelope>,
  options: { onAbort?: () => void; skipUntilSeq?: number } = {},
): Response {
  const skipUntil = options.skipUntilSeq ?? -1
  const iterator = source[Symbol.asyncIterator]()
  let closed = false

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return
        try {
          while (true) {
            const next = await iterator.next()
            if (next.done) {
              closed = true
              controller.close()
              return
            }
            if (next.value.seq <= skipUntil) continue
            controller.enqueue(frame(next.value))
            return
          }
        } catch {
          closed = true
          // Raw exception text may contain provider bodies or private paths.
          controller.enqueue(
            frame({
              type: 'error',
              seq: Number.MAX_SAFE_INTEGER,
              data: {
                code: 'internal_error',
                message: 'The event stream could not continue',
                details: null,
              },
            }),
          )
          controller.close()
        }
      },
      async cancel() {
        if (closed) return
        closed = true
        options.onAbort?.()
        await iterator.return?.(undefined as never)
      },
    },
    { highWaterMark: 1 },
  )

  return new Response(stream, { headers: SSE_HEADERS })
}

/** Номер последнего доставленного события из заголовка переподключения. */
export function lastEventId(header: string | undefined | null): number | undefined {
  if (!header) return undefined
  const parsed = Number(header)
  return Number.isFinite(parsed) ? parsed : undefined
}
