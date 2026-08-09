import type {
  ListRunningResponse,
  RunningModel,
  RuntimeCurrentFit,
  RuntimeGovernorSnapshot,
  RuntimeHostTelemetry,
  RuntimeModelObservation,
  RuntimeReconciliationDecision,
  RuntimeSnapshot,
  RuntimeSourceErrorCode,
  RuntimeSourceHealth,
  ModelObservationKey,
  HardwareInfo,
} from '@alamo/contract'
import type { HostTelemetry } from '../hardware/telemetry.ts'
import {
  alignHostTelemetryObservedAt,
  unavailableHostTelemetry,
} from '../hardware/telemetry.ts'
import type { InstalledArtifactIdentity } from './observation-key.ts'
import {
  normalizeOllamaModelReference,
  resolveRuntimeObservationKey,
} from './observation-key.ts'
import {
  OllamaError,
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from '../ollama/client.ts'
import type {
  ModelResourceRequest,
  ResourceGovernor,
  ResourceGovernorSnapshot,
  ResourceOwner,
} from './resource-governor.ts'

const INVALID_MODEL_REFERENCE = '[invalid_model_reference]'
const INVALID_OWNER_ID = '[redacted]'

interface ReconciliationOutcome {
  snapshot: RuntimeSnapshot
  runtimeHost: string | null
  compatibilityModels: RunningModel[] | null
  error: unknown | null
}

export interface RuntimeSnapshotWithIdentity {
  snapshot: RuntimeSnapshot
  /** Server-internal endpoint identity; never included in the public projection. */
  runtimeHost: string | null
}

export interface RuntimeReconciliationOptions {
  governor: ResourceGovernor
  hostTelemetry: HostTelemetry
  models(): RuntimeModelSource
  now?: () => Date
}

export interface RuntimeModelSource {
  ps(signal?: AbortSignal): Promise<RunningModel[]>
  installedArtifacts?(signal?: AbortSignal): Promise<readonly InstalledArtifactIdentity[]>
  runtimeVersion?(signal?: AbortSignal): Promise<string>
  readonly runtimeHost?: string
  readonly hardwareProfile?: HardwareInfo
}

export interface RuntimeSnapshotOptions {
  signal?: AbortSignal
}

function abortError(): Error {
  const error = new Error('Runtime snapshot request was cancelled')
  error.name = 'AbortError'
  return error
}

export { normalizeOllamaModelReference } from './observation-key.ts'

function safeOwner(owner: ResourceOwner): ResourceOwner {
  if (owner.kind === 'job') {
    return {
      kind: 'job',
      jobId: /^[a-zA-Z0-9:_-]+$/u.test(owner.jobId) ? owner.jobId : INVALID_OWNER_ID,
    }
  }
  return {
    kind: 'operation',
    operationId: /^[a-zA-Z0-9:_-]+$/u.test(owner.operationId)
      ? owner.operationId
      : INVALID_OWNER_ID,
  }
}

function safeModel(model: ModelResourceRequest): ModelResourceRequest {
  return {
    provider: 'ollama',
    name: normalizeOllamaModelReference(model.name) ?? INVALID_MODEL_REFERENCE,
  }
}

function publicGovernorSnapshot(
  snapshot: ResourceGovernorSnapshot,
): RuntimeGovernorSnapshot {
  return {
    ...snapshot,
    policy: {
      ...snapshot.policy,
      priorities: ['normal', 'prewarm'],
    },
    queued: snapshot.queued.map((entry) => ({
      ...entry,
      owner: safeOwner(entry.owner),
      model: safeModel(entry.model),
    })),
    activeLease: snapshot.activeLease
      ? {
          ...snapshot.activeLease,
          owner: safeOwner(snapshot.activeLease.owner),
          model: safeModel(snapshot.activeLease.model),
        }
      : null,
    lastDecision: snapshot.lastDecision
      ? {
          ...snapshot.lastDecision,
          owner: snapshot.lastDecision.owner ? safeOwner(snapshot.lastDecision.owner) : null,
          model: snapshot.lastDecision.model ? safeModel(snapshot.lastDecision.model) : null,
        }
      : null,
  }
}

function sourceFailure(error: unknown, observedAt: string): RuntimeSourceHealth {
  if (error instanceof OllamaProtocolError) {
    return {
      state: 'incompatible',
      source: 'ollama_api_ps',
      observedAt,
      errorCode: 'runtime_protocol',
    }
  }

  let errorCode: Exclude<RuntimeSourceErrorCode, 'runtime_protocol'> = 'internal_error'
  if (error instanceof OllamaTimeoutError) {
    errorCode =
      error.phase === 'connect'
        ? 'ollama_connect_timeout'
        : error.phase === 'load'
          ? 'ollama_load_timeout'
          : 'ollama_stream_idle_timeout'
  } else if (error instanceof OllamaUnavailableError) {
    errorCode = 'ollama_unavailable'
  } else if (error instanceof OllamaError) {
    errorCode = 'upstream_error'
  }

  return { state: 'unavailable', source: 'ollama_api_ps', observedAt, errorCode }
}

function decision(
  input: Partial<RuntimeReconciliationDecision> &
    Pick<RuntimeReconciliationDecision, 'code'>,
): RuntimeReconciliationDecision {
  return {
    code: input.code,
    modelName: input.modelName ?? null,
    normalizedModelName: input.normalizedModelName ?? null,
    leaseId: input.leaseId ?? null,
    owner: input.owner ?? null,
    runtimeDigest: input.runtimeDigest ?? null,
    requestedContext: input.requestedContext ?? null,
    observedContext: input.observedContext ?? null,
    identityBasis: input.identityBasis ?? 'none',
    observationKey: input.observationKey ?? {
      state: 'unavailable',
      version: 1,
      reason: 'legacy_snapshot',
    },
    artifactIdentity: input.artifactIdentity ?? 'unknown',
  }
}

function reconcileModels(
  running: readonly RunningModel[],
  governor: RuntimeGovernorSnapshot,
  host: RuntimeHostTelemetry,
  observedAt: string,
  identity: {
    installed: readonly InstalledArtifactIdentity[] | null
    runtimeVersion: string | null
    runtimeHost: string
    hardware: HardwareInfo
  },
): { models: RuntimeModelObservation[]; decisions: RuntimeReconciliationDecision[] } {
  const active = governor.activeLease
  const activeReference = active
    ? normalizeOllamaModelReference(active.model.name)
    : null
  let activeMatched = false
  const normalizedCounts = new Map<string, number>()
  for (const raw of running) {
    const normalized = normalizeOllamaModelReference(raw.name)
    if (normalized) normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1)
  }
  const decisions: RuntimeReconciliationDecision[] = []
  const models = running.map((raw): RuntimeModelObservation => {
    const normalizedName = normalizeOllamaModelReference(raw.name)
    const ambiguousReference = Boolean(
      normalizedName && (normalizedCounts.get(normalizedName) ?? 0) > 1,
    )
    const matched = Boolean(
      !activeMatched &&
        !ambiguousReference &&
        active &&
        activeReference &&
        normalizedName === activeReference,
    )
    if (matched) activeMatched = true
    const modelName = normalizedName ? raw.name.trim() : INVALID_MODEL_REFERENCE
    const owner = matched && active ? active.owner : null
    const observationKey = resolveRuntimeObservationKey({
      running: raw,
      runningRows: running,
      installed: identity.installed,
      runtimeVersion: identity.runtimeVersion,
      runtimeHost: identity.runtimeHost,
      hardware: identity.hardware,
    })
    const model: RuntimeModelObservation = {
      ...raw,
      name: modelName,
      source: 'ollama_api_ps',
      observedAt,
      normalizedName: normalizedName ?? INVALID_MODEL_REFERENCE,
      ownerState: matched ? 'active_lease' : 'unknown',
      leaseId: matched && active ? active.leaseId : null,
      owner,
      decisionCode: matched ? 'matched_active_lease' : 'observed_unknown_owner',
      identityBasis: matched
        ? 'exact_normalized_model_reference'
        : 'runtime_observation_only',
      observationKey,
      artifactIdentity: observationKey.state === 'complete' ? 'exact_digest' : 'unknown',
      currentFit: currentFitFor({
        model: raw,
        active: matched ? active : null,
        host,
        observedAt,
        ambiguousReference,
        observationKey,
      }),
    }
    decisions.push(
      decision({
        code: model.decisionCode,
        modelName: model.name,
        normalizedModelName: model.normalizedName,
        leaseId: model.leaseId,
        owner,
        runtimeDigest: model.digest,
        requestedContext: matched && active ? active.requestedContext : null,
        observedContext: model.contextLength,
        identityBasis: model.identityBasis,
        observationKey,
        artifactIdentity: model.artifactIdentity,
      }),
    )
    return model
  })

  if (active && !activeMatched) {
    decisions.push(
      decision({
        code: 'active_not_observed',
        modelName: active.model.name,
        normalizedModelName: normalizeOllamaModelReference(active.model.name),
        leaseId: active.leaseId,
        owner: active.owner,
        requestedContext: active.requestedContext,
        identityBasis: 'exact_normalized_model_reference',
      }),
    )
  }
  if (models.length === 0) decisions.push(decision({ code: 'empty_sample' }))

  return { models, decisions }
}

