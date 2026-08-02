/**
 * SSE-события. Конверт фиксирован: { type, seq, data }.
 *
 * `seq` монотонно растёт внутри одного стрима. Он нужен, чтобы клиент при обрыве
 * переподключился с `Last-Event-ID` и не потерял и не задвоил события.
 */
import { z } from 'zod'
import {
  contextStateSchema,
  toolCallSchema,
  usageSchema,
  apiErrorSchema,
  toolCallStatusSchema,
  turnErrorSchema,
  turnStopReasonSchema,
  turnTerminalOutcomeSchema,
} from './schemas.ts'

/* ────────────────────── Стрим ответа: /api/threads/:id/messages ──────────── */

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  /** Ход начался, сообщение ассистента создано в базе с этим id. */
  z.object({
    type: z.literal('start'),
    seq: z.number().int(),
    data: z.object({
      messageId: z.string(),
      model: z.string(),
      /** Номер шага агентного цикла, для чата всегда 0. */
      step: z.number().int(),
      /** Additive bridge field; omitted frames from older servers remain readable. */
      status: z.literal('pending').optional(),
    }),
  }),

  /** Кусок «размышления» для моделей с thinking. */
  z.object({
    type: z.literal('thinking'),
    seq: z.number().int(),
    data: z.object({ delta: z.string() }),
  }),

  /** Кусок обычного ответа. */
  z.object({
    type: z.literal('token'),
    seq: z.number().int(),
    data: z.object({ delta: z.string() }),
  }),

  /** Модель попросила инструмент. Ещё не выполнен. */
  z.object({
    type: z.literal('tool_call'),
    seq: z.number().int(),
    data: toolCallSchema,
  }),

  /**
   * Инструмент требует подтверждения человеком. Стрим при этом не рвётся,
   * сервер ждёт POST /api/approvals/:toolCallId.
   */
  z.object({
    type: z.literal('tool_approval_required'),
    seq: z.number().int(),
    data: z.object({
      toolCall: toolCallSchema,
      /** Через сколько миллисекунд ожидание истечёт и вызов будет отклонён. */
      timeoutMs: z.number().int(),
    }),
  }),

  /** Инструмент отработал. */
  z.object({
    type: z.literal('tool_result'),
    seq: z.number().int(),
    data: z.object({
      toolCallId: z.string(),
      status: toolCallStatusSchema,
      result: z.string().nullable(),
      error: z.string().nullable(),
      durationMs: z.number().int(),
    }),
  }),

  /** Метрики хода. Приходит один раз перед `done`. */
  z.object({
    type: z.literal('usage'),
    seq: z.number().int(),
    data: usageSchema,
  }),

  /** Обновлённое состояние окна контекста. Питает шкалу. */
  z.object({
    type: z.literal('context'),
    seq: z.number().int(),
    data: contextStateSchema,
  }),

  /** Ход завершён. */
  z.object({
    type: z.literal('done'),
    seq: z.number().int(),
    data: z.object({
      messageId: z.string(),
      /** Compatibility value understood by pre-P0-B clients. */
      stopReason: z.enum(['stop', 'length', 'tool_limit', 'stopped_by_user', 'error']),
      /** Older frames omit outcome; persisted Message remains the reload source of truth. */
      outcome: turnTerminalOutcomeSchema.optional(),
      /** Precise additive reason; old clients ignore this unknown optional field. */
      terminalStopReason: turnStopReasonSchema.optional(),
      /** Сколько шагов агентного цикла прошло. */
      steps: z.number().int(),
    }),
  }),

  z.object({
    type: z.literal('error'),
    seq: z.number().int(),
    data: apiErrorSchema.extend({
      /** Precise additive error; `code` above stays compatible with old clients. */
      turnError: turnErrorSchema.optional(),
    }),
  }),
])
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
export type ChatStreamEventType = ChatStreamEvent['type']

/* ────────────────────── Стрим скачивания: /api/models/:name/pull ─────────── */

export const pullStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    seq: z.number().int(),
    data: z.object({
      /** Человекочитаемая фаза: "pulling manifest", "downloading", "verifying". */
      status: z.string(),
      digest: z.string().nullable(),
      totalBytes: z.number().int().nullable(),
      completedBytes: z.number().int().nullable(),
      /** 0..100, null пока неизвестен общий размер. */
      percent: z.number().nullable(),
      bytesPerSecond: z.number().nullable(),
      etaSeconds: z.number().nullable(),
    }),
  }),
  z.object({
    type: z.literal('done'),
    seq: z.number().int(),
    data: z.object({ name: z.string() }),
  }),
  z.object({
    type: z.literal('error'),
    seq: z.number().int(),
    data: apiErrorSchema,
  }),
])
export type PullStreamEvent = z.infer<typeof pullStreamEventSchema>

/* ──────────────────────────────── Помощники ──────────────────────────────── */

/** Имя SSE-события в поле `event:`. Клиент может слушать и точечно, и через onmessage. */
export const SSE_EVENT_NAME = 'alamo' as const

/** Заголовок для возобновления стрима после обрыва. */
export const SSE_LAST_EVENT_ID_HEADER = 'Last-Event-ID' as const
