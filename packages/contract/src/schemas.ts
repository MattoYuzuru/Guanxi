/**
 * Alamo UI — доменные схемы.
 *
 * Это единственный источник правды между сервером и вебом. Обе стороны импортируют
 * отсюда типы и валидаторы; расходиться им физически негде.
 *
 * Правило: менять этот файл можно только согласованно. Любое поле, которое читает
 * фронт, обязано быть описано здесь, а не «подразумеваться».
 */
import { z } from 'zod'

/* ─────────────────────────── Железо и влезаемость ────────────────────────── */

export const acceleratorSchema = z.enum(['metal', 'cuda', 'rocm', 'cpu'])
export type Accelerator = z.infer<typeof acceleratorSchema>

export const hardwareInfoSchema = z.object({
  platform: z.string(), // darwin | linux | win32
  arch: z.string(), // arm64 | x64
  cpuModel: z.string(),
  cpuCores: z.number().int(),
  totalMemoryBytes: z.number().int(),
  /** Legacy compatibility estimate; it is not current available/pressure telemetry. */
  usableMemoryBytes: z.number().int(),
  accelerator: acceleratorSchema,
  acceleratorName: z.string().nullable(),
  /** true — память общая между CPU и GPU (Apple Silicon). Влияет на расчёт влезаемости. */
  unifiedMemory: z.boolean(),
  freeDiskBytes: z.number().int().nullable(),
})
export type HardwareInfo = z.infer<typeof hardwareInfoSchema>

export const fitLevelSchema = z.enum(['green', 'yellow', 'red', 'unknown'])
export type FitLevel = z.infer<typeof fitLevelSchema>

/**
 * Вердикт «потянет ли железо». Всегда содержит разбор, чтобы UI мог показать
 * не только цвет, но и почему именно такой цвет.
 */
export const fitVerdictSchema = z.object({
  level: fitLevelSchema,
  /** Короткая формулировка для карточки, на русском. */
  summary: z.string(),
  /** При каком размере окна считали. */
  contextLength: z.number().int(),
  modelBytes: z.number().int(),
  kvCacheBytes: z.number().int(),
  requiredBytes: z.number().int(),
  usableBytes: z.number().int(),
  /** Заполненность памяти, 0..1+. Больше 1 — не влезает. */
  utilization: z.number(),
  /** Прогноз посчитан по формуле, либо взят из факта после загрузки модели. */
  basis: z.enum(['estimate', 'measured', 'vendor_hint']),
  /** Заполняется после реального прогрева: что показал ollama ps. */
  measured: z
    .object({
      sizeBytes: z.number().int(),
      gpuPercent: z.number().int(),
      processorLabel: z.string(),
    })
    .nullable(),
})
export type FitVerdict = z.infer<typeof fitVerdictSchema>

/* ──────────────────────────────── Модели ─────────────────────────────────── */

export const modelCapabilitySchema = z.enum([
  'completion',
  'tools',
  'vision',
  'insert',
  'thinking',
  'embedding',
])
export type ModelCapability = z.infer<typeof modelCapabilitySchema>

export const localModelSchema = z.object({
  name: z.string(),
  digest: z.string(),
  sizeBytes: z.number().int(),
  modifiedAt: z.string(), // ISO
  family: z.string(),
  parameterSize: z.string(), // "7.6B"
  quantization: z.string(), // "Q4_K_M"
  /** Максимум, который поддерживает модель. Не путать с выделенным при загрузке. */
  contextLength: z.number().int(),
  capabilities: z.array(modelCapabilitySchema),
  /** true — модель считается в облаке Ollama, локальная память не тратится. */
  isCloud: z.boolean(),
  fit: fitVerdictSchema,
})
export type LocalModel = z.infer<typeof localModelSchema>

export const catalogModelSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Доступные теги-размеры: 7b, 14b, 27b-q4 и т.п. */
  variants: z.array(
    z.object({
      tag: z.string(),
      sizeBytes: z.number().int().nullable(),
      parameterSize: z.string().nullable(),
    }),
  ),
  contextLength: z.number().int().nullable(),
  capabilities: z.array(modelCapabilitySchema),
  /** Подсказка вендора по требуемой видеопамяти, если есть. */
  vramBytes: z.number().int().nullable(),
  isCloud: z.boolean(),
  requiredPlan: z.enum(['free', 'pro']).nullable(),
  installed: z.boolean(),
  fit: fitVerdictSchema,
  /** Provider provenance. `remote` remains for a future documented provider. */
  source: z.enum(['remote', 'local_cache', 'bundled']),
  /** Additive P0-D freshness fields; absent values are legacy/unknown. */
  freshness: z.enum(['fresh', 'stale', 'fallback', 'unknown']).optional().default('unknown'),
  sourceObservedAt: z.string().nullable().optional().default(null),
  sourceFetchedAt: z.string().nullable().optional().default(null),
})
export type CatalogModel = z.infer<typeof catalogModelSchema>

