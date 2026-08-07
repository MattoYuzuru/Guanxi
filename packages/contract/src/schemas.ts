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

/** JSON/SQLite transport boundary for user-selected counts without a product ceiling. */
export const positiveSafeIntegerSchema = z.number().int().positive().safe()

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
  contextLength: positiveSafeIntegerSchema,
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

export const modelContextLimitSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('declared'),
      value: positiveSafeIntegerSchema,
      source: z.enum(['ollama_api_tags', 'ollama_api_show']),
      observedAt: z.string().datetime(),
      confidence: z.literal('declared'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      value: z.null(),
      source: z.enum(['not_reported', 'conflicting_provider_declarations']),
      observedAt: z.string().datetime(),
      confidence: z.literal('unknown'),
    })
    .strict(),
])
export type ModelContextLimit = z.infer<typeof modelContextLimitSchema>

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

export const modelReferenceSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('canonical'),
      provider: z.literal('ollama'),
      original: z.string().min(1),
      normalized: z.string().min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      provider: z.literal('ollama'),
      original: z.string().nullable(),
      normalized: z.null(),
      reason: z.enum(['legacy_response', 'invalid_reference']),
    })
    .strict(),
])
export type ModelReference = z.infer<typeof modelReferenceSchema>

export const modelArtifactIdentitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('exact_digest'), digest: z.string().min(1) }).strict(),
  z
    .object({
      state: z.literal('unknown'),
      digest: z.null(),
      reason: z.enum([
        'legacy_response',
        'digest_not_reported',
        'digest_malformed',
        'detail_not_bound_to_digest',
      ]),
    })
    .strict(),
])
export type ModelArtifactIdentity = z.infer<typeof modelArtifactIdentitySchema>

export const modelRuntimeFingerprintSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('sourced'),
      runtime: z.literal('ollama'),
      version: z.string().min(1),
      source: z.literal('ollama_api_version'),
      observedAt: z.string().datetime(),
      confidence: z.literal('observed'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      runtime: z.literal('ollama'),
      version: z.null(),
      source: z.enum(['legacy_response', 'runtime_unavailable']),
      observedAt: z.string().datetime(),
      confidence: z.literal('unknown'),
    })
    .strict(),
])
export type ModelRuntimeFingerprint = z.infer<typeof modelRuntimeFingerprintSchema>

export const modelEvidenceBasisSchema = z
  .object({
    reference: modelReferenceSchema,
    artifact: modelArtifactIdentitySchema,
    runtime: modelRuntimeFingerprintSchema,
  })
  .strict()
export type ModelEvidenceBasis = z.infer<typeof modelEvidenceBasisSchema>

export const modelCapabilityDeclarationSchema = z
  .object({
    capabilities: z.array(modelCapabilitySchema),
    source: z.enum(['ollama_api_tags', 'ollama_api_show']),
    observedAt: z.string().datetime(),
    confidence: z.literal('declared'),
    basis: modelEvidenceBasisSchema,
  })
  .strict()
export type ModelCapabilityDeclaration = z.infer<typeof modelCapabilityDeclarationSchema>

const modelCapabilityEvidenceBaseSchema = z.object({
  observedAt: z.string().datetime(),
  declarations: z.array(modelCapabilityDeclarationSchema),
})

export const modelCapabilityEvidenceSchema = z.discriminatedUnion('state', [
  modelCapabilityEvidenceBaseSchema
    .extend({ state: z.literal('declared'), reason: z.null() })
    .strict(),
  modelCapabilityEvidenceBaseSchema
    .extend({
      state: z.literal('degraded'),
      reason: z.enum([
        'artifact_identity_ambiguous',
        'artifact_identity_changed',
        'conflicting_provider_declarations',
        'provider_field_missing',
        'provider_malformed',
        'provider_unavailable',
      ]),
    })
    .strict(),
  modelCapabilityEvidenceBaseSchema
    .extend({
      state: z.literal('unknown'),
      reason: z.enum([
        'artifact_identity_ambiguous',
        'artifact_identity_changed',
        'legacy_response',
        'field_not_reported',
        'provider_malformed',
        'provider_unavailable',
      ]),
    })
    .strict(),
])
export type ModelCapabilityEvidence = z.infer<typeof modelCapabilityEvidenceSchema>

export const modelEvidenceFreshnessSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('fresh'),
      source: z.enum(['provider', 'process_cache', 'persistent_cache']),
      observedAt: z.string().datetime(),
      validatedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      offline: z.literal(false),
    })
    .strict(),
  z
    .object({
      state: z.literal('stale'),
      source: z.literal('persistent_cache'),
      observedAt: z.string().datetime(),
      validatedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      staleUntil: z.string().datetime(),
      offline: z.literal(true),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      source: z.enum(['provider', 'none']),
      observedAt: z.string().datetime().nullable(),
      reason: z.enum([
        'legacy_response',
        'identity_unavailable',
        'identity_changed',
        'provider_unavailable',
        'provider_malformed',
        'conflicting_provider_data',
        'cache_expired',
      ]),
      offline: z.boolean(),
    })
    .strict(),
])
export type ModelEvidenceFreshness = z.infer<typeof modelEvidenceFreshnessSchema>

