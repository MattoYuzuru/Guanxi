import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MODEL_CAPABILITY_OVERRIDE_VERSION,
  installedModelDescriptorSchema,
  legacyInstalledModelDescriptor,
  modelCapabilityOverrideMutationBody,
  modelCapabilityOverrideResponse,
  modelCapabilityOverrideSchema,
  type ModelCapabilityOverride,
} from '@guanxi/contract'

const AT = '2026-08-07T00:00:00.000Z'

function override(patch: Record<string, unknown> = {}): unknown {
  return {
    version: MODEL_CAPABILITY_OVERRIDE_VERSION,
    source: 'user_override',
    state: 'overridden',
    value: 'present',
    capability: 'tools',
    provider: 'ollama',
    normalizedModelReference: 'fixture:latest',
    artifactDigest: 'sha256:fixture',
    runtimeVersion: '0.12.6',
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  }
}

function descriptor(patch: Record<string, unknown> = {}): unknown {
  return {
    reference: {
      state: 'canonical', provider: 'ollama', original: 'fixture:latest',
      normalized: 'fixture:latest',
    },
    artifact: { state: 'exact_digest', digest: 'sha256:fixture' },
    installation: {
      state: 'installed', source: 'ollama_api_tags', observedAt: AT,
      confidence: 'observed',
    },
    capabilities: { state: 'declared', reason: null, observedAt: AT, declarations: [] },
    ...patch,
  }
}

describe('capability override contract', () => {
  it('defaults a legacy descriptor response to no override and no sourced runtime', () => {
    const parsed = installedModelDescriptorSchema.parse(descriptor())
    assert.deepEqual(parsed.overrides, [])
    assert.equal(parsed.overrides.length, 0)
    assert.equal(parsed.runtime.state, 'unknown')
    assert.equal(parsed.runtime.version, null)
    assert.equal(parsed.runtime.source, 'legacy_response')
    // The shared legacy constant must carry the same explicit absence.
    assert.deepEqual(legacyInstalledModelDescriptor.overrides, [])
    assert.equal(legacyInstalledModelDescriptor.runtime.state, 'unknown')
  })

  it('round-trips one exact positive assertion beside untouched provider evidence', () => {
    const parsed = installedModelDescriptorSchema.parse(
      descriptor({ overrides: [override()] }),
    )
    assert.equal(parsed.overrides.length, 1)
    const only = parsed.overrides[0]!
    assert.equal(only.source, 'user_override')
    assert.equal(only.state, 'overridden')
    assert.equal(only.value, 'present')
    assert.equal(only.capability, 'tools')
    // Provider capability evidence keeps its own state and gains no declaration.
    assert.equal(parsed.capabilities.state, 'declared')
    assert.equal(parsed.capabilities.declarations.length, 0)
  })

  it('fails closed on unknown/future values, extra fields and malformed identity', () => {
    const rejected: Array<[string, unknown]> = [
      ['future capability', override({ capability: 'audio' })],
      ['future version', override({ version: 2 })],
      ['negative value', override({ value: 'absent' })],
      ['unsupported state', override({ state: 'unsupported' })],
      ['foreign source', override({ source: 'ollama_api_tags' })],
      ['foreign provider', override({ provider: 'huggingface' })],
      ['extra field', override({ note: 'free form' })],
      ['confidence field', override({ confidence: 0.5 })],
      ['empty reference', override({ normalizedModelReference: '' })],
      ['empty digest', override({ artifactDigest: '' })],
      ['empty runtime version', override({ runtimeVersion: '' })],
      ['malformed createdAt', override({ createdAt: 'yesterday' })],
      ['malformed updatedAt', override({ updatedAt: '2026-08-07' })],
    ]
    for (const [label, candidate] of rejected) {
      assert.equal(
        modelCapabilityOverrideSchema.safeParse(candidate).success,
        false,
        label,
      )
      assert.equal(
        installedModelDescriptorSchema.safeParse(
          descriptor({ overrides: [candidate] }),
        ).success,
        false,
        `${label} inside a descriptor`,
      )
    }
  })

  it('requires an exact expected identity in every mutation body', () => {
    const valid = {
      capability: 'tools',
      expectedDigest: 'sha256:fixture',
      expectedRuntimeVersion: '0.12.6',
    }
    assert.equal(modelCapabilityOverrideMutationBody.safeParse(valid).success, true)
    for (const invalid of [
      { ...valid, capability: 'audio' },
      { ...valid, expectedDigest: '' },
      { ...valid, expectedRuntimeVersion: '' },
      { ...valid, note: 'free form' },
      { ...valid, value: 'absent' },
      { capability: 'tools', expectedDigest: 'sha256:fixture' },
      { capability: 'tools', expectedRuntimeVersion: '0.12.6' },
    ]) {
      assert.equal(modelCapabilityOverrideMutationBody.safeParse(invalid).success, false)
    }
  })

  it('types every mutation outcome and never lets a conflict carry an override', () => {
    const identity = {
      provider: 'ollama',
      normalizedModelReference: 'fixture:latest',
      artifactDigest: 'sha256:fixture',
      runtimeVersion: '0.12.6',
    }
    for (const state of ['applied', 'cleared', 'absent'] as const) {
      const parsed = modelCapabilityOverrideResponse.parse({
        outcome: { state, capability: 'tools', identity, overrides: [override()] },
      })
      assert.equal(parsed.outcome.state, state)
      assert.equal(parsed.outcome.overrides.length, 1)
    }
    const conflict = modelCapabilityOverrideResponse.parse({
      outcome: {
        state: 'conflict',
        capability: 'tools',
        reason: 'digest_expectation_mismatch',
        identity: null,
        overrides: [],
      },
    })
    assert.equal(conflict.outcome.state, 'conflict')
    assert.equal(conflict.outcome.overrides.length, 0)

    // A conflict asserts nothing, so it can neither claim an identity nor a row.
    assert.equal(
      modelCapabilityOverrideResponse.safeParse({
        outcome: {
          state: 'conflict', capability: 'tools', reason: 'model_not_installed',
          identity: null, overrides: [override()],
        },
      }).success,
      false,
    )
    assert.equal(
      modelCapabilityOverrideResponse.safeParse({
        outcome: {
          state: 'conflict', capability: 'tools', reason: 'model_not_installed',
          identity, overrides: [],
        },
      }).success,
      false,
    )
    for (const reason of ['unsupported', 'capability_absent', 'unknown']) {
      assert.equal(
        modelCapabilityOverrideResponse.safeParse({
          outcome: {
            state: 'conflict', capability: 'tools', reason,
            identity: null, overrides: [],
          },
        }).success,
        false,
        reason,
      )
    }
  })

  it('keeps a stored assertion assignable to the contract projection type', () => {
    const typed: ModelCapabilityOverride = modelCapabilityOverrideSchema.parse(override())
    assert.equal(typed.version, 1)
    assert.equal(typed.provider, 'ollama')
  })
})
