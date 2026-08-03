export function runtimeBrowserSnapshot() {
  const observedAt = '2026-08-02T12:00:00.000Z'
  const unknownMemory = (basis: string) => ({
    bytes: null,
    source: 'not_reported',
    observedAt,
    confidence: 'unknown',
    basis,
  })
  return {
    observedAt,
    source: {
      state: 'available',
      source: 'ollama_api_ps',
      observedAt,
      errorCode: null,
    },
    host: {
      state: 'available',
      observedAt,
      profile: {
        platform: 'darwin',
        arch: 'arm64',
        accelerator: 'metal',
        acceleratorName: 'Fixture Metal',
        unifiedMemory: true,
        source: 'legacy_hardware_probe',
        observedAt,
        confidence: 'observed',
        totalMemoryBytes: {
          bytes: 16_000_000_000,
          source: 'node_os_totalmem',
          observedAt,
          confidence: 'observed',
          basis: 'total_unified_memory',
        },
        legacyUsableMemoryBytes: {
          bytes: 11_200_000_000,
          source: 'legacy_apple_unified_memory_70_percent',
          observedAt,
          confidence: 'estimated',
          basis: 'legacy_compatibility_estimate_not_current_availability',
        },
        discreteVramBytes: unknownMemory(
          'discrete_vram_not_applicable_to_apple_unified_memory',
        ),
      },
      sample: {
        source: 'apple_vm_stat',
        observedAt,
        freeMemoryBytes: {
          bytes: 2_000_000_000,
          source: 'apple_vm_stat_pages_free',
          observedAt,
          confidence: 'observed',
          basis: 'system_free_pages_not_safe_capacity',
        },
        availableMemoryBytes: unknownMemory('system_available_memory_advisory'),
        pressure: {
          level: 'unknown',
          source: 'not_reported',
          observedAt,
          confidence: 'unknown',
          basis: 'not_observed',
        },
        gpuFreeMemoryBytes: unknownMemory('gpu_free_memory_not_reported'),
      },
      availableFields: [
        'total_unified_memory_bytes',
        'legacy_usable_memory_estimate_bytes',
        'free_memory_bytes',
      ],
      missingFields: [
        'available_memory_bytes',
        'memory_pressure',
        'discrete_vram_bytes',
        'gpu_free_memory_bytes',
      ],
      errorCode: null,
    },
    governor: {
      observedAt,
      accepting: true,
      policy: {
        acceleratorPermits: 1,
        order: 'fifo',
        priorities: ['normal'],
        scope: 'application_process',
        basis: 'conservative_single_process_single_accelerator_permit_fifo',
      },
      queued: [],
      activeLease: null,
      lastDecision: null,
    },
    models: [],
    decisions: [
      {
        code: 'empty_sample',
        modelName: null,
        normalizedModelName: null,
        leaseId: null,
        owner: null,
        runtimeDigest: null,
        requestedContext: null,
        observedContext: null,
        identityBasis: 'none',
        artifactIdentity: 'unknown',
      },
    ],
  }
}

