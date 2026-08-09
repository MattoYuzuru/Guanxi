import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  ESTIMATED_PARALLEL_ADMISSION_VERSION,
  estimatedParallelAdmissionBody,
  estimatedParallelAdmissionResponseSchema,
  type EstimatedParallelAdmissionBody,
  type HardwareInfo,
  type RunningModel,
  type RuntimeHostTelemetry,
} from '@alamo/contract'
import { createApp } from '../src/app.ts'
import {
  ESTIMATED_PARALLEL_ADMISSION_ENV,
  FeatureFlagRegistry,
} from '../src/config/feature-flags.ts'
import type { HostTelemetry } from '../src/hardware/telemetry.ts'
import type { AppContext } from '../src/context.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import {
  ESTIMATED_PARALLEL_ADMISSION_FLAG,
  EstimatedParallelAdmissionService,
} from '../src/runtime/estimated-parallel-admission.ts'
import { buildCompleteObservationKey } from '../src/runtime/observation-key.ts'
import {
  ResourceGovernor,
  type AdmissionRequest,
  type ResourceLease,
} from '../src/runtime/resource-governor.ts'
import { RuntimeReconciliationService } from '../src/runtime/reconciliation.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'

const OBSERVED_AT = '2026-08-09T12:00:00.000Z'
const RUNTIME_VERSION = '0.12.6'
const ACTIVE_DIGEST = 'sha256:active'
const CANDIDATE_DIGEST = 'sha256:candidate'
const CONTEXT_LENGTH = 8_192
const FORMULA_KV_BYTES = 16_384
const DECLARED_BYTES = 1_000
const FORMULA_RESERVATION = DECLARED_BYTES + FORMULA_KV_BYTES

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 11_200_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function appleHost(
  availableMemoryBytes: number | null,
  pressure: 'normal' | 'warning' | 'unknown' = 'normal',
  nvidia = false,
): RuntimeHostTelemetry {
  const fact = (
    bytes: number,
    source: 'node_os_totalmem' | 'apple_vm_stat_pages_free' | 'apple_host_available_memory',
    basis: 'total_unified_memory' | 'system_free_pages_not_safe_capacity' | 'system_available_memory_advisory',
  ) => ({ bytes, source, observedAt: OBSERVED_AT, confidence: 'observed' as const, basis })
  const unknown = (
    basis: 'discrete_vram_not_applicable_to_apple_unified_memory' | 'gpu_free_memory_not_reported' | 'system_available_memory_advisory',
  ) => ({
    bytes: null,
    source: 'not_reported' as const,
    observedAt: OBSERVED_AT,
    confidence: 'unknown' as const,
    basis,
  })
  return {
    state: availableMemoryBytes === null || pressure === 'unknown' ? 'partial' : 'available',
    observedAt: OBSERVED_AT,
    profile: {
      platform: 'darwin',
      arch: 'arm64',
      accelerator: 'metal',
      acceleratorName: 'fixture',
      unifiedMemory: true,
      source: 'legacy_hardware_probe',
      observedAt: OBSERVED_AT,
      confidence: 'observed',
      totalMemoryBytes: fact(HARDWARE.totalMemoryBytes, 'node_os_totalmem', 'total_unified_memory'),
      legacyUsableMemoryBytes: {
        bytes: HARDWARE.usableMemoryBytes,
        source: 'legacy_apple_unified_memory_70_percent',
        observedAt: OBSERVED_AT,
        confidence: 'estimated',
        basis: 'legacy_compatibility_estimate_not_current_availability',
      },
      discreteVramBytes: unknown('discrete_vram_not_applicable_to_apple_unified_memory'),
    },
    sample: {
      source: 'apple_vm_stat',
      observedAt: OBSERVED_AT,
      freeMemoryBytes: fact(
        3_000,
        'apple_vm_stat_pages_free',
        'system_free_pages_not_safe_capacity',
      ),
      availableMemoryBytes: availableMemoryBytes === null
        ? unknown('system_available_memory_advisory')
        : fact(
            availableMemoryBytes,
            'apple_host_available_memory',
            'system_available_memory_advisory',
          ),
      pressure: {
        level: pressure,
        source: pressure === 'unknown' ? 'not_reported' : 'apple_host_memory_pressure',
        observedAt: OBSERVED_AT,
        confidence: pressure === 'unknown' ? 'unknown' : 'observed',
        basis: pressure === 'unknown' ? 'not_observed' : 'system_memory_pressure',
      },
      gpuFreeMemoryBytes: unknown('gpu_free_memory_not_reported'),
    },
    nvidia: nvidia
      ? {
          state: 'available',
          source: 'nvidia_smi',
          observedAt: OBSERVED_AT,
          reason: null,
          devices: [{
            providerIndex: 0,
            uuid: 'GPU-fixture',
            displayName: 'fixture',
            source: 'nvidia_smi_query_gpu',
            observedAt: OBSERVED_AT,
            confidence: 'observed',
            totalVramBytes: {
              bytes: 8_000,
              source: 'nvidia_smi_memory_total',
              observedAt: OBSERVED_AT,
              confidence: 'observed',
              basis: 'device_total_vram',
            },
            freeVramBytes: {
              bytes: 7_000,
              source: 'nvidia_smi_memory_free',
              observedAt: OBSERVED_AT,
              confidence: 'observed',
              basis: 'device_free_vram_not_safe_capacity',
            },
          }],
        }
      : {
          state: 'unknown',
          source: 'none',
          observedAt: OBSERVED_AT,
          devices: [],
          reason: 'legacy_snapshot',
        },
    availableFields: [
      'total_unified_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
      'free_memory_bytes',
      ...(availableMemoryBytes === null ? [] : ['available_memory_bytes'] as const),
      ...(pressure === 'unknown' ? [] : ['memory_pressure'] as const),
      ...(nvidia ? ['nvidia_devices'] as const : []),
    ],
    missingFields: [
      ...(availableMemoryBytes === null ? ['available_memory_bytes'] as const : []),
      ...(pressure === 'unknown' ? ['memory_pressure'] as const : []),
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
    ],
    errorCode: null,
  }
}