export const modelInstallationEvidenceSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('installed'),
      source: z.literal('ollama_api_tags'),
      observedAt: z.string().datetime(),
      confidence: z.literal('observed'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      source: z.literal('legacy_response'),
      observedAt: z.string().datetime(),
      confidence: z.literal('unknown'),
    })
    .strict(),
])
export type ModelInstallationEvidence = z.infer<typeof modelInstallationEvidenceSchema>

/**
 * P2-I explicit positive user assertion for one exact installed artifact.
 *
 * It is never a provider declaration, a controlled probe or a runtime proof, and
 * the absence of a row never means `unsupported`. There is no negative override,
 * no confidence slider and no free-form capability in this version: the value is
 * always the single positive `present`, so a missing row leaves the capability in
 * its prior declared/degraded/unknown state.
 */
export const MODEL_CAPABILITY_OVERRIDE_VERSION = 1
export const modelCapabilityOverrideSchema = z
  .object({
    version: z.literal(MODEL_CAPABILITY_OVERRIDE_VERSION),
    source: z.literal('user_override'),
    state: z.literal('overridden'),
    value: z.literal('present'),
    capability: modelCapabilitySchema,
    provider: z.literal('ollama'),
    normalizedModelReference: z.string().min(1),
    artifactDigest: z.string().min(1),
    runtimeVersion: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type ModelCapabilityOverride = z.infer<typeof modelCapabilityOverrideSchema>

export const installedModelDescriptorSchema = z
  .object({
    reference: modelReferenceSchema,
    artifact: modelArtifactIdentitySchema,
    installation: modelInstallationEvidenceSchema,
    capabilities: modelCapabilityEvidenceSchema,
    freshness: modelEvidenceFreshnessSchema.optional().default({
      state: 'unknown',
      source: 'none',
      observedAt: null,
      reason: 'legacy_response',
      offline: false,
    }),
    /**
     * Sourced local runtime version for this observation. It is part of the exact
     * identity a user assertion binds to, so it is projected independently of
     * whether the provider declared any capability at all.
     */
    runtime: modelRuntimeFingerprintSchema.optional().default({
      state: 'unknown',
      runtime: 'ollama',
      version: null,
      source: 'legacy_response',
      observedAt: '1970-01-01T00:00:00.000Z',
      confidence: 'unknown',
    }),
    /**
     * Additive user assertions for this exact identity only. Optional so recorded
     * legacy descriptor responses stay parseable without a fabricated override.
     */
    overrides: z.array(modelCapabilityOverrideSchema).optional().default([]),
  })
  .strict()
export type InstalledModelDescriptor = z.infer<typeof installedModelDescriptorSchema>

export const completionProbeIdentitySchema = z
  .object({
    state: z.literal('exact'),
    keyVersion: z.literal(1),
    probeDefinitionVersion: z.literal(1),
    provider: z.literal('ollama'),
    normalizedModelReference: z.string().min(1),
    artifactDigest: z.string().min(1),
    runtimeVersion: z.string().min(1),
    contextLength: positiveSafeIntegerSchema,
    id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict()
export type CompletionProbeIdentity = z.infer<typeof completionProbeIdentitySchema>

export const completionProbeBasisSchema = z.discriminatedUnion('state', [
  completionProbeIdentitySchema,
  z
    .object({
      state: z.literal('unavailable'),
      keyVersion: z.literal(1),
      probeDefinitionVersion: z.literal(1),
      reason: z.enum([
        'invalid_model_reference',
        'installed_reference_ambiguous',
        'installed_digest_missing',
        'runtime_version_unavailable',
      ]),
    })
    .strict(),
])
export type CompletionProbeBasis = z.infer<typeof completionProbeBasisSchema>

const completionProbeEvidenceBaseSchema = z
  .object({
    capability: z.literal('completion'),
    source: z.literal('runtime_probe'),
    observedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    basis: completionProbeBasisSchema,
    historical: z.boolean(),
  })
  .strict()

export const completionProbeEvidenceSchema = z.discriminatedUnion('status', [
  completionProbeEvidenceBaseSchema.extend({
    status: z.literal('verified'),
    confidence: z.literal('verified'),
    reason: z.literal('terminal_response'),
  }),
  completionProbeEvidenceBaseSchema.extend({
    status: z.literal('degraded'),
    confidence: z.literal('degraded'),
    reason: z.enum([
      'provider_unavailable',
      'connect_timeout',
      'load_timeout',
      'response_timeout',
      'provider_error',
      'runtime_protocol',
      'empty_response',
      'identity_changed',
      'persistence_failed',
    ]),
  }),
  completionProbeEvidenceBaseSchema.extend({
    status: z.literal('unknown'),
    confidence: z.literal('unknown'),
    reason: z.enum(['identity_unavailable', 'context_limit_unknown']),
  }),
  completionProbeEvidenceBaseSchema.extend({
    status: z.literal('cancelled'),
    confidence: z.literal('unknown'),
    reason: z.enum(['request_cancelled', 'request_timeout']),
  }),
  completionProbeEvidenceBaseSchema.extend({
    status: z.literal('skipped'),
    confidence: z.literal('unknown'),
    reason: z.enum([
      'model_not_installed',
      'cloud_model',
      'fit_red',
      'fit_unknown',
      'context_limit_exceeded',
      'identity_unavailable',
      'probe_in_progress',
    ]),
  }),
])
export type CompletionProbeEvidence = z.infer<typeof completionProbeEvidenceSchema>

export const legacyInstalledModelDescriptor: InstalledModelDescriptor = {
  reference: {
    state: 'unknown',
    provider: 'ollama',
    original: null,
    normalized: null,
    reason: 'legacy_response',
  },
  artifact: { state: 'unknown', digest: null, reason: 'legacy_response' },
  installation: {
    state: 'unknown',
    source: 'legacy_response',
    observedAt: '1970-01-01T00:00:00.000Z',
    confidence: 'unknown',
  },
  capabilities: {
    state: 'unknown',
    reason: 'legacy_response',
    observedAt: '1970-01-01T00:00:00.000Z',
    declarations: [],
  },
  freshness: {
    state: 'unknown',
    source: 'none',
    observedAt: null,
    reason: 'legacy_response',
    offline: false,
  },
  runtime: {
    state: 'unknown',
    runtime: 'ollama',
    version: null,
    source: 'legacy_response',
    observedAt: '1970-01-01T00:00:00.000Z',
    confidence: 'unknown',
  },
  overrides: [],
}

export const localModelSchema = z.object({
  name: z.string(),
  digest: z.string(),
  sizeBytes: z.number().int(),
  modifiedAt: z.string(), // ISO
  family: z.string(),
  parameterSize: z.string(), // "7.6B"
  quantization: z.string(), // "Q4_K_M"
  /** Legacy compatibility projection; capability decisions use `contextLimit`. */
  contextLength: positiveSafeIntegerSchema,
  /** Authoritative additive evidence; `contextLength` remains a legacy compatibility field. */
  contextLimit: modelContextLimitSchema.optional().default({
    state: 'unknown',
    value: null,
    source: 'not_reported',
    observedAt: '1970-01-01T00:00:00.000Z',
    confidence: 'unknown',
  }),
  capabilities: z.array(modelCapabilitySchema),
  /** Additive installed identity and source-preserving capability declarations. */
  descriptor: installedModelDescriptorSchema.optional().default(legacyInstalledModelDescriptor),
  /** true — модель считается в облаке Ollama, локальная память не тратится. */
  isCloud: z.boolean(),
  fit: fitVerdictSchema,
})
export type LocalModel = z.infer<typeof localModelSchema>

export const catalogVariantFitSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('calculated'),
      source: z.literal('catalog_claim'),
      contextLength: positiveSafeIntegerSchema,
      verdict: fitVerdictSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      source: z.enum(['catalog_claim', 'legacy_response']),
      contextLength: positiveSafeIntegerSchema.nullable(),
      verdict: z.null(),
      reason: z.enum(['size_unknown', 'invalid_variant', 'legacy_response']),
    })
    .strict(),
])
export type CatalogVariantFit = z.infer<typeof catalogVariantFitSchema>

