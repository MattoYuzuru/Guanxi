import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { getCatalog, type CatalogSeed } from '../src/models/catalog.ts'

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
  installed: new Set<string>(),
}

describe('catalog provenance', () => {
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
})
