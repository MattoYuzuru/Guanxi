/**
 * Типизированный клиент. Все пути — только через ROUTES из контракта,
 * все ответы — прогоняются через zod-схемы контракта.
 *
 * Своих описаний формы данных здесь нет и быть не должно.
 */
import type { output, ZodTypeAny } from 'zod'
import {
  ROUTES,
  apiErrorSchema,
  approvalResponse,
  browseResponse,
  chatStreamEventSchema,
  compactThreadResponse,
  completionProbeResponse,
  createThreadResponse,
  getContextResponse,
  getHealthResponse,
  getJobResponse,
  getModelResponse,
  getRuntimeResponse,
  getSettingsResponse,
  getThreadResponse,
  huggingFaceRepositoryResponse,
  huggingFaceSearchResponse,
  huggingFaceSelectionResponse,
  huggingFaceDownloadStreamEventSchema,
  listCatalogResponse,
  listModelsResponse,
  listRunningResponse,
  listThreadsResponse,
  listWorkspacesResponse,
  modelCapabilityOverrideResponse,
  cancelJobResponse,
  jobStreamEventSchema,
  ollamaReferencePreviewResponse,
  pullStreamEventSchema,
  prewarmModelResponse,
  warmModelResponse,
  workspaceSchema,
  type ApiError,
  type ApprovalBody,
  type ChatStreamEvent,
  type CompletionProbeBody,
  type HuggingFaceSearchBody,
  type HuggingFaceSelectionBody,
  type HuggingFaceDownloadBody,
  type HuggingFaceDownloadStreamEvent,
  type ModelCapabilityOverrideMutationBody,
  type OllamaReferenceStartBody,
  type JobStreamEvent,
  type CreateThreadBody,
  type CreateWorkspaceBody,
  type PullStreamEvent,
  type PrewarmModelBody,
  type SendMessageBody,
  type UpdateSettingsBody,
  type UpdateThreadBody,
  type ListCatalogQuery,
} from '@alamo/contract'
import { consumeSse, sseStream } from './sse.ts'
import { translate } from './locale.ts'

/* ──────────────────────────────── Ошибки ──────────────────────────────── */

/** Ошибка, у которой есть код из контракта — на неё UI может реагировать точечно. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiError | null,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }

  get code(): ApiError['code'] | 'unknown' {
    return this.payload?.code ?? 'unknown'
  }
}

/** Ответ пришёл, но не по контракту — это баг, а не пользовательская ошибка. */
export class ApiShapeError extends Error {
  constructor(
    readonly path: string,
    readonly issues: unknown,
  ) {
    super(`Ответ ${path} не соответствует контракту`)
    this.name = 'ApiShapeError'
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'context_limit_exceeded') return translate('context.limit.exceeded')
    return error.payload?.message ?? error.message
  }
  if (error instanceof ApiShapeError) return error.message
  if (error instanceof Error) {
    // Самый частый случай локально: сервер не поднят.
    if (error.name === 'TypeError' && /fetch/i.test(error.message)) {
      return 'Не удалось соединиться с сервером Alamo'
    }
    return error.message
  }
  return String(error)
}

/* ─────────────────────────────── Транспорт ────────────────────────────── */

type RequestInitLike = {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
}

