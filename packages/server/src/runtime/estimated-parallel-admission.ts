import {
  ESTIMATED_PARALLEL_ADMISSION_VERSION,
  estimatedParallelAdmissionResponseSchema,
  type EstimatedParallelAdmissionBody,
  type EstimatedParallelAdmissionCalculation,
  type EstimatedParallelAdmissionReason,
  type EstimatedParallelAdmissionResponse,
  type EstimatedParallelMemoryFact,
  type EstimatedParallelPairMember,
  type EstimatedParallelPairResolution,
  type FeatureFlagProjection,
  type HardwareInfo,
  type ModelObservationKey,
  type RuntimeResourceOwner,
  type RuntimeSnapshot,
} from '@alamo/contract'
import type { FeatureFlagRegistry } from '../config/feature-flags.ts'
import { extractArchParams, estimateKvCacheBytes } from '../hardware/fit.ts'
import type { OllamaClient } from '../ollama/client.ts'
import type { CalibrationStore } from '../store/calibration.ts'
import {
  buildCompleteObservationKey,
  normalizeOllamaModelReference,
} from './observation-key.ts'
import type { RuntimeReconciliationService } from './reconciliation.ts'

export const ESTIMATED_PARALLEL_ADMISSION_FLAG =
  'estimated_parallel_admission_policy' as const

type AvailableFact = Extract<EstimatedParallelMemoryFact, { state: 'available' }>

export interface EstimatedParallelAdmissionOptions {
  featureFlags: FeatureFlagRegistry
  runtime: Pick<RuntimeReconciliationService, 'snapshot'>
  calibration: CalibrationStore
  ollama(): OllamaClient
  hardware: HardwareInfo
  now?: () => Date
}

function unavailableFact(
  reason: Extract<EstimatedParallelMemoryFact, { state: 'unavailable' }>['reason'],
  observedAt: string | null = null,
): EstimatedParallelMemoryFact {
  return {
    state: 'unavailable',
    bytes: null,
    source: 'not_available',
    observedAt,
    confidence: 'unknown',
    basis: 'fact_not_available',
    reason,
  }
}

function notEvaluatedPair(): EstimatedParallelPairResolution {
  return {
    state: 'unavailable',
    reason: 'not_evaluated',
    runtimeVersion: null,
    observationKey: null,
  }
}

function sameOwner(left: RuntimeResourceOwner, right: RuntimeResourceOwner): boolean {
  return left.kind === right.kind && (
    left.kind === 'job'
      ? left.jobId === (right as Extract<RuntimeResourceOwner, { kind: 'job' }>).jobId
      : left.operationId === (
          right as Extract<RuntimeResourceOwner, { kind: 'operation' }>
        ).operationId
  )
}

function pairMatchesResource(
  requested: EstimatedParallelPairMember,
  current: {
    owner: RuntimeResourceOwner
    model: { provider: 'ollama'; name: string }
    requestedContext: number
  },
): boolean {
  return sameOwner(requested.owner, current.owner)
    && normalizeOllamaModelReference(current.model.name) === requested.model.normalizedReference
    && requested.contextLength === current.requestedContext
}

function safeAdd(left: number, right: number): number | null {
  if (
    !Number.isSafeInteger(left)
    || left < 0
    || !Number.isSafeInteger(right)
    || right < 0
  ) {
    return null
  }
  const result = left + right
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}

function emptyFacts(observedAt: string | null) {
  return {
    activeRuntimeAllocation: unavailableFact('not_reported', observedAt),
    activeAcceleratorAllocation: unavailableFact('not_reported', observedAt),
    candidateDeclaredModel: unavailableFact('not_reported', observedAt),
    candidateKvCache: unavailableFact('not_reported', observedAt),
    candidateCalibration: unavailableFact('calibration_missing', observedAt),
    hostAvailableCapacity: unavailableFact('host_capacity_unknown', observedAt),
  }
}

function disabledReason(flag: FeatureFlagProjection): Extract<
  EstimatedParallelAdmissionReason,
  'flag_disabled' | 'flag_invalid' | 'flag_unavailable'
> {
  if (flag.state === 'invalid') return 'flag_invalid'
  if (flag.state === 'unavailable') return 'flag_unavailable'
  return 'flag_disabled'
}

function unavailableCalculation(
  reason: EstimatedParallelAdmissionReason,
): EstimatedParallelAdmissionCalculation {
  return { state: 'unavailable', reason }
}

