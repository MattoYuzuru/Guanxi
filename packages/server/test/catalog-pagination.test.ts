import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CATALOG_MAX_PAGE_SIZE,
  catalogPaginationSchema,
  listCatalogQuery,
  listCatalogResponse,
  type HardwareInfo,
} from '@guanxi/contract'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { getCatalog, type CatalogSeed } from '../src/models/catalog.ts'

const AT = '2026-08-04T00:00:00.000Z'
const HARDWARE: HardwareInfo = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
  totalMemoryBytes: 32_000_000_000, usableMemoryBytes: 24_000_000_000,
  accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
  freeDiskBytes: null,
}

function seeds(count: number): CatalogSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `synthetic-${String(count - index - 1).padStart(4, '0')}`,
    description: index % 2 === 0 ? 'even local catalog row' : 'odd local catalog row',
    variants: Array.from({ length: 4 }, (_, variant) => ({
      tag: `q${variant + 1}`,
      sizeBytes: 1_000_000_000 + index * 1_000 + variant,
      parameterSize: `${variant + 1}B`,
    })),
    contextLength: index % 3 === 0 ? 65_536 : 32_768,
    capabilities: index % 2 === 0 ? ['completion', 'tools'] : [],
    vramBytes: null,
    isCloud: false,
    requiredPlan: null,
  }))
}

function input(page?: number, pageSize?: number) {
  return {
    contextLength: 8_192,
    hardware: HARDWARE,
    installed: { models: [], observedAt: AT },
    pagination: page === undefined ? undefined : { page, pageSize: pageSize! },
  }
}

async function catalog(
  rows: readonly CatalogSeed[],
  page?: number,
  pageSize?: number,
  query: { query?: string; filters?: Parameters<typeof getCatalog>[0]['filters'] } = {},
) {
  let sourceReads = 0
  const result = await getCatalog(
    { ...input(page, pageSize), ...query },
    {
      loadLocalRecommendations: async (signal) => {
        sourceReads += 1
        signal?.throwIfAborted()
        return null
      },
      bundled: rows,
      now: () => new Date(AT),
    },
  )
  return { result, sourceReads }
}

describe('catalog pagination contract', () => {
  it('keeps legacy mode full-list compatible without fabricating page boundaries', async () => {
    assert.deepEqual(listCatalogQuery.parse({ q: 'row' }), { q: 'row' })
    const { result } = await catalog(seeds(3))
    assert.equal(result.models.length, 3)
    assert.deepEqual(result.pagination, { mode: 'legacy', totalItems: 3 })
    assert.equal('page' in result.pagination, false)
    assert.equal('totalPages' in result.pagination, false)
    assert.equal(listCatalogResponse.safeParse(result).success, true)
    assert.equal(catalogPaginationSchema.safeParse(result.pagination).success, true)
  })

  it('requires an unambiguous positive safe page pair within the one-page policy', () => {
    assert.deepEqual(listCatalogQuery.parse({ page: '2', pageSize: '12' }), {
      page: 2, pageSize: 12,
    })
    for (const value of [
      { page: '1' }, { pageSize: '12' }, { page: '0', pageSize: '12' },
      { page: '-1', pageSize: '12' }, { page: '1.5', pageSize: '12' },
      { page: '9007199254740992', pageSize: '12' }, { page: '1', pageSize: '0' },
      { page: '1', pageSize: '1.5' },
      { page: '1', pageSize: String(CATALOG_MAX_PAGE_SIZE + 1) },
    ]) {
      assert.equal(listCatalogQuery.safeParse(value).success, false, JSON.stringify(value))
    }
  })
})

