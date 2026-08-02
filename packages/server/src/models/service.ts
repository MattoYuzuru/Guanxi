/**
 * Слой моделей: превращает сырые ответы Ollama в контрактные типы и навешивает
 * вердикт по железу.
 *
 * Здесь же живёт калибровка: каждая загрузка модели даёт точку «окно → память»,
 * и со второй точки вердикт для этой модели считается по факту, а не по формуле.
 */
import type {
  LocalModel,
  ModelCapability,
  ModelDetail,
  RunningModel,
  HardwareInfo,
} from '@alamo/contract'
import { computeFit } from '../hardware/fit.ts'
import type { OllamaClient } from '../ollama/client.ts'
import type { OllamaTagsEntry } from '../ollama/types.ts'
import type { CalibrationStore } from '../store/calibration.ts'

const KNOWN_CAPABILITIES = new Set<ModelCapability>([
  'completion',
  'tools',
  'vision',
  'insert',
  'thinking',
  'embedding',
])

/** Размеры окна, для которых считаем вердикт в профиле модели. */
const PROFILE_CONTEXT_STEPS = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072]

function toCapabilities(raw: readonly string[] | undefined): ModelCapability[] {
  if (!raw) return []
  return raw.filter((item): item is ModelCapability => KNOWN_CAPABILITIES.has(item as ModelCapability))
}

/** Облачные модели помечены суффиксом тега. Локальную память они не расходуют. */
function isCloudModel(name: string): boolean {
  return name.endsWith(':cloud') || name.includes(':cloud-')
}

function contextLengthOf(entry: OllamaTagsEntry): number {
  return entry.details.context_length ?? 4_096
}

export class ModelService {
  private readonly client: OllamaClient
  private readonly calibration: CalibrationStore
  private readonly hardware: HardwareInfo
  /** Кэш /api/show: архитектурные параметры не меняются, а запрос не бесплатный. */
  private readonly showCache = new Map<string, Record<string, unknown>>()

  constructor(client: OllamaClient, calibration: CalibrationStore, hardware: HardwareInfo) {
    this.client = client
    this.calibration = calibration
    this.hardware = hardware
  }

  private async modelInfo(name: string): Promise<Record<string, unknown> | null> {
    const cached = this.showCache.get(name)
    if (cached) return cached

    try {
      const shown = await this.client.show(name)
      const info = shown.model_info ?? null
      if (info) this.showCache.set(name, info)
      return info
    } catch {
      return null
    }
  }

  /**
   * Список локальных моделей с вердиктом по железу.
   *
   * Загруженные прямо сейчас модели попутно дают точку калибровки — так вердикт
   * уточняется сам, без отдельного действия пользователя.
   */
  async listLocal(contextLength: number): Promise<LocalModel[]> {
    const [tags, running] = await Promise.all([
      this.client.tags(),
      // Installed state belongs to /api/tags. A failed /api/ps sample removes
      // optional loaded-instance calibration, but must not erase installed rows.
      this.ps().catch(() => []),
    ])
    const loadedByName = new Map(running.map((entry) => [entry.name, entry]))

    for (const entry of running) {
      if (entry.contextLength !== null && entry.sizeVramBytes !== null) {
        this.calibration.record(
          entry.name,
          entry.contextLength,
          entry.sizeBytes,
          entry.sizeVramBytes,
        )
      }
    }

    const samplesByModel = this.calibration.allSamples()

    return Promise.all(
      tags.models.map(async (entry) => {
        const isCloud = isCloudModel(entry.name)
        const loaded = loadedByName.get(entry.name)
        const info = isCloud ? null : await this.modelInfo(entry.name)

        return {
          name: entry.name,
          digest: entry.digest,
          sizeBytes: entry.size,
          modifiedAt: entry.modified_at,
          family: entry.details.family ?? 'unknown',
          parameterSize: entry.details.parameter_size ?? '—',
          quantization: entry.details.quantization_level ?? '—',
          contextLength: contextLengthOf(entry),
          capabilities: toCapabilities(entry.capabilities),
          isCloud,
          fit: computeFit({
            contextLength,
            hardware: this.hardware,
            modelBytes: entry.size,
            modelInfo: info,
            isCloud,
            calibrationSamples: samplesByModel.get(entry.name) ?? [],
            // Факт учитываем, только если модель загружена именно с этим окном.
            loaded:
              loaded &&
                loaded.contextLength === contextLength &&
                loaded.sizeVramBytes !== null
                ? { sizeBytes: loaded.sizeBytes, sizeVramBytes: loaded.sizeVramBytes }
                : null,
          }),
        }
      }),
    )
  }

