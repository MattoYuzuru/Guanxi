import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { listCatalogQuery } from '@guanxi/contract'

describe('catalog facet query contract', () => {
  it('keeps legacy query defaults additive and parses deterministic CSV multi-selects', () => {
    assert.deepEqual(listCatalogQuery.parse({ q: 'Coder', contextLength: '8192' }), {
      q: 'Coder', contextLength: 8_192,
    })
    assert.deepEqual(listCatalogQuery.parse({
      installation: 'installed,unknown',
      fit: 'green,yellow',
      providerScope: 'local,cloud',
      source: 'local_cache,bundled,remote',
      freshness: 'fresh,stale,fallback,unknown',
      capability: 'tools,unknown',
      minClaimedContext: '32768',
      maxClaimedArtifactSize: '9007199254740991',
    }), {
      installation: ['installed', 'unknown'],
      fit: ['green', 'yellow'],
      providerScope: ['local', 'cloud'],
      source: ['local_cache', 'bundled', 'remote'],
      freshness: ['fresh', 'stale', 'fallback', 'unknown'],
      capability: ['tools', 'unknown'],
      minClaimedContext: 32_768,
      maxClaimedArtifactSize: Number.MAX_SAFE_INTEGER,
    })
    assert.deepEqual(listCatalogQuery.parse({ fit: '', capability: '' }), {
      fit: [], capability: [],
    })
  })

  it('fails closed on unknown keys, future enums, duplicates and unsafe numeric shapes', () => {
    const invalid = [
      { future: 'value' },
      { fit: 'green,future' },
      { fit: 'green,green' },
      { capability: 'unsupported' },
      { minClaimedContext: '0' },
      { minClaimedContext: '-1' },
      { minClaimedContext: '1.5' },
      { maxClaimedArtifactSize: '9007199254740992' },
      { minClaimedContext: '1', contextClaim: 'unknown' },
      { maxClaimedArtifactSize: '1', artifactSizeClaim: 'unknown' },
    ]
    for (const value of invalid) {
      assert.equal(listCatalogQuery.safeParse(value).success, false, JSON.stringify(value))
    }
  })

  it('accepts explicit unknown claimed context and artifact-size filters', () => {
    assert.deepEqual(listCatalogQuery.parse({
      contextClaim: 'unknown', artifactSizeClaim: 'unknown',
    }), {
      contextClaim: 'unknown', artifactSizeClaim: 'unknown',
    })
  })
})