export function activeRuntimeBrowserSnapshot() {
  const base = runtimeBrowserSnapshot()
  const observedAt = base.observedAt
  const activeLease = {
    leaseId: 'lease-browser-active',
    ticketId: 'ticket-browser-active',
    owner: { kind: 'job', jobId: 'job-browser-active' },
    operation: 'chat',
    model: { provider: 'ollama', name: 'browser-active:latest' },
    requestedContext: 16_384,
    acquiredAt: observedAt,
    state: 'active',
  }
  const queued = [1, 2].map((position) => ({
    ticketId: `ticket-browser-${position}`,
    owner: { kind: 'operation', operationId: `operation-browser-${position}` },
    operation: position === 1 ? 'model_warm' : 'compaction',
    model: { provider: 'ollama', name: `browser-waiter-${position}:latest` },
    requestedContext: 4_096 * position,
    priority: 'normal',
    enqueuedAt: observedAt,
    reason: position === 1 ? 'single_permit_busy' : 'fifo_predecessor',
  }))
  const currentFit = {
    state: 'observed',
    basis: 'current_loaded_configuration',
    reason: 'observed_current_residency',
    observedAt,
    requestedContext: 16_384,
    observedContext: 16_384,
    runtimeAllocationBytes: 5_000_000_000,
    runtimeAcceleratorAllocationBytes: 4_000_000_000,
    pressureLevel: 'normal',
    futureAdmissionGuarantee: false,
  }
  const row = {
    name: 'browser-active:latest',
    digest: 'sha256:browser-active',
    sizeBytes: 5_000_000_000,
    sizeVramBytes: 4_000_000_000,
    gpuPercent: null,
    processorLabel: null,
    contextLength: 16_384,
    expiresAt: null,
    source: 'ollama_api_ps',
    observedAt,
    normalizedName: 'browser-active:latest',
    ownerState: 'active_lease',
    leaseId: activeLease.leaseId,
    owner: activeLease.owner,
    decisionCode: 'matched_active_lease',
    identityBasis: 'exact_normalized_model_reference',
    artifactIdentity: 'unknown',
    currentFit,
  }
  const unknownRow = {
    ...row,
    name: 'browser-unknown-owner:latest',
    digest: 'sha256:browser-unknown',
    sizeBytes: 2_000_000_000,
    sizeVramBytes: null,
    contextLength: null,
    normalizedName: 'browser-unknown-owner:latest',
    ownerState: 'unknown',
    leaseId: null,
    owner: null,
    decisionCode: 'observed_unknown_owner',
    identityBasis: 'runtime_observation_only',
    currentFit: {
      ...currentFit,
      state: 'unknown',
      basis: 'insufficient_evidence',
      reason: 'runtime_owner_unknown',
      requestedContext: null,
      observedContext: null,
      runtimeAllocationBytes: 2_000_000_000,
      runtimeAcceleratorAllocationBytes: null,
      pressureLevel: 'unknown',
    },
  }

  return {
    ...base,
    host: {
      ...base.host,
      sample: {
        ...base.host.sample,
        availableMemoryBytes: {
          bytes: 7_000_000_000,
          source: 'apple_host_available_memory',
          observedAt,
          confidence: 'observed',
          basis: 'system_available_memory_advisory',
        },
        pressure: {
          level: 'normal',
          source: 'apple_host_memory_pressure',
          observedAt,
          confidence: 'observed',
          basis: 'system_memory_pressure',
        },
      },
      availableFields: [
        ...base.host.availableFields,
        'available_memory_bytes',
        'memory_pressure',
      ],
      missingFields: ['discrete_vram_bytes', 'gpu_free_memory_bytes'],
    },
    governor: {
      ...base.governor,
      queued,
      activeLease,
    },
    models: [row, unknownRow],
    decisions: [
      {
        code: 'matched_active_lease',
        modelName: row.name,
        normalizedModelName: row.normalizedName,
        leaseId: activeLease.leaseId,
        owner: activeLease.owner,
        runtimeDigest: row.digest,
        requestedContext: 16_384,
        observedContext: 16_384,
        identityBasis: 'exact_normalized_model_reference',
        artifactIdentity: 'unknown',
      },
      {
        code: 'observed_unknown_owner',
        modelName: unknownRow.name,
        normalizedModelName: unknownRow.normalizedName,
        leaseId: null,
        owner: null,
        runtimeDigest: unknownRow.digest,
        requestedContext: null,
        observedContext: null,
        identityBasis: 'runtime_observation_only',
        artifactIdentity: 'unknown',
      },
    ],
  }
}

export function degradedRuntimeBrowserSnapshot() {
  const active = activeRuntimeBrowserSnapshot()
  return {
    ...active,
    source: {
      state: 'unavailable',
      source: 'ollama_api_ps',
      observedAt: active.observedAt,
      errorCode: 'ollama_unavailable',
    },
    models: null,
    decisions: [
      {
        code: 'source_failure',
        modelName: null,
        normalizedModelName: null,
        leaseId: null,
        owner: null,
        runtimeDigest: null,
        requestedContext: null,
        observedContext: null,
        identityBasis: 'none',
        artifactIdentity: 'unknown',
      },
      {
        code: 'active_not_observed',
        modelName: active.governor.activeLease.model.name,
        normalizedModelName: active.governor.activeLease.model.name,
        leaseId: active.governor.activeLease.leaseId,
        owner: active.governor.activeLease.owner,
        runtimeDigest: null,
        requestedContext: active.governor.activeLease.requestedContext,
        observedContext: null,
        identityBasis: 'none',
        artifactIdentity: 'unknown',
      },
    ],
  }
}
