import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  listRunningResponse,
  runtimeSnapshotSchema,
  type HardwareInfo,
  type RunningModel,
  type RuntimeHostTelemetry,
} from '@guanxi/contract'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import {
  UnsupportedHostTelemetry,
  type HostTelemetry,
} from '../src/hardware/telemetry.ts'
import {
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
} from '../src/ollama/client.ts'
import {
  ResourceGovernor,
  ResourceGovernorError,
  type AdmissionRequest,
  type ResourceLease,
} from '../src/runtime/resource-governor.ts'
import {
  RuntimeReconciliationService,
  normalizeOllamaModelReference,
} from '../src/runtime/reconciliation.ts'

const OBSERVED_AT = '2026-08-03T12:00:00.000Z'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function appleHost(options: {
  pressure?: 'normal' | 'warning' | 'critical' | 'unknown'
  availableMemoryBytes?: number | null
  state?: RuntimeHostTelemetry['state']
  platform?: string
} = {}): RuntimeHostTelemetry {
  const pressure = options.pressure ?? 'normal'
  const availableMemoryBytes = options.availableMemoryBytes ?? 4_000
  const state = options.state ?? 'available'
  const observed = (bytes: number, source: 'node_os_totalmem' | 'apple_vm_stat_pages_free' | 'apple_host_available_memory', basis: 'total_unified_memory' | 'system_free_pages_not_safe_capacity' | 'system_available_memory_advisory') => ({
    bytes,
    source,
    observedAt: OBSERVED_AT,
    confidence: 'observed' as const,
    basis,
  })
  const unknown = (basis: 'discrete_vram_not_applicable_to_apple_unified_memory' | 'gpu_free_memory_not_reported' | 'system_available_memory_advisory') => ({
    bytes: null,
    source: 'not_reported' as const,
    observedAt: OBSERVED_AT,
    confidence: 'unknown' as const,
    basis,
  })
  return {
    state,
    observedAt: OBSERVED_AT,
    profile: {
      platform: options.platform ?? 'darwin',
      arch: 'arm64',
      accelerator: 'metal',
      acceleratorName: 'fixture',
      unifiedMemory: true,
      source: 'legacy_hardware_probe',
      observedAt: OBSERVED_AT,
      confidence: 'observed',
      totalMemoryBytes: observed(
        HARDWARE.totalMemoryBytes,
        'node_os_totalmem',
        'total_unified_memory',
      ),
      legacyUsableMemoryBytes: {
        bytes: HARDWARE.usableMemoryBytes,
        source: 'legacy_apple_unified_memory_70_percent',
        observedAt: OBSERVED_AT,
        confidence: 'estimated',
        basis: 'legacy_compatibility_estimate_not_current_availability',
      },
      discreteVramBytes: unknown(
        'discrete_vram_not_applicable_to_apple_unified_memory',
      ),
    },
    sample: {
      source: 'apple_vm_stat',
      observedAt: OBSERVED_AT,
      freeMemoryBytes: observed(
        3_000,
        'apple_vm_stat_pages_free',
        'system_free_pages_not_safe_capacity',
      ),
      availableMemoryBytes:
        availableMemoryBytes === null
          ? unknown('system_available_memory_advisory')
          : observed(
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
    availableFields: [
      'total_unified_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
      'free_memory_bytes',
      ...(availableMemoryBytes === null ? [] : ['available_memory_bytes'] as const),
      ...(pressure === 'unknown' ? [] : ['memory_pressure'] as const),
    ],
    missingFields: [
      ...(availableMemoryBytes === null ? ['available_memory_bytes'] as const : []),
      ...(pressure === 'unknown' ? ['memory_pressure'] as const : []),
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
    ],
    errorCode: state === 'available' ? null : 'host_probe_failed',
    nvidia: {
      state: 'unknown',
      source: 'none',
      observedAt: OBSERVED_AT,
      devices: [],
      reason: 'legacy_snapshot',
    },
  }
}

function fixedHostTelemetry(
  sample: () => Promise<RuntimeHostTelemetry>,
  profile: HardwareInfo = HARDWARE,
): HostTelemetry {
  return { profile, sample }
}

function request(ownerId: string, model = ownerId): AdmissionRequest {
  return {
    owner: { kind: 'operation', operationId: ownerId },
    operation: 'model_warm',
    model: { provider: 'ollama', name: model },
    requestedContext: 8_192,
    priority: 'normal',
    enqueuedAt: OBSERVED_AT,
  }
}

function running(
  name: string,
  options: Partial<Pick<RunningModel, 'digest' | 'contextLength'>> = {},
): RunningModel {
  return {
    name,
    digest: options.digest ?? `sha256:${name}`,
    sizeBytes: 1_000,
    sizeVramBytes: 750,
    gpuPercent: null,
    processorLabel: null,
    contextLength: options.contextLength ?? 8_192,
    expiresAt: '2026-08-03T12:10:00.000Z',
    source: 'ollama_api_ps',
    observedAt: '2020-01-01T00:00:00.000Z',
  }
}

function reconciliation(
  governor: ResourceGovernor,
  ps: () => Promise<RunningModel[]>,
  hostTelemetry: HostTelemetry = new UnsupportedHostTelemetry(
    HARDWARE,
    () => new Date(OBSERVED_AT),
  ),
  identity?: {
    installed: readonly { name: string; digest: string }[]
    runtimeVersion?: string
    runtimeHost?: string
    hardware?: HardwareInfo
  },
): RuntimeReconciliationService {
  return new RuntimeReconciliationService({
    governor,
    hostTelemetry,
    models: () => ({
      ps,
      ...(identity
        ? {
            installedArtifacts: async () => identity.installed,
            runtimeVersion: async () => identity.runtimeVersion ?? '0.12.6',
            runtimeHost: identity.runtimeHost ?? 'http://127.0.0.1:11434',
            hardwareProfile: identity.hardware ?? HARDWARE,
          }
        : {}),
    }),
    now: () => new Date(OBSERVED_AT),
  })
}

async function activeLease(
  governor: ResourceGovernor,
  model: string,
  ownerId = 'active-owner',
): Promise<ResourceLease> {
  return governor.acquire(governor.enqueue(request(ownerId, model)))
}

describe('runtime reconciliation contract and identity', () => {
  it('normalizes only exact Ollama references and does not fuzzy-match invalid names', () => {
    assert.equal(normalizeOllamaModelReference(' QWEN3 '), 'qwen3:latest')
    assert.equal(normalizeOllamaModelReference('library/QWEN3:8B'), 'library/qwen3:8b')
    assert.equal(
      normalizeOllamaModelReference('registry.invalid:5000/team/model'),
      'registry.invalid:5000/team/model:latest',
    )
    assert.equal(normalizeOllamaModelReference('../private/model'), null)
    assert.equal(normalizeOllamaModelReference('/tmp/private'), null)
    assert.equal(normalizeOllamaModelReference('model secret'), null)
  })

  it('round-trips active/queued admission, matched and unknown rows without digest identity claims', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'Fixture')
    const queued = governor.enqueue(request('queued-owner', 'queued'))
    const service = reconciliation(governor, async () => [
      running('fixture:latest', { digest: 'sha256:observed', contextLength: 8_192 }),
      running('second:latest', { digest: 'sha256:second', contextLength: 4_096 }),
    ])

    const snapshot = runtimeSnapshotSchema.parse(await service.snapshot())
    assert.equal(snapshot.observedAt, OBSERVED_AT)
    assert.equal(snapshot.source.state, 'available')
    assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
    assert.equal(snapshot.governor.activeLease?.requestedContext, 8_192)
    assert.deepEqual(snapshot.governor.queued.map((entry) => entry.ticketId), [queued.id])
    assert.deepEqual(
      snapshot.models?.map((model) => ({
        name: model.normalizedName,
        owner: model.ownerState,
        decision: model.decisionCode,
        artifact: model.artifactIdentity,
      })),
      [
        {
          name: 'fixture:latest',
          owner: 'active_lease',
          decision: 'matched_active_lease',
          artifact: 'unknown',
        },
        {
          name: 'second:latest',
          owner: 'unknown',
          decision: 'observed_unknown_owner',
          artifact: 'unknown',
        },
      ],
    )
    const matched = snapshot.decisions.find((item) => item.code === 'matched_active_lease')
    assert.equal(matched?.runtimeDigest, 'sha256:observed')
    assert.equal(matched?.requestedContext, 8_192)
    assert.equal(matched?.observedContext, 8_192)
    assert.equal(matched?.artifactIdentity, 'unknown')
    assert.equal(snapshot.models?.every((model) => model.observedAt === OBSERVED_AT), true)

    const additive = runtimeSnapshotSchema.parse({
      ...snapshot,
      futureHostTelemetry: { state: 'unknown' },
    })
    assert.equal(additive.observedAt, OBSERVED_AT)

    lease.release()
    assert.equal(governor.cancel(queued), true)
  })

  it('keeps a successful empty sample distinct and leaves an active lease not observed', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'active:latest')
    const snapshot = runtimeSnapshotSchema.parse(
      await reconciliation(governor, async () => []).snapshot(),
    )

    assert.deepEqual(snapshot.models, [])
    assert.deepEqual(
      snapshot.decisions.map((item) => item.code),
      ['active_not_observed', 'empty_sample'],
    )
    assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
    assert.equal(governor.active, true)
    assert.throws(
      () => governor.assertCanUnload({ provider: 'ollama', name: 'active:latest' }),
      ResourceGovernorError,
    )
    lease.release()
  })

  it('labels only an exact loaded configuration with sufficient Apple facts as observed current fit', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'fixture:latest')
    const host = appleHost()
    const service = reconciliation(
      governor,
      async () => [running('fixture:latest', { digest: 'sha256:provider-observation' })],
      fixedHostTelemetry(async () => host),
      { installed: [{ name: 'fixture:latest', digest: 'sha256:provider-observation' }] },
    )

    const snapshot = runtimeSnapshotSchema.parse(await service.snapshot())
    const model = snapshot.models?.[0]
    assert.equal(model?.currentFit.state, 'observed')
    assert.equal(model?.currentFit.basis, 'current_loaded_configuration')
    assert.equal(model?.currentFit.reason, 'observed_current_residency')
    assert.equal(model?.currentFit.runtimeAllocationBytes, 1_000)
    assert.equal(model?.currentFit.runtimeAcceleratorAllocationBytes, 750)
    assert.equal(model?.currentFit.pressureLevel, 'normal')
    assert.equal(model?.currentFit.futureAdmissionGuarantee, false)
    assert.equal(model?.artifactIdentity, 'exact_digest')
    assert.equal(model?.observationKey.state, 'complete')
    assert.equal(model?.digest, 'sha256:provider-observation')
    assert.equal(snapshot.host.profile.totalMemoryBytes.source, 'node_os_totalmem')
    assert.equal(
      snapshot.host.profile.legacyUsableMemoryBytes.source,
      'legacy_apple_unified_memory_70_percent',
    )
    assert.equal(snapshot.host.profile.discreteVramBytes.bytes, null)
    assert.equal(snapshot.host.sample.gpuFreeMemoryBytes.bytes, null)
    assert.throws(() =>
      runtimeSnapshotSchema.parse({
        ...snapshot,
        decisions: snapshot.decisions.map((decision, index) =>
          index === 0 ? { ...decision, artifactIdentity: 'unknown' } : decision,
        ),
      }),
    )
    lease.release()
  })

  it('publishes complete keys only for exact tags↔ps/version/local-host identity', async () => {
    const fixtures = [
      {
        name: 'exact',
        identity: { installed: [{ name: 'fixture:latest', digest: 'sha256:runtime' }] },
        keyState: 'complete',
        reason: null,
      },
      {
        name: 'changed installed digest',
        identity: { installed: [{ name: 'fixture:latest', digest: 'sha256:stale' }] },
        keyState: 'unavailable',
        reason: 'installed_digest_mismatch',
      },
      {
        name: 'ambiguous installed reference',
        identity: {
          installed: [
            { name: 'fixture:latest', digest: 'sha256:runtime' },
            { name: 'FIXTURE', digest: 'sha256:runtime' },
          ],
        },
        keyState: 'unavailable',
        reason: 'installed_reference_ambiguous',
      },
      {
        name: 'missing runtime version',
        identity: {
          installed: [{ name: 'fixture:latest', digest: 'sha256:runtime' }],
          runtimeVersion: '',
        },
        keyState: 'unavailable',
        reason: 'runtime_version_unavailable',
      },
      {
        name: 'remote runtime with local hardware',
        identity: {
          installed: [{ name: 'fixture:latest', digest: 'sha256:runtime' }],
          runtimeHost: 'https://remote.example',
        },
        keyState: 'unavailable',
        reason: 'hardware_fingerprint_unavailable',
      },
    ] as const

    for (const fixture of fixtures) {
      const governor = new ResourceGovernor()
      const lease = await activeLease(governor, 'fixture:latest')
      const snapshot = runtimeSnapshotSchema.parse(
        await reconciliation(
          governor,
          async () => [running('fixture:latest', { digest: 'sha256:runtime' })],
          fixedHostTelemetry(async () => appleHost()),
          fixture.identity,
        ).snapshot(),
      )
      const key = snapshot.models?.[0]?.observationKey
      assert.equal(key?.state, fixture.keyState, fixture.name)
      assert.equal(
        key?.state === 'unavailable' ? key.reason : null,
        fixture.reason,
        fixture.name,
      )
      assert.equal(
        snapshot.models?.[0]?.artifactIdentity,
        fixture.keyState === 'complete' ? 'exact_digest' : 'unknown',
        fixture.name,
      )
      assert.equal(
        snapshot.models?.[0]?.currentFit.state,
        fixture.keyState === 'complete' ? 'observed' : 'unknown',
        fixture.name,
      )
      if (fixture.keyState === 'unavailable') {
        assert.equal(
          snapshot.models?.[0]?.currentFit.reason,
          'observation_key_unavailable',
          fixture.name,
        )
      }
      lease.release()
    }
  })

  it('parses a legacy observed Runtime snapshot as unavailable without fabricated components', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'fixture:latest')
    const current = await reconciliation(
      governor,
      async () => [running('fixture:latest', { digest: 'sha256:runtime' })],
      fixedHostTelemetry(async () => appleHost()),
      { installed: [{ name: 'fixture:latest', digest: 'sha256:runtime' }] },
    ).snapshot()
    const currentModel = current.models?.[0]
    assert.ok(currentModel)
    const { observationKey: _modelKey, ...legacyModel } = currentModel
    const legacyDecisions = current.decisions.map((item) => {
      const { observationKey: _decisionKey, ...legacyDecision } = item
      return { ...legacyDecision, artifactIdentity: 'unknown' as const }
    })
    const parsed = runtimeSnapshotSchema.parse({
      ...current,
      models: [{ ...legacyModel, artifactIdentity: 'unknown' }],
      decisions: legacyDecisions,
    })
    assert.deepEqual(parsed.models?.[0]?.observationKey, {
      state: 'unavailable',
      version: 1,
      reason: 'legacy_snapshot',
    })
    assert.equal(parsed.models?.[0]?.currentFit.state, 'observed')
    lease.release()
  })

  it('keeps current fit unknown for ambiguous digest rows, context/host mismatch, and missing pressure', async () => {
    const fixtures: Array<{
      name: string
      running: RunningModel[]
      host: RuntimeHostTelemetry
      reason: string
    }> = [
      {
        name: 'ambiguous digest rows',
        running: [
          running('fixture:latest', { digest: 'sha256:first' }),
          running('FIXTURE', { digest: 'sha256:second' }),
        ],
        host: appleHost(),
        reason: 'runtime_reference_ambiguous',
      },
      {
        name: 'context mismatch',
        running: [running('fixture:latest', { contextLength: 4_096 })],
        host: appleHost(),
        reason: 'runtime_context_mismatch',
      },
      {
        name: 'host mismatch',
        running: [running('fixture:latest')],
        host: appleHost({ platform: 'linux' }),
        reason: 'host_unsupported',
      },
      {
        name: 'missing pressure',
        running: [running('fixture:latest')],
        host: appleHost({ pressure: 'unknown' }),
        reason: 'host_pressure_unknown',
      },
    ]

    for (const fixture of fixtures) {
      const governor = new ResourceGovernor()
      const lease = await activeLease(governor, 'fixture:latest')
      const snapshot = runtimeSnapshotSchema.parse(
        await reconciliation(
          governor,
          async () => fixture.running,
          fixedHostTelemetry(async () => fixture.host),
          {
            installed: fixture.running.map((model) => ({
              name: model.name,
              digest: model.digest ?? '',
            })),
          },
        ).snapshot(),
      )
      assert.equal(snapshot.models?.[0]?.currentFit.state, 'unknown', fixture.name)
      assert.equal(snapshot.models?.[0]?.currentFit.reason, fixture.reason, fixture.name)
      assert.equal(snapshot.models?.[0]?.currentFit.futureAdmissionGuarantee, false)
      assert.equal(
        snapshot.models?.[0]?.artifactIdentity,
        fixture.reason === 'runtime_reference_ambiguous' ? 'unknown' : 'exact_digest',
      )
      lease.release()
    }
  })

  it('keeps Linux NVIDIA fit and observation identity unavailable without a device allocation link', async () => {
    const linuxHardware: HardwareInfo = {
      ...HARDWARE,
      platform: 'linux',
      arch: 'x64',
      accelerator: 'cuda',
      acceleratorName: 'legacy first GPU name',
      unifiedMemory: false,
      totalMemoryBytes: 64 * 1024 ** 3,
      usableMemoryBytes: 22 * 1024 ** 3,
    }
    const host = appleHost({ platform: 'linux' })
    host.profile.arch = 'x64'
    host.profile.accelerator = 'cuda'
    host.profile.acceleratorName = 'legacy first GPU name'
    host.profile.unifiedMemory = false
    host.profile.totalMemoryBytes.basis = 'total_system_memory'
    host.profile.legacyUsableMemoryBytes.source = 'legacy_hardware_usable_estimate'
    host.profile.discreteVramBytes.basis = 'discrete_vram_not_observed'
    host.sample.source = 'nvidia_smi'
    host.sample.availableMemoryBytes.bytes = null
    host.sample.availableMemoryBytes.source = 'not_reported'
    host.sample.availableMemoryBytes.confidence = 'unknown'
    host.sample.pressure = {
      level: 'unknown', source: 'not_reported', observedAt: OBSERVED_AT,
      confidence: 'unknown', basis: 'not_observed',
    }
    host.nvidia = {
      state: 'available', source: 'nvidia_smi', observedAt: OBSERVED_AT, reason: null,
      devices: [{
        providerIndex: 7,
        uuid: 'GPU-reconciliation-12345678',
        displayName: 'NVIDIA fixture',
        source: 'nvidia_smi_query_gpu',
        observedAt: OBSERVED_AT,
        confidence: 'observed',
        totalVramBytes: {
          bytes: 24 * 1024 ** 3,
          source: 'nvidia_smi_memory_total',
          observedAt: OBSERVED_AT,
          confidence: 'observed',
          basis: 'device_total_vram',
        },
        freeVramBytes: {
          bytes: 8 * 1024 ** 3,
          source: 'nvidia_smi_memory_free',
          observedAt: OBSERVED_AT,
          confidence: 'observed',
          basis: 'device_free_vram_not_safe_capacity',
        },
      }],
    }
    host.availableFields = [
      'total_system_memory_bytes',
      'legacy_usable_memory_estimate_bytes',
      'nvidia_devices',
    ]
    host.missingFields = [
      'free_memory_bytes',
      'available_memory_bytes',
      'memory_pressure',
      'discrete_vram_bytes',
      'gpu_free_memory_bytes',
    ]

    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'fixture:latest')
    const snapshot = runtimeSnapshotSchema.parse(await reconciliation(
      governor,
      async () => [running('fixture:latest', { digest: 'sha256:linux' })],
      fixedHostTelemetry(async () => host, linuxHardware),
      {
        installed: [{ name: 'fixture:latest', digest: 'sha256:linux' }],
        hardware: linuxHardware,
      },
    ).snapshot())
    const model = snapshot.models?.[0]
    assert.deepEqual(model?.observationKey, {
      state: 'unavailable', version: 1, reason: 'hardware_fingerprint_unavailable',
    })
    assert.equal(model?.artifactIdentity, 'unknown')
    assert.equal(model?.currentFit.state, 'unknown')
    assert.equal(model?.currentFit.reason, 'observation_key_unavailable')
    assert.equal(model?.currentFit.runtimeAcceleratorAllocationBytes, 750)
    assert.equal(model?.currentFit.futureAdmissionGuarantee, false)
    assert.doesNotMatch(JSON.stringify(model), /GPU-reconciliation|providerIndex/u)
    assert.equal(snapshot.host.nvidia.devices[0]?.providerIndex, 7)
    lease.release()
  })
})

