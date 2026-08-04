import {
  runtimeSnapshotSchema,
  type RuntimeGovernorSnapshot,
  type RuntimeModelObservation,
  type RuntimeSnapshot,
} from '@alamo/contract'

export const RUNTIME_OBSERVED_AT = '2026-08-02T12:00:00.000Z'

export function runtimeActiveLease(
  owner: RuntimeGovernorSnapshot['activeLease'] extends infer Lease
    ? NonNullable<Lease>['owner']
    : never = { kind: 'job', jobId: 'job-fixture' },
): NonNullable<RuntimeGovernorSnapshot['activeLease']> {
  return {
    leaseId: 'lease-active',
    ticketId: 'ticket-active',
    owner,
    operation: 'chat',
    model: { provider: 'ollama', name: 'fixture:latest' },
    requestedContext: 8_192,
    acquiredAt: RUNTIME_OBSERVED_AT,
    state: 'active',
  }
}

export function runtimeWaiter(
  index: number,
  owner: { kind: 'job'; jobId: string } | { kind: 'operation'; operationId: string } = {
    kind: 'operation',
    operationId: `operation-${index}`,
  },
): RuntimeGovernorSnapshot['queued'][number] {
  return {
    ticketId: `ticket-waiter-${index}`,
    owner,
    operation: index % 2 === 0 ? 'compaction' : 'model_warm',
    model: { provider: 'ollama', name: `waiter-${index}:latest` },
    requestedContext: 4_096 * index,
    priority: 'normal',
    enqueuedAt: RUNTIME_OBSERVED_AT,
    reason: index === 1 ? 'single_permit_busy' : 'fifo_predecessor',
  }
}

export function runtimeModel(
  ownerState: RuntimeModelObservation['ownerState'] = 'active_lease',
  fitState: RuntimeModelObservation['currentFit']['state'] = 'observed',
): RuntimeModelObservation {
  const active = ownerState === 'active_lease'
  return {
    name: active ? 'fixture:latest' : 'external-possible:latest',
    digest: active ? 'sha256:fixture' : 'sha256:unknown-owner',
    sizeBytes: active ? 4_000_000_000 : 2_000_000_000,
    sizeVramBytes: active ? 3_000_000_000 : null,
    gpuPercent: null,
    processorLabel: null,
    contextLength: active ? 8_192 : null,
    expiresAt: null,
    source: 'ollama_api_ps',
    observedAt: RUNTIME_OBSERVED_AT,
    normalizedName: active ? 'fixture:latest' : 'external-possible:latest',
    ownerState,
    leaseId: active ? 'lease-active' : null,
    owner: active ? { kind: 'job', jobId: 'job-fixture' } : null,
    decisionCode: active ? 'matched_active_lease' : 'observed_unknown_owner',
    identityBasis: active
      ? 'exact_normalized_model_reference'
      : 'runtime_observation_only',
    artifactIdentity: 'unknown',
    currentFit:
      fitState === 'observed'
        ? {
            state: 'observed',
            basis: 'current_loaded_configuration',
            reason: 'observed_current_residency',
            observedAt: RUNTIME_OBSERVED_AT,
            requestedContext: 8_192,
            observedContext: 8_192,
            runtimeAllocationBytes: 4_000_000_000,
            runtimeAcceleratorAllocationBytes: 3_000_000_000,
            pressureLevel: 'normal',
            futureAdmissionGuarantee: false,
          }
        : {
            state: 'unknown',
            basis: 'insufficient_evidence',
            reason: active ? 'host_pressure_unknown' : 'runtime_owner_unknown',
            observedAt: RUNTIME_OBSERVED_AT,
            requestedContext: active ? 8_192 : null,
            observedContext: active ? 8_192 : null,
            runtimeAllocationBytes: active ? 4_000_000_000 : 2_000_000_000,
            runtimeAcceleratorAllocationBytes: active ? 3_000_000_000 : null,
            pressureLevel: 'unknown',
            futureAdmissionGuarantee: false,
          },
  }
}

