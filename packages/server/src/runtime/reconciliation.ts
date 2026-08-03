import type {
  ListRunningResponse,
  RunningModel,
  RuntimeGovernorSnapshot,
  RuntimeModelObservation,
  RuntimeReconciliationDecision,
  RuntimeSnapshot,
  RuntimeSourceErrorCode,
  RuntimeSourceHealth,
} from '@alamo/contract'
import type { ModelService } from '../models/service.ts'
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
  compatibilityModels: RunningModel[] | null
  error: unknown | null
}

export interface RuntimeReconciliationOptions {
  governor: ResourceGovernor
  models(): ModelService
  now?: () => Date
}

export interface RuntimeSnapshotOptions {
  signal?: AbortSignal
}

function abortError(): Error {
  const error = new Error('Runtime snapshot request was cancelled')
  error.name = 'AbortError'
  return error
}

/**
 * Normalize only syntax that Ollama itself makes implicit. No family, digest,
 * or fuzzy matching is allowed at this boundary.
 */
export function normalizeOllamaModelReference(input: string): string | null {
  const normalized = input.normalize('NFKC').trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\\') ||
    /\s|[^a-z0-9._:/@-]/u.test(normalized)
  ) {
    return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null
  }
  if (normalized.includes('@')) return normalized

  const lastSlash = normalized.lastIndexOf('/')
  return normalized.lastIndexOf(':') > lastSlash ? normalized : `${normalized}:latest`
}

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
      priorities: ['normal'],
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
    artifactIdentity: 'unknown',
  }
}

function reconcileModels(
  running: readonly RunningModel[],
  governor: RuntimeGovernorSnapshot,
  observedAt: string,
): { models: RuntimeModelObservation[]; decisions: RuntimeReconciliationDecision[] } {
  const active = governor.activeLease
  const activeReference = active
    ? normalizeOllamaModelReference(active.model.name)
    : null
  let activeMatched = false
  const decisions: RuntimeReconciliationDecision[] = []
  const models = running.map((raw): RuntimeModelObservation => {
    const normalizedName = normalizeOllamaModelReference(raw.name)
    const matched = Boolean(
      !activeMatched && active && activeReference && normalizedName === activeReference,
    )
    if (matched) activeMatched = true
    const modelName = normalizedName ? raw.name.trim() : INVALID_MODEL_REFERENCE
    const owner = matched && active ? active.owner : null
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
      artifactIdentity: 'unknown',
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

/**
 * One sampled application boundary for public runtime projections.
 *
 * A provider call is shared only while it is pending. Caller cancellation stops
 * that caller's wait, never the shared sample, and no completed history/cache is
 * retained. Governor state is captured after the provider settles; that capture
 * is the snapshot linearization point and shares one `observedAt` with all rows.
 */
export class RuntimeReconciliationService {
  private readonly governor: ResourceGovernor
  private readonly models: () => ModelService
  private readonly now: () => Date
  private inFlight: Promise<ReconciliationOutcome> | null = null

  constructor(options: RuntimeReconciliationOptions) {
    this.governor = options.governor
    this.models = options.models
    this.now = options.now ?? (() => new Date())
  }

  get sampling(): boolean {
    return this.inFlight !== null
  }

  async snapshot(options: RuntimeSnapshotOptions = {}): Promise<RuntimeSnapshot> {
    return (await this.waitForOutcome(options.signal)).snapshot
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
    let running: RunningModel[]
    try {
      running = await this.models().ps()
    } catch (error) {
      const observedAt = this.now().toISOString()
      const governor = publicGovernorSnapshot(this.governor.snapshot(observedAt))
      return {
        snapshot: {
          observedAt,
          source: sourceFailure(error, observedAt),
          governor,
          models: null,
          decisions: [decision({ code: 'source_failure' })],
        },
        compatibilityModels: null,
        error,
      }
    }

    const observedAt = this.now().toISOString()
    const compatibilityModels = running.map((model) => ({ ...model, observedAt }))
    const governor = publicGovernorSnapshot(this.governor.snapshot(observedAt))
    const reconciled = reconcileModels(compatibilityModels, governor, observedAt)
    return {
      snapshot: {
        observedAt,
        source: {
          state: 'available',
          source: 'ollama_api_ps',
          observedAt,
          errorCode: null,
        },
        governor,
        models: reconciled.models,
        decisions: reconciled.decisions,
      },
      compatibilityModels,
      error: null,
    }
  }
}