export const runningModelSchema = z.object({
  name: z.string(),
  digest: z.string().nullable().optional().default(null),
  sizeBytes: z.number().int(),
  /** Runtime-reported accelerator allocation; on Apple this is not discrete VRAM. */
  sizeVramBytes: z.number().int().nullable(),
  /** Legacy derived fields; current `/api/ps` projection leaves them null. */
  gpuPercent: z.number().int().nullable(),
  processorLabel: z.string().nullable(), // "100% GPU" | "43%/57% CPU/GPU"
  contextLength: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
  source: z.literal('ollama_api_ps').nullable().optional().default(null),
  observedAt: z.string().nullable().optional().default(null),
})
export type RunningModel = z.infer<typeof runningModelSchema>

/* ─────────────────────────── Runtime reconciliation ─────────────────────── */

export const runtimeSourceErrorCodeSchema = z.enum([
  'ollama_unavailable',
  'ollama_connect_timeout',
  'ollama_load_timeout',
  'ollama_stream_idle_timeout',
  'runtime_protocol',
  'upstream_error',
  'internal_error',
])
export type RuntimeSourceErrorCode = z.infer<typeof runtimeSourceErrorCodeSchema>

const runtimeSourceObservationSchema = z.object({
  source: z.literal('ollama_api_ps'),
  observedAt: z.string().datetime(),
})

export const runtimeSourceHealthSchema = z.discriminatedUnion('state', [
  runtimeSourceObservationSchema.extend({
    state: z.literal('available'),
    errorCode: z.null(),
  }),
  runtimeSourceObservationSchema.extend({
    state: z.literal('unavailable'),
    errorCode: z.enum([
      'ollama_unavailable',
      'ollama_connect_timeout',
      'ollama_load_timeout',
      'ollama_stream_idle_timeout',
      'upstream_error',
      'internal_error',
    ]),
  }),
  runtimeSourceObservationSchema.extend({
    state: z.literal('incompatible'),
    errorCode: z.literal('runtime_protocol'),
  }),
])
export type RuntimeSourceHealth = z.infer<typeof runtimeSourceHealthSchema>

/* ───────────────────────────── Host telemetry ───────────────────────────── */

export const runtimeTelemetryConfidenceSchema = z.enum(['observed', 'estimated', 'unknown'])
export type RuntimeTelemetryConfidence = z.infer<typeof runtimeTelemetryConfidenceSchema>

export const runtimeMemoryFactSourceSchema = z.enum([
  'node_os_totalmem',
  'legacy_apple_unified_memory_70_percent',
  'legacy_hardware_usable_estimate',
  'apple_vm_stat_pages_free',
  'apple_host_available_memory',
  'apple_host_gpu_free_memory',
  'not_reported',
])
export type RuntimeMemoryFactSource = z.infer<typeof runtimeMemoryFactSourceSchema>

export const runtimeMemoryFactBasisSchema = z.enum([
  'total_unified_memory',
  'total_system_memory',
  'legacy_compatibility_estimate_not_current_availability',
  'system_free_pages_not_safe_capacity',
  'system_available_memory_advisory',
  'discrete_vram_not_applicable_to_apple_unified_memory',
  'discrete_vram_not_observed',
  'gpu_free_memory_not_reported',
])
export type RuntimeMemoryFactBasis = z.infer<typeof runtimeMemoryFactBasisSchema>

export const runtimeMemoryFactSchema = z
  .object({
    bytes: z.number().int().nonnegative().nullable(),
    source: runtimeMemoryFactSourceSchema,
    observedAt: z.string().datetime(),
    confidence: runtimeTelemetryConfidenceSchema,
    basis: runtimeMemoryFactBasisSchema,
  })
  .strict()
export type RuntimeMemoryFact = z.infer<typeof runtimeMemoryFactSchema>

export const runtimeHostPressureLevelSchema = z.enum([
  'normal',
  'warning',
  'critical',
  'unknown',
])
export type RuntimeHostPressureLevel = z.infer<typeof runtimeHostPressureLevelSchema>

