/**
 * SSE-события. Конверт фиксирован: { type, seq, data }.
 *
 * `seq` монотонно растёт внутри одного стрима. Он нужен, чтобы клиент при обрыве
 * переподключился с `Last-Event-ID` и не потерял и не задвоил события.
 */
import { z } from 'zod'
import {
  completionProbeEvidenceSchema,
  contextStateSchema,
  jobEventSchema,
  toolCallSchema,
  usageSchema,
  apiErrorSchema,
  toolCallStatusSchema,
  turnErrorSchema,
  turnStopReasonSchema,
  turnTerminalOutcomeSchema,
  HUGGING_FACE_DOWNLOAD_VERSION,
  huggingFaceDownloadFailureReasonSchema,
  huggingFaceDownloadProvenanceSchema,
  huggingFaceDownloadRefusalReasonSchema,
  HUGGING_FACE_IMPORT_VERSION,
  huggingFaceImportConflictReasonSchema,
  huggingFaceImportFailureReasonSchema,
  huggingFaceImportProvenanceSchema,
  huggingFaceImportTargetObservationSchema,
} from './schemas.ts'

/* ────────────────────── Стрим ответа: /api/threads/:id/messages ──────────── */

const chatStartDataSchema = z.object({
  messageId: z.string(),
  model: z.string(),
  /** Номер шага агентного цикла, для чата всегда 0. */
  step: z.number().int(),
  /** Additive bridge field; omitted frames from older servers remain readable. */
  status: z.literal('pending').optional(),
  /** Durable owner identity; omitted by pre-P1-D servers. */
  jobId: z.string().uuid().optional(),
})

const chatThinkingDataSchema = z.object({ delta: z.string() })
const chatTokenDataSchema = z.object({ delta: z.string() })
const chatToolApprovalDataSchema = z.object({
  toolCall: toolCallSchema,
  /** Через сколько миллисекунд ожидание истечёт и вызов будет отклонён. */
  timeoutMs: z.number().int(),
})
const chatToolResultDataSchema = z.object({
  toolCallId: z.string(),
  status: toolCallStatusSchema,
  result: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int(),
})
const chatDoneDataSchema = z.object({
  messageId: z.string(),
  /** Compatibility value understood by pre-P0-B clients. */
  stopReason: z.enum(['stop', 'length', 'tool_limit', 'stopped_by_user', 'error']),
  /** Older frames omit outcome; persisted Message remains the reload source of truth. */
  outcome: turnTerminalOutcomeSchema.optional(),
  /** Precise additive reason; old clients ignore this unknown optional field. */
  terminalStopReason: turnStopReasonSchema.optional(),
  /** Сколько шагов агентного цикла прошло. */
  steps: z.number().int(),
})
const chatErrorDataSchema = apiErrorSchema.extend({
  /** Precise additive error; `code` above stays compatible with old clients. */
  turnError: turnErrorSchema.optional(),
})

/**
 * Private durable payload stored outside safe Job metadata. It deliberately has
 * no sequence: the enclosing persisted Job event owns ordering and replay.
 */
export const chatJobOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), data: chatStartDataSchema }),
  z.object({ type: z.literal('thinking'), data: chatThinkingDataSchema }),
  z.object({ type: z.literal('token'), data: chatTokenDataSchema }),
  z.object({ type: z.literal('tool_call'), data: toolCallSchema }),
  z.object({ type: z.literal('tool_approval_required'), data: chatToolApprovalDataSchema }),
  z.object({ type: z.literal('tool_result'), data: chatToolResultDataSchema }),
  z.object({ type: z.literal('usage'), data: usageSchema }),
  z.object({ type: z.literal('context'), data: contextStateSchema }),
  z.object({ type: z.literal('done'), data: chatDoneDataSchema }),
  z.object({ type: z.literal('error'), data: chatErrorDataSchema }),
])
export type ChatJobOutput = z.infer<typeof chatJobOutputSchema>

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  /** Ход начался, сообщение ассистента создано в базе с этим id. */
  z.object({
    type: z.literal('start'),
    seq: z.number().int(),
    data: chatStartDataSchema,
  }),

  /** Кусок «размышления» для моделей с thinking. */
  z.object({
    type: z.literal('thinking'),
    seq: z.number().int(),
    data: chatThinkingDataSchema,
  }),

  /** Кусок обычного ответа. */
  z.object({
    type: z.literal('token'),
    seq: z.number().int(),
    data: chatTokenDataSchema,
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
    data: chatToolApprovalDataSchema,
  }),

  /** Инструмент отработал. */
  z.object({
    type: z.literal('tool_result'),
    seq: z.number().int(),
    data: chatToolResultDataSchema,
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
    data: chatDoneDataSchema,
  }),

  z.object({
    type: z.literal('error'),
    seq: z.number().int(),
    data: chatErrorDataSchema,
  }),
])
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>
export type ChatStreamEventType = ChatStreamEvent['type']

