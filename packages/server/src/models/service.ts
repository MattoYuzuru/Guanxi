/**
 * Слой моделей: превращает сырые ответы Ollama в контрактные типы и навешивает
 * вердикт по железу.
 *
 * Здесь же живёт калибровка: только доказанное exact-соответствие artifact,
 * context, runtime/backend и hardware даёт отдельную точку «окно → память».
 */
import {
  DEFAULT_NUM_CTX,
  type HardwareInfo,
  type LocalModel,
  type ModelContextLimit,
  type ModelCapability,
  type ModelDetail,
  type RunningModel,
} from '@alamo/contract'
import { computeFit } from '../hardware/fit.ts'
import type { OllamaClient } from '../ollama/client.ts'
import type { OllamaShowResponse, OllamaTagsEntry } from '../ollama/types.ts'
import {
  buildCompleteObservationKey,
  normalizeOllamaModelReference,
  resolveRuntimeObservationKey,
  type InstalledArtifactIdentity,
} from '../runtime/observation-key.ts'
import type { CalibrationStore } from '../store/calibration.ts'

const KNOWN_CAPABILITIES = new Set<ModelCapability>([
  'completion',
  'tools',
  'vision',
  'insert',
  'thinking',
  'embedding',
])

/** Suggested checkpoints, never a whitelist or a product limit. */
const PROFILE_CONTEXT_STEPS = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072]
export const MODEL_SHOW_CACHE_MAX_ENTRIES = 64
export const MODEL_SHOW_MAX_CONCURRENCY = 4

export class ModelContextLimitExceededError extends Error {
  readonly model: string
  readonly requestedContext: number
  readonly limit: Extract<ModelContextLimit, { state: 'declared' }>

  constructor(
    model: string,
    requestedContext: number,
    limit: Extract<ModelContextLimit, { state: 'declared' }>,
  ) {
    super(`Requested context ${requestedContext} exceeds the declared model limit ${limit.value}`)
    this.name = 'ModelContextLimitExceededError'
    this.model = model
    this.requestedContext = requestedContext
    this.limit = limit
  }
}

function toCapabilities(raw: readonly string[] | undefined): ModelCapability[] {
  if (!raw) return []
  return raw.filter((item): item is ModelCapability => KNOWN_CAPABILITIES.has(item as ModelCapability))
}

/** Облачные модели помечены суффиксом тега. Локальную память они не расходуют. */
function isCloudModel(name: string): boolean {
  return name.endsWith(':cloud') || name.includes(':cloud-')
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function contextLimitOf(
  entry: OllamaTagsEntry,
  shown: OllamaShowResponse | null,
  observedAt: string,
  shownObservedAt = observedAt,
): ModelContextLimit {
  const tagged = positiveSafeInteger(entry.details.context_length)
    ? entry.details.context_length
    : null
  const shownCandidates = [
    shown?.details?.context_length,
    ...Object.entries(shown?.model_info ?? {})
      .filter(([key]) => key.endsWith('.context_length'))
      .map(([, value]) => value),
  ].filter(positiveSafeInteger)
  const distinct = [...new Set([...(tagged === null ? [] : [tagged]), ...shownCandidates])]

  if (distinct.length === 1 && tagged !== null) {
    return {
      state: 'declared',
      value: tagged,
      source: 'ollama_api_tags',
      observedAt,
      confidence: 'declared',
    }
  }
  if (distinct.length === 1) {
    return {
      state: 'declared',
      value: distinct[0]!,
      source: 'ollama_api_show',
      observedAt: shownObservedAt,
      confidence: 'declared',
    }
  }

  return {
    state: 'unknown',
    value: null,
    source: distinct.length > 1 ? 'conflicting_provider_declarations' : 'not_reported',
    observedAt,
    confidence: 'unknown',
  }
}

interface ModelDetailsObservation {
  details: OllamaShowResponse
  observedAt: string
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next
        next += 1
        output[index] = await map(values[index]!)
      }
    },
  )
  await Promise.all(workers)
  return output
}