export const runtimeHostPressureFactSchema = z
  .object({
    level: runtimeHostPressureLevelSchema,
    source: z.enum(['apple_host_memory_pressure', 'not_reported']),
    observedAt: z.string().datetime(),
    confidence: runtimeTelemetryConfidenceSchema,
    basis: z.enum(['system_memory_pressure', 'not_observed']),
  })
  .strict()
export type RuntimeHostPressureFact = z.infer<typeof runtimeHostPressureFactSchema>

export const runtimeHostTelemetryFieldSchema = z.enum([
  'total_unified_memory_bytes',
  'legacy_usable_memory_estimate_bytes',
  'free_memory_bytes',
  'available_memory_bytes',
  'memory_pressure',
  'discrete_vram_bytes',
  'gpu_free_memory_bytes',
])
export type RuntimeHostTelemetryField = z.infer<typeof runtimeHostTelemetryFieldSchema>

export const runtimeHostProfileSchema = z
  .object({
    platform: z.string().min(1),
    arch: z.string().min(1),
    accelerator: acceleratorSchema,
    acceleratorName: z.string().nullable(),
    unifiedMemory: z.boolean(),
    source: z.literal('legacy_hardware_probe'),
    observedAt: z.string().datetime(),
    confidence: z.literal('observed'),
    totalMemoryBytes: runtimeMemoryFactSchema,
    legacyUsableMemoryBytes: runtimeMemoryFactSchema,
    discreteVramBytes: runtimeMemoryFactSchema,
  })
  .strict()
export type RuntimeHostProfile = z.infer<typeof runtimeHostProfileSchema>

export const runtimeHostSampleSchema = z
  .object({
    source: z.enum(['apple_vm_stat', 'none']),
    observedAt: z.string().datetime(),
    freeMemoryBytes: runtimeMemoryFactSchema,
    availableMemoryBytes: runtimeMemoryFactSchema,
    pressure: runtimeHostPressureFactSchema,
    gpuFreeMemoryBytes: runtimeMemoryFactSchema,
  })
  .strict()
export type RuntimeHostSample = z.infer<typeof runtimeHostSampleSchema>

export const runtimeHostTelemetrySchema = z
  .object({
    state: z.enum(['available', 'partial', 'unavailable', 'unsupported']),
    observedAt: z.string().datetime(),
    profile: runtimeHostProfileSchema,
    sample: runtimeHostSampleSchema,
    availableFields: z.array(runtimeHostTelemetryFieldSchema),
    missingFields: z.array(runtimeHostTelemetryFieldSchema),
    errorCode: z
      .enum(['host_probe_timeout', 'host_probe_output_limit', 'host_probe_failed', 'host_probe_malformed'])
      .nullable(),
  })
  .strict()
  .superRefine((host, context) => {
    const timestamps = [
      host.profile.observedAt,
      host.profile.totalMemoryBytes.observedAt,
      host.profile.legacyUsableMemoryBytes.observedAt,
      host.profile.discreteVramBytes.observedAt,
      host.sample.observedAt,
      host.sample.freeMemoryBytes.observedAt,
      host.sample.availableMemoryBytes.observedAt,
      host.sample.pressure.observedAt,
      host.sample.gpuFreeMemoryBytes.observedAt,
    ]
    if (timestamps.some((observedAt) => observedAt !== host.observedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'host telemetry facts must share the host observedAt',
      })
    }
    if ((host.state === 'available' || host.state === 'unsupported') && host.errorCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorCode'],
        message: 'available and unsupported host telemetry cannot carry an error',
      })
    }
    if (host.state === 'partial' && host.missingFields.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['missingFields'],
        message: 'partial host telemetry must enumerate missing fields',
      })
    }
  })
export type RuntimeHostTelemetry = z.infer<typeof runtimeHostTelemetrySchema>

export const runtimeCurrentFitReasonSchema = z.enum([
  'observed_current_residency',
  'runtime_owner_unknown',
  'runtime_reference_ambiguous',
  'runtime_digest_missing',
  'runtime_context_missing',
  'runtime_context_mismatch',
  'host_unsupported',
  'host_unavailable',
  'host_partial',
  'host_available_memory_unknown',
  'host_pressure_unknown',
  'host_pressure_elevated',
])
export type RuntimeCurrentFitReason = z.infer<typeof runtimeCurrentFitReasonSchema>

const runtimeCurrentFitObservationSchema = z.object({
  observedAt: z.string().datetime(),
  requestedContext: z.number().int().positive().nullable(),
  observedContext: z.number().int().nonnegative().nullable(),
  runtimeAllocationBytes: z.number().int().nonnegative().nullable(),
  runtimeAcceleratorAllocationBytes: z.number().int().nonnegative().nullable(),
  pressureLevel: runtimeHostPressureLevelSchema,
  /** A current observation never promises that a future admission is safe. */
  futureAdmissionGuarantee: z.literal(false),
})

