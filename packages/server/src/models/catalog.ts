/**
 * Каталог моделей, доступных к установке.
 *
 * В локальном API Ollama поиска по библиотеке нет — это проверено по OpenAPI-спеке,
 * там только generate/chat/embed/tags/ps/show/create/copy/pull/push/delete/version.
 * Human catalog живёт на ollama.com, но не является документированным API.
 *
 * P0-D intentionally has no live Ollama catalog provider: the previous
 * remote search call was undocumented and returned 404. Discovery uses a local
 * recommendations cache when present and a dated bundled snapshot.
 */
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  CatalogModel,
  CatalogVariant,
  CatalogSourceHealth,
  CatalogPagination,
  HardwareInfo,
  ListCatalogQuery,
  ModelCapability,
} from '@alamo/contract'
import { z } from 'zod'
import { computeFit } from '../hardware/fit.ts'
import {
  normalizeOllamaModelName,
  OllamaReferenceError,
} from './ollama-reference.ts'

export interface CatalogSeed {
  name: string
  description: string
  variants: { tag: string; sizeBytes: number | null; parameterSize: string | null }[]
  contextLength: number | null
  capabilities: ModelCapability[]
  vramBytes: number | null
  isCloud: boolean
  requiredPlan: 'free' | 'pro' | null
}

const BUNDLED_FETCHED_AT = '2026-08-02T00:00:00.000Z'

/**
 * Встроенный снимок. Намеренно короткий: это не попытка повторить библиотеку
 * Ollama, а запасной вариант, чтобы офлайн можно было хоть что-то выбрать.
 */
const BUNDLED: readonly CatalogSeed[] = [
  {
    name: 'qwen2.5-coder',
    description: 'Кодовая модель: генерация, объяснение и правка кода. Поддерживает вызов инструментов.',
    variants: [
      { tag: '1.5b', sizeBytes: 986_000_000, parameterSize: '1.5B' },
      { tag: '7b', sizeBytes: 4_683_087_561, parameterSize: '7.6B' },
      { tag: '14b', sizeBytes: 9_000_000_000, parameterSize: '14.8B' },
      { tag: '32b', sizeBytes: 19_900_000_000, parameterSize: '32.8B' },
    ],
    contextLength: 32_768,
    capabilities: ['completion', 'tools', 'insert'],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
  },
  {
    name: 'llama3.2',
    description: 'Компактная универсальная модель. Хорошо идёт на слабом железе.',
    variants: [
      { tag: '1b', sizeBytes: 1_300_000_000, parameterSize: '1.2B' },
      { tag: '3b', sizeBytes: 2_000_000_000, parameterSize: '3.2B' },
    ],
    contextLength: 131_072,
    capabilities: ['completion', 'tools'],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
  },
  {
    name: 'mistral',
    description: 'Универсальная модель 7B с поддержкой вызова инструментов.',
    variants: [{ tag: '7b', sizeBytes: 4_100_000_000, parameterSize: '7.2B' }],
    contextLength: 32_768,
    capabilities: ['completion', 'tools'],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
  },
  {
    name: 'nomic-embed-text',
    description: 'Модель эмбеддингов для поиска по документам. Нужна для индексации файлов.',
    variants: [{ tag: 'latest', sizeBytes: 274_000_000, parameterSize: '137M' }],
    contextLength: 8_192,
    capabilities: ['embedding'],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
  },
]