export const catalogVariantInstallationSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('installed'),
      digest: z.string().min(1),
      source: z.literal('ollama_api_tags'),
      observedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      state: z.literal('not_installed'),
      digest: z.null(),
      source: z.literal('ollama_api_tags'),
      observedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      digest: z.null(),
      source: z.enum(['unavailable', 'legacy_response']),
      observedAt: z.null(),
      reason: z.enum([
        'provider_unavailable',
        'ambiguous_installed_reference',
        'installed_digest_missing',
        'legacy_response',
      ]),
    })
    .strict(),
])
export type CatalogVariantInstallation = z.infer<
  typeof catalogVariantInstallationSchema
>

const legacyCatalogVariantFit = {
  state: 'unknown' as const,
  source: 'legacy_response' as const,
  contextLength: null,
  verdict: null,
  reason: 'legacy_response' as const,
}

const legacyCatalogVariantInstallation = {
  state: 'unknown' as const,
  digest: null,
  source: 'legacy_response' as const,
  observedAt: null,
  reason: 'legacy_response' as const,
}

export const catalogVariantSchema = z.object({
  tag: z.string(),
  sizeBytes: z.number().int().nullable(),
  parameterSize: z.string().nullable(),
  /** Exact pull target produced by the shared server normalizer. */
  normalizedName: z.string().nullable().optional().default(null),
  /** Catalog claim copied to the variant; it is not a runtime maximum. */
  contextLength: positiveSafeIntegerSchema.nullable().optional().default(null),
  fit: catalogVariantFitSchema.optional().default(legacyCatalogVariantFit),
  installation: catalogVariantInstallationSchema
    .optional()
    .default(legacyCatalogVariantInstallation),
  source: z
    .enum(['remote', 'local_cache', 'bundled'])
    .nullable()
    .optional()
    .default(null),
  freshness: z
    .enum(['fresh', 'stale', 'fallback', 'unknown'])
    .optional()
    .default('unknown'),
  sourceObservedAt: z.string().nullable().optional().default(null),
  sourceFetchedAt: z.string().nullable().optional().default(null),
})
export type CatalogVariant = z.infer<typeof catalogVariantSchema>

