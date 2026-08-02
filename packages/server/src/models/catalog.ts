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
  CatalogSourceHealth,
  HardwareInfo,
  ModelCapability,
} from '@alamo/contract'
import { z } from 'zod'
import { computeFit } from '../hardware/fit.ts'

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

/** Читает рекомендации, которые Ollama складывает у себя в кэш. */
async function loadLocalRecommendations(): Promise<LocalRecommendations | null> {
  const path = join(homedir(), '.ollama', 'cache', 'model-recommendations.json')

  try {
    const [raw, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const parsed = recommendationsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null

    const seeds = (parsed.data.recommendations ?? []).map((entry) => {
      const isCloud = entry.model.endsWith(':cloud')
      const [base, tag] = entry.model.split(':')

      return {
        name: base ?? entry.model,
        description: entry.description ?? '',
        variants: [{ tag: tag ?? 'latest', sizeBytes: null, parameterSize: null }],
        contextLength: entry.context_length ?? null,
        // The cache entry has no capability evidence. Absence remains unknown.
        capabilities: [],
        vramBytes: entry.vram_bytes ?? null,
        isCloud,
        requiredPlan: entry.required_plan ?? null,
      }
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
}

export interface CatalogInput {
  query?: string
  contextLength: number
  hardware: HardwareInfo
  /** Уже скачанные модели: их помечаем как установленные. */
  installed: ReadonlySet<string>
}

export interface CatalogDependencies {
  loadLocalRecommendations?: () => Promise<LocalRecommendations | null>
  bundled?: readonly CatalogSeed[]
  now?: () => Date
}

interface SourcedSeed {
  seed: CatalogSeed
  source: CatalogModel['source']
  freshness: CatalogModel['freshness']
  fetchedAt: string | null
}

export async function getCatalog(
  input: CatalogInput,
  dependencies: CatalogDependencies = {},
): Promise<CatalogResult> {
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString()
  const local = await (
    dependencies.loadLocalRecommendations ?? loadLocalRecommendations
  )()
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
      const installed = [...input.installed].some(
        (name) => name === seed.name || name.startsWith(`${seed.name}:`),
      )
      // Для вердикта берём самый крупный вариант: он и есть ограничивающий.
      const largest = seed.variants.reduce<number>(
        (max, variant) => Math.max(max, variant.sizeBytes ?? 0),
        0,
      )

      return {
        name: seed.name,
        description: seed.description,
        variants: seed.variants,
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
        source: modelSource,
        freshness,
        sourceObservedAt: observedAt,
        sourceFetchedAt: fetchedAt,
      }
    })

  return { models, live: false, source }
}