function admission(ownerId: string, model: string): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId: ownerId },
    operation: 'model_warm',
    model: { provider: 'ollama', name: model },
    requestedContext: CONTEXT_LENGTH,
    priority: 'normal',
    enqueuedAt: OBSERVED_AT,
  }
}

function runningActive(): RunningModel {
  return {
    name: 'active:latest',
    digest: ACTIVE_DIGEST,
    sizeBytes: 6_000,
    sizeVramBytes: 5_500,
    gpuPercent: null,
    processorLabel: null,
    contextLength: CONTEXT_LENGTH,
    expiresAt: '2026-08-09T12:10:00.000Z',
    source: 'ollama_api_ps',
    observedAt: OBSERVED_AT,
  }
}

const REQUEST: EstimatedParallelAdmissionBody = {
  version: ESTIMATED_PARALLEL_ADMISSION_VERSION,
  expectedRuntimeObservedAt: OBSERVED_AT,
  active: {
    owner: { kind: 'operation', operationId: 'active-owner' },
    model: {
      provider: 'ollama',
      normalizedReference: 'active:latest',
      artifactDigest: ACTIVE_DIGEST,
    },
    contextLength: CONTEXT_LENGTH,
  },
  candidate: {
    owner: { kind: 'operation', operationId: 'candidate-owner' },
    model: {
      provider: 'ollama',
      normalizedReference: 'candidate:latest',
      artifactDigest: CANDIDATE_DIGEST,
    },
    contextLength: CONTEXT_LENGTH,
  },
}

interface HarnessOptions {
  flag?: 'enabled' | 'default' | 'disabled' | 'invalid' | 'unavailable'
  availableMemoryBytes?: number | null
  pressure?: 'normal' | 'warning' | 'unknown'
  nvidia?: boolean
  declaredBytes?: number
  calibrationBytes?: number
  identityDrift?: boolean
  noArchitecture?: boolean
  ambiguousQueue?: boolean
  candidateRuntimeHost?: string
  calibrationMeasuredAt?: string
  queryObservedAt?: string
  blockCandidateShow?: boolean
}