function currentFitFor(input: {
  model: RunningModel
  active: RuntimeGovernorSnapshot['activeLease']
  host: RuntimeHostTelemetry
  observedAt: string
  ambiguousReference: boolean
  observationKey: ModelObservationKey
}): RuntimeCurrentFit {
  const base = {
    observedAt: input.observedAt,
    requestedContext: input.active?.requestedContext ?? null,
    observedContext: input.model.contextLength,
    runtimeAllocationBytes: input.model.sizeBytes,
    runtimeAcceleratorAllocationBytes: input.model.sizeVramBytes,
    pressureLevel: input.host.sample.pressure.level,
    futureAdmissionGuarantee: false as const,
  }
  const unknown = (reason: Exclude<RuntimeCurrentFit['reason'], 'observed_current_residency'>) => ({
    ...base,
    state: 'unknown' as const,
    basis: 'insufficient_evidence' as const,
    reason,
  })

  if (input.ambiguousReference) return unknown('runtime_reference_ambiguous')
  if (!input.active) return unknown('runtime_owner_unknown')
  if (input.model.digest === null) return unknown('runtime_digest_missing')
  if (input.model.contextLength === null) return unknown('runtime_context_missing')
  if (input.observationKey.state !== 'complete') {
    return unknown('observation_key_unavailable')
  }
  if (input.active.requestedContext !== input.model.contextLength) {
    return unknown('runtime_context_mismatch')
  }
  if (
    input.host.state === 'unsupported' ||
    input.host.profile.platform !== 'darwin' ||
    input.host.profile.arch !== 'arm64' ||
    !input.host.profile.unifiedMemory
  ) {
    return unknown('host_unsupported')
  }
  if (input.host.state === 'unavailable') return unknown('host_unavailable')
  if (input.host.state === 'partial') return unknown('host_partial')
  if (input.host.sample.pressure.level === 'unknown') return unknown('host_pressure_unknown')
  if (input.host.sample.pressure.level !== 'normal') return unknown('host_pressure_elevated')
  if (
    input.host.sample.availableMemoryBytes.bytes === null ||
    input.host.sample.availableMemoryBytes.confidence !== 'observed'
  ) {
    return unknown('host_available_memory_unknown')
  }

  return {
    ...base,
    state: 'observed',
    basis: 'current_loaded_configuration',
    reason: 'observed_current_residency',
  }
}

