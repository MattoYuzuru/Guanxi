import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FEATURE_FLAG_DECLARATION_VERSION,
  FEATURE_FLAG_REGISTRY_VERSION,
  ROUTES,
  featureFlagKeySchema,
  getFeatureFlagsResponse,
} from '@alamo/contract'
import { createApp } from '../src/app.ts'
import {
  ESTIMATED_PARALLEL_ADMISSION_ENV,
  FEATURE_FLAG_DECLARATIONS,
  FeatureFlagRegistry,
  type FeatureFlagDeclaration,
} from '../src/config/feature-flags.ts'
import type { AppContext } from '../src/context.ts'

const OBSERVED_AT = '2026-08-09T12:00:00.000Z'
const KEY = 'estimated_parallel_admission_policy' as const

function registry(
  values: Readonly<Record<string, string | undefined>> = {},
  declarations?: readonly FeatureFlagDeclaration[],
): FeatureFlagRegistry {
  return new FeatureFlagRegistry({
    environment: { state: 'available', values },
    observedAt: OBSERVED_AT,
    declarations,
  })
}

function exactProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: KEY,
    effectiveValue: false,
    state: 'resolved',
    source: 'safe_default',
    reason: null,
    observedAt: OBSERVED_AT,
    basis: {
      registryVersion: FEATURE_FLAG_REGISTRY_VERSION,
      declarationVersion: FEATURE_FLAG_DECLARATION_VERSION,
    },
    ...overrides,
  }
}

