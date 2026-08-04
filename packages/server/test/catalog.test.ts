import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import {
  catalogSeedFromRecommendation,
  getCatalog,
  type CatalogSeed,
} from '../src/models/catalog.ts'

const HARDWARE: HardwareInfo = {
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

const SEED: CatalogSeed = {
  name: 'fixture',
  description: 'fixture model',
  variants: [{ tag: 'latest', sizeBytes: 1_000_000, parameterSize: '1B' }],
  contextLength: 8_192,
  capabilities: ['completion'],
  vramBytes: null,
  isCloud: false,
  requiredPlan: null,
}

const INPUT = {
  contextLength: 4_096,
  hardware: HARDWARE,
  installed: {
    models: [] as Array<{ name: string; digest: string }>,
    observedAt: '2026-08-02T12:00:00.000Z',
  },
}

describe('catalog provenance', () => {
  it('normalizes cache base, tag and namespace rows and rejects malformed references', () => {
    assert.deepEqual(
      catalogSeedFromRecommendation({ model: 'TEAM/Model:Q4', description: 'safe' }),
      {
        name: 'team/model', description: 'safe',
        variants: [{ tag: 'q4', sizeBytes: null, parameterSize: null }],
        contextLength: null, capabilities: [], vramBytes: null,
        isCloud: false, requiredPlan: null,
      },
    )
    assert.equal(catalogSeedFromRecommendation({ model: 'Model' })?.variants[0]?.tag, 'latest')
    for (const model of ['name:tag:extra', 'team/../model', 'a/b/c', ' model']) {
      assert.equal(catalogSeedFromRecommendation({ model }), null, model)
    }
  })

  it('uses the dated bundled fallback without any remote request', async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error('catalog must not use network')
    }

    try {
      const result = await getCatalog(
        INPUT,
        {
          loadLocalRecommendations: async () => null,
          bundled: [SEED],
          now: () => new Date('2026-08-02T12:00:00.000Z'),
        },
      )

      assert.equal(fetchCalls, 0)
      assert.equal(result.live, false)
      assert.deepEqual(result.source, {
        state: 'bundled_fallback',
        source: 'bundled_snapshot',
        observedAt: '2026-08-02T12:00:00.000Z',
        fetchedAt: '2026-08-02T00:00:00.000Z',
      })
      assert.deepEqual(
        result.models.map((model) => ({
          source: model.source,
          freshness: model.freshness,
          fetchedAt: model.sourceFetchedAt,
        })),
        [
          {
            source: 'bundled',
            freshness: 'fallback',
            fetchedAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks a local recommendations cache stale and preserves row provenance', async () => {
    const result = await getCatalog(
      INPUT,
      {
        loadLocalRecommendations: async () => ({
          seeds: [{ ...SEED, name: 'cached', capabilities: [] }],
          fetchedAt: '2026-07-30T08:00:00.000Z',
        }),
        bundled: [SEED],
        now: () => new Date('2026-08-02T12:00:00.000Z'),
      },
    )

    assert.deepEqual(result.source, {
      state: 'stale_cache',
      source: 'ollama_recommendations_cache',
      observedAt: '2026-08-02T12:00:00.000Z',
      fetchedAt: '2026-07-30T08:00:00.000Z',
    })
    assert.deepEqual(
      result.models.map((model) => ({
        name: model.name,
        source: model.source,
        freshness: model.freshness,
      })),
      [
        { name: 'cached', source: 'local_cache', freshness: 'stale' },
        { name: 'fixture', source: 'bundled', freshness: 'fallback' },
      ],
    )
    assert.deepEqual(result.models[0]?.capabilities, [])
  })

  it('reports unavailable rather than healthy when no allowed source has data', async () => {
    const result = await getCatalog(INPUT, {
      loadLocalRecommendations: async () => null,
      bundled: [],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    assert.equal(result.models.length, 0)
    assert.equal(result.source.state, 'unavailable')
    assert.equal(result.source.source, 'none')
  })

  it('derives exact base, tag and namespace targets only through the strict normalizer', async () => {
    const result = await getCatalog(INPUT, {
      loadLocalRecommendations: async () => null,
      bundled: [
        { ...SEED, name: 'BASE', variants: [{ tag: 'latest', sizeBytes: 1, parameterSize: '1B' }] },
        { ...SEED, name: 'Base', variants: [{ tag: 'Q4', sizeBytes: 2, parameterSize: '1B' }] },
        { ...SEED, name: 'Team/Model', variants: [{ tag: '8B', sizeBytes: 3, parameterSize: '8B' }] },
      ],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    assert.deepEqual(
      result.models.map((model) => model.variants[0]?.normalizedName),
      ['base:latest', 'base:q4', 'team/model:8b'],
    )
  })

  it('fails malformed and duplicate variant rows closed without a default target', async () => {
    const result = await getCatalog(INPUT, {
      loadLocalRecommendations: async () => null,
      bundled: [{
        ...SEED,
        variants: [
          { tag: 'Q4', sizeBytes: 1_000, parameterSize: '1B' },
          { tag: 'q4', sizeBytes: 2_000, parameterSize: '2B' },
          { tag: '../latest', sizeBytes: 3_000, parameterSize: '3B' },
          { tag: '', sizeBytes: 4_000, parameterSize: '4B' },
          { tag: 'bad-size', sizeBytes: -1, parameterSize: '5B' },
        ],
      }],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    assert.deepEqual(
      result.models[0]?.variants.map((variant) => ({
        target: variant.normalizedName,
        fit: variant.fit.state === 'unknown' ? variant.fit.reason : variant.fit.state,
      })),
      [
        { target: null, fit: 'invalid_variant' },
        { target: null, fit: 'invalid_variant' },
        { target: null, fit: 'invalid_variant' },
        { target: null, fit: 'invalid_variant' },
        { target: null, fit: 'invalid_variant' },
      ],
    )
  })

  it('calculates distinct per-variant fit and never turns unknown size green or zero', async () => {
    const result = await getCatalog(INPUT, {
      loadLocalRecommendations: async () => null,
      bundled: [{
        ...SEED,
        variants: [
          { tag: 'small', sizeBytes: 1_000_000_000, parameterSize: '1B' },
          { tag: 'large', sizeBytes: 20_000_000_000, parameterSize: '20B' },
          { tag: 'unknown', sizeBytes: null, parameterSize: null },
        ],
      }],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })
    const small = result.models[0]!.variants[0]!
    const large = result.models[0]!.variants[1]!
    const unknown = result.models[0]!.variants[2]!
    assert.equal(small!.fit.state, 'calculated')
    assert.equal(large!.fit.state, 'calculated')
    assert.equal(small!.fit.state === 'calculated' && small.fit.verdict.level, 'green')
    assert.equal(large!.fit.state === 'calculated' && large.fit.verdict.level, 'red')
    assert.deepEqual(unknown!.fit, {
      state: 'unknown', source: 'catalog_claim', contextLength: SEED.contextLength,
      verdict: null, reason: 'size_unknown',
    })
  })

  it('matches installation by exact normalized target and preserves digest truth', async () => {
    const result = await getCatalog({
      ...INPUT,
      installed: {
        observedAt: '2026-08-02T11:59:00.000Z',
        models: [{ name: 'FIXTURE:SMALL', digest: 'sha256:small' }],
      },
    }, {
      loadLocalRecommendations: async () => null,
      bundled: [{
        ...SEED,
        variants: [
          { tag: 'small', sizeBytes: 1_000, parameterSize: '1B' },
          { tag: 'large', sizeBytes: 2_000, parameterSize: '2B' },
        ],
      }],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })

    assert.equal(result.models[0]?.installed, true)
    assert.equal(result.models[0]?.installedProjection, 'variant_aggregate_compatibility')
    assert.deepEqual(result.models[0]?.variants.map((variant) => variant.installation), [
      {
        state: 'installed', digest: 'sha256:small', source: 'ollama_api_tags',
        observedAt: '2026-08-02T11:59:00.000Z',
      },
      {
        state: 'not_installed', digest: null, source: 'ollama_api_tags',
        observedAt: '2026-08-02T11:59:00.000Z',
      },
    ])
  })

  it('preserves stale and fallback provenance on every exact variant', async () => {
    const result = await getCatalog(INPUT, {
      loadLocalRecommendations: async () => ({
        seeds: [{ ...SEED, name: 'cached' }],
        fetchedAt: '2026-07-30T08:00:00.000Z',
      }),
      bundled: [SEED],
      now: () => new Date('2026-08-02T12:00:00.000Z'),
    })
    assert.deepEqual(result.models.map((model) => ({
      model: model.name,
      source: model.variants[0]?.source,
      freshness: model.variants[0]?.freshness,
      fetchedAt: model.variants[0]?.sourceFetchedAt,
    })), [
      { model: 'cached', source: 'local_cache', freshness: 'stale', fetchedAt: '2026-07-30T08:00:00.000Z' },
      { model: 'fixture', source: 'bundled', freshness: 'fallback', fetchedAt: '2026-08-02T00:00:00.000Z' },
    ])
  })

  it('keeps exact installation unknown when tags are unavailable or ambiguous', async () => {
    const unavailable = await getCatalog({ ...INPUT, installed: null }, {
      loadLocalRecommendations: async () => null, bundled: [SEED],
    })
    assert.equal(unavailable.models[0]?.variants[0]?.installation.state, 'unknown')
    assert.equal(unavailable.models[0]?.installed, false)

    const ambiguous = await getCatalog({
      ...INPUT,
      installed: {
        observedAt: '2026-08-02T12:00:00.000Z',
        models: [
          { name: 'fixture', digest: 'sha256:a' },
          { name: 'FIXTURE:latest', digest: 'sha256:b' },
        ],
      },
    }, {
      loadLocalRecommendations: async () => null, bundled: [SEED],
    })
    assert.deepEqual(ambiguous.models[0]?.variants[0]?.installation, {
      state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
      reason: 'ambiguous_installed_reference',
    })
  })
})
