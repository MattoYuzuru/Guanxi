/**
 * Контракт HTTP-роутов: пути, тела запросов, тела ответов.
 *
 * Фронт строит запросы только через `ROUTES`, сервер регистрирует ровно эти пути.
 * Опечатка в URL становится ошибкой компиляции, а не багом в рантайме.
 */
import { z } from 'zod'
import {
  catalogModelSchema,
  catalogSourceHealthSchema,
  contextStateSchema,
  fitLevelSchema,
  fitVerdictSchema,
  healthSchema,
  jobKindSchema,
  jobSchema,
  localModelSchema,
  messageSchema,
  modelDetailSchema,
  positiveSafeIntegerSchema,
  runningModelSchema,
  runtimeSnapshotSchema,
  settingsSchema,
  threadModeSchema,
  threadOptionsSchema,
  threadSchema,
  workspaceSchema,
} from './schemas.ts'

/* ──────────────────────────────── Пути ───────────────────────────────────── */

export const ROUTES = {
  health: () => '/api/health',

  jobs: () => '/api/jobs',
  job: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`,
  jobEvents: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/events`,
  jobCancel: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/cancel`,

  models: () => '/api/models',
  modelsCatalog: () => '/api/models/catalog',
  modelsRunning: () => '/api/models/running',
  runtime: () => '/api/runtime',
  model: (name: string) => `/api/models/${encodeURIComponent(name)}`,
  modelPull: (name: string) => `/api/models/${encodeURIComponent(name)}/pull`,
  modelWarm: (name: string) => `/api/models/${encodeURIComponent(name)}/warm`,
  modelPrewarm: (name: string) => `/api/models/${encodeURIComponent(name)}/prewarm`,
  modelStop: (name: string) => `/api/models/${encodeURIComponent(name)}/stop`,

  threads: () => '/api/threads',
  thread: (id: string) => `/api/threads/${id}`,
  threadMessages: (id: string) => `/api/threads/${id}/messages`,
  threadCompact: (id: string) => `/api/threads/${id}/compact`,
  threadStop: (id: string) => `/api/threads/${id}/stop`,
  threadContext: (id: string) => `/api/threads/${id}/context`,

  workspaces: () => '/api/workspaces',
  workspace: (id: string) => `/api/workspaces/${id}`,
  workspaceBrowse: () => '/api/workspaces/browse',

  approval: (toolCallId: string) => `/api/approvals/${toolCallId}`,

  settings: () => '/api/settings',
} as const

/* ──────────────────────────────── Health ─────────────────────────────────── */

export const getHealthResponse = healthSchema
export type GetHealthResponse = z.infer<typeof getHealthResponse>

/* ───────────────────────────── Durable Jobs ─────────────────────────────── */

export const jobPathParams = z
  .object({
    jobId: z.string().uuid(),
  })
  .strict()
export type JobPathParams = z.infer<typeof jobPathParams>

export const createJobBody = z
  .object({
    kind: jobKindSchema,
    operation: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict()
export type CreateJobBody = z.infer<typeof createJobBody>

export const createJobResponse = z
  .object({
    created: z.boolean(),
    job: jobSchema,
    eventsUrl: z.string().min(1),
  })
  .strict()
export type CreateJobResponse = z.infer<typeof createJobResponse>

export const getJobResponse = z.object({ job: jobSchema }).strict()
export type GetJobResponse = z.infer<typeof getJobResponse>

/** Decimal transport form for an already-persisted Job event sequence. */
export const jobEventCursorText = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger, 'sequence must be a safe integer')

export const jobEventsQuery = z
  .object({
    after: jobEventCursorText.optional(),
  })
  .strict()
export type JobEventsQuery = z.infer<typeof jobEventsQuery>

export const jobCancelReasonSchema = z.enum(['user_requested'])
export type JobCancelReason = z.infer<typeof jobCancelReasonSchema>

export const cancelJobBody = z
  .object({
    reason: jobCancelReasonSchema.optional().default('user_requested'),
  })
  .strict()
export type CancelJobBody = z.infer<typeof cancelJobBody>

export const cancelJobResponse = z.object({ job: jobSchema }).strict()
export type CancelJobResponse = z.infer<typeof cancelJobResponse>

/* ──────────────────────────────── Модели ─────────────────────────────────── */

/** GET /api/models?contextLength=32768 — вердикт влезаемости считается под это окно. */
export const listModelsQuery = z.object({
  contextLength: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
})
export const listModelsResponse = z.object({
  models: z.array(localModelSchema),
})
export type ListModelsResponse = z.infer<typeof listModelsResponse>

/** GET /api/models/catalog?q=&contextLength= */
export const listCatalogQuery = z.object({
  q: z.string().optional(),
  contextLength: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
})
export const listCatalogResponse = z.object({
  models: z.array(catalogModelSchema),
  /** Legacy compatibility projection; P0-D does not call an undocumented remote endpoint. */
  live: z.boolean(),
  source: catalogSourceHealthSchema.optional(),
})
export type ListCatalogResponse = z.infer<typeof listCatalogResponse>

export const getModelResponse = modelDetailSchema
export type GetModelResponse = z.infer<typeof getModelResponse>

export const getModelQuery = z
  .object({
    contextLength: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
  })

export const listRunningResponse = z.object({
  models: z.array(runningModelSchema),
  observedAt: z.string().nullable().optional().default(null),
})
export type ListRunningResponse = z.infer<typeof listRunningResponse>

export const getRuntimeResponse = runtimeSnapshotSchema
export type GetRuntimeResponse = z.infer<typeof getRuntimeResponse>

/** POST /api/models/:name/warm — прогреть с нужным окном, чтобы замерить факт. */
export const warmModelBody = z.object({
  contextLength: positiveSafeIntegerSchema,
})
export const warmModelResponse = z.object({
  running: runningModelSchema,
  /** Вердикт, пересчитанный уже по факту загрузки. */
  fit: localModelSchema.shape.fit,
})
export type WarmModelResponse = z.infer<typeof warmModelResponse>

export const prewarmSkipReasonSchema = z.enum([
  'disabled',
  'context_limit_exceeded',
  'selection_changed',
  'model_not_installed',
  'fit_unknown',
  'fit_unavailable',
  'runtime_unavailable',
  'normal_work_present',
  'resident_identity_ambiguous',
])
export type PrewarmSkipReason = z.infer<typeof prewarmSkipReasonSchema>

export const prewarmCancellationReasonSchema = z.enum([
  'request_timeout',
  'request_cancelled',
  'normal_work_started',
])
export type PrewarmCancellationReason = z.infer<
  typeof prewarmCancellationReasonSchema
>

/** POST /api/models/:name/prewarm — cancellable low-priority best-effort command. */
export const prewarmModelBody = z
  .object({
    operation: z.literal('chat'),
    contextLength: positiveSafeIntegerSchema,
    selection: z
      .object({
        digest: z.string().min(1),
        fitLevel: fitLevelSchema,
        fitBasis: fitVerdictSchema.shape.basis,
      })
      .strict(),
  })
  .strict()
export type PrewarmModelBody = z.infer<typeof prewarmModelBody>

const prewarmModelResultBase = z
  .object({
    model: z.object({ name: z.string().min(1), digest: z.string().min(1) }).strict(),
    operation: z.literal('chat'),
    purpose: z.literal('model_prewarm'),
    priority: z.literal('prewarm'),
    keepAlive: z.literal('2m'),
    observedAt: z.string().datetime(),
  })
  .strict()

export const prewarmModelResponse = z.discriminatedUnion('status', [
  prewarmModelResultBase.extend({ status: z.literal('warmed'), reason: z.literal('loaded') }),
  prewarmModelResultBase.extend({
    status: z.literal('reused'),
    reason: z.literal('already_resident_exact'),
  }),
  prewarmModelResultBase.extend({
    status: z.literal('skipped'),
    reason: prewarmSkipReasonSchema,
  }),
  prewarmModelResultBase.extend({
    status: z.literal('cancelled'),
    reason: prewarmCancellationReasonSchema,
  }),
])
export type PrewarmModelResponse = z.infer<typeof prewarmModelResponse>

/** POST /api/models/:name/pull → SSE (PullStreamEvent) */
export const pullModelBody = z.object({
  insecure: z.boolean().optional(),
})

/* ──────────────────────────────── Треды ──────────────────────────────────── */

export const listThreadsResponse = z.object({
  threads: z.array(threadSchema),
})
export type ListThreadsResponse = z.infer<typeof listThreadsResponse>

export const createThreadBody = z.object({
  title: z.string().optional(),
  mode: threadModeSchema,
  model: z.string(),
  workspaceId: z.string().nullable().optional(),
  options: threadOptionsSchema.partial().optional(),
})
export type CreateThreadBody = z.infer<typeof createThreadBody>
export const createThreadResponse = threadSchema

export const getThreadResponse = z.object({
  thread: threadSchema,
  messages: z.array(messageSchema),
  context: contextStateSchema,
})
export type GetThreadResponse = z.infer<typeof getThreadResponse>

export const updateThreadBody = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  workspaceId: z.string().nullable().optional(),
  options: threadOptionsSchema.partial().optional(),
})
export type UpdateThreadBody = z.infer<typeof updateThreadBody>

/** POST /api/threads/:id/messages → SSE (ChatStreamEvent) */
export const sendMessageBody = z.object({
  content: z.string(),
  /** New clients keep this stable for one logical submit; omitted by legacy clients. */
  idempotencyKey: z.string().uuid().optional(),
  /** Пути файлов из воркспейса, приложенные к сообщению. */
  attachments: z.array(z.string()).optional(),
  /** Разрешить агенту выполнять инструменты без подтверждения в этом ходе. */
  autoApprove: z.boolean().optional(),
}).strict()
export type SendMessageBody = z.infer<typeof sendMessageBody>

/** Private persisted input snapshot; never serialized as safe Job metadata. */
export const chatJobInputSnapshotSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.string()),
    autoApprove: z.boolean().nullable(),
  })
  .strict()
export type ChatJobInputSnapshot = z.infer<typeof chatJobInputSnapshotSchema>

export const compactThreadResponse = z.object({
  message: messageSchema,
  context: contextStateSchema,
  /** Сколько токенов свернули и во сколько это обойдётся на следующем ходе. */
  compactedTokens: z.number().int(),
  estimatedRepefillMs: z.number().int(),
})
export type CompactThreadResponse = z.infer<typeof compactThreadResponse>

export const getContextResponse = contextStateSchema

/* ──────────────────────────────── Воркспейсы ─────────────────────────────── */

export const listWorkspacesResponse = z.object({
  workspaces: z.array(workspaceSchema),
})
export type ListWorkspacesResponse = z.infer<typeof listWorkspacesResponse>

export const createWorkspaceBody = z.object({
  rootPath: z.string(),
  name: z.string().optional(),
})
export type CreateWorkspaceBody = z.infer<typeof createWorkspaceBody>

/**
 * GET /api/workspaces/browse?path= — листинг директорий для пикера.
 * Фронт не читает ФС напрямую: это инвариант, который делает вынос на сервер дешёвым.
 */
export const browseQuery = z.object({
  path: z.string().optional(),
})
export const browseResponse = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      isDirectory: z.boolean(),
      isGitRepo: z.boolean(),
    }),
  ),
})
export type BrowseResponse = z.infer<typeof browseResponse>

/* ──────────────────────────────── Подтверждения ──────────────────────────── */

export const approvalBody = z.object({
  decision: z.enum(['approve', 'deny']),
  /** Подтверждать все дальнейшие вызовы этого инструмента в текущем треде. */
  rememberForThread: z.boolean().optional(),
})
export type ApprovalBody = z.infer<typeof approvalBody>

export const approvalResponse = z.object({ ok: z.boolean() })

/* ──────────────────────────────── Настройки ──────────────────────────────── */

export const getSettingsResponse = settingsSchema

export const updateSettingsBody = z.object({
  ollamaHost: z.string().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultNumCtx: positiveSafeIntegerSchema.optional(),
  autoApproveTools: z.boolean().optional(),
  enableBash: z.boolean().optional(),
  prewarmEnabled: z.boolean().optional(),
  webSearch: z
    .object({
      provider: settingsSchema.shape.webSearch.shape.provider.optional(),
      baseUrl: z.string().nullable().optional(),
      /** Записывается, но никогда не читается обратно. */
      apiKey: z.string().nullable().optional(),
    })
    .optional(),
  theme: settingsSchema.shape.theme.optional(),
})
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>

/* ──────────────────────────── Значения по умолчанию ──────────────────────── */

/**
 * Ollama при <24 ГБ VRAM по умолчанию даёт 4k контекста — для агента этого мало.
 * Поэтому в приложении свой дефолт, и он передаётся явно в каждый запрос.
 */
export const DEFAULT_NUM_CTX = 32_768
export const DEFAULT_CHAT_NUM_CTX = 8_192
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_AGENT_TEMPERATURE = 0

/** Потолок шагов агентного цикла, чтобы модель не крутилась вечно. */
export const MAX_AGENT_STEPS = 40

/** Сколько ждём решения человека по инструменту, прежде чем отклонить. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
