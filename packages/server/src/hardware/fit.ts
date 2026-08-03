/**
 * Legacy catalog estimate for a model and context window.
 *
 * This helper intentionally retains `HardwareInfo.usableMemoryBytes` for the
 * current Web contract. It is not the sampled P1-H current-fit projection and
 * must not be used as observed host availability or pressure.
 *
 * Требуемая память = вес весов модели + KV-кэш. Второе линейно растёт с окном
 * контекста, и при 32k окне сопоставимо с самими весами, поэтому игнорировать его нельзя.
 *
 * Точность добывается в два этапа:
 *
 *  1. Пока про модель ничего не известно — считаем по архитектурным параметрам из
 *     /api/show. Это приблизительно: у гибридных архитектур с линейным вниманием
 *     формула завышает в разы, потому что не все слои держат полный KV-кэш.
 *
 *  2. Как только модель хоть раз загружалась, у нас есть точки (окно → занятая память)
 *     из /api/ps. Зависимость строго линейная — на qwen2 три замера при 4k/16k/32k дали
 *     ровно 31 488 Б/токен без разброса. Двух точек достаточно, чтобы дальше считать
 *     этой модели точно, а не приблизительно.
 *
 * То есть вердикт сам себя уточняет по мере использования.
 */
import type { FitLevel, FitVerdict, HardwareInfo } from '@alamo/contract'

/**
 * Байт на элемент KV-кэша.
 *
 * Не 2, как было бы при f16: Ollama 0.32 по умолчанию держит кэш квантованным.
 * Замер на qwen2.5-coder:7b — 31 488 Б/токен при 28 672 элементах/токен, то есть
 * 1.098 Б/элемент. Округляем вверх, чтобы прогноз ошибался в безопасную сторону.
 */
const KV_BYTES_PER_ELEMENT = 1.1

/** K и V — две матрицы. */
const KV_MATRICES = 2

/** Ниже этой заполненности считаем, что запас есть. */
const GREEN_UTILIZATION = 0.8

/** Меньше двух точек — калибровать нечего. */
const MIN_CALIBRATION_SAMPLES = 2

export interface ModelArchParams {
  blockCount: number
  headCountKv: number
  /** Размерность одной головы. */
  headDim: number
}

/**
 * Достаёт архитектурные параметры из `model_info` ответа /api/show.
 * Ключи префиксованы архитектурой: `qwen2.block_count`, `llama.block_count`.
 */
export function extractArchParams(
  modelInfo: Record<string, unknown> | undefined | null,
): ModelArchParams | null {
  if (!modelInfo) return null

  const architecture = modelInfo['general.architecture']
  if (typeof architecture !== 'string' || !architecture) return null

  const num = (suffix: string): number | null => {
    const value = modelInfo[`${architecture}.${suffix}`]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  }

  const blockCount = num('block_count')
  const headCount = num('attention.head_count')
  // Без grouped-query attention это поле не публикуют — там оно равно head_count.
  const headCountKv = num('attention.head_count_kv') ?? headCount
  if (!blockCount || !headCountKv) return null

  /*
   * Размер головы: если модель объявила key_length явно — берём его. Выводить
   * из embedding_length/head_count можно не всегда: у qwen35 это 5120/24, не целое,
   * а реальный key_length там 256.
   */
  const keyLength = num('attention.key_length')
  const embeddingLength = num('embedding_length')
  const headDim = keyLength ?? (embeddingLength && headCount ? embeddingLength / headCount : null)
  if (!headDim) return null

  return { blockCount, headCountKv, headDim }
}

/** Сколько байт KV-кэша приходится на один токен контекста. */
export function kvBytesPerToken(params: ModelArchParams): number {
  return Math.round(
    KV_MATRICES * params.blockCount * params.headCountKv * params.headDim * KV_BYTES_PER_ELEMENT,
  )
}

export function estimateKvCacheBytes(params: ModelArchParams, contextLength: number): number {
  return kvBytesPerToken(params) * contextLength
}

/** Точка замера: при каком окне сколько памяти реально заняла модель. */
export interface CalibrationSample {
  contextLength: number
  sizeBytes: number
}

export interface Calibration {
  bytesPerToken: number
  /** Постоянная часть: веса модели плюс служебные буферы. */
  baseBytes: number
  samples: number
}

/**
 * Выводит линейную зависимость память(окно) по замерам.
 * Берём крайние точки: зависимость линейная, а крайние точки дают наибольшее плечо
 * и наименьшую чувствительность к округлению в отчётах Ollama.
 */
