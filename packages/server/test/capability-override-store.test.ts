import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { openDb, type Db } from '../src/store/db.ts'
import {
  ModelCapabilityOverrideStore,
  exactCapabilityOverrides,
  modelCapabilityOverrideKey,
  modelCapabilityOverrideProjection,
} from '../src/store/capability-override.ts'

const AT = '2026-08-07T00:00:00.000Z'
const LATER = '2026-08-07T01:00:00.000Z'
const IDENTITY = {
  provider: 'ollama' as const,
  normalizedModelReference: 'fixture:latest',
  artifactDigest: 'sha256:fixture',
  runtimeVersion: '0.12.6',
}

async function store(test: { after: (fn: () => unknown) => void }, label: string) {
  const root = await mkdtemp(join(tmpdir(), `alamo-override-store-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'alamo.db'))
  test.after(() => db.close())
  return { db, store: new ModelCapabilityOverrideStore(db) }
}

function rowCount(db: Db): number {
  return (
    db.prepare('SELECT COUNT(*) AS count FROM model_capability_user_overrides').get() as {
      count: number
    }
  ).count
}

describe('capability override store', () => {
  it('creates exactly one row and keeps a repeated identical write idempotent', async (test) => {
    const { db, store: overrides } = await store(test, 'idempotent')
    const first = overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    assert.equal(rowCount(db), 1)
    assert.equal(first.createdAt, AT)
    assert.equal(first.updatedAt, AT)

    // A later identical assertion must not look like a fresh decision.
    const second = overrides.write({ identity: IDENTITY, capability: 'tools', now: LATER })
    assert.equal(rowCount(db), 1)
    assert.equal(overrides.list(IDENTITY).length, 1)
    assert.equal(second.createdAt, AT)
    assert.equal(second.updatedAt, AT)
    assert.equal(second.overrideKey, first.overrideKey)

    const third = overrides.write({ identity: IDENTITY, capability: 'tools', now: LATER })
    assert.equal(rowCount(db), 1)
    assert.equal(third.updatedAt, AT)
  })

  it('isolates every exact key component and never shares a row', async (test) => {
    const { db, store: overrides } = await store(test, 'isolation')
    const variants = [
      { label: 'baseline', identity: IDENTITY, capability: 'tools' as const },
      {
        label: 'same name, new digest',
        identity: { ...IDENTITY, artifactDigest: 'sha256:replaced' },
        capability: 'tools' as const,
      },
      {
        label: 'same digest, new runtime',
        identity: { ...IDENTITY, runtimeVersion: '0.12.7' },
        capability: 'tools' as const,
      },
      {
        label: 'another model',
        identity: { ...IDENTITY, normalizedModelReference: 'other:latest' },
        capability: 'tools' as const,
      },
      { label: 'another capability', identity: IDENTITY, capability: 'vision' as const },
    ]
    const keys = new Set<string>()
    for (const variant of variants) {
      const record = overrides.write({
        identity: variant.identity,
        capability: variant.capability,
        now: AT,
      })
      keys.add(record.overrideKey)
    }
    assert.equal(keys.size, variants.length)
    assert.equal(rowCount(db), variants.length)

    // The baseline identity sees only its own two capabilities, never a neighbour's.
    const baseline = overrides.list(IDENTITY)
    assert.equal(baseline.length, 2)
    assert.deepEqual(baseline.map((record) => record.capability), ['tools', 'vision'])
    assert.equal(
      overrides.list({ ...IDENTITY, artifactDigest: 'sha256:replaced' }).length,
      1,
    )
    assert.equal(overrides.list({ ...IDENTITY, runtimeVersion: '0.12.7' }).length, 1)
    assert.equal(overrides.list({ ...IDENTITY, normalizedModelReference: 'other:latest' }).length, 1)
    assert.equal(overrides.list({ ...IDENTITY, runtimeVersion: '9.9.9' }).length, 0)
  })

  it('returns a stable deterministic order regardless of insert order', async (test) => {
    const { store: overrides } = await store(test, 'order')
    for (const capability of ['vision', 'completion', 'tools', 'embedding'] as const) {
      overrides.write({ identity: IDENTITY, capability, now: AT })
    }
    const expected = ['completion', 'embedding', 'tools', 'vision']
    assert.deepEqual(overrides.list(IDENTITY).map((r) => r.capability), expected)
    assert.deepEqual(overrides.list(IDENTITY).map((r) => r.capability), expected)
  })

  it('clears only the exact row', async (test) => {
    const { db, store: overrides } = await store(test, 'clear')
    overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    overrides.write({ identity: IDENTITY, capability: 'vision', now: AT })
    overrides.write({
      identity: { ...IDENTITY, artifactDigest: 'sha256:replaced' },
      capability: 'tools',
      now: AT,
    })
    assert.equal(rowCount(db), 3)

    assert.deepEqual(overrides.clear({ identity: IDENTITY, capability: 'tools' }), {
      removed: true,
    })
    assert.equal(rowCount(db), 2)
    assert.equal(overrides.read(IDENTITY, 'tools'), null)
    assert.equal(overrides.read(IDENTITY, 'vision')?.capability, 'vision')
    assert.equal(
      overrides.read({ ...IDENTITY, artifactDigest: 'sha256:replaced' }, 'tools')?.capability,
      'tools',
    )

    // Clearing twice is not an error and removes nothing further.
    assert.deepEqual(overrides.clear({ identity: IDENTITY, capability: 'tools' }), {
      removed: false,
    })
    assert.equal(rowCount(db), 2)
  })

  it('fails closed on a malformed row and projects no assertion at all', async (test) => {
    const { db, store: overrides } = await store(test, 'malformed')
    overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    // A key that does not recompute from its own identity is not trusted, even
    // though every CHECK constraint is satisfied.
    db.prepare(
      `UPDATE model_capability_user_overrides
       SET override_key = ? WHERE override_key = ?`,
    ).run(
      `sha256:${'c'.repeat(64)}`,
      modelCapabilityOverrideKey(IDENTITY, 'tools'),
    )
    assert.equal(rowCount(db), 1)
    assert.throws(() => overrides.list(IDENTITY), /does not match its exact identity/u)
    // The descriptor projection must not surface a claim it cannot verify.
    assert.deepEqual(exactCapabilityOverrides(overrides, IDENTITY), [])
  })

  it('fails closed on an unreadable timestamp', async (test) => {
    const { db, store: overrides } = await store(test, 'timestamps')
    overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    db.prepare('UPDATE model_capability_user_overrides SET updated_at = ?').run('yesterday')
    assert.throws(() => overrides.list(IDENTITY))
    assert.deepEqual(exactCapabilityOverrides(overrides, IDENTITY), [])

    db.prepare('UPDATE model_capability_user_overrides SET updated_at = ?').run(
      '2020-01-01T00:00:00.000Z',
    )
    assert.throws(() => overrides.list(IDENTITY), /invalid timestamps/u)
    assert.deepEqual(exactCapabilityOverrides(overrides, IDENTITY), [])
  })

  it('rejects an incomplete identity before touching SQLite', async (test) => {
    const { db, store: overrides } = await store(test, 'identity')
    for (const identity of [
      { ...IDENTITY, normalizedModelReference: '' },
      { ...IDENTITY, artifactDigest: '  ' },
      { ...IDENTITY, runtimeVersion: '' },
      { ...IDENTITY, normalizedModelReference: ' fixture:latest ' },
      { ...IDENTITY, provider: 'huggingface' as unknown as 'ollama' },
    ]) {
      assert.throws(() => overrides.write({ identity, capability: 'tools', now: AT }))
      assert.throws(() => overrides.list(identity))
      assert.throws(() => overrides.clear({ identity, capability: 'tools' }))
    }
    assert.equal(rowCount(db), 0)
  })

  it('projects only the safe typed assertion fields', async (test) => {
    const { store: overrides } = await store(test, 'projection')
    const record = overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    const projection = modelCapabilityOverrideProjection(record)
    assert.deepEqual(Object.keys(projection).sort(), [
      'artifactDigest',
      'capability',
      'createdAt',
      'normalizedModelReference',
      'provider',
      'runtimeVersion',
      'source',
      'state',
      'updatedAt',
      'value',
      'version',
    ])
    assert.equal(projection.source, 'user_override')
    assert.equal(projection.state, 'overridden')
    assert.equal(projection.value, 'present')
  })

  it('projects nothing when any identity component is unavailable', async (test) => {
    const { store: overrides } = await store(test, 'unavailable')
    overrides.write({ identity: IDENTITY, capability: 'tools', now: AT })
    assert.equal(exactCapabilityOverrides(overrides, IDENTITY).length, 1)
    for (const partial of [
      { ...IDENTITY, normalizedModelReference: null },
      { ...IDENTITY, artifactDigest: null },
      { ...IDENTITY, runtimeVersion: null },
    ]) {
      assert.deepEqual(exactCapabilityOverrides(overrides, partial), [])
    }
  })
})
