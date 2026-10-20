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
  createProjectChatResponse,
  createQuickRunResponse,
  createRecipeResponse,
  createRecipeJobSnapshotResponse,
  getContextResponse,
  getChatRetentionResponse,
  getHealthResponse,
  getJobResponse,
  getModelResponse,
  getRuntimeResponse,
  getSettingsResponse,
  getThreadResponse,
  getProjectChatResponse,
  getQuickRunResponse,
  getRecipeResponse,
  getRecipeRevisionResponse,
  getRecipeJobSnapshotResponse,
  huggingFaceRepositoryResponse,
  huggingFaceSearchResponse,
  huggingFaceSelectionResponse,
  huggingFaceDownloadStreamEventSchema,
  huggingFaceImportStreamEventSchema,
  listCatalogResponse,
  listChatTrashResponse,
  listReasoningArtifactsResponse,
  leaveSessionChatResponse,
  getReasoningArtifactResponse,
  listModelsResponse,
  listProjectsResponse,
  listProjectsWithPresentationResponse,
  listProjectChatsResponse,
  listProjectlessChatsResponse,
  listQuickRunsResponse,
  listRecipesResponse,
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
  ATTACHMENT_VERSION,
  createAttachmentResponse,
  getArtifactTransferPolicyResponse,
  listAttachmentsResponse,
  projectSchema,
  projectWithPresentationSchema,
  restoreChatResponse,
  updateQuickRunRetentionResponse,
  renameRecipeResponse,
  reviseRecipeResponse,
  PROJECT_PRESENTATION_VERSION,
  PROJECT_CHAT_OWNERSHIP_VERSION,
  type ApiError,
  type ApprovalBody,
  type ChatStreamEvent,
  type CompletionProbeBody,
  type CompactThreadBody,
  type HuggingFaceSearchBody,
  type HuggingFaceSelectionBody,
  type HuggingFaceDownloadBody,
  type HuggingFaceDownloadStreamEvent,
  type HuggingFaceImportBody,
  type HuggingFaceImportStreamEvent,
  type ModelCapabilityOverrideMutationBody,
  type OllamaReferenceStartBody,
  type JobStreamEvent,
  type CreateThreadBody,
  type CreateWorkspaceBody,
  type CreateProjectBody,
  type CreateProjectChatBody,
  type CreateQuickRunBody,
  type CreateRecipeBody,
  type CreateRecipeJobSnapshotBody,
  type PullStreamEvent,
  type PrewarmModelBody,
  type SendMessageBody,
  type UpdateSettingsBody,
  type UpdateThreadBody,
  type UpdateChatRetentionBody,
  type UpdateProjectBody,
  type UpdateProjectPresentationBody,
  type ListCatalogQuery,
  type ListChatTrashQuery,
  type ListReasoningArtifactsQuery,
  type LeaveSessionChatBody,
  type RestoreChatBody,
  type QuickRunScopeQuery,
  type RecipeScopeQuery,
  type RecipeJobSnapshotQuery,
  type RenameRecipeBody,
  type ReviseRecipeBody,
  type UpdateQuickRunRetentionBody,
  type ArtifactScope,
} from '@guanxi/contract'
import { consumeSse, sseStream } from './sse.ts'
import { PRODUCT_NAME } from './brand.ts'
import { translate, type LocaleKey } from './locale.ts'

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
    super('API response shape mismatch')
    this.name = 'ApiShapeError'
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'context_limit_exceeded') return translate('context.limit.exceeded')
    if (error.payload) return translate(API_ERROR_KEYS[error.payload.code])
    return translate('error.api.internal')
  }
  if (error instanceof ApiShapeError) return translate('error.contractShape', { path: error.path })
  if (error instanceof Error) {
    // Самый частый случай локально: сервер не поднят.
    if (error.name === 'TypeError' && /fetch/i.test(error.message)) {
      return translate('error.serverConnection', { product: PRODUCT_NAME })
    }
    return error.message
  }
  return String(error)
}

