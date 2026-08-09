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
  FEATURE_FLAG_REGISTRY_VERSION,
  ESTIMATED_PARALLEL_ADMISSION_VERSION,
  estimatedParallelAdmissionResponseSchema,
  estimatedParallelPairMemberSchema,
  featureFlagProjectionSchema,
  completionProbeEvidenceSchema,
  healthSchema,
  HUGGING_FACE_DISCOVERY_VERSION,
  huggingFaceExactRevisionSchema,
  huggingFaceGgufPathSchema,
  huggingFaceReferencePreviewSchema,
  huggingFaceRepositoryIdentitySchema,
  huggingFaceRepositorySchema,
  huggingFaceSelectionResultSchema,
  huggingFaceSourceHealthSchema,
  huggingFaceTransportFailureReasonSchema,
  jobKindSchema,
  jobSchema,
  localModelSchema,
  messageSchema,
  modelCapabilitySchema,
  modelCapabilityOverrideSchema,
  modelDetailSchema,
  positiveSafeIntegerSchema,
  projectSchema,
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
  featureFlags: () => '/api/feature-flags',

  jobs: () => '/api/jobs',
  job: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`,
  jobEvents: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/events`,
  jobCancel: (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/cancel`,

  models: () => '/api/models',
  modelsCatalog: () => '/api/models/catalog',
  modelsRunning: () => '/api/models/running',
  runtime: () => '/api/runtime',
  estimatedParallelAdmission: () => '/api/runtime/estimated-parallel-admission',
  model: (name: string) => `/api/models/${encodeURIComponent(name)}`,
  modelPull: (name: string) => `/api/models/${encodeURIComponent(name)}/pull`,
  modelWarm: (name: string) => `/api/models/${encodeURIComponent(name)}/warm`,
  modelPrewarm: (name: string) => `/api/models/${encodeURIComponent(name)}/prewarm`,
  modelCompletionProbe: (name: string) =>
    `/api/models/${encodeURIComponent(name)}/probes/completion`,
  modelCapabilityOverrides: (name: string) =>
    `/api/models/${encodeURIComponent(name)}/capability-overrides`,
  ollamaReferencePreview: () => '/api/models/imports/ollama-reference/preview',
  ollamaReferenceStart: () => '/api/models/imports/ollama-reference/start',
  huggingFaceSearch: () => '/api/models/discovery/hugging-face/search',
  huggingFaceRepository: () => '/api/models/discovery/hugging-face/repository',
  huggingFaceSelection: () => '/api/models/discovery/hugging-face/selection',
  huggingFaceDownload: () => '/api/models/discovery/hugging-face/download',
  huggingFaceImport: () => '/api/models/imports/hugging-face-gguf/start',
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

  projects: () => '/api/projects',
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,

  approval: (toolCallId: string) => `/api/approvals/${toolCallId}`,

  settings: () => '/api/settings',
} as const

/* ──────────────────────────────── Health ─────────────────────────────────── */

export const getHealthResponse = healthSchema
export type GetHealthResponse = z.infer<typeof getHealthResponse>

/* ───────────────────────────── Feature flags ────────────────────────────── */

export const getFeatureFlagsResponse = z
  .object({
    version: z.literal(FEATURE_FLAG_REGISTRY_VERSION),
    flags: z.array(featureFlagProjectionSchema).length(1),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.flags.map((flag) => flag.key)
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flags'],
        message: 'Duplicate feature flag keys are not allowed',
      })
    }
  })
export type GetFeatureFlagsResponse = z.infer<typeof getFeatureFlagsResponse>

export const estimatedParallelAdmissionBody = z
  .object({
    version: z.literal(ESTIMATED_PARALLEL_ADMISSION_VERSION),
    expectedRuntimeObservedAt: z.string().datetime().nullable(),
    active: estimatedParallelPairMemberSchema,
    candidate: estimatedParallelPairMemberSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (JSON.stringify(value.active.owner) === JSON.stringify(value.candidate.owner)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidate', 'owner'],
        message: 'Active and candidate owners must be different',
      })
    }
  })
export type EstimatedParallelAdmissionBody = z.infer<
  typeof estimatedParallelAdmissionBody
>
export const estimatedParallelAdmissionResponse = estimatedParallelAdmissionResponseSchema

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

const csvValues = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value.length === 0
          ? []
          : value.split(',')
        : value,
    z.array(schema).max(16).refine(
      (values) => new Set(values).size === values.length,
      'Duplicate filter values are not allowed',
    ),
  )

export const catalogInstallationFilterSchema = z.enum([
  'installed',
  'not_installed',
  'unknown',
])
export type CatalogInstallationFilter = z.infer<typeof catalogInstallationFilterSchema>
export const catalogFitFilterSchema = z.enum(['green', 'yellow', 'red', 'unknown'])
export type CatalogFitFilter = z.infer<typeof catalogFitFilterSchema>
export const catalogProviderScopeFilterSchema = z.enum(['local', 'cloud'])
export type CatalogProviderScopeFilter = z.infer<typeof catalogProviderScopeFilterSchema>
export const catalogSourceFilterSchema = z.enum(['local_cache', 'bundled', 'remote'])
export type CatalogSourceFilter = z.infer<typeof catalogSourceFilterSchema>
export const catalogFreshnessFilterSchema = z.enum([
  'fresh',
  'stale',
  'fallback',
  'unknown',
])
export type CatalogFreshnessFilter = z.infer<typeof catalogFreshnessFilterSchema>
export const catalogCapabilityFilterSchema = z.enum([
  'completion',
  'tools',
  'vision',
  'insert',
  'thinking',
  'embedding',
  'unknown',
])
export type CatalogCapabilityFilter = z.infer<typeof catalogCapabilityFilterSchema>

/**
 * P2-H transport/render policy. The default is used by explicit new clients;
 * the maximum bounds one response page only and never caps matching catalog rows.
 */
export const CATALOG_DEFAULT_PAGE_SIZE = 12
export const CATALOG_MAX_PAGE_SIZE = 100
const catalogCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/**
 * GET /api/models/catalog. Multi-select groups use one comma-separated value;
 * OR applies inside a group and AND across groups. Repeated keys are rejected
 * by the HTTP boundary before this strict schema is parsed.
 */
export const listCatalogQuery = z
  .object({
    q: z.string().optional(),
    contextLength: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
    installation: csvValues(catalogInstallationFilterSchema).optional(),
    fit: csvValues(catalogFitFilterSchema).optional(),
    providerScope: csvValues(catalogProviderScopeFilterSchema).optional(),
    source: csvValues(catalogSourceFilterSchema).optional(),
    freshness: csvValues(catalogFreshnessFilterSchema).optional(),
    capability: csvValues(catalogCapabilityFilterSchema).optional(),
    minClaimedContext: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
    contextClaim: z.literal('unknown').optional(),
    maxClaimedArtifactSize: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
    artifactSizeClaim: z.literal('unknown').optional(),
    page: z.coerce.number().pipe(positiveSafeIntegerSchema).optional(),
    pageSize: z.coerce
      .number()
      .pipe(positiveSafeIntegerSchema.max(CATALOG_MAX_PAGE_SIZE))
      .optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.minClaimedContext !== undefined && query.contextClaim !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contextClaim'],
        message: 'Claimed context cannot be both numeric and unknown',
      })
    }
    if (
      query.maxClaimedArtifactSize !== undefined
      && query.artifactSizeClaim !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactSizeClaim'],
        message: 'Claimed artifact size cannot be both numeric and unknown',
      })
    }
    if ((query.page === undefined) !== (query.pageSize === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [query.page === undefined ? 'page' : 'pageSize'],
        message: 'page and pageSize must be provided together',
      })
    }
  })
export type ListCatalogQuery = z.infer<typeof listCatalogQuery>
export const catalogPaginationSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('legacy'),
    totalItems: catalogCountSchema,
  }).strict(),
  z.object({
    mode: z.literal('paged'),
    page: positiveSafeIntegerSchema,
    pageSize: positiveSafeIntegerSchema.max(CATALOG_MAX_PAGE_SIZE),
    totalItems: catalogCountSchema,
    totalPages: catalogCountSchema,
    previousPage: positiveSafeIntegerSchema.nullable(),
    nextPage: positiveSafeIntegerSchema.nullable(),
  }).strict(),
])
export type CatalogPagination = z.infer<typeof catalogPaginationSchema>
export const listCatalogResponse = z.object({
  models: z.array(catalogModelSchema),
  /** Legacy compatibility projection; P0-D does not call an undocumented remote endpoint. */
  live: z.boolean(),
  source: catalogSourceHealthSchema.optional(),
  /** Optional only so recorded legacy responses remain parseable by new clients. */
  pagination: catalogPaginationSchema.optional(),
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

export const completionProbeBody = z
  .object({
    capability: z.literal('completion'),
    expectedDigest: z.string().min(1),
    contextLength: positiveSafeIntegerSchema,
    force: z.boolean().optional().default(false),
  })
  .strict()
export type CompletionProbeBody = z.infer<typeof completionProbeBody>

export const completionProbeResponse = z
  .object({
    evidence: completionProbeEvidenceSchema,
  })
  .strict()
export type CompletionProbeResponse = z.infer<typeof completionProbeResponse>

/**
 * P2-I user override mutations. The client always states the exact identity it
 * rendered, so a stale expectation is a controlled conflict instead of a write
 * addressed by model name alone.
 */
export const modelCapabilityOverrideMutationBody = z
  .object({
    capability: modelCapabilitySchema,
    expectedDigest: z.string().min(1),
    expectedRuntimeVersion: z.string().min(1),
  })
  .strict()
export type ModelCapabilityOverrideMutationBody = z.infer<
  typeof modelCapabilityOverrideMutationBody
>

export const modelCapabilityOverrideIdentitySchema = z
  .object({
    provider: z.literal('ollama'),
    normalizedModelReference: z.string().min(1),
    artifactDigest: z.string().min(1),
    runtimeVersion: z.string().min(1),
  })
  .strict()
export type ModelCapabilityOverrideIdentity = z.infer<
  typeof modelCapabilityOverrideIdentitySchema
>

/**
 * A conflict is never a capability claim: it says the exact identity or the
 * caller expectation could not be confirmed, so nothing was written or removed.
 */
export const modelCapabilityOverrideConflictReasonSchema = z.enum([
  'invalid_model_reference',
  'model_not_installed',
  'installed_reference_ambiguous',
  'installed_digest_missing',
  'runtime_version_unavailable',
  'provider_unavailable',
  'digest_expectation_mismatch',
  'runtime_expectation_mismatch',
  'persistence_failed',
])
export type ModelCapabilityOverrideConflictReason = z.infer<
  typeof modelCapabilityOverrideConflictReasonSchema
>

const modelCapabilityOverrideResolvedBase = z
  .object({
    capability: modelCapabilitySchema,
    identity: modelCapabilityOverrideIdentitySchema,
    /** Every exact compatible override for this identity after the mutation. */
    overrides: z.array(modelCapabilityOverrideSchema),
  })
  .strict()

export const modelCapabilityOverrideOutcomeSchema = z.discriminatedUnion('state', [
  modelCapabilityOverrideResolvedBase.extend({ state: z.literal('applied') }),
  modelCapabilityOverrideResolvedBase.extend({ state: z.literal('cleared') }),
  /** Clearing an override that this exact identity does not have changes nothing. */
  modelCapabilityOverrideResolvedBase.extend({ state: z.literal('absent') }),
  z
    .object({
      state: z.literal('conflict'),
      capability: modelCapabilitySchema,
      reason: modelCapabilityOverrideConflictReasonSchema,
      identity: z.null(),
      overrides: z.array(modelCapabilityOverrideSchema).max(0),
    })
    .strict(),
])
export type ModelCapabilityOverrideOutcome = z.infer<
  typeof modelCapabilityOverrideOutcomeSchema
>

export const modelCapabilityOverrideResponse = z
  .object({ outcome: modelCapabilityOverrideOutcomeSchema })
  .strict()
export type ModelCapabilityOverrideResponse = z.infer<
  typeof modelCapabilityOverrideResponse
>

export const ollamaReferenceInputKindSchema = z.enum([
  'model_name',
  'official_page_url',
])
export type OllamaReferenceInputKind = z.infer<typeof ollamaReferenceInputKindSchema>

export const ollamaReferencePreviewBody = z
  .object({ reference: z.string().min(1) })
  .strict()
export type OllamaReferencePreviewBody = z.infer<typeof ollamaReferencePreviewBody>

export const ollamaReferencePreviewSchema = z
  .object({
    inputKind: ollamaReferenceInputKindSchema,
    displayValue: z.string().min(1),
    normalizedModelName: z.string().min(1),
  })
  .strict()
export type OllamaReferencePreview = z.infer<typeof ollamaReferencePreviewSchema>

export const ollamaReferencePreviewResponse = z
  .object({ preview: ollamaReferencePreviewSchema })
  .strict()
export type OllamaReferencePreviewResponse = z.infer<
  typeof ollamaReferencePreviewResponse
>

export const ollamaReferenceStartBody = z
  .object({
    reference: z.string().min(1),
    confirmedModelName: z.string().min(1),
  })
  .strict()
export type OllamaReferenceStartBody = z.infer<typeof ollamaReferenceStartBody>

/* ─────────────────── Hugging Face read-only discovery (P2-J) ─────────────── */

/**
 * P2-J discovery is a POST so arbitrary user query text never lands in a request line,
 * an access log or a referrer, matching the existing reference-preview precedent. It is
 * still a read-only operation: it starts no download, pull, probe, load, unload, Governor
 * admission, catalog refresh or background Job.
 */
export const HUGGING_FACE_SEARCH_DEFAULT_PAGE_SIZE = 10
export const HUGGING_FACE_SEARCH_MAX_PAGE_SIZE = 25
/**
 * One explicit search may walk at most this many bounded pages. The Hub list API is
 * cursor-paginated, so `page` is only this ordinal bound — never an offset, and never
 * published as a total-result count.
 */
export const HUGGING_FACE_SEARCH_MAX_PAGES = 5
export const HUGGING_FACE_SEARCH_MAX_QUERY_LENGTH = 128

export const huggingFaceSearchBody = z
  .object({
    query: z
      .string()
      .min(1)
      .max(HUGGING_FACE_SEARCH_MAX_QUERY_LENGTH)
      .refine((value) => value.trim().length > 0, 'The search text cannot be blank')
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        'The search text cannot contain control characters',
      ),
    page: positiveSafeIntegerSchema.max(HUGGING_FACE_SEARCH_MAX_PAGES).optional().default(1),
    pageSize: positiveSafeIntegerSchema
      .max(HUGGING_FACE_SEARCH_MAX_PAGE_SIZE)
      .optional()
      .default(HUGGING_FACE_SEARCH_DEFAULT_PAGE_SIZE),
    /** Opaque documented Hub cursor. It is echoed back, never parsed or constructed. */
    cursor: z.string().min(1).max(2_048).nullable().optional().default(null),
  })
  .strict()
  .superRefine((body, context) => {
    // A cursor is what makes a page beyond the first reachable, so the pair must agree
    // instead of silently returning page 1 for a page-3 request.
    if ((body.page === 1) !== (body.cursor === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cursor'],
        message: 'exactly the first page is requested without a cursor',
      })
    }
  })
export type HuggingFaceSearchBody = z.infer<typeof huggingFaceSearchBody>

const huggingFaceSearchPageBase = z
  .object({
    version: z.literal(HUGGING_FACE_DISCOVERY_VERSION),
    page: positiveSafeIntegerSchema.max(HUGGING_FACE_SEARCH_MAX_PAGES),
    pageSize: positiveSafeIntegerSchema.max(HUGGING_FACE_SEARCH_MAX_PAGE_SIZE),
    source: huggingFaceSourceHealthSchema,
    /**
     * Rows the bounded parser refused. Reported so a shrunken page is visible instead of
     * looking like a smaller result set.
     */
    droppedRows: z.number().int().nonnegative().safe(),
  })
  .strict()

export const huggingFaceSearchResultSchema = z.discriminatedUnion('state', [
  huggingFaceSearchPageBase
    .extend({
      state: z.literal('listed'),
      repositories: z.array(huggingFaceRepositorySchema).min(1),
      /** `null` means this bounded page is the last one this slice will walk. */
      nextCursor: z.string().min(1).max(2_048).nullable(),
      reason: z.null(),
    })
    .strict(),
  huggingFaceSearchPageBase
    .extend({
      state: z.literal('empty'),
      repositories: z.array(huggingFaceRepositorySchema).max(0),
      nextCursor: z.null(),
      reason: z.null(),
    })
    .strict(),
  huggingFaceSearchPageBase
    .extend({
      state: z.literal('failed'),
      repositories: z.array(huggingFaceRepositorySchema).max(0),
      nextCursor: z.null(),
      reason: huggingFaceTransportFailureReasonSchema,
    })
    .strict(),
])
export type HuggingFaceSearchResult = z.infer<typeof huggingFaceSearchResultSchema>

export const huggingFaceSearchResponse = z
  .object({ result: huggingFaceSearchResultSchema })
  .strict()
export type HuggingFaceSearchResponse = z.infer<typeof huggingFaceSearchResponse>

export const huggingFaceRepositoryBody = z
  .object({ reference: z.string().min(1).max(512) })
  .strict()
export type HuggingFaceRepositoryBody = z.infer<typeof huggingFaceRepositoryBody>

export const huggingFaceRepositoryResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('resolved'),
      version: z.literal(HUGGING_FACE_DISCOVERY_VERSION),
      preview: huggingFaceReferencePreviewSchema,
      repository: huggingFaceRepositorySchema,
      source: huggingFaceSourceHealthSchema,
      reason: z.null(),
    })
    .strict(),
  /**
   * The identity parsed locally, but the Hub could not be read. The repository row is
   * still returned with `metadata: 'unavailable'` and an unknown verdict, because a
   * failed read is not evidence that the repository lacks GGUF files.
   */
  z
    .object({
      state: z.literal('failed'),
      version: z.literal(HUGGING_FACE_DISCOVERY_VERSION),
      preview: huggingFaceReferencePreviewSchema,
      repository: huggingFaceRepositorySchema,
      source: huggingFaceSourceHealthSchema,
      reason: huggingFaceTransportFailureReasonSchema,
    })
    .strict(),
])
export type HuggingFaceRepositoryResult = z.infer<
  typeof huggingFaceRepositoryResultSchema
>

export const huggingFaceRepositoryResponse = z
  .object({ result: huggingFaceRepositoryResultSchema })
  .strict()
export type HuggingFaceRepositoryResponse = z.infer<
  typeof huggingFaceRepositoryResponse
>

/**
 * P2-K exact GGUF file/revision selection. The server re-parses `identity.repositoryId`
 * through the same strict local grammar as the repository route, re-derives identity,
 * and reads this exact immutable revision from the Hub. A mutable branch cannot be
 * represented by this body.
 */
export const huggingFaceSelectionBody = z
  .object({
    identity: huggingFaceRepositoryIdentitySchema,
    revision: huggingFaceExactRevisionSchema,
    filePath: huggingFaceGgufPathSchema,
    contextLength: positiveSafeIntegerSchema,
  })
  .strict()
export type HuggingFaceSelectionBody = z.infer<typeof huggingFaceSelectionBody>

export const huggingFaceSelectionResponse = z
  .object({ result: huggingFaceSelectionResultSchema })
  .strict()
export type HuggingFaceSelectionResponse = z.infer<
  typeof huggingFaceSelectionResponse
>

/** P2-L connection-owned POST+SSE command; the server revalidates this P2-K tuple. */
export const huggingFaceDownloadBody = huggingFaceSelectionBody
export type HuggingFaceDownloadBody = z.infer<typeof huggingFaceDownloadBody>

/**
 * P2-M explicit connection-owned import. The browser can name only a server-issued
 * staging artifact and a desired Ollama reference; paths, Modelfiles, provider URLs,
 * create options and shell commands are deliberately unrepresentable.
 */
export const huggingFaceImportBody = z
  .object({
    artifactId: z.string().uuid(),
    targetModelName: z.string().min(1).max(255),
    contextLength: positiveSafeIntegerSchema,
  })
  .strict()
export type HuggingFaceImportBody = z.infer<typeof huggingFaceImportBody>


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

/* ───────────────────────────────── Проекты ──────────────────────────────── */

export const PROJECT_NAME_MAX_LENGTH = 120

export const listProjectsResponse = z
  .object({
    projects: z.array(projectSchema),
  })
  .strict()
export type ListProjectsResponse = z.infer<typeof listProjectsResponse>

export const createProjectBody = z
  .object({
    name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH),
  })
  .strict()
export type CreateProjectBody = z.infer<typeof createProjectBody>

export const updateProjectBody = createProjectBody
export type UpdateProjectBody = z.infer<typeof updateProjectBody>

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