export const runtimeCurrentFitSchema = z.discriminatedUnion('state', [
  runtimeCurrentFitObservationSchema
    .extend({
      state: z.literal('observed'),
      basis: z.literal('current_loaded_configuration'),
      reason: z.literal('observed_current_residency'),
    })
    .strict(),
  runtimeCurrentFitObservationSchema
    .extend({
      state: z.literal('unknown'),
      basis: z.literal('insufficient_evidence'),
      reason: runtimeCurrentFitReasonSchema.exclude(['observed_current_residency']),
    })
    .strict(),
])
export type RuntimeCurrentFit = z.infer<typeof runtimeCurrentFitSchema>

export const runtimeResourceOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job'), jobId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('operation'), operationId: z.string().min(1) }).strict(),
])
export type RuntimeResourceOwner = z.infer<typeof runtimeResourceOwnerSchema>

export const runtimeResourceModelSchema = z
  .object({
    provider: z.literal('ollama'),
    name: z.string().min(1),
  })
  .strict()
export type RuntimeResourceModel = z.infer<typeof runtimeResourceModelSchema>

export const runtimeResourceOperationSchema = z.enum([
  'chat',
  'compaction',
  'model_warm',
  'model_prewarm',
])
export type RuntimeResourceOperation = z.infer<typeof runtimeResourceOperationSchema>

export const runtimeAdmissionPrioritySchema = z.enum(['normal', 'prewarm'])
export type RuntimeAdmissionPriority = z.infer<typeof runtimeAdmissionPrioritySchema>

export const runtimeAdmissionPolicyBasisSchema = z.enum([
  'conservative_single_process_single_accelerator_permit_fifo',
  'conservative_single_process_single_accelerator_permit_normal_before_prewarm_fifo',
])

export const runtimeAdmissionDecisionCodeSchema = z.enum([
  'queued_fifo',
  'admitted_single_permit',
  'cancelled_waiting',
  'released',
  'admission_closed',
  'unload_active_model',
  'unload_conservative_active_owner',
  'prewarm_skipped_normal_work',
  'prewarm_preempted_by_normal',
  'unknown_ticket',
])
export type RuntimeAdmissionDecisionCode = z.infer<
  typeof runtimeAdmissionDecisionCodeSchema
>

export const runtimeAdmissionExplanationSchema = z
  .object({
    ticketId: z.string().nullable(),
    decisionCode: runtimeAdmissionDecisionCodeSchema,
    observedAt: z.string().datetime(),
    policyBasis: runtimeAdmissionPolicyBasisSchema,
    owner: runtimeResourceOwnerSchema.nullable(),
    operation: runtimeResourceOperationSchema.nullable(),
    model: runtimeResourceModelSchema.nullable(),
    requestedContext: z.number().int().positive().nullable(),
    priority: runtimeAdmissionPrioritySchema.nullable().optional().default(null),
    queuePosition: z.number().int().positive().nullable(),
  })
  .strict()

export const runtimeGovernorSnapshotSchema = z
  .object({
    observedAt: z.string().datetime(),
    accepting: z.boolean(),
    policy: z
      .object({
        acceleratorPermits: z.literal(1),
        order: z.enum(['fifo', 'priority_fifo']),
        priorities: z.union([
          z.tuple([z.literal('normal')]),
          z.tuple([z.literal('normal'), z.literal('prewarm')]),
        ]),
        scope: z.literal('application_process'),
        basis: runtimeAdmissionPolicyBasisSchema,
      })
      .strict(),
    queued: z.array(
      z
        .object({
          ticketId: z.string().min(1),
          owner: runtimeResourceOwnerSchema,
          operation: runtimeResourceOperationSchema,
          model: runtimeResourceModelSchema,
          requestedContext: z.number().int().positive(),
          priority: runtimeAdmissionPrioritySchema,
          enqueuedAt: z.string().datetime(),
          reason: z.enum(['single_permit_busy', 'fifo_predecessor']),
        })
        .strict(),
    ),
    activeLease: z
      .object({
        leaseId: z.string().min(1),
        ticketId: z.string().min(1),
        owner: runtimeResourceOwnerSchema,
        operation: runtimeResourceOperationSchema,
        model: runtimeResourceModelSchema,
        requestedContext: z.number().int().positive(),
        priority: runtimeAdmissionPrioritySchema.optional().default('normal'),
        acquiredAt: z.string().datetime(),
        state: z.literal('active'),
      })
      .strict()
      .nullable(),
    lastDecision: runtimeAdmissionExplanationSchema.nullable(),
  })
  .strict()