/**
 * Read-only explanation owner. It never calls ResourceGovernor mutation methods;
 * the only Governor state it sees is the already-redacted runtime snapshot.
 */
export class EstimatedParallelAdmissionService {
  private readonly featureFlags: FeatureFlagRegistry
  private readonly runtime: Pick<RuntimeReconciliationService, 'snapshot'>
  private readonly calibration: CalibrationStore
  private readonly ollama: () => OllamaClient
  private readonly hardware: HardwareInfo
  private readonly now: () => Date

  constructor(options: EstimatedParallelAdmissionOptions) {
    this.featureFlags = options.featureFlags
    this.runtime = options.runtime
    this.calibration = options.calibration
    this.ollama = options.ollama
    this.hardware = options.hardware
    this.now = options.now ?? (() => new Date())
  }

  async estimate(
    request: EstimatedParallelAdmissionBody,
    signal?: AbortSignal,
  ): Promise<EstimatedParallelAdmissionResponse> {
    const featureFlag = this.featureFlags.projection(ESTIMATED_PARALLEL_ADMISSION_FLAG)
    if (!featureFlag.effectiveValue) {
      const observedAt = this.now().toISOString()
      const reason = disabledReason(featureFlag)
      return estimatedParallelAdmissionResponseSchema.parse({
        version: ESTIMATED_PARALLEL_ADMISSION_VERSION,
        verdict: 'disabled',
        reason,
        observedAt,
        confidence: 'unknown',
        futureAdmissionGuarantee: false,
        governorAcceleratorPermits: 1,
        featureFlag,
        request,
        runtimeObservedAt: null,
        pair: { active: notEvaluatedPair(), candidate: notEvaluatedPair() },
        facts: emptyFacts(null),
        calculation: unavailableCalculation(reason),
        exclusions: ['future_admission_not_guaranteed'],
      })
    }

    const runtime = await this.runtime.snapshot({ signal })
    const base = this.base(request, featureFlag, runtime)
    if (
      request.expectedRuntimeObservedAt !== null
      && request.expectedRuntimeObservedAt !== runtime.observedAt
    ) {
      return this.unknown(base, 'stale_runtime_sample')
    }
    if (runtime.source.state !== 'available' || runtime.models === null) {
      return this.unknown(base, 'runtime_source_unavailable')
    }

    const activeLease = runtime.governor.activeLease
    const activeOwnerMatches = activeLease
      ? sameOwner(request.active.owner, activeLease.owner)
      : false
    if (!activeLease || !activeOwnerMatches || !pairMatchesResource(request.active, activeLease)) {
      return this.unknown(base, 'active_pair_unavailable', {
        active: {
          state: 'unavailable',
          reason: !activeLease || !activeOwnerMatches
            ? 'active_owner_mismatch'
            : 'active_model_mismatch',
          runtimeVersion: null,
          observationKey: null,
        },
      })
    }
    const queued = runtime.governor.queued.filter((entry) =>
      sameOwner(entry.owner, request.candidate.owner),
    )
    if (queued.length !== 1 || !pairMatchesResource(request.candidate, queued[0]!)) {
      return this.unknown(base, 'candidate_pair_unavailable', {
        candidate: {
          state: 'unavailable',
          reason: queued.length === 0
            ? 'queued_owner_missing'
            : queued.length > 1
              ? 'queued_owner_ambiguous'
              : 'queued_model_mismatch',
          runtimeVersion: null,
          observationKey: null,
        },
      })
    }

    const activeRows = runtime.models.filter(
      (model) => model.leaseId === activeLease.leaseId && model.ownerState === 'active_lease',
    )
    const activeRow = activeRows.length === 1 ? activeRows[0]! : null
    if (
      !activeRow
      || activeRow.observationKey.state !== 'complete'
      || activeRow.observationKey.components.artifactDigest !== request.active.model.artifactDigest
      || activeRow.contextLength !== request.active.contextLength
    ) {
      return this.unknown(base, 'active_pair_unavailable', {
        active: {
          state: 'unavailable',
          reason: 'active_identity_unavailable',
          runtimeVersion: null,
          observationKey: activeRow?.observationKey ?? null,
        },
      })
    }

    const activeResolution: EstimatedParallelPairResolution = {
      state: 'matched',
      reason: null,
      runtimeVersion: activeRow.observationKey.components.runtimeBackend.version,
      observationKey: activeRow.observationKey,
    }
    const activeRuntimeAllocation = this.fact({
      bytes: activeRow.sizeBytes,
      source: 'ollama_api_ps_total_allocation',
      observedAt: runtime.observedAt,
      confidence: 'observed',
      basis: 'current_loaded_runtime_allocation',
    })
    const activeAcceleratorAllocation = activeRow.sizeVramBytes === null
      ? unavailableFact('not_reported', runtime.observedAt)
      : this.fact({
          bytes: activeRow.sizeVramBytes,
          source: 'ollama_api_ps_accelerator_allocation',
          observedAt: runtime.observedAt,
          confidence: 'observed',
          basis: 'current_loaded_accelerator_allocation',
        })

    const candidate = await this.candidateEvidence(
      request.candidate,
      activeRow.observationKey,
      signal,
    )
    if (candidate.state === 'unavailable') {
      return this.unknown(
        {
          ...base,
          pair: { active: activeResolution, candidate: candidate.resolution },
          facts: {
            ...base.facts,
            activeRuntimeAllocation,
            activeAcceleratorAllocation,
            ...candidate.facts,
          },
        },
        'candidate_provider_unavailable',
      )
    }

    const facts = {
      ...base.facts,
      activeRuntimeAllocation,
      activeAcceleratorAllocation,
      ...candidate.facts,
      hostAvailableCapacity: this.hostCapacity(runtime),
    }
    const completeBase = {
      ...base,
      pair: { active: activeResolution, candidate: candidate.resolution },
      facts,
    }

    if (runtime.host.profile.platform === 'linux' || runtime.host.nvidia.devices.length > 0) {
      return this.unknown(completeBase, 'host_topology_ambiguous')
    }
    if (
      runtime.host.sample.pressure.level === 'unknown'
      || runtime.host.sample.pressure.confidence !== 'observed'
    ) {
      return this.unknown(completeBase, 'host_pressure_unavailable')
    }
    if (runtime.host.sample.pressure.level !== 'normal') {
      return this.unknown(completeBase, 'host_pressure_elevated')
    }
    if (facts.hostAvailableCapacity.state !== 'available') {
      return this.unknown(completeBase, 'host_capacity_unavailable')
    }

    const reservation = candidate.reservation
    if (!reservation) return this.unknown(completeBase, 'unsafe_arithmetic')
    const comparison = reservation.bytes < facts.hostAvailableCapacity.bytes
      ? 'positive_headroom'
      : reservation.bytes === facts.hostAvailableCapacity.bytes
        ? 'boundary_equal'
        : 'shortfall'
    const safetyMargin = this.fact({
      bytes: 0,
      source: 'policy_zero_margin',
      observedAt: runtime.observedAt,
      confidence: 'declared',
      basis: 'no_owner_margin_configured',
    })
    const calculation: EstimatedParallelAdmissionCalculation = {
      state: 'calculated',
      reservationBasis: candidate.reservationBasis,
      candidateReservation: reservation,
      availableCapacity: facts.hostAvailableCapacity,
      safetyMargin,
      comparison,
      activeAlreadyReflectedInCapacity: true,
    }

    if (comparison === 'boundary_equal' || comparison === 'shortfall') {
      const reason = comparison === 'boundary_equal'
        ? 'estimated_capacity_equal'
        : 'estimated_capacity_shortfall'
      return estimatedParallelAdmissionResponseSchema.parse({
        ...completeBase,
        verdict: 'estimated_deny',
        reason,
        confidence: 'estimated',
        calculation,
        exclusions: this.exclusions(candidate.reservationBasis),
      })
    }

    // Current host available-memory facts are advisory, not an accepted admission
    // capacity. Positive arithmetic therefore remains unknown until a later owner
    // decision/source can bound reserve and parallel runtime overhead.
    return this.unknown(
      { ...completeBase, calculation },
      candidate.reservationBasis === 'exact_calibration'
        ? 'admission_capacity_policy_unapproved'
        : 'formula_overhead_unknown',
    )
  }