export function runtimeSnapshotFixture(
  mutate?: (snapshot: RuntimeSnapshot) => void,
): RuntimeSnapshot {
  const snapshot: RuntimeSnapshot = {
    observedAt: RUNTIME_OBSERVED_AT,
    source: {
      state: 'available',
      source: 'ollama_api_ps',
      observedAt: RUNTIME_OBSERVED_AT,
      errorCode: null,
    },
    host: {
      state: 'available',
      observedAt: RUNTIME_OBSERVED_AT,
      profile: {
        platform: 'darwin',
        arch: 'arm64',
        accelerator: 'metal',
        acceleratorName: 'Fixture Metal',
        unifiedMemory: true,
        source: 'legacy_hardware_probe',
        observedAt: RUNTIME_OBSERVED_AT,
        confidence: 'observed',
        totalMemoryBytes: {
          bytes: 16_000_000_000,
          source: 'node_os_totalmem',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'observed',
          basis: 'total_unified_memory',
        },
        legacyUsableMemoryBytes: {
          bytes: 11_200_000_000,
          source: 'legacy_apple_unified_memory_70_percent',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'estimated',
          basis: 'legacy_compatibility_estimate_not_current_availability',
        },
        discreteVramBytes: {
          bytes: null,
          source: 'not_reported',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'unknown',
          basis: 'discrete_vram_not_applicable_to_apple_unified_memory',
        },
      },
      sample: {
        source: 'apple_vm_stat',
        observedAt: RUNTIME_OBSERVED_AT,
        freeMemoryBytes: {
          bytes: 2_000_000_000,
          source: 'apple_vm_stat_pages_free',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'observed',
          basis: 'system_free_pages_not_safe_capacity',
        },
        availableMemoryBytes: {
          bytes: 6_000_000_000,
          source: 'apple_host_available_memory',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'observed',
          basis: 'system_available_memory_advisory',
        },
        pressure: {
          level: 'normal',
          source: 'apple_host_memory_pressure',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'observed',
          basis: 'system_memory_pressure',
        },
        gpuFreeMemoryBytes: {
          bytes: null,
          source: 'not_reported',
          observedAt: RUNTIME_OBSERVED_AT,
          confidence: 'unknown',
          basis: 'gpu_free_memory_not_reported',
        },
      },
      availableFields: [
        'total_unified_memory_bytes',
        'legacy_usable_memory_estimate_bytes',
        'free_memory_bytes',
        'available_memory_bytes',
        'memory_pressure',
      ],
      missingFields: ['discrete_vram_bytes', 'gpu_free_memory_bytes'],
      errorCode: null,
      nvidia: {
        state: 'unsupported',
        source: 'none',
        observedAt: RUNTIME_OBSERVED_AT,
        devices: [],
        reason: 'platform_not_linux',
      },
    },
    governor: {
      observedAt: RUNTIME_OBSERVED_AT,
      accepting: true,
      policy: {
        acceleratorPermits: 1,
        order: 'fifo',
        priorities: ['normal'],
        scope: 'application_process',
        basis: 'conservative_single_process_single_accelerator_permit_fifo',
      },
      queued: [runtimeWaiter(1), runtimeWaiter(2)],
      activeLease: runtimeActiveLease(),
      lastDecision: {
        ticketId: 'ticket-waiter-2',
        decisionCode: 'queued_fifo',
        observedAt: RUNTIME_OBSERVED_AT,
        policyBasis: 'conservative_single_process_single_accelerator_permit_fifo',
        owner: { kind: 'operation', operationId: 'operation-2' },
        operation: 'compaction',
        model: { provider: 'ollama', name: 'waiter-2:latest' },
        requestedContext: 8_192,
        queuePosition: 2,
      },
    },
    models: [runtimeModel('active_lease', 'observed'), runtimeModel('unknown', 'unknown')],
    decisions: [
      {
        code: 'matched_active_lease',
        modelName: 'fixture:latest',
        normalizedModelName: 'fixture:latest',
        leaseId: 'lease-active',
        owner: { kind: 'job', jobId: 'job-fixture' },
        runtimeDigest: 'sha256:fixture',
        requestedContext: 8_192,
        observedContext: 8_192,
        identityBasis: 'exact_normalized_model_reference',
        artifactIdentity: 'unknown',
      },
      {
        code: 'observed_unknown_owner',
        modelName: 'external-possible:latest',
        normalizedModelName: 'external-possible:latest',
        leaseId: null,
        owner: null,
        runtimeDigest: 'sha256:unknown-owner',
        requestedContext: null,
        observedContext: null,
        identityBasis: 'runtime_observation_only',
        artifactIdentity: 'unknown',
      },
    ],
  }

  mutate?.(snapshot)
  return runtimeSnapshotSchema.parse(structuredClone(snapshot))
}