export type RuntimeGovernorSnapshot = z.infer<typeof runtimeGovernorSnapshotSchema>

export const runtimeOwnerStateSchema = z.enum(['active_lease', 'unknown'])
export type RuntimeOwnerState = z.infer<typeof runtimeOwnerStateSchema>

export const runtimeReconciliationDecisionCodeSchema = z.enum([
  'matched_active_lease',
  'active_not_observed',
  'observed_unknown_owner',
  'empty_sample',
  'source_failure',
])
export type RuntimeReconciliationDecisionCode = z.infer<
  typeof runtimeReconciliationDecisionCodeSchema
>

export const runtimeModelObservationSchema = runningModelSchema
  .extend({
    source: z.literal('ollama_api_ps'),
    observedAt: z.string().datetime(),
    normalizedName: z.string().min(1),
    ownerState: runtimeOwnerStateSchema,
    leaseId: z.string().nullable(),
    owner: runtimeResourceOwnerSchema.nullable(),
    decisionCode: z.enum(['matched_active_lease', 'observed_unknown_owner']),
    identityBasis: z.enum([
      'exact_normalized_model_reference',
      'runtime_observation_only',
    ]),
    /** A lease has no digest, so `/api/ps` cannot prove artifact identity. */
    artifactIdentity: z.literal('unknown'),
    currentFit: runtimeCurrentFitSchema,
  })
  .strict()
export type RuntimeModelObservation = z.infer<typeof runtimeModelObservationSchema>

export const runtimeReconciliationDecisionSchema = z
  .object({
    code: runtimeReconciliationDecisionCodeSchema,
    modelName: z.string().nullable(),
    normalizedModelName: z.string().nullable(),
    leaseId: z.string().nullable(),
    owner: runtimeResourceOwnerSchema.nullable(),
    runtimeDigest: z.string().nullable(),
    requestedContext: z.number().int().positive().nullable(),
    observedContext: z.number().int().nonnegative().nullable(),
    identityBasis: z.enum([
      'exact_normalized_model_reference',
      'runtime_observation_only',
      'none',
    ]),
    artifactIdentity: z.literal('unknown'),
  })
  .strict()
export type RuntimeReconciliationDecision = z.infer<
  typeof runtimeReconciliationDecisionSchema
>

export const runtimeSnapshotSchema = z
  .object({
    observedAt: z.string().datetime(),
    source: runtimeSourceHealthSchema,
    host: runtimeHostTelemetrySchema,
    governor: runtimeGovernorSnapshotSchema,
    /** `null` means the source failed; `[]` is a successful empty observation. */
    models: z.array(runtimeModelObservationSchema).nullable(),
    decisions: z.array(runtimeReconciliationDecisionSchema).min(1),
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.observedAt !== snapshot.source.observedAt ||
      snapshot.observedAt !== snapshot.host.observedAt ||
      snapshot.observedAt !== snapshot.governor.observedAt ||
      snapshot.models?.some(
        (model) =>
          model.observedAt !== snapshot.observedAt ||
          model.currentFit.observedAt !== snapshot.observedAt,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'runtime snapshot observations must share one observedAt',
      })
    }
    if ((snapshot.source.state === 'available') !== (snapshot.models !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models'],
        message: 'runtime models must be present exactly for an available source',
      })
    }
  })
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>

export const catalogSourceStateSchema = z.enum([
  'fresh_remote',
  'stale_cache',
  'bundled_fallback',
  'unavailable',
  'unknown',
])
export type CatalogSourceState = z.infer<typeof catalogSourceStateSchema>

const catalogSourceObservationSchema = z.object({
  observedAt: z.string(),
})

export const catalogSourceHealthSchema = z.discriminatedUnion('state', [
  catalogSourceObservationSchema.extend({
    state: z.literal('fresh_remote'),
    source: z.literal('documented_remote'),
    fetchedAt: z.string(),
  }),
  catalogSourceObservationSchema.extend({
    state: z.literal('stale_cache'),
    source: z.literal('ollama_recommendations_cache'),
    fetchedAt: z.string(),
  }),
  catalogSourceObservationSchema.extend({
    state: z.literal('bundled_fallback'),
    source: z.literal('bundled_snapshot'),
    fetchedAt: z.string(),
  }),
  catalogSourceObservationSchema.extend({
    state: z.literal('unavailable'),
    source: z.literal('none'),
    fetchedAt: z.null(),
  }),
  catalogSourceObservationSchema.extend({
    state: z.literal('unknown'),
    source: z.literal('none'),
    fetchedAt: z.null(),
  }),
])
export type CatalogSourceHealth = z.infer<typeof catalogSourceHealthSchema>