export const catalogModelSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Доступные теги-размеры: 7b, 14b, 27b-q4 и т.п. */
  variants: z.array(catalogVariantSchema),
  contextLength: z.number().int().nullable(),
  capabilities: z.array(modelCapabilitySchema),
  /** Подсказка вендора по требуемой видеопамяти, если есть. */
  vramBytes: z.number().int().nullable(),
  isCloud: z.boolean(),
  requiredPlan: z.enum(['free', 'pro']).nullable(),
  installed: z.boolean(),
  fit: fitVerdictSchema,
  /** `installed` is retained only as an any-variant compatibility aggregate. */
  installedProjection: z
    .enum(['variant_aggregate_compatibility', 'legacy_family_compatibility'])
    .optional()
    .default('legacy_family_compatibility'),
  /** `fit` is retained only for clients that predate per-variant fit evidence. */
  fitProjection: z
    .enum(['largest_variant_compatibility', 'legacy_model_compatibility'])
    .optional()
    .default('legacy_model_compatibility'),
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
  'nvidia_smi_memory_total',
  'nvidia_smi_memory_free',
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
  'device_total_vram',
  'device_free_vram_not_safe_capacity',
])
export type RuntimeMemoryFactBasis = z.infer<typeof runtimeMemoryFactBasisSchema>

export const runtimeMemoryFactSchema = z
  .object({
    bytes: z.number().int().nonnegative().safe().nullable(),
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
  'total_system_memory_bytes',
  'legacy_usable_memory_estimate_bytes',
  'free_memory_bytes',
  'available_memory_bytes',
  'memory_pressure',
  'discrete_vram_bytes',
  'gpu_free_memory_bytes',
  'nvidia_devices',
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
    source: z.enum(['apple_vm_stat', 'nvidia_smi', 'none']),
    observedAt: z.string().datetime(),
    freeMemoryBytes: runtimeMemoryFactSchema,
    availableMemoryBytes: runtimeMemoryFactSchema,
    pressure: runtimeHostPressureFactSchema,
    gpuFreeMemoryBytes: runtimeMemoryFactSchema,
  })
  .strict()
export type RuntimeHostSample = z.infer<typeof runtimeHostSampleSchema>

export const runtimeNvidiaDeviceSchema = z
  .object({
    providerIndex: z.number().int().nonnegative().safe(),
    uuid: z.string().regex(/^GPU-[0-9A-Za-z-]+$/u).nullable(),
    displayName: z
      .string()
      .min(1)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
        message: 'NVIDIA display name cannot contain control characters',
      }),
    source: z.literal('nvidia_smi_query_gpu'),
    observedAt: z.string().datetime(),
    confidence: z.literal('observed'),
    totalVramBytes: runtimeMemoryFactSchema,
    freeVramBytes: runtimeMemoryFactSchema,
  })
  .strict()
  .superRefine((device, context) => {
    if (
      device.totalVramBytes.observedAt !== device.observedAt ||
      device.freeVramBytes.observedAt !== device.observedAt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'NVIDIA device facts must share the device observedAt',
      })
    }
    if (
      device.totalVramBytes.bytes !== null &&
      device.freeVramBytes.bytes !== null &&
      device.freeVramBytes.bytes > device.totalVramBytes.bytes
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeVramBytes', 'bytes'],
        message: 'NVIDIA free VRAM cannot exceed total VRAM',
      })
    }
    if (
      device.totalVramBytes.bytes === null ||
      device.totalVramBytes.source !== 'nvidia_smi_memory_total' ||
      device.totalVramBytes.confidence !== 'observed' ||
      device.totalVramBytes.basis !== 'device_total_vram'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalVramBytes'],
        message: 'NVIDIA total VRAM must be an observed nvidia-smi device fact',
      })
    }
    if (
      device.freeVramBytes.bytes === null ||
      device.freeVramBytes.source !== 'nvidia_smi_memory_free' ||
      device.freeVramBytes.confidence !== 'observed' ||
      device.freeVramBytes.basis !== 'device_free_vram_not_safe_capacity'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeVramBytes'],
        message: 'NVIDIA free VRAM must be an observed nvidia-smi device fact',
      })
    }
  })