  async detail(name: string, contextLength: number): Promise<ModelDetail | null> {
    const tags = await this.client.tags()
    const entry = tags.models.find((model) => model.name === name)
    if (!entry) return null

    const shown = await this.client.show(name).catch(() => null)
    const info = shown?.model_info ?? null
    const isCloud = isCloudModel(name)
    const samples = this.calibration.samples(name)

    const fitFor = (ctx: number) =>
      computeFit({
        contextLength: ctx,
        hardware: this.hardware,
        modelBytes: entry.size,
        modelInfo: info,
        isCloud,
        calibrationSamples: samples,
      })

    const maxContext = contextLengthOf(entry)

    return {
      name: entry.name,
      digest: entry.digest,
      sizeBytes: entry.size,
      modifiedAt: entry.modified_at,
      family: entry.details.family ?? 'unknown',
      parameterSize: entry.details.parameter_size ?? '—',
      quantization: entry.details.quantization_level ?? '—',
      contextLength: maxContext,
      capabilities: toCapabilities(entry.capabilities ?? shown?.capabilities),
      isCloud,
      fit: fitFor(contextLength),
      modelInfo: (info ?? {}) as ModelDetail['modelInfo'],
      template: shown?.template ?? null,
      systemPrompt: shown?.system ?? null,
      license: shown?.license ?? null,
      // Слайдер в профиле показывает только достижимые для этой модели окна.
      fitByContext: PROFILE_CONTEXT_STEPS.filter((ctx) => ctx <= maxContext).map(fitFor),
    }
  }

  async ps(): Promise<RunningModel[]> {
    const observedAt = new Date().toISOString()
    const response = await this.client.ps()

    return response.models.map((entry) => {
      const sizeVram = entry.size_vram ?? null

      return {
        name: entry.name,
        digest: entry.digest,
        sizeBytes: entry.size,
        sizeVramBytes: sizeVram,
        // Retained nullable compatibility fields. `/api/ps` does not provide
        // these labels, so the running-source projection does not invent them.
        gpuPercent: null,
        processorLabel: null,
        contextLength: entry.context_length ?? null,
        expiresAt: entry.expires_at ?? null,
        source: 'ollama_api_ps' as const,
        observedAt,
      }
    })
  }

  /**
   * Загружает модель с нужным окном и возвращает факт: сколько заняла и не ушла ли
   * часть на CPU. Заодно записывает точку калибровки.
   */
  async warm(
    name: string,
    contextLength: number,
    signal?: AbortSignal,
  ): Promise<{ running: RunningModel; fit: LocalModel['fit'] } | null> {
    await this.client.warm(name, contextLength, '10m', signal)

    const running = (await this.ps()).find((entry) => entry.name === name)
    if (!running) return null

    if (running.contextLength !== null && running.sizeVramBytes !== null) {
      this.calibration.record(
        name,
        running.contextLength,
        running.sizeBytes,
        running.sizeVramBytes,
      )
    }

    const tags = await this.client.tags()
    const entry = tags.models.find((model) => model.name === name)

    return {
      running,
      fit: computeFit({
        contextLength: running.contextLength ?? contextLength,
        hardware: this.hardware,
        modelBytes: entry?.size ?? running.sizeBytes,
        isCloud: isCloudModel(name),
        loaded:
          running.sizeVramBytes === null
            ? null
            : { sizeBytes: running.sizeBytes, sizeVramBytes: running.sizeVramBytes },
      }),
    }
  }

  /** Поддерживает ли модель структурный tool-calling. */
  async supportsTools(name: string): Promise<boolean> {
    const tags = await this.client.tags().catch(() => null)
    const entry = tags?.models.find((model) => model.name === name)
    return toCapabilities(entry?.capabilities).includes('tools')
  }
}
