import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CatalogModel, CatalogVariant } from '@alamo/contract'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { filterCatalogModels, getCatalog } from '../src/models/catalog.ts'

const AT = '2026-08-04T00:00:00.000Z'

function verdict(level: 'green' | 'yellow' | 'red' | 'unknown', bytes: number) {
  return {
    level, summary: level, contextLength: 8_192, modelBytes: bytes,
    kvCacheBytes: 0, requiredBytes: bytes, usableBytes: 10_000,
    utilization: bytes / 10_000, basis: 'vendor_hint' as const, measured: null,
  }
}

function variant(options: {
  tag: string
  fit: 'green' | 'yellow' | 'red' | 'unknown'
  installation: 'installed' | 'not_installed' | 'unknown'
  context?: number | null
  size?: number | null
  valid?: boolean
}): CatalogVariant {
  const normalizedName = options.valid === false ? null : `fixture:${options.tag}`
  const contextLength = 'context' in options ? options.context ?? null : 8_192
  const sizeBytes = 'size' in options ? options.size ?? null : 1_000
  return {
    tag: options.tag,
    normalizedName,
    sizeBytes,
    parameterSize: '1B',
    contextLength,
    fit: options.fit === 'unknown'
      ? {
          state: 'unknown', source: 'catalog_claim',
          contextLength, verdict: null,
          reason: normalizedName === null ? 'invalid_variant' : 'size_unknown',
        }
      : {
          state: 'calculated', source: 'catalog_claim', contextLength: 8_192,
          verdict: verdict(options.fit, sizeBytes ?? 1_000),
        },
    installation: options.installation === 'installed'
      ? { state: 'installed', digest: `sha256:${options.tag}`, source: 'ollama_api_tags', observedAt: AT }
      : options.installation === 'not_installed'
        ? { state: 'not_installed', digest: null, source: 'ollama_api_tags', observedAt: AT }
        : {
            state: 'unknown', digest: null, source: 'unavailable', observedAt: null,
            reason: 'provider_unavailable',
          },
    source: 'local_cache', freshness: 'stale', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-01T00:00:00.000Z',
  }
}

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    name: 'fixture', description: 'Facet Search Fixture',
    variants: [
      variant({ tag: 'installed-red', fit: 'red', installation: 'installed', context: 32_768, size: 3_000 }),
      variant({ tag: 'green', fit: 'green', installation: 'not_installed', context: 65_536, size: 1_000 }),
      variant({ tag: 'unknown', fit: 'unknown', installation: 'unknown', context: null, size: null }),
      variant({ tag: 'invalid', fit: 'unknown', installation: 'unknown', valid: false }),
    ],
    contextLength: 65_536, capabilities: ['completion', 'tools'], vramBytes: null,
    isCloud: false, requiredPlan: null, installed: true,
    fit: verdict('red', 3_000),
    installedProjection: 'variant_aggregate_compatibility',
    fitProjection: 'largest_variant_compatibility', source: 'local_cache',
    freshness: 'stale', sourceObservedAt: AT,
    sourceFetchedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('truthful catalog facets', () => {
  it('uses AND across groups, OR inside a group and preserves only exact matching rows', () => {
    const result = filterCatalogModels([model()], {
      installation: ['not_installed', 'unknown'],
      fit: ['green', 'unknown'],
      minClaimedContext: 60_000,
      maxClaimedArtifactSize: 2_000,
    })
    assert.deepEqual(result[0]?.variants.map((row) => row.normalizedName), ['fixture:green'])
  })

  it('combines case-insensitive name/description text search with same-row facets', async () => {
    const result = await getCatalog({
      query: 'FACET SEARCH', contextLength: 8_192,
      hardware: {
        platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
        totalMemoryBytes: 16_000, usableMemoryBytes: 10_000, accelerator: 'metal',
        acceleratorName: 'fixture', unifiedMemory: true, freeDiskBytes: null,
      },
      installed: { models: [], observedAt: AT },
      filters: { installation: ['not_installed'], fit: ['green'] },
    }, {
      loadLocalRecommendations: async () => null,
      bundled: [{
        name: 'fixture', description: 'Facet Search Fixture',
        variants: [
          { tag: 'small', sizeBytes: 1_000, parameterSize: '1B' },
          { tag: 'large', sizeBytes: 20_000, parameterSize: '20B' },
        ],
        contextLength: 8_192, capabilities: ['completion'], vramBytes: null,
        isCloud: false, requiredPlan: null,
      }],
      now: () => new Date(AT),
    })
    assert.deepEqual(result.models[0]?.variants.map((row) => row.normalizedName), ['fixture:small'])
  })

  it('never combines installed A with green B and never reads legacy aggregates as evidence', () => {
    assert.deepEqual(filterCatalogModels([model()], {
      installation: ['installed'], fit: ['green'],
    }), [])
    assert.deepEqual(filterCatalogModels([model({ installed: true, fit: verdict('green', 1) })], {
      installation: ['installed'], fit: ['green'],
    }), [])
  })

  it('isolates exact installed/not-installed/unknown tags and unknown facts', () => {
    assert.deepEqual(filterCatalogModels([model()], { installation: ['installed'] })[0]?.variants.map((row) => row.tag), ['installed-red'])
    assert.deepEqual(filterCatalogModels([model()], { installation: ['not_installed'] })[0]?.variants.map((row) => row.tag), ['green'])
    assert.deepEqual(filterCatalogModels([model()], {
      installation: ['unknown'], contextClaim: 'unknown', artifactSizeClaim: 'unknown',
    })[0]?.variants.map((row) => row.tag), ['unknown'])
  })

  it('filters model scope/source/freshness/capability separately and treats absent metadata as unknown', () => {
    const cloudUnknown = model({
      name: 'cloud', isCloud: true, capabilities: [], source: 'remote', freshness: 'fresh',
      variants: [variant({ tag: 'cloud', fit: 'green', installation: 'not_installed' })],
    })
    assert.deepEqual(filterCatalogModels([model(), cloudUnknown], {
      providerScope: ['cloud'], source: ['remote'], freshness: ['fresh'], capability: ['unknown'],
    }).map((entry) => entry.name), ['cloud'])
    assert.deepEqual(filterCatalogModels([model(), cloudUnknown], {
      capability: ['tools', 'unknown'],
    }).map((entry) => entry.name), ['fixture', 'cloud'])
    assert.deepEqual(filterCatalogModels([cloudUnknown], { capability: ['tools'] }), [])
  })

  it('fails malformed exact variants closed and preserves provenance/timestamps without mutation', () => {
    const original = model()
    const before = structuredClone(original)
    const result = filterCatalogModels([original], { fit: ['unknown'] })
    assert.deepEqual(result[0]?.variants.map((row) => row.tag), ['unknown'])
    assert.deepEqual(result[0]?.variants[0]?.sourceObservedAt, AT)
    assert.deepEqual(result[0]?.variants[0]?.sourceFetchedAt, '2026-08-01T00:00:00.000Z')
    assert.deepEqual(original, before)
  })

  it('returns a controlled 400 before provider access for invalid, repeated and unknown query fields', async () => {
    const app = createApp({} as AppContext)
    for (const query of [
      'fit=future',
      'fit=green&fit=yellow',
      'minClaimedContext=0',
      'minClaimedContext=1.5',
      'contextClaim=unknown&minClaimedContext=1',
      'future=value',
    ]) {
      const response = await app.request(`/api/models/catalog?${query}`)
      assert.equal(response.status, 400, query)
      const body = await response.json() as { code: string; message: string }
      assert.equal(body.code, 'validation_failed')
      assert.equal(body.message, 'Invalid catalog query')
    }
  })
})