export function linuxNvidiaRuntimeSnapshot(
  state: 'available' | 'partial' | 'unavailable' = 'available',
): RuntimeSnapshot {
  return runtimeSnapshotFixture((snapshot) => {
    snapshot.host.state = state
    snapshot.host.profile.platform = 'linux'
    snapshot.host.profile.arch = 'x64'
    snapshot.host.profile.accelerator = 'cuda'
    snapshot.host.profile.acceleratorName = 'Legacy startup NVIDIA profile'
    snapshot.host.profile.unifiedMemory = false
    snapshot.host.profile.totalMemoryBytes.basis = 'total_system_memory'
    snapshot.host.profile.legacyUsableMemoryBytes.source = 'legacy_hardware_usable_estimate'
    snapshot.host.profile.discreteVramBytes.basis = 'discrete_vram_not_observed'
    snapshot.host.sample.source = state === 'unavailable' ? 'none' : 'nvidia_smi'
    snapshot.host.sample.availableMemoryBytes.bytes = null
    snapshot.host.sample.availableMemoryBytes.source = 'not_reported'
    snapshot.host.sample.availableMemoryBytes.confidence = 'unknown'
    snapshot.host.sample.pressure.level = 'unknown'
    snapshot.host.sample.pressure.source = 'not_reported'
    snapshot.host.sample.pressure.confidence = 'unknown'
    snapshot.host.sample.pressure.basis = 'not_observed'
    snapshot.host.availableFields = ['total_system_memory_bytes', 'legacy_usable_memory_estimate_bytes']
    snapshot.host.missingFields = [
      'free_memory_bytes', 'available_memory_bytes', 'memory_pressure',
      'discrete_vram_bytes', 'gpu_free_memory_bytes',
      ...(state === 'unavailable' ? ['nvidia_devices' as const] : []),
    ]
    snapshot.host.errorCode = state === 'available' ? null : 'host_probe_malformed'
    snapshot.host.nvidia = {
      state,
      source: state === 'unavailable' ? 'none' : 'nvidia_smi',
      observedAt: RUNTIME_OBSERVED_AT,
      reason: state === 'available' ? null : state === 'partial' ? 'some_rows_malformed' : 'all_rows_malformed',
      devices: state === 'unavailable' ? [] : [
        nvidiaDevice(2, 'GPU-sensitive-first-12345678', 'NVIDIA RTX 4090', 24_576, 8_192),
        nvidiaDevice(7, null, 'NVIDIA Тестовая GPU', 98_304, 0),
      ],
    }
    snapshot.models = snapshot.models?.map((model) => ({
      ...model,
      currentFit: {
        ...model.currentFit,
        state: 'unknown' as const,
        basis: 'insufficient_evidence' as const,
        reason: 'observation_key_unavailable' as const,
        pressureLevel: 'unknown' as const,
        futureAdmissionGuarantee: false as const,
      },
    })) ?? null
  })
}

function nvidiaDevice(
  providerIndex: number,
  uuid: string | null,
  displayName: string,
  totalMib: number,
  freeMib: number,
) {
  return {
    providerIndex,
    uuid,
    displayName,
    source: 'nvidia_smi_query_gpu' as const,
    observedAt: RUNTIME_OBSERVED_AT,
    confidence: 'observed' as const,
    totalVramBytes: {
      bytes: totalMib * 1024 ** 2,
      source: 'nvidia_smi_memory_total' as const,
      observedAt: RUNTIME_OBSERVED_AT,
      confidence: 'observed' as const,
      basis: 'device_total_vram' as const,
    },
    freeVramBytes: {
      bytes: freeMib * 1024 ** 2,
      source: 'nvidia_smi_memory_free' as const,
      observedAt: RUNTIME_OBSERVED_AT,
      confidence: 'observed' as const,
      basis: 'device_free_vram_not_safe_capacity' as const,
    },
  }
}