async function harness(options: HarnessOptions = {}) {
  const db = openDb(':memory:')
  const calibration = new CalibrationStore(db)
  const governor = new ResourceGovernor({
    now: () => new Date(OBSERVED_AT),
    createId: (() => {
      let id = 0
      return () => `resource-${++id}`
    })(),
  })
  const activeTicket = governor.enqueue(admission('active-owner', 'active:latest'))
  const lease = await governor.acquire(activeTicket)
  const queued = [governor.enqueue(admission('candidate-owner', 'candidate:latest'))]
  if (options.ambiguousQueue) {
    queued.push(governor.enqueue(admission('candidate-owner', 'candidate:latest')))
  }
  let runtimeCalls = 0
  let providerCalls = 0
  let tagsCalls = 0
  let showStartedResolve!: () => void
  const showStarted = new Promise<void>((resolve) => {
    showStartedResolve = resolve
  })
  const hostTelemetry: HostTelemetry = {
    profile: HARDWARE,
    sample: async () => appleHost(
      options.availableMemoryBytes === undefined ? 20_000 : options.availableMemoryBytes,
      options.pressure,
      options.nvidia,
    ),
  }
  const reconciliation = new RuntimeReconciliationService({
    governor,
    hostTelemetry,
    models: () => ({
      ps: async () => [runningActive()],
      installedArtifacts: async () => [{ name: 'active:latest', digest: ACTIVE_DIGEST }],
      runtimeVersion: async () => RUNTIME_VERSION,
      runtimeHost: 'http://127.0.0.1:11434',
      hardwareProfile: HARDWARE,
    }),
    now: () => new Date(OBSERVED_AT),
  })
  const client = {
    host: options.candidateRuntimeHost ?? 'http://127.0.0.1:11434',
    tags: async () => {
      providerCalls += 1
      tagsCalls += 1
      return {
        models: [{
          name: 'candidate:latest',
          digest: options.identityDrift && tagsCalls > 1 ? 'sha256:changed' : CANDIDATE_DIGEST,
          size: options.declaredBytes ?? DECLARED_BYTES,
        }],
      }
    },
    version: async () => {
      providerCalls += 1
      return RUNTIME_VERSION
    },
    show: async (_name: string, signal?: AbortSignal) => {
      providerCalls += 1
      showStartedResolve()
      if (options.blockCandidateShow) {
        await new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      }
      return {
        model_info: options.noArchitecture
          ? {}
          : {
              'general.architecture': 'fixture',
              'fixture.block_count': 1,
              'fixture.attention.head_count': 1,
              'fixture.attention.head_count_kv': 1,
              'fixture.attention.key_length': 1,
            },
      }
    },
  } as unknown as OllamaClient
  const flag = options.flag ?? 'enabled'
  const featureFlags = new FeatureFlagRegistry({
    environment: flag === 'unavailable'
      ? { state: 'unavailable' }
      : {
          state: 'available',
          values: flag === 'default'
            ? {}
            : flag === 'disabled'
            ? { [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'disabled' }
            : flag === 'invalid'
              ? { [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'future' }
              : { [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled' },
        },
    observedAt: OBSERVED_AT,
  })
  const service = new EstimatedParallelAdmissionService({
    featureFlags,
    runtime: {
      snapshotWithIdentity: async (input) => {
        runtimeCalls += 1
        return reconciliation.snapshotWithIdentity(input)
      },
    },
    calibration,
    ollama: () => client,
    hardware: HARDWARE,
    now: () => new Date(options.queryObservedAt ?? OBSERVED_AT),
  })
  if (options.calibrationBytes !== undefined) {
    const key = buildCompleteObservationKey({
      normalizedModelReference: 'candidate:latest',
      artifactDigest: CANDIDATE_DIGEST,
      contextLength: CONTEXT_LENGTH,
      runtimeVersion: RUNTIME_VERSION,
      runtimeHost: client.host,
      hardware: HARDWARE,
    })
    assert.equal(
      calibration.record(
        key,
        options.calibrationBytes,
        options.calibrationBytes,
        options.calibrationMeasuredAt ?? OBSERVED_AT,
      ),
      true,
    )
  }
  return {
    db,
    service,
    calibration,
    governor,
    lease,
    queued,
    showStarted,
    calls: () => ({ runtime: runtimeCalls, provider: providerCalls }),
  }
}

function closeHarness(value: Awaited<ReturnType<typeof harness>>): void {
  value.lease.release()
  for (const queued of value.queued) value.governor.cancel(queued)
  value.db.close()
}

function sourceTree(directory: URL): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory)
      if (entry.isDirectory()) return [sourceTree(child)]
      return entry.isFile()
        && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
        ? [readFileSync(child, 'utf8')]
        : []
    })
    .join('\n')
}

