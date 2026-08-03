import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  completionProbeBody,
  completionProbeResponse,
  legacyInstalledModelDescriptor,
  localModelSchema,
  runtimeSnapshotSchema,
} from '@alamo/contract'

const AT = '2026-08-03T00:00:00.000Z'
const exactBasis = {
  state: 'exact' as const,
  keyVersion: 1 as const,
  probeDefinitionVersion: 1 as const,
  provider: 'ollama' as const,
  normalizedModelReference: 'fixture:latest',
  artifactDigest: 'sha256:fixture',
  runtimeVersion: '0.12.6',
  contextLength: 8_192,
  id: `sha256:${'a'.repeat(64)}`,
}

describe('completion probe contract', () => {
  it('keeps legacy model responses probe-free and preserves descriptor defaults', () => {
    const parsed = localModelSchema.parse({
      name: 'legacy:latest', digest: '', sizeBytes: 1, modifiedAt: AT,
      family: 'legacy', parameterSize: '1B', quantization: 'Q4',
      contextLength: 8_192, capabilities: [], isCloud: false,
      fit: {
        level: 'unknown', summary: 'unknown', contextLength: 8_192,
        modelBytes: 1, kvCacheBytes: 0, requiredBytes: 1, usableBytes: 1,
        utilization: 1, basis: 'estimate', measured: null,
      },
    })
    assert.deepEqual(parsed.descriptor, legacyInstalledModelDescriptor)
    assert.equal('probe' in parsed.descriptor, false)
  })

  it('round-trips strict exact request and every public evidence state', () => {
    assert.deepEqual(completionProbeBody.parse({
      capability: 'completion', expectedDigest: 'sha256:fixture',
      contextLength: Number.MAX_SAFE_INTEGER, force: true,
    }), {
      capability: 'completion', expectedDigest: 'sha256:fixture',
      contextLength: Number.MAX_SAFE_INTEGER, force: true,
    })
    const fixtures = [
      { status: 'verified', confidence: 'verified', reason: 'terminal_response' },
      { status: 'degraded', confidence: 'degraded', reason: 'provider_error' },
      { status: 'unknown', confidence: 'unknown', reason: 'identity_unavailable' },
      { status: 'cancelled', confidence: 'unknown', reason: 'request_cancelled' },
      { status: 'skipped', confidence: 'unknown', reason: 'fit_unknown' },
    ] as const
    for (const fixture of fixtures) {
      assert.equal(completionProbeResponse.parse({
        evidence: {
          ...fixture,
          capability: 'completion', source: 'runtime_probe',
          observedAt: AT, completedAt: AT, durationMs: 0,
          basis: exactBasis, historical: false,
        },
      }).evidence.status, fixture.status)
    }
  })

  it('rejects arbitrary prompt/options and unknown future enums', () => {
    assert.equal(completionProbeBody.safeParse({
      capability: 'completion', expectedDigest: 'sha256:fixture',
      contextLength: 8_192, prompt: 'private', tools: [], options: {},
    }).success, false)
    assert.equal(completionProbeBody.safeParse({
      capability: 'tools', expectedDigest: 'sha256:fixture', contextLength: 8_192,
    }).success, false)
    assert.equal(completionProbeResponse.safeParse({
      evidence: {
        status: 'future', confidence: 'unknown', reason: 'future',
        capability: 'completion', source: 'runtime_probe', observedAt: AT,
        completedAt: AT, durationMs: 0, basis: exactBasis, historical: false,
      },
    }).success, false)
  })

  it('round-trips model_probe as a typed normal operation owner', () => {
    const parsed = runtimeSnapshotSchema.parse({
      observedAt: AT,
      source: { state: 'available', source: 'ollama_api_ps', observedAt: AT, errorCode: null },
      governor: {
        observedAt: AT, accepting: true,
        policy: {
          acceleratorPermits: 1, order: 'priority_fifo', priorities: ['normal', 'prewarm'],
          scope: 'application_process',
          basis: 'conservative_single_process_single_accelerator_permit_normal_before_prewarm_fifo',
        },
        queued: [{
          ticketId: 'probe-ticket', owner: { kind: 'operation', operationId: 'probe-owner' },
          operation: 'model_probe', model: { provider: 'ollama', name: 'fixture:latest' },
          requestedContext: 8_192, priority: 'normal', enqueuedAt: AT,
          reason: 'single_permit_busy',
        }],
        activeLease: null, lastDecision: null,
      },
      host: {
        state: 'unsupported', observedAt: AT,
        profile: {
          platform: 'linux', arch: 'x64', accelerator: 'cpu', acceleratorName: null,
          unifiedMemory: false, source: 'legacy_hardware_probe', observedAt: AT,
          confidence: 'observed',
          totalMemoryBytes: { bytes: 1, source: 'node_os_totalmem', observedAt: AT, confidence: 'observed', basis: 'total_system_memory' },
          legacyUsableMemoryBytes: { bytes: 1, source: 'legacy_hardware_usable_estimate', observedAt: AT, confidence: 'estimated', basis: 'legacy_compatibility_estimate_not_current_availability' },
          discreteVramBytes: { bytes: null, source: 'not_reported', observedAt: AT, confidence: 'unknown', basis: 'discrete_vram_not_observed' },
        },
        sample: {
          source: 'none', observedAt: AT,
          freeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: AT, confidence: 'unknown', basis: 'system_free_pages_not_safe_capacity' },
          availableMemoryBytes: { bytes: null, source: 'not_reported', observedAt: AT, confidence: 'unknown', basis: 'system_available_memory_advisory' },
          pressure: { level: 'unknown', source: 'not_reported', observedAt: AT, confidence: 'unknown', basis: 'not_observed' },
          gpuFreeMemoryBytes: { bytes: null, source: 'not_reported', observedAt: AT, confidence: 'unknown', basis: 'gpu_free_memory_not_reported' },
        },
        availableFields: ['total_unified_memory_bytes', 'legacy_usable_memory_estimate_bytes'],
        missingFields: ['free_memory_bytes', 'available_memory_bytes', 'memory_pressure', 'discrete_vram_bytes', 'gpu_free_memory_bytes'],
        errorCode: null,
      },
      models: [],
      decisions: [{
        code: 'empty_sample', modelName: null, normalizedModelName: null,
        leaseId: null, owner: null, runtimeDigest: null, requestedContext: null,
        observedContext: null, identityBasis: 'none',
      }],
    })
    assert.equal(parsed.governor.queued[0]?.operation, 'model_probe')
  })
})
