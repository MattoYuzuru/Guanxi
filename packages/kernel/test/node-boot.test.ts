import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ProfileError, contribute, createKernel, declareSlot, effect, provide, service, type ProfileLayer } from '../src/index.ts'
import { NodeLoadError, bootNode } from '../src/node.ts'
import { deferred, testPlugin, tick } from './helpers.ts'

function counted(id: string, trust: 'T0' | 'T1' = 'T0') {
  const calls: unknown[] = []
  const plugin = testPlugin<{ value?: number } | undefined>({ id, trust }, (ctx, config) => {
    calls.push(config)
    effect(ctx, () => () => calls.push('unloaded'))
  })
  return { plugin, calls }
}

describe('node boot and profile reconciliation', () => {
  it('loads profile rows and reconciles only the rows that changed', { timeout: 10_000 }, async () => {
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
    assert.equal(node.stateOf('a'), 'active')

    await node.apply([base, { name: 'user', patch: [{ id: 'b', config: { value: 2 } }] }])
    assert.deepEqual(a.calls, [{ value: 1 }], 'unchanged row did not reload')
    assert.deepEqual(b.calls, [{ value: 1 }, 'unloaded', { value: 2 }])

    await node.apply([base, { name: 'user', patch: [{ id: 'a', disabled: true }, { id: 'b', config: { value: 2 } }] }])
    assert.deepEqual(a.calls, [{ value: 1 }, 'unloaded'])
    assert.equal(node.stateOf('a'), undefined)

    await node.apply([base, { name: 'user', patch: [{ id: 'a', remove: true }] }])
    assert.deepEqual(b.calls.at(-1), { value: 1 })
    assert.deepEqual(node.entries().map((entry) => entry.id), ['b'])

    await node.dispose()
    assert.equal(node.counters().fibers, 0)
  })

  it('refuses unknown plugins and contributions to slots nobody declares', { timeout: 10_000 }, async () => {
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

  it('disables every non-T0 row in safe mode', { timeout: 10_000 }, async () => {
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

  it('replaces the code of a loaded plugin', { timeout: 10_000 }, async () => {
    const v1 = counted('fixture.hot')
    const node = await bootNode({ plugins: [v1.plugin], profile: [{ name: 'p', insert: [{ id: 'hot', plugin: 'fixture.hot' }] }] })
    const before = node.counters()
    const v2 = counted('fixture.hot')
    await node.replacePlugin(v2.plugin)
    assert.deepEqual(v1.calls, [undefined, 'unloaded'])
    assert.deepEqual(v2.calls, [undefined])
    assert.deepEqual(node.counters(), before, 'one fiber replaced another')
    await node.dispose()
  })
})

function providerPlugin(id: string, order: string[], release?: Promise<void>) {
  return testPlugin({ id, provides: ['permit'] }, (ctx) => {
    order.push(`${id} up`)
    provide(ctx, 'permit', id)
    effect(ctx, () => async () => {
      await release
      order.push(`${id} down`)
    })
  })
}

describe('node reconciliation', () => {
  it('replaces a provider only after the old one fully unloaded, with its dependent intact', { timeout: 10_000 }, async () => {
    const order: string[] = []
    const release = deferred()
    const consumer = testPlugin({ id: 'fixture.consumer', requires: ['permit'] }, (ctx) => {
      order.push(`consumer sees ${service<string>(ctx, 'permit')}`)
    })
    const node = await bootNode({
      plugins: [providerPlugin('fixture.provider', order, release.promise), consumer],
      profile: [{ name: 'p', insert: [{ id: 'provider', plugin: 'fixture.provider' }, { id: 'consumer', plugin: 'fixture.consumer' }] }],
    })
    const replacing = node.replacePlugin(providerPlugin('fixture.provider', order))
    await tick(10)
    assert.equal(order.filter((line) => line.endsWith(' up')).length, 1, 'the new provider waits for the old unload')
    release.resolve()
    await replacing
    assert.deepEqual(order, [
      'fixture.provider up',
      'consumer sees fixture.provider',
      'fixture.provider down',
      'fixture.provider up',
      'consumer sees fixture.provider',
    ])
    assert.equal(node.stateOf('consumer'), 'active')
    await node.dispose()
  })

  it('serialises concurrent applies so a disabled row stays disabled', { timeout: 10_000 }, async () => {
    const plugin = testPlugin({ id: 'fixture.row' }, async () => {
      await tick(5)
    })
    const enabled: ProfileLayer[] = [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.row' }] }]
    const disabled: ProfileLayer[] = [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.row', disabled: true }] }]
    const node = await bootNode({ plugins: [plugin], profile: disabled })
    await Promise.all([node.apply(enabled), node.apply(disabled)])
    assert.equal(node.stateOf('row'), undefined)
    await node.dispose()
  })

  it('surfaces a row whose plugin failed to load', { timeout: 10_000 }, async () => {
    const broken = testPlugin({ id: 'fixture.broken' }, () => {
      throw new Error('broken apply')
    })
    await assert.rejects(
      bootNode({ plugins: [broken], profile: [{ name: 'p', insert: [{ id: 'b', plugin: 'fixture.broken' }] }], onLog: () => {} }),
      (error: unknown) => error instanceof NodeLoadError && error.rows.includes('b: failed'),
    )
  })

  it('refuses a requirement that no row provides', { timeout: 10_000 }, async () => {
    const orphan = testPlugin({ id: 'fixture.orphan', requires: ['nothing'] }, () => {})
    await assert.rejects(
      bootNode({ plugins: [orphan], profile: [{ name: 'p', insert: [{ id: 'o', plugin: 'fixture.orphan' }] }] }),
      /requires "nothing", which no row provides/,
    )
  })

  it('refuses to change pinned rows and to hot-swap a changed manifest', { timeout: 10_000 }, async () => {
    const order: string[] = []
    const base: ProfileLayer = { name: 'p', insert: [{ id: 'provider', plugin: 'fixture.pinned' }] }
    const node = await bootNode({ plugins: [providerPlugin('fixture.pinned', order)], profile: [base], pinned: ['provider'] })
    await assert.rejects(node.apply([base, { name: 'u', patch: [{ id: 'provider', disabled: true }] }]), /pinned/)
    await assert.rejects(node.replacePlugin(providerPlugin('fixture.pinned', order)), /pinned/)
    assert.equal(node.stateOf('provider'), 'active')
    await node.dispose()

    const plain = await bootNode({ plugins: [providerPlugin('fixture.swap', order)], profile: [{ name: 'p', insert: [{ id: 's', plugin: 'fixture.swap' }] }] })
    const trusted = testPlugin({ id: 'fixture.swap', provides: ['permit'], trust: 'T1' }, (ctx) => provide(ctx, 'permit', 1))
    await assert.rejects(plain.replacePlugin(trusted), /changed its manifest/)
    await plain.dispose()
  })

  it('cascades safe mode to rows that need a disabled service or slot, and still boots', { timeout: 10_000 }, async () => {
    const t1 = testPlugin({ id: 'fixture.t1', trust: 'T1', provides: ['extra'], contributes: { slotDeclarations: ['extra.slot'] } }, (ctx) => {
      provide(ctx, 'extra', 1)
      declareSlot(ctx, 'extra.slot')
    })
    const needsService = testPlugin({ id: 'fixture.needs-service', requires: ['extra'] }, () => {})
    const needsSlot = testPlugin({ id: 'fixture.needs-slot', contributes: { slots: ['extra.slot'] } }, (ctx) => {
      contribute(ctx, 'extra.slot', { id: 'x', value: 1 })
    })
    const core = testPlugin({ id: 'fixture.core-only' }, () => {})
    const node = await bootNode({
      plugins: [t1, needsService, needsSlot, core],
      safeMode: true,
      profile: [{
        name: 'p',
        insert: [
          { id: 't1', plugin: 'fixture.t1' },
          { id: 'needs-service', plugin: 'fixture.needs-service' },
          { id: 'needs-slot', plugin: 'fixture.needs-slot' },
          { id: 'core', plugin: 'fixture.core-only' },
        ],
      }],
    })
    assert.deepEqual(
      node.entries().map((entry) => [entry.id, entry.disabled]),
      [['t1', true], ['needs-service', true], ['needs-slot', true], ['core', false]],
    )
    assert.equal(node.stateOf('core'), 'active')
    await node.dispose()
  })
})

describe('context tree', () => {
  it('starts a child after its parent is active and unloads it with the parent', { timeout: 10_000 }, async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    const order: string[] = []
    let refused = ''
    const child = testPlugin({ id: 'fixture.child' }, (ctx) => {
      order.push('child up')
      effect(ctx, () => () => order.push('child down'))
    })
    const parent = await kernel.plugin(testPlugin({ id: 'fixture.parent' }, async (ctx) => {
      const handle = ctx.plugin(child)
      await handle.ready().catch((error: Error) => {
        refused = error.message
      })
      order.push('parent applied')
      effect(ctx, () => () => order.push('parent down'))
    }))
    assert.match(refused, /starts after fixture\.parent's apply returns/)
    assert.deepEqual(order, ['parent applied', 'child up'])
    assert.equal(kernel.counters().fibers - before.fibers, 2)
    await parent.dispose()
    assert.deepEqual(order, ['parent applied', 'child up', 'child down', 'parent down'])
    assert.deepEqual(kernel.counters(), before)
  })

  it('loads a child from an active parent as its own transition', { timeout: 10_000 }, async () => {
    const kernel = createKernel()
    let load: (() => Promise<void>) | undefined
    await kernel.plugin(testPlugin({ id: 'fixture.lazy-parent' }, (ctx) => {
      load = async () => {
        const handle = ctx.plugin(testPlugin({ id: 'fixture.lazy-child', provides: ['lazy'] }, (child) => provide(child, 'lazy', 1)))
        await handle.ready()
      }
    }))
    await load!()
    assert.equal(kernel.service('lazy'), 1)
    await kernel.dispose()
    assert.equal(kernel.service('lazy'), undefined)
  })
})