describe('estimated parallel-admission contract', () => {
  it('rejects future/extra/duplicate owners and unsafe numeric inputs', () => {
    const invalid = [
      { ...REQUEST, version: 2 },
      { ...REQUEST, future: true },
      { ...REQUEST, candidate: { ...REQUEST.candidate, owner: REQUEST.active.owner } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, model: { ...REQUEST.candidate.model, normalizedReference: 'Candidate' } } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, model: { ...REQUEST.candidate.model, normalizedReference: '../candidate:latest' } } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, model: { ...REQUEST.candidate.model, artifactDigest: 'private' } } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, contextLength: 0 } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, contextLength: -1 } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, contextLength: Number.NaN } },
      { ...REQUEST, candidate: { ...REQUEST.candidate, contextLength: Number.MAX_VALUE } },
    ]
    for (const input of invalid) assert.equal(estimatedParallelAdmissionBody.safeParse(input).success, false)
    assert.equal(estimatedParallelAdmissionBody.safeParse(REQUEST).success, true)
  })

  it('keeps only a coherent estimated_allow in the closed contract', async () => {
    const value = await harness({ availableMemoryBytes: 10_000, calibrationBytes: 9_000 })
    try {
      const conservative = await value.service.estimate(REQUEST)
      assert.equal(conservative.verdict, 'unknown')
      assert.equal(conservative.reason, 'admission_capacity_policy_unapproved')
      const response = estimatedParallelAdmissionResponseSchema.safeParse({
        ...conservative,
        verdict: 'estimated_allow',
        reason: 'estimated_positive_headroom',
        confidence: 'estimated',
      })
      assert.equal(response.success, true)
      assert.equal(response.success && response.data.futureAdmissionGuarantee, false)
      assert.equal(response.success && response.data.governorAcceleratorPermits, 1)
      assert.ok(response.success)
      const exact = response.data
      const unavailable = {
        state: 'unavailable',
        bytes: null,
        source: 'not_available',
        observedAt: null,
        confidence: 'unknown',
        basis: 'fact_not_available',
        reason: 'calibration_missing',
      }
      assert.equal(exact.calculation.state, 'calculated')
      const calculation = exact.calculation.state === 'calculated'
        ? exact.calculation
        : null
      assert.ok(calculation)
      const disabledFlag = new FeatureFlagRegistry({
        environment: { state: 'available', values: {} },
        observedAt: OBSERVED_AT,
      }).projection(ESTIMATED_PARALLEL_ADMISSION_FLAG)
      const incoherent = [
        { ...exact, featureFlag: disabledFlag },
        {
          ...exact,
          pair: {
            ...exact.pair,
            active: {
              state: 'unavailable', reason: 'not_evaluated',
              runtimeVersion: null, observationKey: null,
            },
          },
        },
        {
          ...exact,
          request: { ...exact.request, expectedRuntimeObservedAt: '2026-08-09T11:00:00.000Z' },
        },
        { ...exact, facts: { ...exact.facts, candidateCalibration: unavailable } },
        {
          ...exact,
          facts: {
            ...exact.facts,
            hostAvailableCapacity: { ...exact.facts.hostAvailableCapacity, bytes: 50 },
          },
          calculation: {
            ...calculation,
            availableCapacity: { ...calculation.availableCapacity, bytes: 50 },
          },
        },
        {
          ...exact,
          calculation: {
            ...calculation,
            candidateReservation: {
              ...calculation.candidateReservation,
              bytes: calculation.candidateReservation.bytes! + 1,
            },
          },
        },
        {
          ...exact,
          request: {
            ...exact.request,
            candidate: {
              ...exact.request.candidate,
              model: { ...exact.request.candidate.model, artifactDigest: 'sha256:other' },
            },
          },
        },
        {
          ...exact,
          facts: {
            ...exact.facts,
            candidateCalibration: {
              ...exact.facts.candidateCalibration,
              source: 'derived_declared_plus_kv_lower_bound',
              basis: 'declared_plus_architecture_kv_lower_bound',
              confidence: 'observed',
            },
          },
          calculation: {
            ...calculation,
            candidateReservation: {
              ...calculation.candidateReservation,
              source: 'derived_declared_plus_kv_lower_bound',
              basis: 'declared_plus_architecture_kv_lower_bound',
              confidence: 'declared',
            },
          },
        },
        exact.pair.candidate.state === 'matched'
          && exact.pair.candidate.observationKey.state === 'complete'
          ? {
              ...exact,
              pair: {
                ...exact.pair,
                candidate: {
                  ...exact.pair.candidate,
                  runtimeVersion: '0.13.0',
                  observationKey: {
                    ...exact.pair.candidate.observationKey,
                    components: {
                      ...exact.pair.candidate.observationKey.components,
                      runtimeBackend: {
                        ...exact.pair.candidate.observationKey.components.runtimeBackend,
                        version: '0.13.0',
                        fingerprint: `sha256:${'a'.repeat(64)}`,
                      },
                    },
                  },
                },
              },
            }
          : {},
        exact.pair.candidate.state === 'matched'
          && exact.pair.candidate.observationKey.state === 'complete'
          ? {
              ...exact,
              pair: {
                ...exact.pair,
                candidate: {
                  ...exact.pair.candidate,
                  observationKey: {
                    ...exact.pair.candidate.observationKey,
                    components: {
                      ...exact.pair.candidate.observationKey.components,
                      hardware: {
                        ...exact.pair.candidate.observationKey.components.hardware,
                        fingerprint: `sha256:${'b'.repeat(64)}`,
                      },
                    },
                  },
                },
              },
            }
          : {},
      ]
      assert.equal(incoherent.length, 10)
      for (const mutation of incoherent) {
        assert.equal(estimatedParallelAdmissionResponseSchema.safeParse(mutation).success, false)
      }
    } finally {
      closeHarness(value)
    }
  })
})