const recommendationsSchema = z.object({
  recommendations: z
    .array(
      z.object({
        model: z.string().min(1),
        description: z.string().optional(),
        context_length: z.number().int().positive().optional(),
        required_plan: z.enum(['free', 'pro']).optional(),
        vram_bytes: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
})

export interface LocalRecommendations {
  seeds: CatalogSeed[]
  fetchedAt: string
}

type RecommendationRow = {
  model: string
  description?: string
  context_length?: number
  required_plan?: 'free' | 'pro'
  vram_bytes?: number
}

export function catalogSeedFromRecommendation(
  entry: RecommendationRow,
): CatalogSeed | null {
  let normalized: string
  try {
    normalized = normalizeOllamaModelName(entry.model)
  } catch (error) {
    if (error instanceof OllamaReferenceError) return null
    throw error
  }
  const separator = normalized.lastIndexOf(':')
  if (separator <= 0 || separator === normalized.length - 1) return null
  const name = normalized.slice(0, separator)
  const tag = normalized.slice(separator + 1)
  return {
    name,
    description: entry.description ?? '',
    variants: [{ tag, sizeBytes: null, parameterSize: null }],
    contextLength: entry.context_length ?? null,
    // The cache entry has no capability evidence. Absence remains unknown.
    capabilities: [],
    vramBytes: entry.vram_bytes ?? null,
    isCloud: tag === 'cloud',
    requiredPlan: entry.required_plan ?? null,
  }
}

/** Читает рекомендации, которые Ollama складывает у себя в кэш. */
async function loadLocalRecommendations(signal?: AbortSignal): Promise<LocalRecommendations | null> {
  const path = join(homedir(), '.ollama', 'cache', 'model-recommendations.json')

  try {
    signal?.throwIfAborted()
    const [raw, metadata] = await Promise.all([
      readFile(path, { encoding: 'utf8', signal }),
      stat(path),
    ])
    signal?.throwIfAborted()
    const parsed = recommendationsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null

    const seeds = (parsed.data.recommendations ?? []).flatMap((entry) => {
      const seed = catalogSeedFromRecommendation(entry)
      return seed ? [seed] : []
    })
    return { seeds, fetchedAt: metadata.mtime.toISOString() }
  } catch {
    return null
  }
}

export interface CatalogResult {
  models: CatalogModel[]
  live: boolean
  source: CatalogSourceHealth
  pagination: CatalogPagination
}

export interface CatalogInput {
  query?: string
  contextLength: number
  filters?: CatalogFilters
  pagination?: { page: number; pageSize: number }
  hardware: HardwareInfo
  /** Exact sampled `/api/tags` rows. `null` means the source was unavailable. */
  installed: {
    models: readonly { name: string; digest: string }[]
    observedAt: string
  } | null
  signal?: AbortSignal
}

export type CatalogFilters = Pick<
  ListCatalogQuery,
  | 'installation'
  | 'fit'
  | 'providerScope'
  | 'source'
  | 'freshness'
  | 'capability'
  | 'minClaimedContext'
  | 'contextClaim'
  | 'maxClaimedArtifactSize'
  | 'artifactSizeClaim'
>

export interface CatalogDependencies {
  loadLocalRecommendations?: (signal?: AbortSignal) => Promise<LocalRecommendations | null>
  bundled?: readonly CatalogSeed[]
  now?: () => Date
}

interface SourcedSeed {
  seed: CatalogSeed
  source: CatalogModel['source']
  freshness: CatalogModel['freshness']
  fetchedAt: string | null
}

type VariantSource = Pick<
  CatalogVariant,
  'source' | 'freshness' | 'sourceObservedAt' | 'sourceFetchedAt'
>

function unknownVariantFit(
  reason: 'size_unknown' | 'invalid_variant',
  contextLength: number | null,
): CatalogVariant['fit'] {
  return {
    state: 'unknown',
    source: 'catalog_claim',
    contextLength,
    verdict: null,
    reason,
  }
}

function installedIndex(
  sample: CatalogInput['installed'],
): Map<string, Array<{ digest: string }>> | null {
  if (!sample) return null
  const result = new Map<string, Array<{ digest: string }>>()
  for (const row of sample.models) {
    let normalized: string
    try {
      normalized = normalizeOllamaModelName(row.name)
    } catch (error) {
      if (error instanceof OllamaReferenceError) continue
      throw error
    }
    const matches = result.get(normalized) ?? []
    matches.push({ digest: row.digest })
    result.set(normalized, matches)
  }
  return result
}

function variantInstallation(
  target: string | null,
  sample: CatalogInput['installed'],
  index: ReturnType<typeof installedIndex>,
): CatalogVariant['installation'] {
  if (!sample || !index) {
    return {
      state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
      reason: 'provider_unavailable',
    }
  }
  if (!target) {
    return {
      state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
      reason: 'ambiguous_installed_reference',
    }
  }
  const matches = index.get(target) ?? []
  if (matches.length === 0) {
    return {
      state: 'not_installed', digest: null, source: 'ollama_api_tags',
      observedAt: sample.observedAt,
    }
  }
  if (matches.length !== 1) {
    return {
      state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
      reason: 'ambiguous_installed_reference',
    }
  }
  const digest = matches[0]!.digest.trim()
  return digest.length > 0
    ? {
        state: 'installed', digest, source: 'ollama_api_tags',
        observedAt: sample.observedAt,
      }
    : {
        state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
        reason: 'installed_digest_missing',
      }
}

function buildVariants(
  seed: CatalogSeed,
  input: CatalogInput,
  source: VariantSource,
): CatalogVariant[] {
  const candidates = seed.variants.map((variant) => {
    const rowValid =
      variant.tag.length > 0
      && variant.tag === variant.tag.trim()
      && (variant.sizeBytes === null
        || (Number.isSafeInteger(variant.sizeBytes) && variant.sizeBytes > 0))
      && (variant.parameterSize === null || variant.parameterSize.trim().length > 0)
      && (seed.contextLength === null
        || (Number.isSafeInteger(seed.contextLength) && seed.contextLength > 0))
    if (!rowValid) return { variant, target: null }
    try {
      return {
        variant,
        target: normalizeOllamaModelName(`${seed.name}:${variant.tag}`),
      }
    } catch (error) {
      if (error instanceof OllamaReferenceError) return { variant, target: null }
      throw error
    }
  })
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.target) counts.set(candidate.target, (counts.get(candidate.target) ?? 0) + 1)
  }
  const installed = installedIndex(input.installed)

  return candidates.map(({ variant, target: candidateTarget }) => {
    const target = candidateTarget && counts.get(candidateTarget) === 1
      ? candidateTarget
      : null
    const safeSize = variant.sizeBytes !== null
      && Number.isSafeInteger(variant.sizeBytes)
      && variant.sizeBytes > 0
      ? variant.sizeBytes
      : null
    const safeParameterSize = variant.parameterSize?.trim() || null
    const safeContextLength = seed.contextLength !== null
      && Number.isSafeInteger(seed.contextLength)
      && seed.contextLength > 0
      ? seed.contextLength
      : null
    const fit: CatalogVariant['fit'] = target === null
      ? unknownVariantFit('invalid_variant', safeContextLength)
      : safeSize === null
        ? unknownVariantFit('size_unknown', safeContextLength)
        : {
            state: 'calculated',
            source: 'catalog_claim',
            contextLength: input.contextLength,
            verdict: computeFit({
              contextLength: input.contextLength,
              hardware: input.hardware,
              modelBytes: safeSize,
              // The claimed artifact size is the only variant-specific memory
              // hint available in this bounded catalog; it is never measured.
              vramHintBytes: safeSize,
              isCloud: seed.isCloud,
            }),
          }
    return {
      tag: variant.tag,
      sizeBytes: safeSize,
      parameterSize: safeParameterSize,
      normalizedName: target,
      contextLength: safeContextLength,
      fit,
      installation: variantInstallation(target, input.installed, installed),
      ...source,
    }
  })
}

export async function getCatalog(
  input: CatalogInput,
  dependencies: CatalogDependencies = {},
): Promise<CatalogResult> {
  input.signal?.throwIfAborted()
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString()
  const local = await (
    dependencies.loadLocalRecommendations ?? loadLocalRecommendations
  )(input.signal)
  input.signal?.throwIfAborted()
  const bundled = dependencies.bundled ?? BUNDLED
  const sourcedSeeds: SourcedSeed[] = [
    ...(local?.seeds ?? []).map((seed) => ({
      seed,
      source: 'local_cache' as const,
      freshness: 'stale' as const,
      fetchedAt: local?.fetchedAt ?? null,
    })),
    ...bundled.map((seed) => ({
      seed,
      source: 'bundled' as const,
      freshness: 'fallback' as const,
      fetchedAt: BUNDLED_FETCHED_AT,
    })),
  ]

  const source: CatalogSourceHealth =
    local && local.seeds.length > 0
      ? {
          state: 'stale_cache',
          source: 'ollama_recommendations_cache',
          observedAt,
          fetchedAt: local.fetchedAt,
        }
      : bundled.length > 0
        ? {
            state: 'bundled_fallback',
            source: 'bundled_snapshot',
            observedAt,
            fetchedAt: BUNDLED_FETCHED_AT,
          }
        : {
            state: 'unavailable',
            source: 'none',
            observedAt,
            fetchedAt: null,
          }

  // Рекомендации вендора и встроенный список могут пересекаться — оставляем первое вхождение.
  const unique = new Map<string, SourcedSeed>()
  for (const sourced of sourcedSeeds) {
    if (!unique.has(sourced.seed.name)) unique.set(sourced.seed.name, sourced)
  }

  const query = input.query?.trim().toLowerCase()

  const models: CatalogModel[] = [...unique.values()]
    .filter(({ seed }) => {
      if (!query) return true
      return seed.name.toLowerCase().includes(query) || seed.description.toLowerCase().includes(query)
    })
    .map(({ seed, source: modelSource, freshness, fetchedAt }) => {
      const sourceFields: VariantSource = {
        source: modelSource,
        freshness,
        sourceObservedAt: observedAt,
        sourceFetchedAt: fetchedAt,
      }
      const variants = buildVariants(seed, input, sourceFields)
      const installed = variants.some((variant) => variant.installation.state === 'installed')
      // Для вердикта берём самый крупный вариант: он и есть ограничивающий.
      const largest = seed.variants.reduce<number>(
        (max, variant) => Math.max(max, variant.sizeBytes ?? 0),
        0,
      )

      return {
        name: seed.name,
        description: seed.description,
        variants,
        contextLength: seed.contextLength,
        capabilities: seed.capabilities,
        vramBytes: seed.vramBytes,
        isCloud: seed.isCloud,
        requiredPlan: seed.requiredPlan,
        installed,
        fit: computeFit({
          contextLength: input.contextLength,
          hardware: input.hardware,
          modelBytes: largest,
          vramHintBytes: seed.vramBytes,
          isCloud: seed.isCloud,
        }),
        installedProjection: 'variant_aggregate_compatibility',
        fitProjection: 'largest_variant_compatibility',
        source: modelSource,
        freshness,
        sourceObservedAt: observedAt,
        sourceFetchedAt: fetchedAt,
      }
    })

  const filtered = filterCatalogModels(
    failClosedDuplicateCatalogTargets(models),
    input.filters,
  ).sort(compareCatalogModels)
  if (!input.pagination) {
    return {
      models: filtered,
      live: false,
      source,
      pagination: { mode: 'legacy', totalItems: filtered.length },
    }
  }

  const { page, pageSize } = input.pagination
  const totalItems = filtered.length
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize)
  const start = page <= totalPages ? (page - 1) * pageSize : null
  return {
    models: start !== null ? filtered.slice(start, start + pageSize) : [],
    live: false,
    source,
    pagination: {
      mode: 'paged',
      page,
      pageSize,
      totalItems,
      totalPages,
      previousPage:
        totalPages === 0 || page > totalPages ? null : page > 1 ? page - 1 : null,
      nextPage: page < totalPages ? page + 1 : null,
    },
  }
}