/* ─────────────────────── Стрим Job events: GET /api/jobs ────────────────── */

export const jobEventOutputSchema = z
  .object({
    privacyClassification: z.literal('private_chat'),
    event: chatJobOutputSchema,
  })
  .strict()
export type JobEventOutput = z.infer<typeof jobEventOutputSchema>

/** The SSE `id` is this persisted event's exact `sequence`. */
export const jobStreamEventSchema = jobEventSchema.extend({
  /** Legacy/pre-v5 events have no replay payload. */
  output: jobEventOutputSchema.nullish().default(null),
})
export type JobStreamEvent = z.infer<typeof jobStreamEventSchema>

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

/* ───── Connection-owned exact HF GGUF download: POST .../download ─────── */

const huggingFaceDownloadBaseSchema = z.object({
  version: z.literal(HUGGING_FACE_DOWNLOAD_VERSION),
})

export const huggingFaceDownloadStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.enum(['preparing', 'verifying']),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('progress'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.literal('downloading'),
      completedBytes: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe().nullable(),
    }).strict().superRefine((progress, context) => {
      if (progress.totalBytes !== null && progress.completedBytes > progress.totalBytes) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['completedBytes'],
          message: 'download progress cannot exceed its observed total',
        })
      }
    }),
  }).strict(),
  z.object({
    type: z.literal('completed'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.literal('completed'),
      provenance: huggingFaceDownloadProvenanceSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('cancelled'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.literal('cancelled'),
      reason: z.enum(['user_requested', 'connection_closed', 'request_cancelled']),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('refused'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.literal('refused'),
      reason: huggingFaceDownloadRefusalReasonSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('failed'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceDownloadBaseSchema.extend({
      state: z.literal('failed'),
      reason: huggingFaceDownloadFailureReasonSchema,
    }).strict(),
  }).strict(),
])
export type HuggingFaceDownloadStreamEvent = z.infer<
  typeof huggingFaceDownloadStreamEventSchema
>

/* ───── Connection-owned local Ollama import: POST .../gguf/start ─────── */

const huggingFaceImportBaseSchema = z.object({
  version: z.literal(HUGGING_FACE_IMPORT_VERSION),
})

export const huggingFaceImportStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceImportBaseSchema.extend({
      state: z.enum(['preparing', 'importing', 'verifying', 'probing']),
      phase: z.enum([
        'validating_artifact',
        'checking_target',
        'checking_blob',
        'uploading_blob',
        'creating_model',
        'observing_installation',
        'running_completion_probe',
      ]),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('completed'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceImportBaseSchema.extend({
      state: z.literal('completed'),
      provenance: huggingFaceImportProvenanceSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('cancelled'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceImportBaseSchema.extend({
      state: z.literal('cancelled'),
      reason: z.enum(['user_requested', 'connection_closed', 'request_cancelled']),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('conflict'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceImportBaseSchema.extend({
      state: z.literal('conflict'),
      reason: huggingFaceImportConflictReasonSchema,
      target: huggingFaceImportTargetObservationSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal('failed'),
    seq: z.number().int().nonnegative(),
    data: huggingFaceImportBaseSchema.extend({
      state: z.literal('failed'),
      reason: huggingFaceImportFailureReasonSchema,
      target: huggingFaceImportTargetObservationSchema.nullable(),
      probe: completionProbeEvidenceSchema.nullable(),
    }).strict(),
  }).strict(),
])
export type HuggingFaceImportStreamEvent = z.infer<
  typeof huggingFaceImportStreamEventSchema
>

/* ──────────────────────────────── Помощники ──────────────────────────────── */

/** Имя SSE-события в поле `event:`. Клиент может слушать и точечно, и через onmessage. */
export const SSE_EVENT_NAME = 'alamo' as const

/** Typed failure frame used only after an HTTP Job event stream has started. */
export const SSE_ERROR_EVENT_NAME = 'alamo-error' as const

/** Заголовок для возобновления стрима после обрыва. */
export const SSE_LAST_EVENT_ID_HEADER = 'Last-Event-ID' as const