describe('runtime reconciliation failures', () => {
  it('keeps queue/lease state on unavailable, timeout and malformed samples without healthy []', async () => {
    const fixtures = [
      {
        error: new OllamaUnavailableError('http://user:secret@private.invalid'),
        state: 'unavailable',
        code: 'ollama_unavailable',
      },
      {
        error: new OllamaTimeoutError('connect', 17),
        state: 'unavailable',
        code: 'ollama_connect_timeout',
      },
      {
        error: new OllamaProtocolError('/api/ps', 'raw provider body private prompt'),
        state: 'incompatible',
        code: 'runtime_protocol',
      },
    ] as const

    for (const fixture of fixtures) {
      const governor = new ResourceGovernor()
      const lease = await activeLease(governor, 'active:latest')
      const queued = governor.enqueue(request('queued-owner', 'queued:latest'))
      const snapshot = runtimeSnapshotSchema.parse(
        await reconciliation(governor, async () => {
          throw fixture.error
        }).snapshot(),
      )

      assert.equal(snapshot.source.state, fixture.state)
      assert.equal(snapshot.source.errorCode, fixture.code)
      assert.equal(snapshot.models, null)
      assert.deepEqual(snapshot.decisions.map((item) => item.code), ['source_failure'])
      assert.equal(snapshot.governor.activeLease?.leaseId, lease.id)
      assert.deepEqual(snapshot.governor.queued.map((item) => item.ticketId), [queued.id])
      assert.doesNotMatch(
        JSON.stringify(snapshot),
        /user:secret|private\.invalid|raw provider body|private prompt|\/tmp\/private/u,
      )

      lease.release()
      assert.equal(governor.cancel(queued), true)
    }
  })

  it('redacts arbitrary provider reasons and keeps runtime success separate from compatibility errors', async () => {
    const governor = new ResourceGovernor()
    const privateError = new OllamaUnavailableError(
      'http://user:secret-token@private.invalid/tmp/private',
      new Error('provider body private prompt'),
    )
    const service = reconciliation(governor, async () => {
      throw privateError
    })
    const app = createApp({ runtime: service } as AppContext)

    const runtimeResponse = await app.request('/api/runtime')
    const runtimeBody = await runtimeResponse.text()
    assert.equal(runtimeResponse.status, 200)
    assert.equal(runtimeSnapshotSchema.parse(JSON.parse(runtimeBody)).source.errorCode, 'ollama_unavailable')
    assert.doesNotMatch(runtimeBody, /secret-token|private\.invalid|\/tmp\/private|prompt/u)

    const compatibilityResponse = await app.request('/api/models/running')
    const compatibilityBody = await compatibilityResponse.text()
    assert.equal(compatibilityResponse.status, 503)
    assert.equal((JSON.parse(compatibilityBody) as { code: string }).code, 'ollama_unavailable')
    assert.doesNotMatch(
      compatibilityBody,
      /user:secret-token|private\.invalid|\/tmp\/private|provider body|prompt/u,
    )
  })

  it('keeps provider and telemetry failures independent in the shared projection', async () => {
    const runtimeGovernor = new ResourceGovernor()
    const runtimeLease = await activeLease(runtimeGovernor, 'fixture:latest')
    const telemetryFailure = fixedHostTelemetry(async () => {
      throw new Error('hostname username secret-token /Users/private')
    })
    const runtimeSuccess = runtimeSnapshotSchema.parse(
      await reconciliation(
        runtimeGovernor,
        async () => [running('fixture:latest')],
        telemetryFailure,
        { installed: [{ name: 'fixture:latest', digest: 'sha256:fixture:latest' }] },
      ).snapshot(),
    )
    assert.equal(runtimeSuccess.models?.[0]?.ownerState, 'active_lease')
    assert.equal(runtimeSuccess.models?.[0]?.currentFit.reason, 'host_unavailable')
    assert.equal(runtimeSuccess.host.state, 'unavailable')
    assert.doesNotMatch(JSON.stringify(runtimeSuccess), /hostname|username|secret-token|Users\/private/u)
    runtimeLease.release()

    const telemetryGovernor = new ResourceGovernor()
    const validHost = appleHost()
    const providerFailure = runtimeSnapshotSchema.parse(
      await reconciliation(
        telemetryGovernor,
        async () => {
          throw new OllamaUnavailableError('provider unavailable')
        },
        fixedHostTelemetry(async () => validHost),
      ).snapshot(),
    )
    assert.equal(providerFailure.models, null)
    assert.equal(providerFailure.source.state, 'unavailable')
    assert.equal(providerFailure.host.state, 'available')
    assert.equal(providerFailure.host.sample.availableMemoryBytes.bytes, 4_000)
  })
})