/**
 * One sampled application boundary for public runtime projections.
 *
 * A provider call is shared only while it is pending. Caller cancellation stops
 * that caller's wait, never the shared sample, and no completed history/cache is
 * retained. Governor state is captured after provider and host sources settle;
 * that capture is the snapshot linearization point and shares one `observedAt`
 * with every projected fact.
 */
export class RuntimeReconciliationService {
  private readonly governor: ResourceGovernor
  private readonly hostTelemetry: HostTelemetry
  private readonly models: () => RuntimeModelSource
  private readonly now: () => Date
  private inFlight: Promise<ReconciliationOutcome> | null = null

  constructor(options: RuntimeReconciliationOptions) {
    this.governor = options.governor
    this.hostTelemetry = options.hostTelemetry
    this.models = options.models
    this.now = options.now ?? (() => new Date())
  }

  get sampling(): boolean {
    return this.inFlight !== null
  }

  async snapshot(options: RuntimeSnapshotOptions = {}): Promise<RuntimeSnapshot> {
    return (await this.waitForOutcome(options.signal)).snapshot
  }

  async snapshotWithIdentity(
    options: RuntimeSnapshotOptions = {},
  ): Promise<RuntimeSnapshotWithIdentity> {
    const outcome = await this.waitForOutcome(options.signal)
    return { snapshot: outcome.snapshot, runtimeHost: outcome.runtimeHost }
  }