export type RuntimeNvidiaDevice = z.infer<typeof runtimeNvidiaDeviceSchema>

export const runtimeNvidiaTelemetrySchema = z
  .object({
    state: z.enum(['available', 'partial', 'unavailable', 'unsupported', 'unknown']),
    source: z.enum(['nvidia_smi', 'none']),
    observedAt: z.string().datetime(),
    devices: z.array(runtimeNvidiaDeviceSchema),
    reason: z
      .enum([
        'legacy_snapshot',
        'platform_not_linux',
        'nvidia_not_detected',
        'command_missing',
        'command_failed',
        'timeout',
        'output_limit',
        'all_rows_malformed',
        'some_rows_malformed',
        'device_identity_partial',
        'inconsistent_rows',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((telemetry, context) => {
    const available = telemetry.state === 'available'
    const partial = telemetry.state === 'partial'
    const expectedSource =
      available ||
      partial ||
      (telemetry.state === 'unavailable' &&
        (telemetry.reason === 'all_rows_malformed' ||
          telemetry.reason === 'inconsistent_rows'))
        ? 'nvidia_smi'
        : 'none'
    if (telemetry.source !== expectedSource) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: 'NVIDIA telemetry source must match its state and reason',
      })
    }
    const reasonMatchesState =
      (available && telemetry.reason === null) ||
      (partial &&
        (telemetry.reason === 'some_rows_malformed' ||
          telemetry.reason === 'device_identity_partial')) ||
      (telemetry.state === 'unavailable' &&
        (telemetry.reason === 'command_missing' ||
          telemetry.reason === 'command_failed' ||
          telemetry.reason === 'timeout' ||
          telemetry.reason === 'output_limit' ||
          telemetry.reason === 'all_rows_malformed' ||
          telemetry.reason === 'inconsistent_rows')) ||
      (telemetry.state === 'unsupported' &&
        (telemetry.reason === 'platform_not_linux' ||
          telemetry.reason === 'nvidia_not_detected')) ||
      (telemetry.state === 'unknown' && telemetry.reason === 'legacy_snapshot')
    if (!reasonMatchesState) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'NVIDIA telemetry reason must match its state',
      })
    }
    if ((available || partial) && telemetry.devices.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['devices'],
        message: 'available or partial NVIDIA telemetry requires a usable device',
      })
    }
    if (!available && !partial && telemetry.devices.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['devices'],
        message: 'unavailable, unsupported, or unknown NVIDIA telemetry cannot publish devices',
      })
    }
    if (
      telemetry.devices.some(
        (device) =>
          device.observedAt !== telemetry.observedAt ||
          device.totalVramBytes.observedAt !== telemetry.observedAt ||
          device.freeVramBytes.observedAt !== telemetry.observedAt,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observedAt'],
        message: 'NVIDIA telemetry facts must share the NVIDIA observedAt',
      })
    }
    const indexes = new Set<number>()
    const uuids = new Set<string>()
    for (const [index, device] of telemetry.devices.entries()) {
      if (indexes.has(device.providerIndex)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['devices', index, 'providerIndex'],
          message: 'NVIDIA provider device index must be unique',
        })
      }
      indexes.add(device.providerIndex)
      if (device.uuid === null) continue
      if (uuids.has(device.uuid)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['devices', index, 'uuid'],
          message: 'NVIDIA device UUID must be unique',
        })
      }
      uuids.add(device.uuid)
    }
  })
export type RuntimeNvidiaTelemetry = z.infer<typeof runtimeNvidiaTelemetrySchema>

function legacyNvidiaTelemetry(observedAt: string): RuntimeNvidiaTelemetry {
  return {
    state: 'unknown',
    source: 'none',
    observedAt,
    devices: [],
    reason: 'legacy_snapshot',
  }
}

