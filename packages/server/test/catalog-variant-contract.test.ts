import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalogModelSchema } from '@guanxi/contract'

const fit = {
  level: 'unknown' as const,
  summary: 'legacy unknown',
  contextLength: 8_192,
  modelBytes: 0,
  kvCacheBytes: 0,
  requiredBytes: 0,
  usableBytes: 1,
  utilization: 0,
  basis: 'estimate' as const,
  measured: null,
}

describe('catalog variant additive contract', () => {
  it('round-trips legacy catalog rows with explicit non-installable defaults', () => {
    const parsed = catalogModelSchema.parse({
      name: 'legacy',
      description: 'legacy row',
      variants: [{ tag: 'latest', sizeBytes: null, parameterSize: null }],
      contextLength: null,
      capabilities: [],
      vramBytes: null,
      isCloud: false,
      requiredPlan: null,
      installed: false,
      fit,
      source: 'bundled',
    })

    assert.equal(parsed.fitProjection, 'legacy_model_compatibility')
    assert.equal(parsed.installedProjection, 'legacy_family_compatibility')
    assert.deepEqual(parsed.variants[0], {
      tag: 'latest', sizeBytes: null, parameterSize: null,
      normalizedName: null, contextLength: null,
      fit: {
        state: 'unknown', source: 'legacy_response', contextLength: null,
        verdict: null, reason: 'legacy_response',
      },
      installation: {
        state: 'unknown', digest: null, source: 'legacy_response', observedAt: null,
        reason: 'legacy_response',
      },
      source: null, freshness: 'unknown', sourceObservedAt: null, sourceFetchedAt: null,
    })
  })

  it('rejects future strict variant fit and installation states', () => {
    const base = {
      name: 'future', description: '', contextLength: null, capabilities: [],
      vramBytes: null, isCloud: false, requiredPlan: null, installed: false,
      fit, source: 'bundled' as const,
    }
    assert.equal(catalogModelSchema.safeParse({
      ...base,
      variants: [{
        tag: 'latest', sizeBytes: null, parameterSize: null,
        fit: { state: 'future' },
      }],
    }).success, false)
    assert.equal(catalogModelSchema.safeParse({
      ...base,
      variants: [{
        tag: 'latest', sizeBytes: null, parameterSize: null,
        installation: { state: 'future' },
      }],
    }).success, false)
  })
})
