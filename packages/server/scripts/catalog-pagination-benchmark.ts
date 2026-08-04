import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { CATALOG_DEFAULT_PAGE_SIZE, type HardwareInfo } from '@alamo/contract'
import { getCatalog, type CatalogSeed } from '../src/models/catalog.ts'

const MODEL_COUNT = 1_000
const VARIANTS_PER_MODEL = 4
const OBSERVED_AT = '2026-08-04T00:00:00.000Z'
const hardware: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'synthetic benchmark fixture',
  cpuCores: 8,
  totalMemoryBytes: 32_000_000_000,
  usableMemoryBytes: 24_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'synthetic benchmark fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

const rows: CatalogSeed[] = Array.from({ length: MODEL_COUNT }, (_, index) => ({
  name: `synthetic-${String(MODEL_COUNT - index - 1).padStart(4, '0')}`,
  description: `Synthetic catalog row ${index}`,
  variants: Array.from({ length: VARIANTS_PER_MODEL }, (_, variant) => ({
    tag: `q${variant + 1}`,
    sizeBytes: 1_000_000_000 + index * 1_000 + variant,
    parameterSize: `${variant + 1}B`,
  })),
  contextLength: 32_768,
  capabilities: ['completion'],
  vramBytes: null,
  isCloud: false,
  requiredPlan: null,
}))

const dependencies = {
  loadLocalRecommendations: async () => null,
  bundled: rows,
  now: () => new Date(OBSERVED_AT),
}
const baseInput = {
  contextLength: 8_192,
  hardware,
  installed: { models: [], observedAt: OBSERVED_AT },
}

async function measure(paged: boolean) {
  const startedAt = performance.now()
  const response = await getCatalog(
    paged
      ? { ...baseInput, pagination: { page: 1, pageSize: CATALOG_DEFAULT_PAGE_SIZE } }
      : baseInput,
    dependencies,
  )
  const elapsedMs = performance.now() - startedAt
  return {
    response,
    responseBytes: Buffer.byteLength(JSON.stringify(response), 'utf8'),
    elapsedMs: Number(elapsedMs.toFixed(3)),
  }
}

const legacy = await measure(false)
const paged = await measure(true)
assert.equal(legacy.response.models.length, MODEL_COUNT)
assert.equal(paged.response.models.length, CATALOG_DEFAULT_PAGE_SIZE)
assert.equal(paged.response.pagination.mode, 'paged')
assert.equal(paged.response.pagination.totalItems, MODEL_COUNT)

console.log(JSON.stringify({
  kind: 'local_synthetic_diagnostic',
  fixture: { models: MODEL_COUNT, variants: MODEL_COUNT * VARIANTS_PER_MODEL },
  legacyFullProjection: {
    responseBytes: legacy.responseBytes,
    elapsedMs: legacy.elapsedMs,
  },
  explicitFirstPage: {
    pageSize: CATALOG_DEFAULT_PAGE_SIZE,
    responseModels: paged.response.models.length,
    responseVariants: paged.response.models.reduce(
      (sum, model) => sum + model.variants.length,
      0,
    ),
    responseBytes: paged.responseBytes,
    elapsedMs: paged.elapsedMs,
  },
  timingScope: 'single local run; diagnostic only; not a production SLA',
}, null, 2))