export class ModelService {
  private readonly client: OllamaClient
  private readonly calibration: CalibrationStore
  private readonly hardware: HardwareInfo
  /** One retained digest per normalized reference, with a bounded LRU across references. */
  private readonly showCache = new Map<
    string,
    { digest: string; details: OllamaShowResponse; observedAt: string }
  >()

  constructor(client: OllamaClient, calibration: CalibrationStore, hardware: HardwareInfo) {
    this.client = client
    this.calibration = calibration
    this.hardware = hardware
  }

  private async modelDetails(
    name: string,
    digest: string,
    signal?: AbortSignal,
  ): Promise<ModelDetailsObservation | null> {
    const normalized = normalizeOllamaModelReference(name)
    if (!normalized) return null
    const cached = this.showCache.get(normalized)
    if (cached?.digest === digest) {
      this.showCache.delete(normalized)
      this.showCache.set(normalized, cached)
      return cached
    }
    if (cached) this.showCache.delete(normalized)

    try {
      const shown = await this.client.show(name, signal)
      const observedAt = new Date().toISOString()
      const observation = { details: shown, observedAt }
      if (shown.model_info) {
        this.showCache.set(normalized, { digest, ...observation })
        while (this.showCache.size > MODEL_SHOW_CACHE_MAX_ENTRIES) {
          const oldest = this.showCache.keys().next().value
          if (oldest === undefined) break
          this.showCache.delete(oldest)
        }
      }
      return observation
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  private async runtimeVersionOrNull(signal?: AbortSignal): Promise<string | null> {
    try {
      return await this.client.version(signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return null
    }
  }

  get runtimeHost(): string {
    return this.client.host
  }

  get hardwareProfile(): HardwareInfo {
    return this.hardware
  }

  async installedArtifacts(signal?: AbortSignal): Promise<InstalledArtifactIdentity[]> {
    const tags = await this.client.tags(signal)
    return tags.models.map((entry) => ({ name: entry.name, digest: entry.digest }))
  }

  runtimeVersion(signal?: AbortSignal): Promise<string> {
    return this.client.version(signal)
  }

  /**
   * Список локальных моделей с вердиктом по железу.
   *
   * Загруженная модель попутно даёт точку калибровки, только когда `/api/tags`
   * и `/api/ps` однозначно доказывают один и тот же exact artifact.
   */
  async listLocal(contextLength: number, signal?: AbortSignal): Promise<LocalModel[]> {
    const [tags, runningResult, versionResult] = await Promise.all([
      this.client.tags(signal),
      // Installed state belongs to /api/tags. A failed /api/ps sample removes
      // optional loaded-instance calibration, but must not erase installed rows.
      this.ps(signal).then(
        (running) => ({ state: 'available' as const, running }),
        (error: unknown) => {
          if (signal?.aborted) throw error
          return { state: 'unavailable' as const, running: [] as RunningModel[] }
        },
      ),
      this.runtimeVersionOrNull(signal),
    ])
    const running = runningResult.running
    const runtimeVersion = versionResult
    const observedAt = new Date().toISOString()
    const installed = tags.models.map((entry) => ({ name: entry.name, digest: entry.digest }))
    const installedReferenceCounts = new Map<string, number>()
    for (const entry of installed) {
      const normalized = normalizeOllamaModelReference(entry.name)
      if (normalized) {
        installedReferenceCounts.set(
          normalized,
          (installedReferenceCounts.get(normalized) ?? 0) + 1,
        )
      }
    }
    const observationKeys = new Map<string, ReturnType<typeof resolveRuntimeObservationKey>>()

    for (const entry of running) {
      const key = resolveRuntimeObservationKey({
        running: entry,
        runningRows: running,
        installed,
        runtimeVersion,
        runtimeHost: this.client.host,
        hardware: this.hardware,
      })
      const normalized = normalizeOllamaModelReference(entry.name)
      if (normalized) observationKeys.set(normalized, key)
      if (entry.sizeVramBytes !== null) {
        this.calibration.record(key, entry.sizeBytes, entry.sizeVramBytes, entry.observedAt ?? undefined)
      }
    }

    return mapConcurrent(
      tags.models,
      MODEL_SHOW_MAX_CONCURRENCY,
      async (entry) => {
        const isCloud = isCloudModel(entry.name)
        const normalized = normalizeOllamaModelReference(entry.name)
        const matchingRunning = running.filter(
          (row) => normalized && normalizeOllamaModelReference(row.name) === normalized,
        )
        const loaded = matchingRunning.length === 1 ? matchingRunning[0] : undefined
        const observationKey = normalized ? observationKeys.get(normalized) : undefined
        const lookupKey =
          normalized && installedReferenceCounts.get(normalized) === 1
            ? buildCompleteObservationKey({
                normalizedModelReference: entry.name,
                artifactDigest: entry.digest,
                contextLength,
                runtimeVersion,
                runtimeHost: this.client.host,
                hardware: this.hardware,
              })
            : {
                state: 'unavailable' as const,
                version: 1 as const,
                reason: 'installed_reference_ambiguous' as const,
              }
        const shownObservation = isCloud
          ? null
          : await this.modelDetails(entry.name, entry.digest, signal)
        const shown = shownObservation?.details ?? null
        const info = shown?.model_info ?? null
        const contextLimit = contextLimitOf(
          entry,
          shown,
          observedAt,
          shownObservation?.observedAt,
        )

        return {
          name: entry.name,
          digest: entry.digest,
          sizeBytes: entry.size,
          modifiedAt: entry.modified_at,
          family: entry.details.family ?? 'unknown',
          parameterSize: entry.details.parameter_size ?? '—',
          quantization: entry.details.quantization_level ?? '—',
          contextLength:
            contextLimit.state === 'declared' ? contextLimit.value : contextLength,
          contextLimit,
          capabilities: toCapabilities(entry.capabilities),
          isCloud,
          fit: computeFit({
            contextLength,
            hardware: this.hardware,
            modelBytes: entry.size,
            modelInfo: info,
            isCloud,
            calibrationSamples: this.calibration.samples(lookupKey),
            // Факт учитываем, только если модель загружена именно с этим окном.
            loaded:
              loaded &&
                observationKey?.state === 'complete' &&
                observationKey.components.artifactDigest === entry.digest &&
                loaded.contextLength === contextLength &&
                loaded.sizeVramBytes !== null
                ? { sizeBytes: loaded.sizeBytes, sizeVramBytes: loaded.sizeVramBytes }
                : null,
          }),
        }
      },
    )
  }

  async detail(
    name: string,
    contextLength?: number,
    signal?: AbortSignal,
  ): Promise<ModelDetail | null> {
    const [tags, runtimeVersion] = await Promise.all([
      this.client.tags(signal),
      this.runtimeVersionOrNull(signal),
    ])
    const exactEntries = tags.models.filter((model) => model.name === name)
    if (exactEntries.length !== 1) return null
    const entry = exactEntries[0]!

    const shownObservation = await this.modelDetails(name, entry.digest, signal)
    const shown = shownObservation?.details ?? null
    const info = shown?.model_info ?? null
    const isCloud = isCloudModel(name)

    const fitFor = (ctx: number) => {
      const key = buildCompleteObservationKey({
        normalizedModelReference: entry.name,
        artifactDigest: entry.digest,
        contextLength: ctx,
        runtimeVersion,
        runtimeHost: this.client.host,
        hardware: this.hardware,
      })
      return computeFit({
        contextLength: ctx,
        hardware: this.hardware,
        modelBytes: entry.size,
        modelInfo: info,
        isCloud,
        calibrationSamples: this.calibration.samples(key),
      })
    }

    const contextLimit = contextLimitOf(
      entry,
      shown,
      new Date().toISOString(),
      shownObservation?.observedAt,
    )
    if (
      contextLength !== undefined &&
      contextLimit.state === 'declared' &&
      contextLength > contextLimit.value
    ) {
      throw new ModelContextLimitExceededError(name, contextLength, contextLimit)
    }
    const selectedContext =
      contextLength ??
      (contextLimit.state === 'declared'
        ? Math.min(DEFAULT_NUM_CTX, contextLimit.value)
        : DEFAULT_NUM_CTX)
    const legacyContextLength =
      contextLimit.state === 'declared' ? contextLimit.value : selectedContext
    const profileContexts = [...new Set([
      ...PROFILE_CONTEXT_STEPS.filter(
        (value) => contextLimit.state !== 'declared' || value <= contextLimit.value,
      ),
      selectedContext,
      ...(contextLimit.state === 'declared' ? [contextLimit.value] : []),
    ])]
      .sort((left, right) => left - right)

    return {
      name: entry.name,
      digest: entry.digest,
      sizeBytes: entry.size,
      modifiedAt: entry.modified_at,
      family: entry.details.family ?? 'unknown',
      parameterSize: entry.details.parameter_size ?? '—',
      quantization: entry.details.quantization_level ?? '—',
      contextLength: legacyContextLength,
      contextLimit,
      capabilities: toCapabilities(entry.capabilities ?? shown?.capabilities),
      isCloud,
      fit: fitFor(selectedContext),
      modelInfo: (info ?? {}) as ModelDetail['modelInfo'],
      template: shown?.template ?? null,
      systemPrompt: shown?.system ?? null,
      license: shown?.license ?? null,
      // Presets aid comparison; the requested custom value is always represented.
      fitByContext: profileContexts.map(fitFor),
    }
  }

  /** Returns only provider-declared evidence; absence remains explicitly unknown. */
  async contextLimit(name: string, signal?: AbortSignal): Promise<ModelContextLimit | null> {
    const tags = await this.client.tags(signal)
    const exactEntries = tags.models.filter((model) => model.name === name)
    if (exactEntries.length !== 1) return null
    const entry = exactEntries[0]!
    const shownObservation = isCloudModel(name)
      ? null
      : await this.modelDetails(name, entry.digest, signal)
    return contextLimitOf(
      entry,
      shownObservation?.details ?? null,
      new Date().toISOString(),
      shownObservation?.observedAt,
    )
  }

  /** Unknown/unavailable provider evidence never becomes an invented rejection. */
  async assertContextAllowed(
    name: string,
    requestedContext: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let limit: ModelContextLimit | null
    try {
      limit = await this.contextLimit(name, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      return
    }
    if (limit?.state === 'declared' && requestedContext > limit.value) {
      throw new ModelContextLimitExceededError(name, requestedContext, limit)
    }
  }

  async ps(signal?: AbortSignal): Promise<RunningModel[]> {
    const observedAt = new Date().toISOString()
    const response = await this.client.ps(signal)

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

    const [runningRows, tags, runtimeVersion] = await Promise.all([
      this.ps(signal),
      this.client.tags(signal),
      this.runtimeVersionOrNull(signal),
    ])
    const normalized = normalizeOllamaModelReference(name)
    const matchingRunning = runningRows.filter(
      (row) => normalized && normalizeOllamaModelReference(row.name) === normalized,
    )
    if (matchingRunning.length !== 1) return null
    const running = matchingRunning[0]!
    const installed = tags.models.map((model) => ({ name: model.name, digest: model.digest }))
    const key = resolveRuntimeObservationKey({
      running,
      runningRows,
      installed,
      runtimeVersion,
      runtimeHost: this.client.host,
      hardware: this.hardware,
    })
    if (running.sizeVramBytes !== null) {
      this.calibration.record(key, running.sizeBytes, running.sizeVramBytes, running.observedAt ?? undefined)
    }
    const installedMatches = tags.models.filter(
      (model) => normalizeOllamaModelReference(model.name) === normalized,
    )
    const entry = installedMatches.length === 1 ? installedMatches[0] : undefined

    return {
      running,
      fit: computeFit({
        contextLength: running.contextLength ?? contextLength,
        hardware: this.hardware,
        modelBytes: key.state === 'complete' ? (entry?.size ?? running.sizeBytes) : running.sizeBytes,
        isCloud: isCloudModel(name),
        loaded:
          running.sizeVramBytes === null || key.state !== 'complete'
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