describe('stable catalog pages', () => {
  it('returns exact first, middle, last and out-of-range metadata without clamping', async () => {
    const rows = seeds(25)
    const first = (await catalog(rows, 1, 10)).result
    const middle = (await catalog(rows, 2, 10)).result
    const last = (await catalog(rows, 3, 10)).result
    const outside = (await catalog(rows, 4, 10)).result
    assert.deepEqual(first.pagination, {
      mode: 'paged', page: 1, pageSize: 10, totalItems: 25, totalPages: 3,
      previousPage: null, nextPage: 2,
    })
    assert.deepEqual(middle.pagination, {
      mode: 'paged', page: 2, pageSize: 10, totalItems: 25, totalPages: 3,
      previousPage: 1, nextPage: 3,
    })
    assert.deepEqual(last.pagination, {
      mode: 'paged', page: 3, pageSize: 10, totalItems: 25, totalPages: 3,
      previousPage: 2, nextPage: null,
    })
    assert.deepEqual(outside.pagination, {
      mode: 'paged', page: 4, pageSize: 10, totalItems: 25, totalPages: 3,
      previousPage: null, nextPage: null,
    })
    assert.deepEqual(
      [...first.models, ...middle.models, ...last.models].map((model) => model.name),
      Array.from({ length: 25 }, (_, index) => `synthetic-${String(index).padStart(4, '0')}`),
    )
    assert.equal(outside.models.length, 0)
  })

  it('defines zero, one-page and exact-boundary pages deterministically', async () => {
    const zero = (await catalog([], 1, 12)).result
    const one = (await catalog(seeds(1), 1, 12)).result
    const boundary = (await catalog(seeds(24), 2, 12)).result
    assert.deepEqual(zero.pagination, {
      mode: 'paged', page: 1, pageSize: 12, totalItems: 0, totalPages: 0,
      previousPage: null, nextPage: null,
    })
    assert.equal(zero.models.length, 0)
    assert.equal(one.models.length, 1)
    assert.deepEqual(one.pagination, {
      mode: 'paged', page: 1, pageSize: 12, totalItems: 1, totalPages: 1,
      previousPage: null, nextPage: null,
    })
    assert.equal(boundary.models.length, 12)
    assert.equal(boundary.pagination.mode === 'paged' && boundary.pagination.nextPage, null)
  })

  it('has no total ceiling across 1,003 models and 4,012 exact variants', async () => {
    const rows = seeds(1_003)
    const names: string[] = []
    let variantCount = 0
    for (let page = 1; page <= 11; page += 1) {
      const { result, sourceReads } = await catalog(rows, page, 100)
      assert.equal(sourceReads, 1)
      assert.ok(result.models.length <= 100)
      assert.equal(result.pagination.mode === 'paged' && result.pagination.totalItems, 1_003)
      names.push(...result.models.map((model) => model.name))
      variantCount += result.models.reduce((sum, model) => sum + model.variants.length, 0)
    }
    assert.equal(names.length, 1_003)
    assert.equal(new Set(names).size, 1_003)
    assert.equal(variantCount, 4_012)
    assert.deepEqual(names, [...names].sort())
  })

  it('fails duplicate canonical targets closed before they can land on different pages', async () => {
    const rows = seeds(20)
    rows[0] = {
      ...rows[0]!, name: 'DUPLICATE',
      variants: [{ tag: 'Q4', sizeBytes: 1_000, parameterSize: '1B' }],
    }
    rows[19] = {
      ...rows[19]!, name: 'duplicate',
      variants: [{ tag: 'q4', sizeBytes: 2_000, parameterSize: '2B' }],
    }
    const first = (await catalog(rows, 1, 10)).result
    const second = (await catalog(rows, 2, 10)).result
    const duplicates = [...first.models, ...second.models]
      .filter((model) => model.name.toLowerCase() === 'duplicate')
    assert.equal(duplicates.length, 2)
    assert.ok(duplicates.every((model) =>
      model.variants[0]?.normalizedName === null
      && model.variants[0]?.fit.state === 'unknown'
      && model.variants[0]?.installation.state === 'unknown',
    ))
  })

  it('filters text and every P2-F facet before exact count and slice', async () => {
    const rows = seeds(60)
    const { result } = await catalog(rows, 1, 7, {
      query: 'even local',
      filters: {
        installation: ['not_installed'], fit: ['green', 'yellow', 'red'],
        providerScope: ['local'], source: ['bundled'], freshness: ['fallback'],
        capability: ['tools'], minClaimedContext: 65_536,
        maxClaimedArtifactSize: Number.MAX_SAFE_INTEGER,
      },
    })
    assert.equal(result.pagination.mode, 'paged')
    assert.ok(result.pagination.mode === 'paged' && result.pagination.totalItems > 7)
    assert.equal(result.models.length, 7)
    assert.ok(result.models.every((model) =>
      model.description.includes('even')
      && model.capabilities.includes('tools')
      && model.variants.every((variant) => variant.contextLength === 65_536),
    ))
  })

  it('uses fresh source truth after shrink and honours AbortSignal', async () => {
    const first = (await catalog(seeds(25), 3, 10)).result
    const shrunk = (await catalog(seeds(5), 3, 10)).result
    assert.equal(first.models.length, 5)
    assert.equal(shrunk.models.length, 0)
    assert.deepEqual(shrunk.pagination, {
      mode: 'paged', page: 3, pageSize: 10, totalItems: 5, totalPages: 1,
      previousPage: null, nextPage: null,
    })

    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      getCatalog(
        { ...input(1, 10), signal: controller.signal },
        { loadLocalRecommendations: async () => null, bundled: seeds(10) },
      ),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    )
  })

  it('preserves unavailable tags and each allowed source state without optimistic totals', async () => {
    const local = await getCatalog(
      { ...input(1, 10), installed: null },
      {
        loadLocalRecommendations: async () => ({
          seeds: seeds(3),
          fetchedAt: '2026-08-03T00:00:00.000Z',
        }),
        bundled: [],
        now: () => new Date(AT),
      },
    )
    assert.equal(local.source.state, 'stale_cache')
    assert.equal(local.pagination.mode === 'paged' && local.pagination.totalItems, 3)
    assert.ok(local.models.every((model) => model.variants.every((variant) =>
      variant.installation.state === 'unknown'
      && variant.installation.reason === 'provider_unavailable',
    )))

    const bundled = (await catalog(seeds(2), 1, 10)).result
    assert.equal(bundled.source.state, 'bundled_fallback')
    assert.equal(bundled.pagination.mode === 'paged' && bundled.pagination.totalItems, 2)

    const unavailable = (await catalog([], 1, 10)).result
    assert.equal(unavailable.source.state, 'unavailable')
    assert.deepEqual(unavailable.pagination, {
      mode: 'paged', page: 1, pageSize: 10, totalItems: 0, totalPages: 0,
      previousPage: null, nextPage: null,
    })
  })
})

describe('catalog pagination HTTP boundary', () => {
  it('rejects duplicate, unknown and invalid page keys before tags or catalog source access', async () => {
    let tagCalls = 0
    const app = createApp({
      ollama: () => ({
        tags: async () => {
          tagCalls += 1
          return { models: [] }
        },
      }),
      hardware: HARDWARE,
    } as unknown as AppContext)
    for (const query of [
      'page=1', 'pageSize=12', 'page=0&pageSize=12', 'page=-1&pageSize=12',
      'page=1.5&pageSize=12', 'page=9007199254740992&pageSize=12',
      'page=1&pageSize=0', 'page=1&pageSize=-1', 'page=1&pageSize=1.5',
      'page=1&pageSize=9007199254740992', `page=1&pageSize=${CATALOG_MAX_PAGE_SIZE + 1}`,
      'page=1&page=2&pageSize=12', 'page=1&pageSize=12&pageSize=24',
      'page=1&pageSize=12&future=value',
    ]) {
      const response = await app.request(`/api/models/catalog?${query}`)
      assert.equal(response.status, 400, query)
    }
    assert.equal(tagCalls, 0)
  })
})