function withQuery(path: string, query: RequestInitLike['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

async function request<Schema extends ZodTypeAny>(
  path: string,
  schema: Schema,
  init: RequestInitLike = {},
): Promise<output<Schema>> {
  const url = withQuery(path, init.query)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })

  const text = await response.text()

  if (!response.ok) {
    const parsed = safeJson(text)
    const apiError = apiErrorSchema.safeParse(parsed)
    throw new ApiRequestError(
      response.status,
      apiError.success ? apiError.data : null,
      apiError.success ? apiError.data.message : `HTTP ${response.status}`,
    )
  }

  const parsed = schema.safeParse(safeJson(text))
  if (!parsed.success) throw new ApiShapeError(path, parsed.error.issues)
  return parsed.data
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ──────────────────────────────── Ручки ───────────────────────────────── */

export const api = {
  health: (signal?: AbortSignal) => request(ROUTES.health(), getHealthResponse, { signal }),

  /* Модели */

  getJob: (jobId: string, signal?: AbortSignal) =>
    request(ROUTES.job(jobId), getJobResponse, { signal }),

  cancelJob: (jobId: string, signal?: AbortSignal) =>
    request(ROUTES.jobCancel(jobId), cancelJobResponse, {
      method: 'POST',
      body: { reason: 'user_requested' },
      signal,
    }),

  listModels: (contextLength?: number, signal?: AbortSignal) =>
    request(ROUTES.models(), listModelsResponse, { query: { contextLength }, signal }),

  listCatalog: (params: ListCatalogQuery = {}, signal?: AbortSignal) =>
    request(ROUTES.modelsCatalog(), listCatalogResponse, {
      query: {
        q: params.q,
        contextLength: params.contextLength,
        installation: params.installation?.join(','),
        fit: params.fit?.join(','),
        providerScope: params.providerScope?.join(','),
        source: params.source?.join(','),
        freshness: params.freshness?.join(','),
        capability: params.capability?.join(','),
        minClaimedContext: params.minClaimedContext,
        contextClaim: params.contextClaim,
        maxClaimedArtifactSize: params.maxClaimedArtifactSize,
        artifactSizeClaim: params.artifactSizeClaim,
        page: params.page,
        pageSize: params.pageSize,
      },
      signal,
    }),

  listRunning: (signal?: AbortSignal) =>
    request(ROUTES.modelsRunning(), listRunningResponse, { signal }),

  runtimeSnapshot: (signal?: AbortSignal) =>
    request(ROUTES.runtime(), getRuntimeResponse, { signal }),

  getModel: (name: string, contextLength?: number, signal?: AbortSignal) =>
    request(ROUTES.model(name), getModelResponse, { query: { contextLength }, signal }),

  /** Прогрев идёт десятки секунд: держать спиннер обязательно. */
  warmModel: (name: string, contextLength: number, signal?: AbortSignal) =>
    request(ROUTES.modelWarm(name), warmModelResponse, {
      method: 'POST',
      body: { contextLength },
      signal,
    }),

  prewarmModel: (name: string, body: PrewarmModelBody, signal?: AbortSignal) =>
    request(ROUTES.modelPrewarm(name), prewarmModelResponse, {
      method: 'POST',
      body,
      signal,
    }),

  completionProbe: (name: string, body: CompletionProbeBody, signal?: AbortSignal) =>
    request(ROUTES.modelCompletionProbe(name), completionProbeResponse, {
      method: 'POST',
      body,
      signal,
    }),

  /** Explicit positive user assertion for the exact identity the caller rendered. */
  applyCapabilityOverride: (
    name: string,
    body: ModelCapabilityOverrideMutationBody,
    signal?: AbortSignal,
  ) =>
    request(ROUTES.modelCapabilityOverrides(name), modelCapabilityOverrideResponse, {
      method: 'POST',
      body,
      signal,
    }),

  clearCapabilityOverride: (
    name: string,
    body: ModelCapabilityOverrideMutationBody,
    signal?: AbortSignal,
  ) =>
    request(ROUTES.modelCapabilityOverrides(name), modelCapabilityOverrideResponse, {
      method: 'DELETE',
      body,
      signal,
    }),

  previewOllamaReference: (reference: string, signal?: AbortSignal) =>
    request(ROUTES.ollamaReferencePreview(), ollamaReferencePreviewResponse, {
      method: 'POST',
      body: { reference },
      signal,
    }),

  /**
   * P2-J read-only Hugging Face discovery. The server owns every Hub request, so the
   * Web client never issues a cross-origin call and never learns the Hub endpoint.
   */
  searchHuggingFace: (
    body: HuggingFaceSearchBody,
    signal?: AbortSignal,
  ) =>
    request(ROUTES.huggingFaceSearch(), huggingFaceSearchResponse, {
      method: 'POST',
      body,
      signal,
    }),

  readHuggingFaceRepository: (reference: string, signal?: AbortSignal) =>
    request(ROUTES.huggingFaceRepository(), huggingFaceRepositoryResponse, {
      method: 'POST',
      body: { reference },
      signal,
    }),

  /**
   * P2-K exact GGUF file/revision selection. This is an intent, not an install: it
   * starts no download, checksum, local import or probe, and nothing here is persisted.
   */
  selectHuggingFaceGgufFile: (
    body: HuggingFaceSelectionBody,
    signal?: AbortSignal,
  ) =>
    request(ROUTES.huggingFaceSelection(), huggingFaceSelectionResponse, {
      method: 'POST',
      body,
      signal,
    }),

  stopModel: (name: string, signal?: AbortSignal) =>
    request(ROUTES.modelStop(name), approvalResponse, { method: 'POST', signal }),

  /* Треды */

  listThreads: (signal?: AbortSignal) =>
    request(ROUTES.threads(), listThreadsResponse, { signal }),

  createThread: (body: CreateThreadBody, signal?: AbortSignal) =>
    request(ROUTES.threads(), createThreadResponse, { method: 'POST', body, signal }),

  getThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.thread(id), getThreadResponse, { signal }),

  updateThread: (id: string, body: UpdateThreadBody, signal?: AbortSignal) =>
    request(ROUTES.thread(id), createThreadResponse, { method: 'PATCH', body, signal }),

  deleteThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.thread(id), approvalResponse, { method: 'DELETE', signal }),

  stopThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadStop(id), approvalResponse, { method: 'POST', signal }),

  compactThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadCompact(id), compactThreadResponse, { method: 'POST', signal }),

  getContext: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadContext(id), getContextResponse, { signal }),

  /* Воркспейсы */

  listWorkspaces: (signal?: AbortSignal) =>
    request(ROUTES.workspaces(), listWorkspacesResponse, { signal }),

  createWorkspace: (body: CreateWorkspaceBody, signal?: AbortSignal) =>
    request(ROUTES.workspaces(), workspaceSchema, { method: 'POST', body, signal }),

  deleteWorkspace: (id: string, signal?: AbortSignal) =>
    request(ROUTES.workspace(id), approvalResponse, { method: 'DELETE', signal }),

  /**
   * Единственный способ увидеть файловую систему. Фронт её сам не читает —
   * инвариант, без которого вынос сервера на удалённую машину сломается.
   */
  browse: (path?: string, signal?: AbortSignal) =>
    request(ROUTES.workspaceBrowse(), browseResponse, { query: { path }, signal }),

  /* Подтверждения */

  respondToApproval: (toolCallId: string, body: ApprovalBody, signal?: AbortSignal) =>
    request(ROUTES.approval(toolCallId), approvalResponse, { method: 'POST', body, signal }),

  /* Настройки */

  getSettings: (signal?: AbortSignal) =>
    request(ROUTES.settings(), getSettingsResponse, { signal }),

  updateSettings: (body: UpdateSettingsBody, signal?: AbortSignal) =>
    request(ROUTES.settings(), getSettingsResponse, { method: 'PUT', body, signal }),
}

