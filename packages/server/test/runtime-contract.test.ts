import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  catalogSourceHealthSchema,
  healthSchema,
  runningModelSchema,
  turnErrorSchema,
  turnStopReasonSchema,
  runtimeHostTelemetrySchema,
} from '@guanxi/contract'

const HARDWARE = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

describe('runtime health contract', () => {
  it('accepts sourced current health and preserves the legacy additive shape', () => {
    const current = healthSchema.parse({
      ok: true,
      appVersion: 'test',
      application: {
        state: 'reachable',
        source: 'application_http',
        observedAt: '2026-08-02T12:00:00.000Z',
      },
      ollama: {
        installed: true,
        installSource: 'local_binary_path',
        running: false,
        state: 'incompatible',
        source: 'ollama_api_version',
        observedAt: '2026-08-02T12:00:00.000Z',
        version: null,
        host: 'http://fixture.invalid',
        installHint: null,
      },
      hardware: HARDWARE,
      network: {
        ollamaComReachable: null,
        checkedAt: null,
        status: 'unknown',
        source: 'not_checked',
      },
    })
    assert.equal(current.ollama.state, 'incompatible')
    assert.equal(current.ollama.installSource, 'local_binary_path')
    assert.equal(current.network.ollamaComReachable, null)

    const legacy = healthSchema.parse({
      ok: true,
      appVersion: 'legacy',
      ollama: {
        installed: true,
        running: true,
        version: '0.1',
        host: 'http://fixture.invalid',
        installHint: null,
      },
      hardware: HARDWARE,
      network: {
        ollamaComReachable: false,
        checkedAt: '2026-08-02T12:00:00.000Z',
      },
    })
    assert.equal(legacy.ollama.state, undefined)
    assert.equal(legacy.ollama.source, null)
    assert.equal(legacy.ollama.installSource, null)
  })

  it('represents every catalog health state without collapsing unknown or stale', () => {
    for (const state of [
      'fresh_remote',
      'stale_cache',
      'bundled_fallback',
      'unavailable',
      'unknown',
    ] as const) {
      const source =
        state === 'fresh_remote'
          ? 'documented_remote'
          : state === 'stale_cache'
            ? 'ollama_recommendations_cache'
            : state === 'bundled_fallback'
              ? 'bundled_snapshot'
              : 'none'
      const parsed = catalogSourceHealthSchema.parse({
        state,
        source,
        observedAt: '2026-08-02T12:00:00.000Z',
        fetchedAt:
          state === 'unknown' || state === 'unavailable'
            ? null
            : '2026-08-02T11:00:00.000Z',
      })
      assert.equal(parsed.state, state)
    }
  })

  it('keeps missing ps facts nullable and exposes timeout categories', () => {
    const running = runningModelSchema.parse({
      name: 'fixture',
      sizeBytes: 1_000,
      sizeVramBytes: null,
      gpuPercent: null,
      processorLabel: null,
      contextLength: null,
      expiresAt: null,
    })
    assert.equal(running.observedAt, null)
    assert.equal(running.source, null)

    for (const code of [
      'ollama_connect_timeout',
      'ollama_load_timeout',
      'ollama_stream_idle_timeout',
    ] as const) {
      assert.equal(turnErrorSchema.parse({ code, message: 'safe' }).code, code)
    }
    assert.equal(turnStopReasonSchema.parse('provider_error'), 'provider_error')
  })
})