  private async candidateEvidence(
    requested: EstimatedParallelPairMember,
    activeObservationKey: Extract<ModelObservationKey, { state: 'complete' }>,
    signal?: AbortSignal,
  ): Promise<
    | {
        state: 'available'
        resolution: EstimatedParallelPairResolution
        facts: {
          candidateDeclaredModel: EstimatedParallelMemoryFact
          candidateKvCache: EstimatedParallelMemoryFact
          candidateCalibration: EstimatedParallelMemoryFact
        }
        reservation: AvailableFact | null
        reservationBasis: 'exact_calibration' | 'formula_lower_bound' | 'declared_lower_bound'
      }
    | {
        state: 'unavailable'
        resolution: EstimatedParallelPairResolution
        facts: {
          candidateDeclaredModel: EstimatedParallelMemoryFact
          candidateKvCache: EstimatedParallelMemoryFact
          candidateCalibration: EstimatedParallelMemoryFact
        }
      }
  > {
    const client = this.ollama()
    try {
      const [beforeTags, beforeVersion] = await Promise.all([
        client.tags(signal),
        client.version(signal),
      ])
      const shown = await client.show(requested.model.normalizedReference, signal)
      const [afterTags, afterVersion] = await Promise.all([
        client.tags(signal),
        client.version(signal),
      ])
      const observedAt = this.now().toISOString()
      const before = beforeTags.models.filter(
        (entry) => normalizeOllamaModelReference(entry.name) === requested.model.normalizedReference,
      )
      const after = afterTags.models.filter(
        (entry) => normalizeOllamaModelReference(entry.name) === requested.model.normalizedReference,
      )
      const coherent = before.length === 1
        && after.length === 1
        && before[0]!.digest === requested.model.artifactDigest
        && after[0]!.digest === requested.model.artifactDigest
        && before[0]!.size === after[0]!.size
        && beforeVersion === afterVersion
        && beforeVersion === activeObservationKey.components.runtimeBackend.version
      if (!coherent) {
        return {
          state: 'unavailable',
          resolution: {
            state: 'unavailable',
            reason: 'candidate_identity_changed',
            runtimeVersion: afterVersion,
            observationKey: null,
          },
          facts: {
            candidateDeclaredModel: unavailableFact('identity_unavailable', observedAt),
            candidateKvCache: unavailableFact('identity_unavailable', observedAt),
            candidateCalibration: unavailableFact('identity_unavailable', observedAt),
          },
        }
      }

      const entry = after[0]!
      if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
        return {
          state: 'unavailable',
          resolution: {
            state: 'unavailable',
            reason: 'candidate_identity_unavailable',
            runtimeVersion: afterVersion,
            observationKey: null,
          },
          facts: {
            candidateDeclaredModel: unavailableFact('unsafe_numeric_input', observedAt),
            candidateKvCache: unavailableFact('unsafe_numeric_input', observedAt),
            candidateCalibration: unavailableFact('calibration_missing', observedAt),
          },
        }
      }

      const key = buildCompleteObservationKey({
        normalizedModelReference: requested.model.normalizedReference,
        artifactDigest: requested.model.artifactDigest,
        contextLength: requested.contextLength,
        runtimeVersion: afterVersion,
        runtimeHost: client.host,
        hardware: this.hardware,
      })
      const observationKey = key
      const resolution: EstimatedParallelPairResolution = {
        state: 'matched',
        reason: null,
        runtimeVersion: afterVersion,
        observationKey,
      }
      const declared = this.fact({
        bytes: entry.size,
        source: 'ollama_api_tags_declared_artifact_size',
        observedAt,
        confidence: 'declared',
        basis: 'installed_artifact_declared_size',
      })
      const params = extractArchParams(shown.model_info)
      let kv: EstimatedParallelMemoryFact = unavailableFact('architecture_unknown', observedAt)
      if (params) {
        const bytes = estimateKvCacheBytes(params, requested.contextLength)
        kv = Number.isSafeInteger(bytes) && bytes >= 0
          ? this.fact({
              bytes,
              source: 'ollama_api_show_architecture_kv_estimate',
              observedAt,
              confidence: 'estimated',
              basis: 'architecture_kv_lower_bound',
            })
          : unavailableFact('unsafe_numeric_input', observedAt)
      }
      const calibrated = this.calibration.exactObservation(observationKey)
      const calibration: EstimatedParallelMemoryFact = calibrated
        ? this.fact({
            bytes: calibrated.sizeBytes,
            source: 'exact_calibration_total',
            observedAt: calibrated.measuredAt,
            confidence: 'calibrated',
            basis: 'historical_exact_fingerprint_total',
          })
        : unavailableFact('calibration_missing', observedAt)

      if (calibration.state === 'available') {
        return {
          state: 'available',
          resolution,
          facts: {
            candidateDeclaredModel: declared,
            candidateKvCache: kv,
            candidateCalibration: calibration,
          },
          reservation: { ...calibration, confidence: 'estimated' },
          reservationBasis: 'exact_calibration',
        }
      }
      if (kv.state === 'available') {
        const required = safeAdd(declared.bytes, kv.bytes)
        return {
          state: 'available',
          resolution,
          facts: {
            candidateDeclaredModel: declared,
            candidateKvCache: kv,
            candidateCalibration: calibration,
          },
          reservation: required === null
            ? null
            : { ...kv, bytes: required },
          reservationBasis: 'formula_lower_bound',
        }
      }
      return {
        state: 'available',
        resolution,
        facts: {
          candidateDeclaredModel: declared,
          candidateKvCache: kv,
          candidateCalibration: calibration,
        },
        reservation: { ...declared, confidence: 'estimated' },
        reservationBasis: 'declared_lower_bound',
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        state: 'unavailable',
        resolution: {
          state: 'unavailable',
          reason: 'candidate_identity_unavailable',
          runtimeVersion: null,
          observationKey: null,
        },
        facts: {
          candidateDeclaredModel: unavailableFact('identity_unavailable'),
          candidateKvCache: unavailableFact('identity_unavailable'),
          candidateCalibration: unavailableFact('identity_unavailable'),
        },
      }
    }
  }

  private hostCapacity(runtime: RuntimeSnapshot): EstimatedParallelMemoryFact {
    const available = runtime.host.sample.availableMemoryBytes
    if (
      available.bytes === null
      || !Number.isSafeInteger(available.bytes)
      || available.bytes < 0
      || available.confidence !== 'observed'
      || available.source !== 'apple_host_available_memory'
    ) {
      return unavailableFact('host_capacity_unknown', runtime.observedAt)
    }
    return this.fact({
      bytes: available.bytes,
      source: 'host_observed_available_memory',
      observedAt: runtime.observedAt,
      confidence: 'observed',
      basis: 'current_available_memory_advisory',
    })
  }

  private fact(fact: Omit<AvailableFact, 'state'>): AvailableFact {
    return { state: 'available', ...fact }
  }

  private base(
    request: EstimatedParallelAdmissionBody,
    featureFlag: FeatureFlagProjection,
    runtime: RuntimeSnapshot,
  ) {
    return {
      version: ESTIMATED_PARALLEL_ADMISSION_VERSION,
      observedAt: runtime.observedAt,
      futureAdmissionGuarantee: false as const,
      governorAcceleratorPermits: 1 as const,
      featureFlag,
      request,
      runtimeObservedAt: runtime.observedAt,
      pair: { active: notEvaluatedPair(), candidate: notEvaluatedPair() },
      facts: emptyFacts(runtime.observedAt),
      calculation: unavailableCalculation('active_pair_unavailable'),
      exclusions: ['future_admission_not_guaranteed'] as const,
    }
  }

  private unknown(
    base: ReturnType<EstimatedParallelAdmissionService['base']> & Record<string, unknown>,
    reason: Exclude<EstimatedParallelAdmissionReason,
      | 'flag_disabled'
      | 'flag_invalid'
      | 'flag_unavailable'
      | 'estimated_positive_headroom'
      | 'estimated_capacity_equal'
      | 'estimated_capacity_shortfall'>,
    pairPatch: Partial<{
      active: EstimatedParallelPairResolution
      candidate: EstimatedParallelPairResolution
    }> = {},
  ): EstimatedParallelAdmissionResponse {
    const pair = {
      ...(base.pair as { active: EstimatedParallelPairResolution; candidate: EstimatedParallelPairResolution }),
      ...pairPatch,
    }
    return estimatedParallelAdmissionResponseSchema.parse({
      ...base,
      verdict: 'unknown',
      reason,
      confidence: 'unknown',
      pair,
      calculation: 'calculation' in base
        && (base.calculation as EstimatedParallelAdmissionCalculation).state === 'calculated'
        ? base.calculation
        : unavailableCalculation(reason),
      exclusions: this.exclusions(
        (base.calculation as EstimatedParallelAdmissionCalculation | undefined)?.state === 'calculated'
          ? (base.calculation as Extract<EstimatedParallelAdmissionCalculation, { state: 'calculated' }>).reservationBasis
          : null,
      ),
    })
  }

  private exclusions(
    reservationBasis: 'exact_calibration' | 'formula_lower_bound' | 'declared_lower_bound' | null,
  ) {
    return [
      'active_allocation_already_reflected_in_available_memory',
      'apple_free_pages_not_capacity',
      'legacy_usable_estimate_not_capacity',
      'nvidia_device_aggregation_forbidden',
      ...(reservationBasis === 'exact_calibration'
        ? []
        : ['runtime_backend_overhead_unknown'] as const),
      'future_admission_not_guaranteed',
    ] as const
  }
}