/**
 * Exact targets are identities across the complete source snapshot, not only a
 * response page. Mark every duplicate ambiguous before filters/count/slicing so
 * pagination can never hide its counterpart on another page.
 */
function failClosedDuplicateCatalogTargets(models: CatalogModel[]): CatalogModel[] {
  const counts = new Map<string, number>()
  for (const model of models) {
    for (const variant of model.variants) {
      if (variant.normalizedName !== null) {
        counts.set(
          variant.normalizedName,
          (counts.get(variant.normalizedName) ?? 0) + 1,
        )
      }
    }
  }
  if ([...counts.values()].every((count) => count === 1)) return models

  return models.map((model) => ({
    ...model,
    variants: model.variants.map((variant) =>
      variant.normalizedName !== null && counts.get(variant.normalizedName)! > 1
        ? {
            ...variant,
            normalizedName: null,
            fit: unknownVariantFit('invalid_variant', variant.contextLength),
            installation: {
              state: 'unknown' as const,
              digest: null,
              source: 'unavailable' as const,
              observedAt: null,
              reason: 'ambiguous_installed_reference' as const,
            },
          }
        : variant,
    ),
  }))
}

/** Locale-independent code-unit ordering with an exact-row tie-breaker. */
function compareCatalogModels(left: CatalogModel, right: CatalogModel): number {
  const byName = compareCodeUnits(left.name, right.name)
  if (byName !== 0) return byName
  const leftTargets = left.variants.map((variant) => variant.normalizedName ?? '').join('\u0000')
  const rightTargets = right.variants.map((variant) => variant.normalizedName ?? '').join('\u0000')
  return compareCodeUnits(leftTargets, rightTargets)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function selected<T>(values: readonly T[] | undefined, value: T): boolean {
  return !values || values.length === 0 || values.includes(value)
}

function hasVariantFilters(filters: CatalogFilters): boolean {
  return Boolean(
    filters.installation?.length
      || filters.fit?.length
      || filters.minClaimedContext
      || filters.contextClaim
      || filters.maxClaimedArtifactSize
      || filters.artifactSizeClaim,
  )
}

function variantMatches(variant: CatalogVariant, filters: CatalogFilters): boolean {
  // A malformed or duplicate exact target can never satisfy a variant facet.
  if (variant.normalizedName === null) return false

  const installation = variant.installation.state
  if (!selected(filters.installation, installation)) return false

  const fit = variant.fit.state === 'calculated' ? variant.fit.verdict.level : 'unknown'
  if (!selected(filters.fit, fit)) return false

  if (filters.contextClaim === 'unknown' && variant.contextLength !== null) return false
  if (
    filters.minClaimedContext !== undefined
    && (variant.contextLength === null || variant.contextLength < filters.minClaimedContext)
  ) return false

  if (filters.artifactSizeClaim === 'unknown' && variant.sizeBytes !== null) return false
  if (
    filters.maxClaimedArtifactSize !== undefined
    && (variant.sizeBytes === null || variant.sizeBytes > filters.maxClaimedArtifactSize)
  ) return false

  return true
}

/** Pure query-time filter; it never changes provenance or compatibility fields. */
export function filterCatalogModels(
  models: readonly CatalogModel[],
  filters: CatalogFilters = {},
): CatalogModel[] {
  const variantFiltering = hasVariantFilters(filters)
  return models.flatMap((model) => {
    const scope = model.isCloud ? 'cloud' : 'local'
    if (!selected(filters.providerScope, scope)) return []
    if (!selected(filters.source, model.source)) return []
    if (!selected(filters.freshness, model.freshness)) return []

    if (filters.capability?.length) {
      const capabilityMatches = filters.capability.some((capability) =>
        capability === 'unknown'
          ? model.capabilities.length === 0
          : model.capabilities.includes(capability),
      )
      if (!capabilityMatches) return []
    }

    if (!variantFiltering) return [model]
    const variants = model.variants.filter((variant) => variantMatches(variant, filters))
    return variants.length === 0 ? [] : [{ ...model, variants }]
  })
}