describe('runtime reconciliation concurrency and lifecycle', () => {
  it('linearizes after provider observation and captures enqueue/acquire/release as one snapshot', async () => {
    const governor = new ResourceGovernor()
    const first = await activeLease(governor, 'first:latest', 'first-owner')
    const provider = deferred<RunningModel[]>()
    const service = reconciliation(governor, () => provider.promise)
    const pendingSnapshot = service.snapshot()

    const secondTicket = governor.enqueue(request('second-owner', 'second'))
    const secondLeasePromise = governor.acquire(secondTicket)
    first.release()
    const second = await secondLeasePromise
    provider.resolve([running('SECOND:latest')])

    const snapshot = runtimeSnapshotSchema.parse(await pendingSnapshot)
    assert.equal(snapshot.governor.activeLease?.leaseId, second.id)
    assert.equal(snapshot.models?.[0]?.decisionCode, 'matched_active_lease')
    assert.equal(snapshot.models?.[0]?.leaseId, second.id)
    assert.equal(snapshot.source.observedAt, snapshot.observedAt)
    assert.equal(snapshot.governor.observedAt, snapshot.observedAt)
    second.release()
  })

  it('single-flights concurrent callers, isolates caller abort and clears live diagnostic state', async () => {
    const governor = new ResourceGovernor()
    const provider = deferred<RunningModel[]>()
    let calls = 0
    const service = reconciliation(governor, async () => {
      calls += 1
      if (calls === 1) return provider.promise
      return []
    })
    const cancelled = new AbortController()
    const first = service.snapshot({ signal: cancelled.signal })
    const second = service.snapshot()
    assert.equal(calls, 1)
    assert.equal(service.sampling, true)

    cancelled.abort('caller-left')
    await assert.rejects(first, { name: 'AbortError' })
    provider.resolve([running('shared:latest')])
    assert.equal((await second).models?.[0]?.name, 'shared:latest')
    assert.equal(calls, 1)
    assert.equal(service.sampling, false)

    const next = await service.snapshot()
    assert.deepEqual(next.models, [])
    assert.equal(calls, 2)
    assert.equal(service.sampling, false)
  })

  it('bounds provider and telemetry probes together and linearizes Governor after both settle', async () => {
    const governor = new ResourceGovernor()
    const firstLease = await activeLease(governor, 'first:latest', 'first-owner')
    const provider = deferred<RunningModel[]>()
    const telemetry = deferred<RuntimeHostTelemetry>()
    let providerCalls = 0
    let telemetryCalls = 0
    const hostTelemetry = fixedHostTelemetry(async () => {
      telemetryCalls += 1
      return telemetryCalls === 1 ? telemetry.promise : appleHost()
    })
    const service = reconciliation(
      governor,
      async () => {
        providerCalls += 1
        return providerCalls === 1 ? provider.promise : []
      },
      hostTelemetry,
      { installed: [{ name: 'second:latest', digest: 'sha256:second:latest' }] },
    )
    const cancelled = new AbortController()
    const callerLeaving = service.snapshot({ signal: cancelled.signal })
    const remainingCaller = service.snapshot()
    assert.equal(providerCalls, 1)
    assert.equal(telemetryCalls, 1)

    const secondTicket = governor.enqueue(request('second-owner', 'second:latest'))
    const secondLeasePromise = governor.acquire(secondTicket)
    firstLease.release()
    const secondLease = await secondLeasePromise
    cancelled.abort('caller-left')
    await assert.rejects(callerLeaving, { name: 'AbortError' })

    provider.resolve([running('second:latest')])
    await Promise.resolve()
    assert.equal(service.sampling, true)
    telemetry.resolve(appleHost())
    const snapshot = runtimeSnapshotSchema.parse(await remainingCaller)

    assert.equal(snapshot.governor.activeLease?.leaseId, secondLease.id)
    assert.equal(snapshot.models?.[0]?.leaseId, secondLease.id)
    assert.equal(snapshot.models?.[0]?.currentFit.state, 'observed')
    assert.equal(snapshot.source.observedAt, snapshot.observedAt)
    assert.equal(snapshot.host.observedAt, snapshot.observedAt)
    assert.equal(snapshot.host.sample.pressure.observedAt, snapshot.observedAt)
    assert.equal(snapshot.governor.observedAt, snapshot.observedAt)
    assert.equal(providerCalls, 1)
    assert.equal(telemetryCalls, 1)
    assert.equal(service.sampling, false)

    const next = await service.snapshot()
    assert.deepEqual(next.models, [])
    assert.equal(providerCalls, 2)
    assert.equal(telemetryCalls, 2)
    assert.equal(service.sampling, false)
    secondLease.release()
  })

  it('shares one provider call across both public routes and preserves the running compatibility shape', async () => {
    const governor = new ResourceGovernor()
    const provider = deferred<RunningModel[]>()
    let calls = 0
    const service = reconciliation(governor, async () => {
      calls += 1
      return provider.promise
    })
    const app = createApp({ runtime: service } as AppContext)
    const runtimeRequest = app.request('/api/runtime')
    const runningRequest = app.request('/api/models/running')
    assert.equal(calls, 1)

    provider.resolve([running('shared:latest')])
    const [runtimeResponse, runningResponse] = await Promise.all([
      runtimeRequest,
      runningRequest,
    ])
    assert.equal(runtimeResponse.status, 200)
    assert.equal(runningResponse.status, 200)
    assert.equal(runtimeSnapshotSchema.parse(await runtimeResponse.json()).models?.length, 1)
    const compatibility = listRunningResponse.parse(await runningResponse.json())
    assert.deepEqual(Object.keys(compatibility.models[0]!).sort(), [
      'contextLength',
      'digest',
      'expiresAt',
      'gpuPercent',
      'name',
      'observedAt',
      'processorLabel',
      'sizeBytes',
      'sizeVramBytes',
      'source',
    ])
    assert.equal(calls, 1)
    assert.equal(service.sampling, false)
  })

  it('never auto-unloads an observed unknown-owner row and preserves the active unload guard', async () => {
    const governor = new ResourceGovernor()
    const lease = await activeLease(governor, 'active:latest')
    let psCalls = 0
    let unloadCalls = 0
    const service = reconciliation(governor, async () => {
      psCalls += 1
      return [running('unknown:latest')]
    })

    const snapshot = await service.snapshot()
    assert.equal(snapshot.models?.[0]?.ownerState, 'unknown')
    assert.equal(snapshot.models?.[0]?.decisionCode, 'observed_unknown_owner')
    assert.equal(snapshot.decisions.some((item) => item.code === 'active_not_observed'), true)
    assert.equal(psCalls, 1)
    assert.equal(unloadCalls, 0)
    assert.throws(
      () => {
        governor.assertCanUnload({ provider: 'ollama', name: 'unknown:latest' })
        unloadCalls += 1
      },
      ResourceGovernorError,
    )
    assert.equal(unloadCalls, 0)
    lease.release()
  })
})

