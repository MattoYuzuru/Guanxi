/**
 * Каталог моделей, доступных к установке.
 *
 * В локальном API Ollama поиска по библиотеке нет — это проверено по OpenAPI-спеке,
 * там только generate/chat/embed/tags/ps/show/create/copy/pull/push/delete/version.
 * Живой каталог живёт на ollama.com, а он доступен не всегда: в корпоративной сети
 * домен может быть заблокирован целиком.
 *
 * Поэтому источников три, по убыванию свежести:
 *   1. ollama.com — если достучались;
 *   2. ~/.ollama/cache/model-recommendations.json — Ollama сама кладёт туда
 *      рекомендации с полем vram_bytes, это настоящие данные вендора на машине;
 *   3. встроенный снимок — чтобы экран каталога не был пустым офлайн.
 *
 * Признак `live` уходит в ответ: интерфейс обязан честно сказать, что показывает
 * снимок, а не актуальный список.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CatalogModel, HardwareInfo, ModelCapability } from '@alamo/contract'
import { computeFit } from '../hardware/fit.ts'

interface CatalogSeed {
  name: string
  description: string
  variants: { tag: string; sizeBytes: number | null; parameterSize: string | null }[]
  contextLength: number | null
  capabilities: ModelCapability[]
  vramBytes: number | null
  isCloud: boolean
  requiredPlan: 'free' | 'pro' | null
}

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

interface RecommendationEntry {
  model: string
  description?: string
  context_length?: number
  max_output_tokens?: number
  required_plan?: 'free' | 'pro'
  vram_bytes?: number
}

/** Читает рекомендации, которые Ollama складывает у себя в кэш. */
async function loadLocalRecommendations(): Promise<CatalogSeed[]> {
  const path = join(homedir(), '.ollama', 'cache', 'model-recommendations.json')

  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { recommendations?: RecommendationEntry[] }

    return (parsed.recommendations ?? []).map((entry) => {
      const isCloud = entry.model.endsWith(':cloud')
      const [base, tag] = entry.model.split(':')

      return {
        name: base ?? entry.model,
        description: entry.description ?? '',
        variants: [{ tag: tag ?? 'latest', sizeBytes: null, parameterSize: null }],
        contextLength: entry.context_length ?? null,
        capabilities: ['completion', 'tools'] as ModelCapability[],
        vramBytes: entry.vram_bytes ?? null,
        isCloud,
        requiredPlan: entry.required_plan ?? null,
      }
    })
  } catch {
    return []
  }
}

/** Пробует живой каталог. Короткий таймаут: за прокси запрос обычно просто виснет. */
async function fetchRemote(query: string | undefined): Promise<CatalogSeed[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4_000)

  try {
    const url = new URL('https://ollama.com/api/search')
    if (query) url.searchParams.set('q', query)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null

    const contentType = response.headers.get('content-type') ?? ''
    // Прокси-заглушка отдаёт HTML со статусом 200 — на это нельзя попасться.
    if (!contentType.includes('application/json')) return null

    const parsed = (await response.json()) as { models?: RecommendationEntry[] }
    if (!Array.isArray(parsed.models)) return null

    return parsed.models.map((entry) => ({
      name: entry.model,
      description: entry.description ?? '',
      variants: [{ tag: 'latest', sizeBytes: null, parameterSize: null }],
      contextLength: entry.context_length ?? null,
      capabilities: ['completion'] as ModelCapability[],
      vramBytes: entry.vram_bytes ?? null,
      isCloud: entry.model.endsWith(':cloud'),
      requiredPlan: entry.required_plan ?? null,
    }))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface CatalogResult {
  models: CatalogModel[]
  live: boolean
}

export interface CatalogInput {
  query?: string
  contextLength: number
  hardware: HardwareInfo
  /** Уже скачанные модели: их помечаем как установленные. */
  installed: ReadonlySet<string>
}

export async function getCatalog(input: CatalogInput): Promise<CatalogResult> {
  const remote = await fetchRemote(input.query)
  const local = await loadLocalRecommendations()

  const live = remote !== null
  const seeds = remote ?? [...local, ...BUNDLED]

  // Рекомендации вендора и встроенный список могут пересекаться — оставляем первое вхождение.
  const unique = new Map<string, CatalogSeed>()
  for (const seed of seeds) {
    if (!unique.has(seed.name)) unique.set(seed.name, seed)
  }

  const query = input.query?.trim().toLowerCase()

  const models: CatalogModel[] = [...unique.values()]
    .filter((seed) => {
      if (!query) return true
      return seed.name.toLowerCase().includes(query) || seed.description.toLowerCase().includes(query)
    })
    .map((seed) => {
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
        source: live ? ('remote' as const) : ('bundled' as const),
      }
    })

  return { models, live }
}