export const modelDetailSchema = localModelSchema.extend({
  /** Сырой блок из /api/show — архитектурные параметры. */
  modelInfo: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  template: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  license: z.string().nullable(),
  /** Вердикт при разных размерах окна — для слайдера в профиле модели. */
  fitByContext: z.array(fitVerdictSchema),
})
export type ModelDetail = z.infer<typeof modelDetailSchema>

/* ─────────────────────────── Треды и сообщения ───────────────────────────── */

export const threadModeSchema = z.enum(['chat', 'agent'])
export type ThreadMode = z.infer<typeof threadModeSchema>

export const threadOptionsSchema = z.object({
  numCtx: z.number().int().min(512).max(1_048_576),
  temperature: z.number().min(0).max(2),
  /** Режим размышления для моделей, которые его поддерживают. */
  think: z.enum(['off', 'low', 'medium', 'high']),
})
export type ThreadOptions = z.infer<typeof threadOptionsSchema>

export const threadSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: threadModeSchema,
  model: z.string(),
  workspaceId: z.string().nullable(),
  options: threadOptionsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int(),
})
export type Thread = z.infer<typeof threadSchema>

export const toolCallStatusSchema = z.enum([
  'pending_approval',
  'running',
  'ok',
  'error',
  'denied',
  'cancelled',
])
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>

export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
  status: toolCallStatusSchema,
  /** Текстовый результат, который ушёл обратно в модель. */
  result: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  source: z.enum(['builtin', 'mcp']),
  /**
   * Как распознали вызов. 'content_json' означает, что модель не отдала
   * структурный tool_calls и мы вытащили JSON из текста — это норма для 7B.
   */
  parsedFrom: z.enum(['native', 'content_json']),
  /** Для write/edit — предпросмотр диффа, чтобы подтверждать осознанно. */
  diff: z
    .object({
      path: z.string(),
      before: z.string(),
      after: z.string(),
    })
    .nullable(),
})
export type ToolCall = z.infer<typeof toolCallSchema>

/** Метрики хода. Из них же считается индикатор кэша. */
export const usageSchema = z.object({
  promptTokens: z.number().int(),
  evalTokens: z.number().int(),
  promptEvalDurationMs: z.number().int(),
  evalDurationMs: z.number().int(),
  loadDurationMs: z.number().int(),
  totalDurationMs: z.number().int(),
  tokensPerSecond: z.number(),
  /** true — префикс переиспользован из KV-кэша (prefill был аномально быстрым). */
  cacheHit: z.boolean(),
  /** Оценка числа токенов, не пересчитанных заново. */
  cachedTokens: z.number().int(),
})
export type Usage = z.infer<typeof usageSchema>

/**
 * Additive Message projection introduced as the Phase 0 compatibility bridge
 * and associated with a durable Job since P1-D.
 *
 * `null` on a Message means that the row predates the bridge (or is not an
 * assistant turn at all). It must not be interpreted as completed.
 */
export const turnStatusSchema = z.enum(['pending', 'completed', 'failed', 'cancelled'])
export type TurnStatus = z.infer<typeof turnStatusSchema>

export const turnTerminalOutcomeSchema = z.enum(['completed', 'failed', 'cancelled'])
export type TurnTerminalOutcome = z.infer<typeof turnTerminalOutcomeSchema>

export const turnStopReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'tool_limit',
  'stopped_by_user',
  'connection_aborted',
  'provider_error',
  'protocol_error',
  'storage_error',
  'internal_error',
  'legacy_terminal_chunk',
  // Kept for compatible reading of the original SSE contract.
  'error',
])
export type TurnStopReason = z.infer<typeof turnStopReasonSchema>

export const turnErrorCodeSchema = z.enum([
  'ollama_unavailable',
  'ollama_connect_timeout',
  'ollama_load_timeout',
  'ollama_stream_idle_timeout',
  'upstream_error',
  'runtime_protocol',
  'storage_error',
  'internal_error',
])
export type TurnErrorCode = z.infer<typeof turnErrorCodeSchema>

export const turnErrorSchema = z.object({
  code: turnErrorCodeSchema,
  /** Safe user-facing summary; raw provider bodies and private content are excluded. */
  message: z.string(),
})
export type TurnError = z.infer<typeof turnErrorSchema>