describe('runtime reconciliation composition inventory', () => {
  it('keeps both public projections on one application boundary with no direct route/Web ps call', () => {
    const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
    const webRoot = fileURLToPath(new URL('../../web/src/', import.meta.url))
    const context = readFileSync(`${sourceRoot}/context.ts`, 'utf8')
    const app = readFileSync(`${sourceRoot}/app.ts`, 'utf8')
    const modelsRoute = readFileSync(`${sourceRoot}/http/models-routes.ts`, 'utf8')
    const runtimeRoute = readFileSync(`${sourceRoot}/http/runtime-routes.ts`, 'utf8')
    const webApi = readFileSync(`${webRoot}/lib/api.ts`, 'utf8')
    const webRuntime = readFileSync(`${webRoot}/features/health/RuntimeStatus.tsx`, 'utf8')
    const webRuntimeContext = readFileSync(`${webRoot}/features/health/RuntimeContext.tsx`, 'utf8')
    // UI redesign (D-202, P2): only the shell's status items read the projection (so a poll does not
    // re-render the whole shell), and the runtime popover renders it.
    const webShell = readFileSync(`${webRoot}/features/shell/ShellStatus.tsx`, 'utf8')
    const webShellHost = readFileSync(`${webRoot}/features/shell/MountedShell.tsx`, 'utf8')
    const webPolling = readFileSync(`${webRoot}/features/health/useRuntimePolling.ts`, 'utf8')
    const webConflict = readFileSync(`${webRoot}/features/chat/ResourceConflictDecision.tsx`, 'utf8')
    const webChat = readFileSync(`${webRoot}/features/chat/ChatPage.tsx`, 'utf8')
    const publicProjectionSources = [
      modelsRoute,
      runtimeRoute,
      webApi,
      webRuntime,
      webRuntimeContext,
      webShell,
      webPolling,
      webConflict,
      webChat,
    ].join('\n')

    assert.match(
      context,
      /const runtime = new RuntimeReconciliationService\(\{ governor, hostTelemetry, models \}\)/u,
    )
    assert.match(context, /\bruntime,\n/u)
    assert.match(app, /server\.route\('\/api\/runtime', runtimeRoutes\(app\)\)/u)
    assert.match(modelsRoute, /app\.runtime\.runningModels/u)
    assert.match(runtimeRoute, /app\.runtime\.snapshot/u)
    assert.doesNotMatch(publicProjectionSources, /\.ps\(/u)
    assert.match(webApi, /request\(ROUTES\.runtime\(\), getRuntimeResponse/u)
    assert.match(webRuntimeContext, /useRuntimePolling\(loader\)/u)
    assert.match(webRuntimeContext, /loader = api\.runtimeSnapshot/u)
    assert.match(webShell, /useRuntimeProjection\(\)/u)
    assert.doesNotMatch(webShellHost, /useRuntimeProjection|useRuntimeSelector/u)
    assert.doesNotMatch(webRuntime, /\bapi\.|useRuntimePolling|\bfetch\(/u)
    assert.doesNotMatch(webShell, /api\.runtimeSnapshot|\bfetch\(|listRunning|modelsRunning|\/api\/ps/u)
    assert.match(webConflict, /useRuntimeProjection\(\)/u)
    assert.match(webConflict, /api\.getJob\(/u)
    assert.match(webConflict, /api\.cancelJob\(/u)
    assert.doesNotMatch(webChat, /api\.runtimeSnapshot|api\.cancelJob|api\.getJob/u)
    assert.doesNotMatch(webRuntime, /listRunning|modelsRunning|\/api\/ps|execFile|filesystem/u)
    assert.doesNotMatch(webConflict, /listRunning|modelsRunning|\/api\/ps|execFile|filesystem|ResourceGovernor/u)
    assert.doesNotMatch(webPolling, /\bfetch\(|ROUTES\.|listRunning|modelsRunning|\/api\/ps/u)
    assert.equal(existsSync(`${sourceRoot}/runtime/reconciliation.ts`), true)
  })
})