/* ──────────────────────────────── Стримы ──────────────────────────────── */

/** Ход модели. Колбэки, потому что события расходятся по разным частям UI. */
export function streamChat(
  threadId: string,
  body: SendMessageBody,
  handlers: {
    onEvent: (event: ChatStreamEvent) => void
    onDone?: () => void
    onError?: (error: unknown) => void
    onInvalidFrame?: (raw: string, error: unknown) => void
    onReconnect?: (attempt: number, lastSeq: number) => void
    onAccepted?: () => void
    signal?: AbortSignal
  },
) {
  return consumeSse<ChatStreamEvent>({
    url: ROUTES.threadMessages(threadId),
    schema: chatStreamEventSchema,
    method: 'POST',
    body,
    // POST не переподключаем: после transport failure useChat перечитывает
    // persisted Message association и продолжает через canonical GET Job SSE.
    maxRetries: 0,
    signal: handlers.signal,
    onEvent: handlers.onEvent,
    onDone: handlers.onDone,
    onError: handlers.onError,
    onInvalidFrame: handlers.onInvalidFrame,
    onReconnect: handlers.onReconnect,
    onOpen: handlers.onAccepted,
  })
}

/** Durable GET subscription. Disconnect only detaches this client. */
export function streamJob(
  jobId: string,
  handlers: {
    onEvent: (event: JobStreamEvent) => void
    onDone?: () => void
    onError?: (error: unknown) => void
    onInvalidFrame?: (raw: string, error: unknown) => void
    onReconnect?: (attempt: number, lastSequence: number) => void
    onGap?: (expected: number, received: number) => void
    after?: number
    signal?: AbortSignal
  },
) {
  return consumeSse<JobStreamEvent>({
    url: ROUTES.jobEvents(jobId),
    schema: jobStreamEventSchema,
    method: 'GET',
    maxRetries: 3,
    lastEventId: handlers.after ?? 0,
    sequenceOf: (event) => event.sequence,
    signal: handlers.signal,
    onEvent: handlers.onEvent,
    onDone: handlers.onDone,
    onError: handlers.onError,
    onInvalidFrame: handlers.onInvalidFrame,
    onReconnect: handlers.onReconnect,
    onGap: handlers.onGap,
  })
}

/** Скачивание модели. Итератор — прогресс потребляется одним компонентом. */
export function streamPull(
  name: string,
  signal?: AbortSignal,
): AsyncGenerator<PullStreamEvent, void, void> {
  return sseStream<PullStreamEvent>({
    url: ROUTES.modelPull(name),
    schema: pullStreamEventSchema,
    method: 'POST',
    body: {},
    signal,
    // Обрыв качающегося многогигабайтного файла лучше показать, чем молча
    // ретраить: сервер продолжит с места, но прогресс придётся пересчитать.
    maxRetries: 1,
  })
}

/** Confirmed manual reference pull. It is connection-owned and never retried. */
export function streamOllamaReferencePull(
  body: OllamaReferenceStartBody,
  signal?: AbortSignal,
): AsyncGenerator<PullStreamEvent, void, void> {
  return sseStream<PullStreamEvent>({
    url: ROUTES.ollamaReferenceStart(),
    schema: pullStreamEventSchema,
    method: 'POST',
    body,
    signal,
    maxRetries: 0,
  })
}

/** Exact HF download is connection-owned and intentionally has no reconnect/resume. */
export function streamHuggingFaceDownload(
  body: HuggingFaceDownloadBody,
  signal?: AbortSignal,
): AsyncGenerator<HuggingFaceDownloadStreamEvent, void, void> {
  return sseStream<HuggingFaceDownloadStreamEvent>({
    url: ROUTES.huggingFaceDownload(),
    schema: huggingFaceDownloadStreamEventSchema,
    method: 'POST',
    body,
    signal,
    maxRetries: 0,
  })
}
