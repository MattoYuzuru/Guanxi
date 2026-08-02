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
  healthSchema,
  localModelSchema,
  messageSchema,
  modelDetailSchema,
  runningModelSchema,
  settingsSchema,
  threadModeSchema,
  threadOptionsSchema,
  threadSchema,
  workspaceSchema,
} from './schemas.ts'

/* ──────────────────────────────── Пути ───────────────────────────────────── */

export const ROUTES = {
  health: () => '/api/health',

  models: () => '/api/models',
  modelsCatalog: () => '/api/models/catalog',
  modelsRunning: () => '/api/models/running',
  model: (name: string) => `/api/models/${encodeURIComponent(name)}`,
  modelPull: (name: string) => `/api/models/${encodeURIComponent(name)}/pull`,
  modelWarm: (name: string) => `/api/models/${encodeURIComponent(name)}/warm`,
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

/* ──────────────────────────────── Модели ─────────────────────────────────── */

/** GET /api/models?contextLength=32768 — вердикт влезаемости считается под это окно. */
export const listModelsQuery = z.object({
  contextLength: z.coerce.number().int().optional(),
})
export const listModelsResponse = z.object({
  models: z.array(localModelSchema),
})
export type ListModelsResponse = z.infer<typeof listModelsResponse>

/** GET /api/models/catalog?q=&contextLength= */
export const listCatalogQuery = z.object({
  q: z.string().optional(),
  contextLength: z.coerce.number().int().optional(),
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

export const listRunningResponse = z.object({
  models: z.array(runningModelSchema),
  observedAt: z.string().nullable().optional().default(null),
})
export type ListRunningResponse = z.infer<typeof listRunningResponse>

/** POST /api/models/:name/warm — прогреть с нужным окном, чтобы замерить факт. */
export const warmModelBody = z.object({
  contextLength: z.number().int(),
})
export const warmModelResponse = z.object({
  running: runningModelSchema,
  /** Вердикт, пересчитанный уже по факту загрузки. */
  fit: localModelSchema.shape.fit,
})
export type WarmModelResponse = z.infer<typeof warmModelResponse>

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
  /** Пути файлов из воркспейса, приложенные к сообщению. */
  attachments: z.array(z.string()).optional(),
  /** Разрешить агенту выполнять инструменты без подтверждения в этом ходе. */
  autoApprove: z.boolean().optional(),
})
export type SendMessageBody = z.infer<typeof sendMessageBody>

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
  defaultNumCtx: z.number().int().optional(),
  autoApproveTools: z.boolean().optional(),
  enableBash: z.boolean().optional(),
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