describe('runtime host telemetry additive contract', () => {
  it('defaults a legacy host snapshot to explicit unknown NVIDIA telemetry', () => {
    const parsed = runtimeHostTelemetrySchema.parse({
      state: 'unsupported',
      observedAt: '2026-08-02T12:00:00.000Z',
      profile: {
        platform: 'linux', arch: 'x64', accelerator: 'cpu', acceleratorName: null,
        unifiedMemory: false, source: 'legacy_hardware_probe',
        observedAt: '2026-08-02T12:00:00.000Z', confidence: 'observed',
        totalMemoryBytes: { bytes: 16_000_000_000, source: 'node_os_totalmem', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'observed', basis: 'total_system_memory' },
        legacyUsableMemoryBytes: { bytes: 8_000_000_000, source: 'legacy_hardware_usable_estimate', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'estimated', basis: 'legacy_compatibility_estimate_not_current_availability' },
        discreteVramBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'discrete_vram_not_observed' },
      },
      sample: {
        source: 'none', observedAt: '2026-08-02T12:00:00.000Z',
        freeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'system_free_pages_not_safe_capacity' },
        availableMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'system_available_memory_advisory' },
        pressure: { level: 'unknown', source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'not_observed' },
        gpuFreeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'gpu_free_memory_not_reported' },
      },
      availableFields: ['total_system_memory_bytes', 'legacy_usable_memory_estimate_bytes'],
      missingFields: ['free_memory_bytes', 'available_memory_bytes', 'memory_pressure', 'discrete_vram_bytes', 'gpu_free_memory_bytes', 'nvidia_devices'],
      errorCode: null,
    })
    assert.deepEqual(parsed.nvidia, {
      state: 'unknown', source: 'none', observedAt: parsed.observedAt,
      devices: [], reason: 'legacy_snapshot',
    })
  })

  it('round-trips additive per-device NVIDIA facts and rejects unknown future states', () => {
    const legacy = runtimeHostTelemetrySchema.parse({
      state: 'unsupported', observedAt: '2026-08-02T12:00:00.000Z',
      profile: {
        platform: 'linux', arch: 'x64', accelerator: 'cpu', acceleratorName: null,
        unifiedMemory: false, source: 'legacy_hardware_probe', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'observed',
        totalMemoryBytes: { bytes: 16_000_000_000, source: 'node_os_totalmem', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'observed', basis: 'total_system_memory' },
        legacyUsableMemoryBytes: { bytes: 8_000_000_000, source: 'legacy_hardware_usable_estimate', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'estimated', basis: 'legacy_compatibility_estimate_not_current_availability' },
        discreteVramBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'discrete_vram_not_observed' },
      },
      sample: {
        source: 'none', observedAt: '2026-08-02T12:00:00.000Z',
        freeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'system_free_pages_not_safe_capacity' },
        availableMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'system_available_memory_advisory' },
        pressure: { level: 'unknown', source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'not_observed' },
        gpuFreeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: '2026-08-02T12:00:00.000Z', confidence: 'unknown', basis: 'gpu_free_memory_not_reported' },
      },
      availableFields: ['total_system_memory_bytes', 'legacy_usable_memory_estimate_bytes'],
      missingFields: ['free_memory_bytes', 'available_memory_bytes', 'memory_pressure', 'discrete_vram_bytes', 'gpu_free_memory_bytes', 'nvidia_devices'], errorCode: null,
    })
    const current = structuredClone(legacy)
    current.state = 'available'
    current.sample.source = 'nvidia_smi'
    current.errorCode = null
    current.nvidia = {
      state: 'available', source: 'nvidia_smi', observedAt: current.observedAt, reason: null,
      devices: [{
        providerIndex: 3, uuid: 'GPU-contract', displayName: 'NVIDIA Contract GPU',
        source: 'nvidia_smi_query_gpu', observedAt: current.observedAt, confidence: 'observed',
        totalVramBytes: { bytes: 24 * 1024 ** 3, source: 'nvidia_smi_memory_total', observedAt: current.observedAt, confidence: 'observed', basis: 'device_total_vram' },
        freeVramBytes: { bytes: 7 * 1024 ** 3, source: 'nvidia_smi_memory_free', observedAt: current.observedAt, confidence: 'observed', basis: 'device_free_vram_not_safe_capacity' },
      }],
    }
    assert.equal(runtimeHostTelemetrySchema.parse(current).nvidia.devices[0]?.providerIndex, 3)
    assert.equal(runtimeHostTelemetrySchema.safeParse({ ...current, nvidia: { ...current.nvidia, state: 'future' } }).success, false)
    assert.equal(runtimeHostTelemetrySchema.safeParse({
      ...current,
      nvidia: { ...current.nvidia, source: 'none' },
    }).success, false)
    assert.equal(runtimeHostTelemetrySchema.safeParse({
      ...current,
      nvidia: {
        ...current.nvidia,
        state: 'unsupported',
        source: 'none',
        devices: [],
        reason: 'command_failed',
      },
    }).success, false)
    assert.equal(runtimeHostTelemetrySchema.safeParse({
      ...current,
      nvidia: {
        ...current.nvidia,
        devices: [current.nvidia.devices[0]!, { ...current.nvidia.devices[0]! }],
      },
    }).success, false)
    assert.equal(runtimeHostTelemetrySchema.safeParse({
      ...current,
      nvidia: {
        ...current.nvidia,
        devices: [{
          ...current.nvidia.devices[0]!,
          totalVramBytes: {
            ...current.nvidia.devices[0]!.totalVramBytes,
            bytes: null,
            source: 'not_reported',
            confidence: 'unknown',
          },
        }],
      },
    }).success, false)
  })
})