const API_ERROR_KEYS = {
  ollama_unavailable: 'error.api.unavailable',
  model_not_found: 'error.api.notFound',
  job_not_found: 'error.api.notFound',
  job_conflict: 'error.api.conflict',
  storage_error: 'error.api.storage',
  thread_not_found: 'error.api.notFound',
  workspace_not_found: 'error.api.notFound',
  project_not_found: 'error.api.notFound',
  quick_run_not_found: 'error.api.notFound',
  recipe_not_found: 'error.api.notFound',
  recipe_revision_conflict: 'error.api.conflict',
  recipe_job_not_found: 'error.api.notFound',
  recipe_job_conflict: 'error.api.conflict',
  artifact_not_found: 'error.api.notFound',
  artifact_conflict: 'error.api.conflict',
  artifact_too_large: 'error.api.tooLarge',
  artifact_policy_unavailable: 'error.api.unavailable',
  artifact_admission_full: 'error.api.admissionFull',
  range_not_supported: 'error.api.notSupported',
  project_chat_mismatch: 'error.api.conflict',
  session_not_found: 'error.api.notFound',
  egress_not_ready: 'error.api.egressNotReady',
  path_outside_workspace: 'error.api.notAllowed',
  tool_disabled: 'error.api.notAllowed',
  validation_failed: 'error.api.validation',
  context_limit_exceeded: 'error.api.validation',
  ollama_connect_timeout: 'error.api.timeout',
  ollama_load_timeout: 'error.api.timeout',
  ollama_stream_idle_timeout: 'error.api.timeout',
  runtime_protocol: 'error.api.protocol',
  upstream_error: 'error.api.upstream',
  internal_error: 'error.api.internal',
} satisfies Record<ApiError['code'], LocaleKey>

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

  listProjectlessChats: (signal?: AbortSignal) =>
    request(ROUTES.threads(), listProjectlessChatsResponse, {
      query: {
        ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
        scope: 'projectless',
      },
      signal,
    }),

  createThread: (body: CreateThreadBody, signal?: AbortSignal) =>
    request(ROUTES.threads(), createThreadResponse, { method: 'POST', body, signal }),

  getThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.thread(id), getThreadResponse, {
      query: { contextCheckpointVersion: 1 },
      signal,
    }),

  updateThread: (id: string, body: UpdateThreadBody, signal?: AbortSignal) =>
    request(ROUTES.thread(id), createThreadResponse, { method: 'PATCH', body, signal }),

  deleteThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.thread(id), approvalResponse, { method: 'DELETE', signal }),

  stopThread: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadStop(id), approvalResponse, { method: 'POST', signal }),

  compactThread: (id: string, body: CompactThreadBody = {}, signal?: AbortSignal) =>
    request(ROUTES.threadCompact(id), compactThreadResponse, { method: 'POST', body, signal }),

  getContext: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadContext(id), getContextResponse, { signal }),

  getChatRetention: (id: string, signal?: AbortSignal) =>
    request(ROUTES.threadRetention(id), getChatRetentionResponse, { signal }),

  updateChatRetention: (id: string, body: UpdateChatRetentionBody, signal?: AbortSignal) =>
    request(ROUTES.threadRetention(id), getChatRetentionResponse, {
      method: 'PATCH',
      body,
      signal,
    }),

  listChatTrash: (query: ListChatTrashQuery, signal?: AbortSignal) =>
    request(ROUTES.chatTrash(), listChatTrashResponse, {
      query: {
        lifecycleVersion: query.lifecycleVersion,
        deletionVersion: query.deletionVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
        limit: query.limit,
      },
      signal,
    }),

  restoreChat: (id: string, body: RestoreChatBody, signal?: AbortSignal) =>
    request(ROUTES.threadRestore(id), restoreChatResponse, {
      method: 'POST',
      body,
      signal,
    }),

  leaveSessionChat: (id: string, body: LeaveSessionChatBody, signal?: AbortSignal) =>
    request(ROUTES.threadSessionLeave(id), leaveSessionChatResponse, {
      method: 'POST',
      body,
      signal,
    }),

  listReasoningArtifacts: (
    id: string,
    query: ListReasoningArtifactsQuery,
    signal?: AbortSignal,
  ) => request(ROUTES.threadReasoningArtifacts(id), listReasoningArtifactsResponse, {
    query: {
      artifactVersion: query.artifactVersion,
      enforcementVersion: query.enforcementVersion,
      scope: query.scope,
      projectId: query.scope === 'project' ? query.projectId : undefined,
    },
    signal,
  }),

  getReasoningArtifact: (
    chatId: string,
    artifactId: string,
    query: ListReasoningArtifactsQuery,
    signal?: AbortSignal,
  ) => request(
    ROUTES.threadReasoningArtifact(chatId, artifactId),
    getReasoningArtifactResponse,
    {
      query: {
        artifactVersion: query.artifactVersion,
        enforcementVersion: query.enforcementVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    },
  ),

  /* Воркспейсы */

  listWorkspaces: (signal?: AbortSignal) =>
    request(ROUTES.workspaces(), listWorkspacesResponse, { signal }),

  createWorkspace: (body: CreateWorkspaceBody, signal?: AbortSignal) =>
    request(ROUTES.workspaces(), workspaceSchema, { method: 'POST', body, signal }),

  deleteWorkspace: (id: string, signal?: AbortSignal) =>
    request(ROUTES.workspace(id), approvalResponse, { method: 'DELETE', signal }),

  /* Проекты */

  listProjects: (signal?: AbortSignal) =>
    request(ROUTES.projects(), listProjectsResponse, { signal }),

  listProjectsWithPresentation: (signal?: AbortSignal) =>
    request(ROUTES.projects(), listProjectsWithPresentationResponse, {
      query: { presentationVersion: PROJECT_PRESENTATION_VERSION },
      signal,
    }),

  createProject: (body: CreateProjectBody, signal?: AbortSignal) =>
    request(ROUTES.projects(), projectSchema, { method: 'POST', body, signal }),

  updateProject: (id: string, body: UpdateProjectBody, signal?: AbortSignal) =>
    request(ROUTES.project(id), projectSchema, { method: 'PATCH', body, signal }),

  updateProjectPresentation: (
    id: string,
    body: UpdateProjectPresentationBody,
    signal?: AbortSignal,
  ) => request(ROUTES.projectPresentation(id), projectWithPresentationSchema, {
    method: 'PATCH',
    body,
    signal,
  }),

  listProjectChats: (projectId: string, signal?: AbortSignal) =>
    request(ROUTES.projectChats(projectId), listProjectChatsResponse, { signal }),

  createProjectChat: (
    projectId: string,
    body: CreateProjectChatBody,
    signal?: AbortSignal,
  ) => request(ROUTES.projectChats(projectId), createProjectChatResponse, {
    method: 'POST',
    body,
    signal,
  }),

  getProjectChat: (projectId: string, threadId: string, signal?: AbortSignal) =>
    request(ROUTES.projectChat(projectId, threadId), getProjectChatResponse, {
      query: { contextCheckpointVersion: 1 },
      signal,
    }),

  /* Local attachment transport; upload does not imply model consumption. */

  artifactTransferPolicy: (signal?: AbortSignal) =>
    request(
      ROUTES.artifactTransferPolicy(),
      getArtifactTransferPolicyResponse,
      { signal },
    ),

  listAttachments: (scope: ArtifactScope, limit: number, signal?: AbortSignal) =>
    request(ROUTES.artifacts(), listAttachmentsResponse, {
      query: {
        attachmentVersion: ATTACHMENT_VERSION,
        scope: scope.scope,
        projectId: scope.scope === 'project' ? scope.projectId : undefined,
        limit,
      },
      signal,
    }),

  uploadAttachment: async (
    scope: ArtifactScope,
    file: File,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => {
    const url = withQuery(ROUTES.artifacts(), {
      attachmentVersion: ATTACHMENT_VERSION,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : undefined,
      displayName: file.name,
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': file.type || 'application/octet-stream',
        'Idempotency-Key': idempotencyKey,
      },
      body: file,
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(safeJson(text))
      throw new ApiRequestError(
        response.status,
        parsed.success ? parsed.data : null,
        parsed.success ? parsed.data.message : `HTTP ${response.status}`,
      )
    }
    const parsed = createAttachmentResponse.safeParse(safeJson(text))
    if (!parsed.success) throw new ApiShapeError(url, parsed.error.issues)
    return parsed.data
  },

  attachmentDownloadUrl: (id: string, scope: ArtifactScope) => withQuery(
    ROUTES.artifactContent(id),
    {
      attachmentVersion: ATTACHMENT_VERSION,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : undefined,
    },
  ),

  downloadAttachment: async (id: string, scope: ArtifactScope, signal?: AbortSignal) => {
    const url = withQuery(ROUTES.artifactContent(id), {
      attachmentVersion: ATTACHMENT_VERSION,
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : undefined,
    })
    const response = await fetch(url, {
      headers: { Accept: 'application/octet-stream' },
      signal,
    })
    if (!response.ok) {
      const text = await response.text()
      const parsed = apiErrorSchema.safeParse(safeJson(text))
      throw new ApiRequestError(
        response.status,
        parsed.success ? parsed.data : null,
        parsed.success ? parsed.data.message : `HTTP ${response.status}`,
      )
    }
    return response.blob()
  },

  /* Quick Run metadata — these routes never execute model work. */

  listQuickRuns: (query: QuickRunScopeQuery, signal?: AbortSignal) =>
    request(ROUTES.quickRuns(), listQuickRunsResponse, {
      query: {
        quickRunVersion: query.quickRunVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    }),

  createQuickRun: (body: CreateQuickRunBody, signal?: AbortSignal) =>
    request(ROUTES.quickRuns(), createQuickRunResponse, { method: 'POST', body, signal }),

  getQuickRun: (id: string, query: QuickRunScopeQuery, signal?: AbortSignal) =>
    request(ROUTES.quickRun(id), getQuickRunResponse, {
      query: {
        quickRunVersion: query.quickRunVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    }),

  updateQuickRunRetention: (
    id: string,
    body: UpdateQuickRunRetentionBody,
    signal?: AbortSignal,
  ) => request(ROUTES.quickRunRetention(id), updateQuickRunRetentionResponse, {
    method: 'PATCH',
    body,
    signal,
  }),

  /* Recipe identity and immutable revisions; execution remains a separate boundary. */

  listRecipes: (query: RecipeScopeQuery, signal?: AbortSignal) =>
    request(ROUTES.recipes(), listRecipesResponse, {
      query: {
        recipeVersion: query.recipeVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    }),

  createRecipe: (body: CreateRecipeBody, signal?: AbortSignal) =>
    request(ROUTES.recipes(), createRecipeResponse, { method: 'POST', body, signal }),

  getRecipe: (id: string, query: RecipeScopeQuery, signal?: AbortSignal) =>
    request(ROUTES.recipe(id), getRecipeResponse, {
      query: {
        recipeVersion: query.recipeVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    }),

  getRecipeRevision: (
    id: string,
    revision: number,
    query: RecipeScopeQuery,
    signal?: AbortSignal,
  ) => request(ROUTES.recipeRevision(id, revision), getRecipeRevisionResponse, {
    query: {
      recipeVersion: query.recipeVersion,
      scope: query.scope,
      projectId: query.scope === 'project' ? query.projectId : undefined,
    },
    signal,
  }),

  renameRecipe: (id: string, body: RenameRecipeBody, signal?: AbortSignal) =>
    request(ROUTES.recipeName(id), renameRecipeResponse, { method: 'PATCH', body, signal }),

  reviseRecipe: (id: string, body: ReviseRecipeBody, signal?: AbortSignal) =>
    request(ROUTES.recipeRevisions(id), reviseRecipeResponse, { method: 'POST', body, signal }),

  createRecipeJobSnapshot: (
    id: string,
    revision: number,
    body: CreateRecipeJobSnapshotBody,
    signal?: AbortSignal,
  ) => request(
    ROUTES.recipeRevisionJobs(id, revision),
    createRecipeJobSnapshotResponse,
    { method: 'POST', body, signal },
  ),

  getRecipeJobSnapshot: (
    id: string,
    revision: number,
    jobId: string,
    query: RecipeJobSnapshotQuery,
    signal?: AbortSignal,
  ) => request(
    ROUTES.recipeRevisionJob(id, revision, jobId),
    getRecipeJobSnapshotResponse,
    {
      query: {
        recipeJobSnapshotVersion: query.recipeJobSnapshotVersion,
        scope: query.scope,
        projectId: query.scope === 'project' ? query.projectId : undefined,
      },
      signal,
    },
  ),

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

/** Explicit staged GGUF import is connection-owned and never auto-retried. */
export function streamHuggingFaceImport(
  body: HuggingFaceImportBody,
  signal?: AbortSignal,
): AsyncGenerator<HuggingFaceImportStreamEvent, void, void> {
  return sseStream<HuggingFaceImportStreamEvent>({
    url: ROUTES.huggingFaceImport(),
    schema: huggingFaceImportStreamEventSchema,
    method: 'POST',
    body,
    signal,
    maxRetries: 0,
  })
}