describe('estimated parallel-admission policy', () => {
  it('exposes one strict POST query and rejects malformed bodies before service work', async () => {
    const value = await harness({ flag: 'disabled' })
    const app = createApp({ estimatedParallelAdmission: value.service } as AppContext)
    try {
      const malformed = await app.request('/api/runtime/estimated-parallel-admission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...REQUEST, future: true }),
      })
      assert.equal(malformed.status, 400)
      assert.equal((await malformed.json() as { code: string }).code, 'validation_failed')
      assert.deepEqual(value.calls(), { runtime: 0, provider: 0 })

      const response = await app.request('/api/runtime/estimated-parallel-admission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(REQUEST),
      })
      assert.equal(response.status, 200)
      assert.equal(
        estimatedParallelAdmissionResponseSchema.parse(await response.json()).verdict,
        'disabled',
      )
      assert.deepEqual(value.calls(), { runtime: 0, provider: 0 })
    } finally {
      closeHarness(value)
    }
  })

  it('fails closed before runtime/provider work for default-off, invalid and unavailable flags', async () => {
    for (const flag of ['default', 'disabled', 'invalid', 'unavailable'] as const) {
      const value = await harness({ flag })
      try {
        const result = estimatedParallelAdmissionResponseSchema.parse(
          await value.service.estimate(REQUEST),
        )
        assert.equal(result.verdict, 'disabled')
        assert.equal(
          result.reason,
          flag === 'default' || flag === 'disabled' ? 'flag_disabled' : `flag_${flag}`,
        )
        assert.deepEqual(value.calls(), { runtime: 0, provider: 0 })
      } finally {
        closeHarness(value)
      }
    }
  })

  it('uses every coherent source, preserves provenance and does not double-count active bytes', async () => {
    const value = await harness({ availableMemoryBytes: 10_000 })
    const before = value.governor.snapshot()
    try {
      const result = estimatedParallelAdmissionResponseSchema.parse(
        await value.service.estimate(REQUEST),
      )
      assert.equal(result.verdict, 'estimated_deny')
      assert.equal(result.reason, 'estimated_capacity_shortfall')
      assert.equal(result.confidence, 'estimated')
      assert.equal(result.facts.activeRuntimeAllocation.bytes, 6_000)
      assert.equal(result.facts.activeRuntimeAllocation.source, 'ollama_api_ps_total_allocation')
      assert.equal(result.facts.activeAcceleratorAllocation.bytes, 5_500)
      assert.equal(result.facts.candidateDeclaredModel.bytes, DECLARED_BYTES)
      assert.equal(result.facts.candidateDeclaredModel.confidence, 'declared')
      assert.equal(result.facts.candidateKvCache.bytes, FORMULA_KV_BYTES)
      assert.equal(result.facts.candidateKvCache.confidence, 'estimated')
      assert.equal(result.facts.hostAvailableCapacity.bytes, 10_000)
      assert.equal(result.facts.hostAvailableCapacity.confidence, 'observed')
      assert.equal(result.calculation.state, 'calculated')
      if (result.calculation.state === 'calculated') {
        assert.equal(result.calculation.candidateReservation.bytes, FORMULA_RESERVATION)
        assert.equal(
          result.calculation.candidateReservation.source,
          'derived_declared_plus_kv_lower_bound',
        )
        assert.equal(
          result.calculation.candidateReservation.basis,
          'declared_plus_architecture_kv_lower_bound',
        )
        assert.equal(result.calculation.activeAlreadyReflectedInCapacity, true)
      }
      assert.equal(result.futureAdmissionGuarantee, false)
      assert.equal(result.governorAcceleratorPermits, 1)
      assert.deepEqual(value.governor.snapshot(), before)
      assert.deepEqual(value.calls(), { runtime: 1, provider: 5 })
    } finally {
      closeHarness(value)
    }
  })

  it('denies equality and keeps positive formula headroom unknown because overhead is excluded', async () => {
    for (const [available, verdict, reason] of [
      [FORMULA_RESERVATION, 'estimated_deny', 'estimated_capacity_equal'],
      [FORMULA_RESERVATION + 1, 'unknown', 'formula_overhead_unknown'],
    ] as const) {
      const value = await harness({ availableMemoryBytes: available })
      try {
        const result = await value.service.estimate(REQUEST)
        assert.equal(result.verdict, verdict)
        assert.equal(result.reason, reason)
        assert.notEqual(result.confidence, 'measured')
        assert.equal(result.exclusions.includes('runtime_backend_overhead_unknown'), true)
      } finally {
        closeHarness(value)
      }
    }
  })

  it('uses exact calibration instead of adding declared/KV and still does not promote history to measured', async () => {
    const value = await harness({ availableMemoryBytes: 9_000, calibrationBytes: 9_000 })
    try {
      const result = await value.service.estimate(REQUEST)
      assert.equal(result.verdict, 'estimated_deny')
      assert.equal(result.reason, 'estimated_capacity_equal')
      assert.equal(result.facts.candidateCalibration.bytes, 9_000)
      assert.equal(result.facts.candidateCalibration.confidence, 'calibrated')
      assert.equal(result.calculation.state, 'calculated')
      if (result.calculation.state === 'calculated') {
        assert.equal(result.calculation.reservationBasis, 'exact_calibration')
        assert.equal(result.calculation.candidateReservation.bytes, 9_000)
      }
      assert.equal(result.confidence, 'estimated')
      assert.equal(result.exclusions.includes('runtime_backend_overhead_unknown'), false)
    } finally {
      closeHarness(value)
    }
  })

  it('rejects corrupt or future calibration while preserving coherent mixed timestamps', async () => {
    const corrupt = await harness({
      availableMemoryBytes: FORMULA_RESERVATION,
      calibrationBytes: 9_000,
    })
    const mixed = await harness({
      availableMemoryBytes: 9_000,
      calibrationBytes: 9_000,
      calibrationMeasuredAt: '2026-08-09T11:00:00.000Z',
      queryObservedAt: '2026-08-09T12:00:01.000Z',
    })
    const future = await harness({
      availableMemoryBytes: FORMULA_RESERVATION,
      calibrationBytes: 9_000,
      calibrationMeasuredAt: '2026-08-09T13:00:00.000Z',
    })
    try {
      corrupt.db.prepare(
        'UPDATE model_calibration_observations SET context_length = 4096',
      ).run()
      const key = buildCompleteObservationKey({
        normalizedModelReference: 'candidate:latest',
        artifactDigest: CANDIDATE_DIGEST,
        contextLength: CONTEXT_LENGTH,
        runtimeVersion: RUNTIME_VERSION,
        runtimeHost: 'http://127.0.0.1:11434',
        hardware: HARDWARE,
      })
      assert.equal(corrupt.calibration.exactObservation(key), null)
      const corruptResult = await corrupt.service.estimate(REQUEST)
      assert.equal(corruptResult.facts.candidateCalibration.state, 'unavailable')
      assert.equal(corruptResult.calculation.state, 'calculated')
      if (corruptResult.calculation.state === 'calculated') {
        assert.equal(corruptResult.calculation.reservationBasis, 'formula_lower_bound')
      }

      const mixedResult = await mixed.service.estimate(REQUEST)
      assert.equal(mixedResult.verdict, 'estimated_deny')
      assert.equal(mixedResult.runtimeObservedAt, OBSERVED_AT)
      assert.equal(mixedResult.facts.candidateDeclaredModel.observedAt, '2026-08-09T12:00:01.000Z')
      assert.equal(mixedResult.facts.candidateCalibration.observedAt, '2026-08-09T11:00:00.000Z')

      const futureResult = await future.service.estimate(REQUEST)
      assert.equal(futureResult.facts.candidateCalibration.state, 'unavailable')
      assert.equal(futureResult.facts.candidateCalibration.reason, 'calibration_timestamp_invalid')
      assert.equal(futureResult.calculation.state, 'calculated')
      if (futureResult.calculation.state === 'calculated') {
        assert.equal(futureResult.calculation.reservationBasis, 'formula_lower_bound')
      }
    } finally {
      closeHarness(corrupt)
      closeHarness(mixed)
      closeHarness(future)
    }
  })

  it('never allows stale, drifting, missing, pressured or ambiguous-topology facts', async () => {
    const cases: Array<{
      options?: HarnessOptions
      request?: EstimatedParallelAdmissionBody
      reason: string
    }> = [
      {
        request: { ...REQUEST, expectedRuntimeObservedAt: '2026-08-09T11:59:59.000Z' },
        reason: 'stale_runtime_sample',
      },
      { options: { identityDrift: true }, reason: 'candidate_provider_unavailable' },
      { options: { availableMemoryBytes: null }, reason: 'host_capacity_unavailable' },
      { options: { pressure: 'warning' }, reason: 'host_pressure_elevated' },
      { options: { pressure: 'unknown' }, reason: 'host_pressure_unavailable' },
      { options: { nvidia: true }, reason: 'host_topology_ambiguous' },
    ]
    for (const testCase of cases) {
      const value = await harness(testCase.options)
      try {
        const result = await value.service.estimate(testCase.request ?? REQUEST)
        assert.equal(result.verdict, 'unknown')
        assert.equal(result.reason, testCase.reason)
      } finally {
        closeHarness(value)
      }
    }
  })

  it('rejects every active/queued pair mismatch and ambiguous candidate owner', async () => {
    const cases: Array<{
      request: EstimatedParallelAdmissionBody
      options?: HarnessOptions
      pair: 'active' | 'candidate'
      pairReason: string
    }> = [
      {
        request: {
          ...REQUEST,
          active: { ...REQUEST.active, owner: { kind: 'operation', operationId: 'wrong' } },
        },
        pair: 'active',
        pairReason: 'active_owner_mismatch',
      },
      {
        request: {
          ...REQUEST,
          active: {
            ...REQUEST.active,
            model: { ...REQUEST.active.model, normalizedReference: 'wrong:latest' },
          },
        },
        pair: 'active',
        pairReason: 'active_model_mismatch',
      },
      {
        request: { ...REQUEST, active: { ...REQUEST.active, contextLength: 4_096 } },
        pair: 'active',
        pairReason: 'active_model_mismatch',
      },
      {
        request: {
          ...REQUEST,
          active: {
            ...REQUEST.active,
            model: { ...REQUEST.active.model, artifactDigest: 'sha256:wrong' },
          },
        },
        pair: 'active',
        pairReason: 'active_identity_unavailable',
      },
      {
        request: {
          ...REQUEST,
          candidate: {
            ...REQUEST.candidate,
            owner: { kind: 'operation', operationId: 'missing' },
          },
        },
        pair: 'candidate',
        pairReason: 'queued_owner_missing',
      },
      {
        request: {
          ...REQUEST,
          candidate: {
            ...REQUEST.candidate,
            model: { ...REQUEST.candidate.model, normalizedReference: 'wrong:latest' },
          },
        },
        pair: 'candidate',
        pairReason: 'queued_model_mismatch',
      },
      {
        request: { ...REQUEST, candidate: { ...REQUEST.candidate, contextLength: 4_096 } },
        pair: 'candidate',
        pairReason: 'queued_model_mismatch',
      },
      {
        request: REQUEST,
        options: { ambiguousQueue: true },
        pair: 'candidate',
        pairReason: 'queued_owner_ambiguous',
      },
    ]
    for (const testCase of cases) {
      const value = await harness(testCase.options)
      try {
        const result = await value.service.estimate(testCase.request)
        assert.equal(result.verdict, 'unknown')
        assert.equal(result.pair[testCase.pair].state, 'unavailable')
        assert.equal(result.pair[testCase.pair].reason, testCase.pairReason)
      } finally {
        closeHarness(value)
      }
    }
  })

  it('binds candidate evidence to the same internal Ollama endpoint', async () => {
    for (const candidateRuntimeHost of [
      'http://127.0.0.1:11435',
      'https://remote.invalid',
    ]) {
      const value = await harness({ candidateRuntimeHost })
      try {
        const result = estimatedParallelAdmissionResponseSchema.parse(
          await value.service.estimate(REQUEST),
        )
        assert.equal(result.verdict, 'unknown')
        assert.equal(result.reason, 'runtime_identity_changed')
        assert.equal(result.pair.candidate.reason, 'candidate_runtime_changed')
        assert.deepEqual(value.calls(), { runtime: 1, provider: 0 })
      } finally {
        closeHarness(value)
      }
    }
  })

  it('fails closed on provider arithmetic overflow and missing architecture', async () => {
    const overflow = await harness({ declaredBytes: Number.MAX_SAFE_INTEGER })
    const declaredOnly = await harness({ noArchitecture: true, availableMemoryBytes: 1_000 })
    try {
      const overflowResult = await overflow.service.estimate(REQUEST)
      assert.equal(overflowResult.verdict, 'unknown')
      assert.equal(overflowResult.reason, 'unsafe_arithmetic')
      const declaredResult = await declaredOnly.service.estimate(REQUEST)
      assert.equal(declaredResult.verdict, 'estimated_deny')
      assert.equal(declaredResult.calculation.state, 'calculated')
      if (declaredResult.calculation.state === 'calculated') {
        assert.equal(declaredResult.calculation.reservationBasis, 'declared_lower_bound')
        assert.equal(declaredResult.calculation.candidateReservation.bytes, DECLARED_BYTES)
      }
    } finally {
      closeHarness(overflow)
      closeHarness(declaredOnly)
    }
  })

  it('keeps independent contexts stable and cancellation leaves Governor state unchanged', async () => {
    const first = await harness({ availableMemoryBytes: FORMULA_RESERVATION })
    const second = await harness({ availableMemoryBytes: FORMULA_RESERVATION + 1 })
    const cancelled = await harness({ blockCandidateShow: true })
    const before = cancelled.governor.snapshot()
    try {
      const [one, two] = await Promise.all([
        first.service.estimate(REQUEST),
        second.service.estimate(REQUEST),
      ])
      assert.equal(one.verdict, 'estimated_deny')
      assert.equal(two.verdict, 'unknown')
      const controller = new AbortController()
      const pending = cancelled.service.estimate(REQUEST, controller.signal)
      await cancelled.showStarted
      controller.abort()
      await assert.rejects(
        pending,
        { name: 'AbortError' },
      )
      assert.deepEqual(cancelled.calls(), { runtime: 1, provider: 3 })
      assert.deepEqual(cancelled.governor.snapshot(), before)
    } finally {
      closeHarness(first)
      closeHarness(second)
      closeHarness(cancelled)
    }
  })

  it('has one typed flag consumer and no raw env, lifecycle or persistence boundary', () => {
    const source = readFileSync(
      new URL('../src/runtime/estimated-parallel-admission.ts', import.meta.url),
      'utf8',
    )
    assert.equal((source.match(/\.projection\(ESTIMATED_PARALLEL_ADMISSION_FLAG\)/gu) ?? []).length, 1)
    assert.equal((source.match(/ALAMO_FEATURE_|process\.env/gu) ?? []).length, 0)
    assert.equal((source.match(/\.acquire\(|\.release\(|\.enqueue\(|\.cancel\(/gu) ?? []).length, 0)
    assert.equal((source.match(/\.record\(|INSERT|UPDATE|DELETE|localStorage|analytics/gu) ?? []).length, 0)
    const serverSource = sourceTree(new URL('../src/', import.meta.url))
    const webSource = sourceTree(new URL('../../web/src/', import.meta.url))
    assert.equal(
      (serverSource.match(
        /\.projection\(ESTIMATED_PARALLEL_ADMISSION_FLAG\)/gu,
      ) ?? []).length,
      1,
    )
    assert.equal(
      (serverSource.match(/new EstimatedParallelAdmissionService\(/gu) ?? []).length,
      1,
    )
    assert.equal(
      (serverSource.match(/estimatedParallelAdmission\.estimate\(/gu) ?? []).length,
      1,
    )
    assert.equal(
      (webSource.match(/estimated-parallel-admission|EstimatedParallelAdmission/gu) ?? []).length,
      0,
    )
  })
})