export function calibrate(samples: readonly CalibrationSample[]): Calibration | null {
  const unique = new Map<number, number>()
  for (const sample of samples) unique.set(sample.contextLength, sample.sizeBytes)
  if (unique.size < MIN_CALIBRATION_SAMPLES) return null

  const points = [...unique.entries()]
    .map(([contextLength, sizeBytes]) => ({ contextLength, sizeBytes }))
    .sort((a, b) => a.contextLength - b.contextLength)

  const low = points[0]!
  const high = points[points.length - 1]!
  const contextSpan = high.contextLength - low.contextLength
  if (contextSpan <= 0) return null

  const bytesPerToken = (high.sizeBytes - low.sizeBytes) / contextSpan
  if (!Number.isFinite(bytesPerToken) || bytesPerToken < 0) return null

  return {
    bytesPerToken,
    baseBytes: low.sizeBytes - bytesPerToken * low.contextLength,
    samples: unique.size,
  }
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`
}

function levelFor(utilization: number): FitLevel {
  if (utilization < GREEN_UTILIZATION) return 'green'
  if (utilization < 1) return 'yellow'
  return 'red'
}

function summarize(level: FitLevel, requiredBytes: number, usableBytes: number): string {
  if (level === 'green') return `${formatGb(requiredBytes)} из ${formatGb(usableBytes)} — запас есть`
  if (level === 'yellow')
    return `${formatGb(requiredBytes)} из ${formatGb(usableBytes)} — впритык, возможны просадки`
  return `Нужно ${formatGb(requiredBytes)}, доступно ${formatGb(usableBytes)} — часть уйдёт на CPU`
}

export interface ComputeFitInput {
  contextLength: number
  hardware: HardwareInfo
  /** Вес весов модели на диске. */
  modelBytes: number
  /** Блок `model_info` из /api/show, если загружен. */
  modelInfo?: Record<string, unknown> | null
  /** Подсказка вендора по требуемой видеопамяти (из каталога Ollama). */
  vramHintBytes?: number | null
  /** Модель считается в облаке — локальная память не тратится. */
  isCloud?: boolean
  /** Замеры прошлых загрузок этой модели. Две точки и больше дают точный прогноз. */
  calibrationSamples?: readonly CalibrationSample[]
  /** Состояние прямо сейчас: модель загружена, /api/ps показал факт. */
  loaded?: { sizeBytes: number; sizeVramBytes: number } | null
}

export function computeFit(input: ComputeFitInput): FitVerdict {
  const { contextLength, hardware, modelBytes, isCloud } = input
  const usableBytes = hardware.usableMemoryBytes

  if (isCloud) {
    return {
      level: 'green',
      summary: 'Считается в облаке Ollama — локальная память не расходуется',
      contextLength,
      modelBytes: 0,
      kvCacheBytes: 0,
      requiredBytes: 0,
      usableBytes,
      utilization: 0,
      basis: 'vendor_hint',
      measured: null,
    }
  }

  /*
   * Модель загружена прямо сейчас и ровно с тем окном, про которое спрашивают, —
   * это не прогноз, а факт. Здесь же видно, не свалилась ли часть слоёв на CPU.
   */
  if (input.loaded) {
    const { sizeBytes, sizeVramBytes } = input.loaded
    const gpuPercent = sizeBytes > 0 ? Math.round((sizeVramBytes / sizeBytes) * 100) : 0
    const utilization = usableBytes > 0 ? sizeBytes / usableBytes : 0
    const fullyOnGpu = gpuPercent >= 99

    let level: FitLevel
    let summary: string
    if (!fullyOnGpu) {
      level = 'red'
      summary = `Только ${gpuPercent}% на ускорителе, остальное считает CPU — будет медленно`
    } else if (utilization < GREEN_UTILIZATION) {
      level = 'green'
      summary = `Загружена целиком на ускоритель, занимает ${formatGb(sizeBytes)}`
    } else {
      level = 'yellow'
      summary = `Влезла на ускоритель, но занимает ${formatGb(sizeBytes)} из ${formatGb(usableBytes)} — запаса почти нет`
    }

    return {
      level,
      summary,
      contextLength,
      modelBytes,
      kvCacheBytes: Math.max(0, sizeBytes - modelBytes),
      requiredBytes: sizeBytes,
      usableBytes,
      utilization,
      basis: 'measured',
      measured: {
        sizeBytes,
        gpuPercent,
        processorLabel: fullyOnGpu ? '100% GPU' : `${gpuPercent}% GPU / ${100 - gpuPercent}% CPU`,
      },
    }
  }

  // Калибровка по прошлым загрузкам — точнее любой формулы.
  const calibration = calibrate(input.calibrationSamples ?? [])
  if (calibration) {
    const requiredBytes = Math.round(
      calibration.baseBytes + calibration.bytesPerToken * contextLength,
    )
    const utilization = usableBytes > 0 ? requiredBytes / usableBytes : Number.POSITIVE_INFINITY
    const level = levelFor(utilization)

    return {
      level,
      summary: summarize(level, requiredBytes, usableBytes),
      contextLength,
      modelBytes,
      kvCacheBytes: Math.max(0, requiredBytes - modelBytes),
      requiredBytes,
      usableBytes,
      utilization,
      basis: 'measured',
      measured: null,
    }
  }

  const archParams = extractArchParams(input.modelInfo)
  if (archParams) {
    const kvCacheBytes = estimateKvCacheBytes(archParams, contextLength)
    const requiredBytes = modelBytes + kvCacheBytes
    const utilization = usableBytes > 0 ? requiredBytes / usableBytes : Number.POSITIVE_INFINITY
    const level = levelFor(utilization)

    return {
      level,
      summary: summarize(level, requiredBytes, usableBytes),
      contextLength,
      modelBytes,
      kvCacheBytes,
      requiredBytes,
      usableBytes,
      utilization,
      basis: 'estimate',
      measured: null,
    }
  }

  if (input.vramHintBytes) {
    const requiredBytes = input.vramHintBytes
    const utilization = usableBytes > 0 ? requiredBytes / usableBytes : Number.POSITIVE_INFINITY
    const level = levelFor(utilization)

    return {
      level,
      summary:
        level === 'red'
          ? `По данным вендора нужно ${formatGb(requiredBytes)} видеопамяти — больше доступных ${formatGb(usableBytes)}`
          : `По данным вендора нужно ${formatGb(requiredBytes)} видеопамяти`,
      contextLength,
      modelBytes,
      kvCacheBytes: 0,
      requiredBytes,
      usableBytes,
      utilization,
      basis: 'vendor_hint',
      measured: null,
    }
  }

  return {
    level: 'unknown',
    summary: 'Недостаточно данных о модели, чтобы оценить требования к памяти',
    contextLength,
    modelBytes,
    kvCacheBytes: 0,
    requiredBytes: modelBytes,
    usableBytes,
    utilization: usableBytes > 0 ? modelBytes / usableBytes : 0,
    basis: 'estimate',
    measured: null,
  }
}