export const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  /** Durable execution association. Legacy/pre-v5 rows remain null. */
  jobId: z.string().uuid().nullish().default(null),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  thinking: z.string().nullable(),
  toolCalls: z.array(toolCallSchema),
  usage: usageSchema.nullable(),
  createdAt: z.string(),
  /** Сообщение — результат компакции, свернувшей N предыдущих. */
  isCompaction: z.boolean(),
  /**
   * Additive fields accept an omitted legacy shape. The parsed projection uses
   * null so current clients always distinguish unknown legacy state from success.
   */
  turnStatus: turnStatusSchema.nullish().default(null),
  turnError: turnErrorSchema.nullish().default(null),
  stopReason: turnStopReasonSchema.nullish().default(null),
})
export type Message = z.infer<typeof messageSchema>

/* ───────────────────────────── Durable Jobs ─────────────────────────────── */

/**
 * Accepted lifecycle states from ADR-0004 and the canonical runtime diagram.
 * These are Job states, not provider-specific streaming phases.
 */
export const jobStateSchema = z.enum([
  'queued',
  'reserving',
  'loading',
  'prefill',
  'thinking',
  'generating',
  'waiting_tool',
  'waiting_approval',
  'finalizing',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type JobState = z.infer<typeof jobStateSchema>

export const jobTerminalStateSchema = z.enum(['completed', 'failed', 'cancelled', 'interrupted'])
export type JobTerminalState = z.infer<typeof jobTerminalStateSchema>

export const jobKindSchema = z.enum(['inference', 'agent', 'tool', 'pipeline'])
export type JobKind = z.infer<typeof jobKindSchema>

export const jobErrorCategorySchema = z.enum([
  'validation',
  'admission',
  'resource',
  'runtime_unavailable',
  'runtime_protocol',
  'cancelled',
  'tool_denied',
  'tool_failed',
  'storage',
  'internal',
])
export type JobErrorCategory = z.infer<typeof jobErrorCategorySchema>

/** Safe summary only: raw provider bodies, prompts, reasoning and file content are excluded. */
export const jobErrorSchema = z.object({
  category: jobErrorCategorySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
})
export type JobError = z.infer<typeof jobErrorSchema>

/**
 * Metadata is deliberately flat and JSON-scalar-only. Callers may persist IDs,
 * counts, codes and measurements here, never private input or generated content.
 */
export const safeJobMetadataValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export const safeJobMetadataSchema = z.record(safeJobMetadataValueSchema)
export type SafeJobMetadata = z.infer<typeof safeJobMetadataSchema>

export const jobOutcomeSchema = z.object({
  code: z.string().min(1),
  metadata: safeJobMetadataSchema,
})
export type JobOutcome = z.infer<typeof jobOutcomeSchema>

export const jobSchema = z
  .object({
    id: z.string().min(1),
    kind: jobKindSchema,
    operation: z.string().min(1),
    status: jobStateSchema,
    /** Provider/adapter detail inside a stable state; null until a Job Engine sets it. */
    phase: z.string().min(1).nullable(),
    idempotencyScope: z.string().min(1),
    idempotencyKey: z.string().min(1),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    error: jobErrorSchema.nullable(),
    outcome: jobOutcomeSchema.nullable(),
    stopReason: z.string().min(1).nullable(),
    /** Sequence of the last event committed in the same SQLite store. */
    lastEventSequence: z.number().int().positive(),
  })
  .superRefine((job, context) => {
    const terminal = jobTerminalStateSchema.safeParse(job.status).success
    if (terminal !== (job.finishedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'finishedAt must be present exactly for terminal Jobs',
      })
    }
    if (!terminal && (job.error !== null || job.outcome !== null || job.stopReason !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'non-terminal Jobs must not contain terminal metadata',
      })
    }
    if (job.status === 'completed' && job.error !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'completed Jobs must not contain an error',
      })
    }
    if (job.status === 'failed' && job.error === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'failed Jobs require a safe structured error',
      })
    }
  })
export type Job = z.infer<typeof jobSchema>

export const jobEventTypeSchema = z.enum([
  'lifecycle',
  'output',
  'tool',
  'resource',
  'usage',
  'warning',
  'error',
  'checkpoint',
])
export type JobEventType = z.infer<typeof jobEventTypeSchema>