const runtimeHostTelemetryObjectSchema = z
  .object({
    state: z.enum(['available', 'partial', 'unavailable', 'unsupported']),
    observedAt: z.string().datetime(),
    profile: runtimeHostProfileSchema,
    sample: runtimeHostSampleSchema,
    nvidia: runtimeNvidiaTelemetrySchema.optional(),
    availableFields: z.array(runtimeHostTelemetryFieldSchema),
    missingFields: z.array(runtimeHostTelemetryFieldSchema),
    errorCode: z
      .enum([
        'host_probe_command_missing',
        'host_probe_timeout',
        'host_probe_output_limit',
        'host_probe_failed',
        'host_probe_malformed',
      ])
      .nullable(),
  })
  .strict()

export const runtimeHostTelemetrySchema = runtimeHostTelemetryObjectSchema
  .transform((host) => ({
    ...host,
    nvidia: host.nvidia ?? legacyNvidiaTelemetry(host.observedAt),
  }))
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
      host.nvidia.observedAt,
      ...host.nvidia.devices.flatMap((device) => [
        device.observedAt,
        device.totalVramBytes.observedAt,
        device.freeVramBytes.observedAt,
      ]),
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

export const modelObservationKeyUnavailableReasonSchema = z.enum([
  'legacy_snapshot',
  'invalid_model_reference',
  'runtime_reference_ambiguous',
  'runtime_digest_missing',
  'runtime_context_missing',
  'installed_source_unavailable',
  'installed_reference_missing',
  'installed_reference_ambiguous',
  'installed_digest_mismatch',
  'runtime_version_unavailable',
  'hardware_fingerprint_unavailable',
])
export type ModelObservationKeyUnavailableReason = z.infer<
  typeof modelObservationKeyUnavailableReasonSchema
>

const sha256FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)

export const modelObservationKeySchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('complete'),
      version: z.literal(1),
      id: sha256FingerprintSchema,
      components: z
        .object({
          provider: z.literal('ollama'),
          normalizedModelReference: z.string().min(1),
          artifactDigest: z.string().min(1),
          contextLength: z.number().int().positive(),
          runtimeBackend: z
            .object({
              runtime: z.literal('ollama'),
              version: z.string().min(1),
              source: z.literal('ollama_api_version'),
              fingerprint: sha256FingerprintSchema,
            })
            .strict(),
          hardware: z
            .object({
              platform: z.literal('darwin'),
              arch: z.literal('arm64'),
              accelerator: z.literal('metal'),
              unifiedMemory: z.literal(true),
              totalMemoryBytes: z.number().int().positive(),
              source: z.literal('local_runtime_profile'),
              totalMemorySource: z.literal('node_os_totalmem'),
              fingerprint: sha256FingerprintSchema,
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      version: z.literal(1),
      reason: modelObservationKeyUnavailableReasonSchema,
    })
    .strict(),
])
export type ModelObservationKey = z.infer<typeof modelObservationKeySchema>

const legacyUnavailableObservationKey: ModelObservationKey = {
  state: 'unavailable',
  version: 1,
  reason: 'legacy_snapshot',
}

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
  'observation_key_unavailable',
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
  'model_probe',
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
    observationKey: modelObservationKeySchema
      .optional()
      .default(legacyUnavailableObservationKey),
    artifactIdentity: z.enum(['unknown', 'exact_digest']).optional().default('unknown'),
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
    observationKey: modelObservationKeySchema
      .optional()
      .default(legacyUnavailableObservationKey),
    artifactIdentity: z.enum(['unknown', 'exact_digest']).optional().default('unknown'),
  })
  .strict()
  .superRefine((decision, context) => {
    const complete = decision.observationKey.state === 'complete'
    if (complete !== (decision.artifactIdentity === 'exact_digest')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactIdentity'],
        message: 'exact artifact identity requires one complete observation key',
      })
    }
  })
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
    snapshot.models?.forEach((model, index) => {
      const complete = model.observationKey.state === 'complete'
      if (complete !== (model.artifactIdentity === 'exact_digest')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'artifactIdentity'],
          message: 'exact artifact identity requires one complete observation key',
        })
      }
    })
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

/* ─────────────────── Hugging Face read-only discovery (P2-J) ─────────────── */

/**
 * P2-J publishes Hugging Face repository facts as a provider of their own. They are
 * deliberately not `CatalogModel` rows and not `InstalledModelDescriptor` facts: an HF
 * repository has different provenance, a different identity grammar and no installability
 * at all in this slice.
 *
 * Nothing in this section is evidence that `ollama pull` works. The accepted scope is
 * exact GGUF files only, so a repository without GGUF is explicitly `unsupported` for
 * this application's import path — never "broken", "bad" or "unavailable" — and a
 * repository whose metadata could not be read stays `unknown` rather than unsupported.
 */
export const HUGGING_FACE_DISCOVERY_VERSION = 1

/**
 * Hub repository paths are case-sensitive, so the identity keeps the exact owner and
 * name. `comparisonKey` is a case-folded local equality/dedup key only and must never be
 * sent back to the Hub or shown as the repository path.
 */