describe('P2-N feature flag contract and registry', () => {
  it('keeps one complete unique default-off declaration for the reserved P2-O policy', () => {
    assert.deepEqual(featureFlagKeySchema.options, [KEY])
    assert.equal(FEATURE_FLAG_DECLARATIONS.length, 1)
    assert.equal(new Set(FEATURE_FLAG_DECLARATIONS.map((item) => item.key)).size, 1)
    assert.deepEqual(
      FEATURE_FLAG_DECLARATIONS.map(({ key, safeDefault, declarationVersion }) => ({
        key,
        safeDefault,
        declarationVersion,
      })),
      [{ key: KEY, safeDefault: false, declarationVersion: 1 }],
    )
  })

  it('parses the exact versioned projection and rejects unknown/future/extra/duplicate shapes', () => {
    const exact = {
      version: FEATURE_FLAG_REGISTRY_VERSION,
      flags: [exactProjection()],
    }
    assert.deepEqual(getFeatureFlagsResponse.parse(exact), exact)

    const rejected = [
      { ...exact, version: 2 },
      { ...exact, extra: true },
      { ...exact, flags: [exactProjection({ key: 'unknown_policy' })] },
      { ...exact, flags: [exactProjection({ effectiveValue: 'disabled' })] },
      { ...exact, flags: [exactProjection({ state: 'future_state' })] },
      { ...exact, flags: [exactProjection({ source: 'user_choice' })] },
      { ...exact, flags: [exactProjection({ extra: 'raw-config' })] },
      {
        ...exact,
        flags: [exactProjection(), exactProjection()],
      },
      {
        ...exact,
        flags: [
          exactProjection({
            basis: { registryVersion: 2, declarationVersion: 1 },
          }),
        ],
      },
    ]
    assert.equal(rejected.length, 9)
    for (const candidate of rejected) {
      assert.equal(getFeatureFlagsResponse.safeParse(candidate).success, false)
    }
  })

  it('applies exact operator precedence over the safe default for both boolean values', () => {
    const fallback = registry().publicProjection().flags[0]!
    const enabled = registry({ [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled' })
      .publicProjection().flags[0]!
    const disabled = registry({ [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'disabled' })
      .publicProjection().flags[0]!

    assert.deepEqual(
      [fallback.source, fallback.effectiveValue, fallback.state],
      ['safe_default', false, 'resolved'],
    )
    assert.deepEqual(
      [enabled.source, enabled.effectiveValue, enabled.state],
      ['operator_environment', true, 'resolved'],
    )
    assert.deepEqual(
      [disabled.source, disabled.effectiveValue, disabled.state],
      ['operator_environment', false, 'resolved'],
    )
  })

  it('accepts only exact documented env values and fail-closes every malformed value', () => {
    const malformed = ['true', 'false', '1', 'ENABLED', ' enabled', 'disabled ', '']
    assert.equal(malformed.length, 7)
    for (const raw of malformed) {
      const current = registry({ [ESTIMATED_PARALLEL_ADMISSION_ENV]: raw })
        .publicProjection().flags[0]!
      assert.deepEqual(
        [current.state, current.effectiveValue, current.source, current.reason],
        ['invalid', false, 'safe_default', 'invalid_operator_value'],
      )
      assert.equal('rawValue' in current, false)
      assert.equal('operatorEnvironmentVariable' in current, false)
    }
    const sentinel = registry({
      [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'private-sentinel-invalid-value',
    }).publicProjection().flags[0]!
    assert.equal(JSON.stringify(sentinel).includes('private-sentinel-invalid-value'), false)
  })

  it('fail-closes an unavailable operator source with explicit provenance', () => {
    const explicit = new FeatureFlagRegistry({
      environment: { state: 'unavailable' },
      observedAt: OBSERVED_AT,
    }).publicProjection().flags[0]!
    const throwingValues = new Proxy<Record<string, string | undefined>>({}, {
      get() {
        throw new Error('source cannot be read')
      },
    })
    const unreadable = registry(throwingValues).publicProjection().flags[0]!
    const future = new FeatureFlagRegistry({
      environment: { state: 'future' } as never,
      observedAt: OBSERVED_AT,
    }).publicProjection().flags[0]!

    for (const current of [explicit, unreadable, future]) {
      assert.deepEqual(
        [current.state, current.effectiveValue, current.source, current.reason],
        ['unavailable', false, 'safe_default', 'operator_source_unavailable'],
      )
    }
  })

  it('captures one stable startup snapshot and ignores later environment mutation', () => {
    const environment: Record<string, string | undefined> = {
      [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled',
    }
    const current = registry(environment)
    const before = current.publicProjection()
    environment[ESTIMATED_PARALLEL_ADMISSION_ENV] = 'disabled'

    assert.equal(current.isEnabled(KEY), true)
    assert.strictEqual(current.publicProjection(), before)
    assert.equal(current.publicProjection().flags[0]!.effectiveValue, true)
    assert.equal(Object.isFrozen(current.publicProjection()), true)
    assert.equal(Object.isFrozen(current.publicProjection().flags[0]), true)
  })

  it('fails closed for an unknown runtime key and rejects duplicate or incomplete registries', () => {
    const current = registry({ [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled' })
    assert.equal(current.isEnabled('unknown_policy' as typeof KEY), false)
    assert.throws(
      () => registry({}, [...FEATURE_FLAG_DECLARATIONS, ...FEATURE_FLAG_DECLARATIONS]),
      /Duplicate feature flag declaration/u,
    )
    assert.throws(() => registry({}, []), /Feature flag registry is incomplete/u)
  })

  it('redacts raw/default/operator metadata and excludes a server-only declaration', () => {
    const serverOnly = FEATURE_FLAG_DECLARATIONS.map((item) => ({
      ...item,
      clientReadable: false,
    }))
    const current = registry(
      { [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled' },
      serverOnly,
    )
    const projection = current.publicProjection()

    assert.equal(current.isEnabled(KEY), true)
    assert.equal(projection.flags.length, 0)
    assert.equal(JSON.stringify(projection).includes(ESTIMATED_PARALLEL_ADMISSION_ENV), false)
    assert.equal(JSON.stringify(projection).includes('safeDefault'), false)
    assert.equal(JSON.stringify(projection).includes('enabled'), false)
  })

  it('keeps two application contexts and requests isolated without global mutable state', async () => {
    const contextA = {
      featureFlags: registry({ [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'enabled' }),
    } as AppContext
    const contextB = { featureFlags: registry() } as AppContext
    const [responseA, responseB] = await Promise.all([
      createApp(contextA).request(ROUTES.featureFlags()),
      createApp(contextB).request(ROUTES.featureFlags()),
    ])
    const bodyA = getFeatureFlagsResponse.parse(await responseA.json())
    const bodyB = getFeatureFlagsResponse.parse(await responseB.json())

    assert.equal(responseA.status, 200)
    assert.equal(responseB.status, 200)
    assert.equal(bodyA.flags.length, 1)
    assert.equal(bodyB.flags.length, 1)
    assert.equal(bodyA.flags[0]!.effectiveValue, true)
    assert.equal(bodyB.flags[0]!.effectiveValue, false)
    assert.notStrictEqual(contextA.featureFlags, contextB.featureFlags)
  })

  it('exposes no write method and cannot mutate the startup snapshot through HTTP', async () => {
    const featureFlags = registry()
    const app = createApp({ featureFlags } as AppContext)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.request(ROUTES.featureFlags(), {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY, value: true }),
      })
      assert.equal(response.status, 404)
    }
    const after = getFeatureFlagsResponse.parse(
      await (await app.request(ROUTES.featureFlags())).json(),
    )
    assert.equal(after.flags.length, 1)
    assert.equal(after.flags[0]!.effectiveValue, false)
    assert.strictEqual(featureFlags.publicProjection(), featureFlags.publicProjection())
  })

  it('reads only the declared env slot and serves without DB/network/model/Governor access', async () => {
    const reads: PropertyKey[] = []
    const environment = new Proxy<Record<string, string | undefined>>(
      { [ESTIMATED_PARALLEL_ADMISSION_ENV]: 'disabled' },
      {
        get(target, property, receiver) {
          reads.push(property)
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const featureFlags = registry(environment)
    const accessed: PropertyKey[] = []
    const context = new Proxy(
      { featureFlags },
      {
        get(target, property, receiver) {
          accessed.push(property)
          if (property !== 'featureFlags') throw new Error(`unexpected side effect: ${String(property)}`)
          return Reflect.get(target, property, receiver)
        },
      },
    ) as AppContext

    const response = await createApp(context).request(ROUTES.featureFlags())
    assert.equal(response.status, 200)
    assert.deepEqual(reads, [ESTIMATED_PARALLEL_ADMISSION_ENV])
    assert.deepEqual(accessed, ['featureFlags'])
    assert.equal(getFeatureFlagsResponse.parse(await response.json()).flags.length, 1)
  })
})