/** Persisted replay envelope. Sequence is monotonic and unique inside one Job. */
export const jobEventSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: jobEventTypeSchema,
  /** Canonical Job state observed atomically with this event. */
  state: jobStateSchema,
  phase: z.string().min(1).nullable(),
  metadata: safeJobMetadataSchema,
  createdAt: z.string().datetime(),
})
export type JobEvent = z.infer<typeof jobEventSchema>

/** Состояние окна контекста — питает шкалу в UI. */
export const contextStateSchema = z.object({
  usedTokens: z.number().int(),
  allocatedTokens: z.number().int(),
  percent: z.number(),
  cacheHit: z.boolean(),
  cachedTokens: z.number().int(),
  /** Есть ли что сворачивать. */
  compactable: z.boolean(),
  /** Честная цена компакции: следующий ход подорожает примерно на столько. */
  estimatedRepefillMs: z.number().int(),
})
export type ContextState = z.infer<typeof contextStateSchema>

/* ──────────────────────────────── Воркспейсы ─────────────────────────────── */

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** Существует ли директория прямо сейчас. */
  exists: z.boolean(),
})
export type Workspace = z.infer<typeof workspaceSchema>

/* ──────────────────────────────── Настройки ──────────────────────────────── */

export const webSearchProviderSchema = z.enum(['none', 'ollama', 'searxng', 'brave', 'tavily'])
export type WebSearchProvider = z.infer<typeof webSearchProviderSchema>

export const settingsSchema = z.object({
  ollamaHost: z.string(),
  defaultModel: z.string().nullable(),
  defaultNumCtx: z.number().int(),
  /** Выполнять инструменты без подтверждения. По умолчанию выключено. */
  autoApproveTools: z.boolean(),
  /** Инструмент bash. Выключен по умолчанию и всегда выключен в удалённом режиме. */
  enableBash: z.boolean(),
  /** Auto prewarm on a stable New Chat model selection. Missing legacy keys default on. */
  prewarmEnabled: z.boolean().optional().default(true),
  webSearch: z.object({
    provider: webSearchProviderSchema,
    baseUrl: z.string().nullable(),
    /** Наружу не отдаётся — только признак наличия. */
    hasApiKey: z.boolean(),
  }),
  theme: z.enum(['light', 'dark', 'system']),
})
export type Settings = z.infer<typeof settingsSchema>

/* ─────────────────────────────── Состояние сервиса ───────────────────────── */

export const ollamaStatusSchema = z.object({
  installed: z.boolean(),
  installSource: z
    .enum(['runtime_response', 'local_binary_path'])
    .nullable()
    .optional()
    .default(null),
  running: z.boolean(),
  /** Current server responses always provide this; omission is a legacy response. */
  state: z.enum(['reachable', 'unavailable', 'incompatible']).optional(),
  source: z.literal('ollama_api_version').nullable().optional().default(null),
  observedAt: z.string().nullable().optional().default(null),
  version: z.string().nullable(),
  host: z.string(),
  /** Инструкция по установке под текущую ОС, если не установлено. */
  installHint: z
    .object({
      command: z.string(),
      docsUrl: z.string(),
    })
    .nullable(),
})
export type OllamaStatus = z.infer<typeof ollamaStatusSchema>

export const healthSchema = z.object({
  ok: z.boolean(),
  appVersion: z.string(),
  application: z
    .object({
      state: z.literal('reachable'),
      source: z.literal('application_http'),
      observedAt: z.string(),
    })
    .optional(),
  ollama: ollamaStatusSchema,
  hardware: hardwareInfoSchema,
  /**
   * Legacy network slot. P0-D no longer probes the undocumented catalog URL, so
   * current responses explicitly report an unknown/not-checked observation.
   */
  network: z.object({
    ollamaComReachable: z.boolean().nullable(),
    checkedAt: z.string().nullable(),
    status: z.literal('unknown').optional(),
    source: z.literal('not_checked').optional(),
  }),
})
export type Health = z.infer<typeof healthSchema>

/* ─────────────────────────────── Ошибки ──────────────────────────────────── */

export const apiErrorSchema = z.object({
  code: z.enum([
    'ollama_unavailable',
    'model_not_found',
    'job_not_found',
    'job_conflict',
    'storage_error',
    'thread_not_found',
    'workspace_not_found',
    'path_outside_workspace',
    'tool_disabled',
    'validation_failed',
    'ollama_connect_timeout',
    'ollama_load_timeout',
    'ollama_stream_idle_timeout',
    'runtime_protocol',
    'upstream_error',
    'internal_error',
  ]),
  message: z.string(),
  details: z.record(z.unknown()).nullable(),
})
export type ApiError = z.infer<typeof apiErrorSchema>