export const huggingFaceRepositoryIdentitySchema = z
  .object({
    provider: z.literal('hugging_face'),
    owner: z.string().min(1),
    name: z.string().min(1),
    repositoryId: z.string().min(1),
    comparisonKey: z.string().min(1),
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.repositoryId !== `${identity.owner}/${identity.name}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repositoryId'],
        message: 'repositoryId must be exactly owner/name',
      })
    }
    if (identity.comparisonKey !== identity.repositoryId.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comparisonKey'],
        message: 'comparisonKey must be the case-folded repositoryId',
      })
    }
  })
export type HuggingFaceRepositoryIdentity = z.infer<
  typeof huggingFaceRepositoryIdentitySchema
>

export const huggingFaceInputKindSchema = z.enum(['repository_id', 'model_page_url'])
export type HuggingFaceInputKind = z.infer<typeof huggingFaceInputKindSchema>

export const huggingFaceReferencePreviewSchema = z
  .object({
    inputKind: huggingFaceInputKindSchema,
    displayValue: z.string().min(1),
    identity: huggingFaceRepositoryIdentitySchema,
  })
  .strict()
export type HuggingFaceReferencePreview = z.infer<
  typeof huggingFaceReferencePreviewSchema
>

/**
 * A revision is only exact when the Hub reported one full commit SHA. A branch name such
 * as `main` is mutable and is therefore never published here as an exact revision.
 */
export const huggingFaceRevisionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('exact_commit'),
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      source: z.literal('hugging_face_api_model'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      commit: z.null(),
      source: z.enum([
        'not_reported',
        'malformed',
        'legacy_response',
      ]),
    })
    .strict(),
])
export type HuggingFaceRevision = z.infer<typeof huggingFaceRevisionSchema>

/**
 * Gated state is shown so the user knows acceptance/token would be required later. P2-J
 * neither requests nor stores a token, and gated state on its own never changes the
 * GGUF support verdict.
 */
export const huggingFaceGatedStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('open'), mode: z.null() }).strict(),
  z
    .object({
      state: z.literal('gated'),
      mode: z.enum(['auto', 'manual', 'unspecified']),
    })
    .strict(),
  z.object({ state: z.literal('unknown'), mode: z.null() }).strict(),
])
export type HuggingFaceGatedState = z.infer<typeof huggingFaceGatedStateSchema>

/** An author-declared license claim, never a legal review or a compliance verdict. */
export const huggingFaceLicenseStateSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('declared'),
      value: z.string().min(1),
      source: z.literal('hugging_face_model_tags'),
      confidence: z.literal('declared'),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      value: z.null(),
      source: z.enum([
        'not_reported',
        'malformed',
        'conflicting_declarations',
        'metadata_unavailable',
      ]),
      confidence: z.literal('unknown'),
    })
    .strict(),
])
export type HuggingFaceLicenseState = z.infer<typeof huggingFaceLicenseStateSchema>

/** One exact GGUF file path inside one repository listing. Size stays nullable. */
export const huggingFaceGgufFileSchema = z
  .object({
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().safe().nullable(),
    sizeSource: z.enum(['hugging_face_api_model', 'not_reported']),
  })
  .strict()
  .superRefine((file, context) => {
    if ((file.sizeBytes === null) !== (file.sizeSource === 'not_reported')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sizeSource'],
        message: 'a GGUF file size and its source must be reported together',
      })
    }
  })
export type HuggingFaceGgufFile = z.infer<typeof huggingFaceGgufFileSchema>

/**
 * `truncated` is the difference between "this repository has no GGUF" and "this listing
 * did not show every file". Only a complete listing can support `unsupported`.
 */
export const huggingFaceFileInventorySchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('listed'),
      source: z.literal('hugging_face_api_model'),
      totalFiles: z.number().int().nonnegative().safe(),
      malformedEntries: z.number().int().nonnegative().safe(),
      truncated: z.boolean(),
      ggufFiles: z.array(huggingFaceGgufFileSchema),
    })
    .strict(),
  z
    .object({
      state: z.literal('unknown'),
      source: z.enum(['not_reported', 'malformed', 'metadata_unavailable']),
      totalFiles: z.null(),
      malformedEntries: z.null(),
      truncated: z.null(),
      ggufFiles: z.array(huggingFaceGgufFileSchema).max(0),
    })
    .strict(),
])
export type HuggingFaceFileInventory = z.infer<typeof huggingFaceFileInventorySchema>

export const huggingFaceUnknownVerdictReasonSchema = z.enum([
  'file_inventory_unavailable',
  'file_listing_truncated',
  'file_entries_malformed',
  'metadata_unavailable',
  'legacy_response',
])
export type HuggingFaceUnknownVerdictReason = z.infer<
  typeof huggingFaceUnknownVerdictReasonSchema
>

/**
 * The single support statement this slice makes, about this application's GGUF-only
 * import scope and nothing else. It is never a capability, quality, fit, licence or
 * `ollama pull` claim.
 */
export const huggingFaceSupportVerdictSchema = z
  .object({
    state: z.enum(['supported', 'unsupported', 'unknown']),
    scope: z.literal('exact_gguf_file_only'),
    basis: z.enum([
      'exact_gguf_files_listed',
      'complete_listing_without_gguf',
      'insufficient_evidence',
    ]),
    reason: huggingFaceUnknownVerdictReasonSchema.nullable(),
    /** An installable target still requires the P2-K exact file/revision choice. */
    requiresExactFileSelection: z.literal(true),
  })
  .strict()
  .superRefine((verdict, context) => {
    const expectedBasis =
      verdict.state === 'supported'
        ? 'exact_gguf_files_listed'
        : verdict.state === 'unsupported'
          ? 'complete_listing_without_gguf'
          : 'insufficient_evidence'
    if (verdict.basis !== expectedBasis) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['basis'],
        message: 'a support verdict basis must match its state',
      })
    }
    if ((verdict.state === 'unknown') !== (verdict.reason !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'exactly an unknown verdict carries a reason',
      })
    }
  })
export type HuggingFaceSupportVerdict = z.infer<typeof huggingFaceSupportVerdictSchema>

/**
 * One repository row. `metadata` separates "the Hub answered about this repository" from
 * "we only know the identity the user typed", so a failed detail read never silently
 * becomes an unsupported repository.
 */
export const huggingFaceRepositorySchema = z
  .object({
    version: z.literal(HUGGING_FACE_DISCOVERY_VERSION),
    provider: z.literal('hugging_face'),
    identity: huggingFaceRepositoryIdentitySchema,
    metadata: z.enum(['resolved', 'unavailable']),
    observedAt: z.string().datetime(),
    revision: huggingFaceRevisionSchema,
    gated: huggingFaceGatedStateSchema,
    license: huggingFaceLicenseStateSchema,
    files: huggingFaceFileInventorySchema,
    verdict: huggingFaceSupportVerdictSchema,
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.metadata === 'unavailable') {
      if (repository.files.state !== 'unknown' || repository.verdict.state !== 'unknown') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['metadata'],
          message: 'unavailable metadata cannot publish file or support evidence',
        })
      }
      return
    }
    const files = repository.files
    if (files.state !== 'listed') {
      if (repository.verdict.state !== 'unknown') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['verdict'],
          message: 'an unknown file inventory cannot support a decided verdict',
        })
      }
      return
    }
    if (files.ggufFiles.length > files.totalFiles) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', 'ggufFiles'],
        message: 'listed GGUF files cannot exceed the listed file total',
      })
    }
    const paths = new Set(files.ggufFiles.map((file) => file.path))
    if (paths.size !== files.ggufFiles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', 'ggufFiles'],
        message: 'listed GGUF file paths must be unique',
      })
    }
    // `supported` requires exact GGUF evidence; `unsupported` requires a complete
    // listing that proves their absence. Truncation or malformed entries are neither.
    const complete = !files.truncated && files.malformedEntries === 0
    const expected =
      files.ggufFiles.length > 0
        ? 'supported'
        : complete
          ? 'unsupported'
          : 'unknown'
    if (repository.verdict.state !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verdict', 'state'],
        message: 'the support verdict must follow the exact GGUF evidence',
      })
    }
  })
export type HuggingFaceRepository = z.infer<typeof huggingFaceRepositorySchema>

/**
 * Redacted transport states. No raw provider body, endpoint, host, path, header or token
 * is ever published, and none of these is a statement about the repository itself.
 */
export const huggingFaceTransportFailureReasonSchema = z.enum([
  'provider_unavailable',
  'connect_timeout',
  'response_timeout',
  'response_too_large',
  'provider_malformed',
  'provider_error',
  'rate_limited',
  'not_found',
  'request_cancelled',
])
export type HuggingFaceTransportFailureReason = z.infer<
  typeof huggingFaceTransportFailureReasonSchema
>

export const huggingFaceSourceHealthSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('available'),
      source: z.literal('hugging_face_public_api'),
      observedAt: z.string().datetime(),
      reason: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      source: z.literal('hugging_face_public_api'),
      observedAt: z.string().datetime(),
      reason: huggingFaceTransportFailureReasonSchema,
    })
    .strict(),
])
export type HuggingFaceSourceHealth = z.infer<typeof huggingFaceSourceHealthSchema>

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
  numCtx: positiveSafeIntegerSchema,
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
  defaultNumCtx: positiveSafeIntegerSchema,
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
    'context_limit_exceeded',
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