  async runningModels(options: RuntimeSnapshotOptions = {}): Promise<ListRunningResponse> {
    const outcome = await this.waitForOutcome(options.signal)
    if (outcome.error) throw outcome.error
    return {
      models: outcome.compatibilityModels ?? [],
      observedAt: outcome.snapshot.observedAt,
    }
  }

  private sharedOutcome(): Promise<ReconciliationOutcome> {
    if (this.inFlight) return this.inFlight
    const flight = this.reconcileOnce()
    this.inFlight = flight
    void flight.then(
      () => {
        if (this.inFlight === flight) this.inFlight = null
      },
      () => {
        if (this.inFlight === flight) this.inFlight = null
      },
    )
    return flight
  }

  private waitForOutcome(signal?: AbortSignal): Promise<ReconciliationOutcome> {
    if (signal?.aborted) return Promise.reject(abortError())
    const flight = this.sharedOutcome()
    if (!signal) return flight

    return new Promise<ReconciliationOutcome>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort)
        reject(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void flight.then(
        (outcome) => {
          signal.removeEventListener('abort', onAbort)
          resolve(outcome)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private async reconcileOnce(): Promise<ReconciliationOutcome> {
    const modelSource = this.models()
    const [runtimeResult, hostResult, installedResult, versionResult] = await Promise.allSettled([
      modelSource.ps(),
      this.hostTelemetry.sample(),
      modelSource.installedArtifacts?.() ?? Promise.reject(new Error('installed source unavailable')),
      modelSource.runtimeVersion?.() ?? Promise.reject(new Error('runtime version unavailable')),
    ])
    const observedAt = this.now().toISOString()
    const host = alignHostTelemetryObservedAt(
      hostResult.status === 'fulfilled'
        ? hostResult.value
        : unavailableHostTelemetry(this.hostTelemetry.profile, observedAt),
      observedAt,
    )
    const governor = publicGovernorSnapshot(this.governor.snapshot(observedAt))

    if (runtimeResult.status === 'rejected') {
      return {
        runtimeHost: modelSource.runtimeHost ?? null,
        snapshot: {
          observedAt,
          source: sourceFailure(runtimeResult.reason, observedAt),
          host,
          governor,
          models: null,
          decisions: [decision({ code: 'source_failure' })],
        },
        compatibilityModels: null,
        error: runtimeResult.reason,
      }
    }

    const running = runtimeResult.value
    const compatibilityModels = running.map((model) => ({ ...model, observedAt }))
    const reconciled = reconcileModels(compatibilityModels, governor, host, observedAt, {
      installed: installedResult.status === 'fulfilled' ? installedResult.value : null,
      runtimeVersion: versionResult.status === 'fulfilled' ? versionResult.value : null,
      runtimeHost: modelSource.runtimeHost ?? '',
      hardware: modelSource.hardwareProfile ?? this.hostTelemetry.profile,
    })
    return {
      runtimeHost: modelSource.runtimeHost ?? null,
      snapshot: {
        observedAt,
        source: {
          state: 'available',
          source: 'ollama_api_ps',
          observedAt,
          errorCode: null,
        },
        host,
        governor,
        models: reconciled.models,
        decisions: reconciled.decisions,
      },
      compatibilityModels,
      error: null,
    }
  }
}
