import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProfileError, contribute, declareSlot, effect, isActive, type ProfileLayer } from '../src/index.ts'
import { bootNode } from '../src/node.ts'
import { testPlugin } from './helpers.ts'

function counted(id: string, trust: 'T0' | 'T1' = 'T0') {
  const calls: unknown[] = []
  const plugin = testPlugin<{ value?: number } | undefined>({ id, trust }, (ctx, config) => {
    calls.push(config)
    effect(ctx, () => () => calls.push('unloaded'))
  })
  return { plugin, calls }
}

describe('node boot through the Cordis loader', () => {
  it('loads profile rows and reconciles only the rows that changed', async () => {
    const a = counted('fixture.a')
    const b = counted('fixture.b')
    const base: ProfileLayer = {
      name: 'profile:test',
      insert: [
        { id: 'a', plugin: 'fixture.a', config: { value: 1 } },
        { id: 'b', plugin: 'fixture.b', config: { value: 1 } },
      ],
    }
    const node = await bootNode({ plugins: [a.plugin, b.plugin], profile: [base] })
    assert.deepEqual(a.calls, [{ value: 1 }])
    assert.ok(node.fiberOf('a') && isActive(node.fiberOf('a')!))

    await node.apply([base, { name: 'user', patch: [{ id: 'b', config: { value: 2 } }] }])
    assert.deepEqual(a.calls, [{ value: 1 }], 'unchanged row did not reload')
    assert.deepEqual(b.calls, [{ value: 1 }, 'unloaded', { value: 2 }])

    await node.apply([base, { name: 'user', patch: [{ id: 'a', disabled: true }, { id: 'b', config: { value: 2 } }] }])
    assert.deepEqual(a.calls, [{ value: 1 }, 'unloaded'])
    assert.equal(node.fiberOf('a'), undefined)

    await node.apply([base, { name: 'user', patch: [{ id: 'a', remove: true }] }])
    assert.deepEqual(b.calls.at(-1), { value: 1 })
    assert.deepEqual(node.entries().map((entry) => entry.id), ['b'])

    await node.dispose()
    assert.equal(node.counters().fibers, 0)
  })

  it('refuses unknown plugins and contributions to slots nobody declares', async () => {
    await assert.rejects(
      bootNode({ plugins: [], profile: [{ name: 'p', insert: [{ id: 'x', plugin: 'fixture.missing' }] }] }),
      (error: unknown) => error instanceof ProfileError && /unknown plugin "fixture.missing"/.test(error.message),
    )
    const contributor = testPlugin({ id: 'fixture.contributor', contributes: { slots: ['sidebar.items'] } }, (ctx) => {
      contribute(ctx, 'sidebar.items', { id: 'x', value: {} })
    })
    await assert.rejects(
      bootNode({ plugins: [contributor], profile: [{ name: 'p', insert: [{ id: 'c', plugin: 'fixture.contributor' }] }] }),
      /contributes to undeclared slot "sidebar.items"/,
    )
    const owner = testPlugin({ id: 'fixture.owner', contributes: { slotDeclarations: ['sidebar.items'] } }, (ctx) => {
      declareSlot(ctx, 'sidebar.items')
    })
    const node = await bootNode({
      plugins: [contributor, owner],
      profile: [{ name: 'p', insert: [{ id: 'c', plugin: 'fixture.contributor' }, { id: 'o', plugin: 'fixture.owner' }] }],
    })
    assert.equal(node.slots.list('sidebar.items').length, 1)
    await node.dispose()
  })

  it('disables every non-T0 row in safe mode', async () => {
    const core = counted('fixture.core', 'T0')
    const trusted = counted('fixture.trusted', 'T1')
    const profile: ProfileLayer[] = [{
      name: 'p',
      insert: [{ id: 'core', plugin: 'fixture.core' }, { id: 'trusted', plugin: 'fixture.trusted' }],
    }]
    const node = await bootNode({ plugins: [core.plugin, trusted.plugin], profile, safeMode: true })
    assert.equal(core.calls.length, 1)
    assert.equal(trusted.calls.length, 0)
    assert.equal(node.entries().find((entry) => entry.id === 'trusted')?.disabled, true)
    await node.dispose()
  })

  it('replaces the code of a loaded plugin', async () => {
    const v1 = counted('fixture.hot')
    const node = await bootNode({ plugins: [v1.plugin], profile: [{ name: 'p', insert: [{ id: 'hot', plugin: 'fixture.hot' }] }] })
    const before = node.counters()
    const v2 = counted('fixture.hot')
    await node.replacePlugin(v2.plugin)
    assert.deepEqual(v1.calls, [undefined, 'unloaded'])
    assert.deepEqual(v2.calls, [undefined])
    assert.deepEqual(node.counters(), before, 'one hot fiber replaced another')
    await node.dispose()
  })
})
