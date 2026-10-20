/**
 * Regression tests for the K1 independent review findings: each fails on the
 * code before its fix.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  FIBER_STATE,
  KernelTimeoutError,
  createKernel,
  declareSlot,
  contribute,
  effect,
  interval,
  isActive,
  on,
  provide,
  service,
  type ProfileLayer,
} from '../src/index.ts'
import { NodeLoadError, bootNode, processResources } from '../src/node.ts'
import { deferred, settle, testPlugin, tick } from './helpers.ts'

describe('definePlugin apply (implementation review, High 1)', () => {
  it('awaits an async apply before the plugin counts as active', async () => {
    const kernel = createKernel()
    await kernel.plugin(testPlugin({ provides: ['late'] }, async (ctx) => {
      await tick(5)
      provide(ctx, 'late', 'ready')
    }))
    assert.equal(service(kernel.root, 'late'), 'ready')
  })

  it('rejects the load when an async apply throws, without an unhandled rejection', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await assert.rejects(kernel.plugin(testPlugin({}, async () => {
      await tick()
      throw new Error('late failure')
    })), /late failure/)
    await assert.rejects(kernel.plugin(testPlugin({ provides: ['never'] }, async () => {
      await tick()
    })), /did not provide never/)
  })

  it('runs a disposer returned from apply on unload', async () => {
    const kernel = createKernel()
    let disposed = 0
    const handle = await kernel.plugin(testPlugin({}, () => () => {
      disposed += 1
    }))
    await handle.dispose()
    assert.equal(disposed, 1)
  })
})

describe('lifecycle guard on FAILED fibers (architecture review, H1)', () => {
  it('refuses timers and listeners from a continuation of a failed apply', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const timers = processResources().timers
    const before = kernel.counters()
    const later = deferred()
    const outcome = deferred<string>()
    const plugin = testPlugin({}, async (ctx) => {
      void later.promise.then(() => {
        try {
          interval(ctx, () => {}, 60_000)
          on(ctx, 'late', () => {})
          outcome.resolve('accepted')
        } catch (error) {
          outcome.resolve((error as Error).message)
        }
      })
      throw new Error('apply failed')
    })
    const fiber = kernel.root.plugin(plugin)
    await fiber.await().catch(() => undefined)
    assert.equal(fiber.state, FIBER_STATE.failed)
    later.resolve()
    assert.match(await outcome.promise, /failed plugin/)
    assert.equal(processResources().timers, timers)
    await fiber.dispose()
    assert.deepEqual(kernel.counters(), before)
  })
})

describe('facade rules', () => {
  it('refuses plugin listeners on Cordis lifecycle events', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => {
      on(ctx, 'internal/update', () => {})
    })), /lifecycle event "internal\/update"/)
  })

  it('refuses plugin objects that did not come from definePlugin', async () => {
    const kernel = createKernel()
    const forged = { name: 'x.forged', manifest: { trust: 'T2' }, inject: [], apply() {} }
    await assert.rejects(kernel.plugin(forged as never), /only plugins built by definePlugin/)
    await assert.rejects(bootNode({ plugins: [forged as never], profile: [] }), /only plugins built by definePlugin/)
  })
})

describe('bounded unload (architecture review, H4)', () => {
  it('reports the plugin and effect that keep an unload from finishing', async () => {
    const kernel = createKernel({ disposeTimeoutMs: 50 })
    const handle = await kernel.plugin(testPlugin({ id: 'test.hung-cleanup' }, (ctx) => {
      effect(ctx, () => () => new Promise(() => {}), 'never-settles')
    }))
    const started = Date.now()
    await assert.rejects(handle.dispose(), (error: unknown) => {
      return error instanceof KernelTimeoutError && /test\.hung-cleanup/.test(error.message)
    })
    assert.ok(Date.now() - started < 1_000)
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

describe('node reconciliation (both reviews)', () => {
  it('replaces a provider only after the old one fully unloaded, with its dependent intact', async () => {
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
    assert.ok(isActive(node.fiberOf('consumer')!))
    await node.dispose()
  })

  it('serialises concurrent applies so a disabled row stays disabled', async () => {
    const runs: string[] = []
    const plugin = testPlugin({ id: 'fixture.row' }, async () => {
      runs.push('up')
      await tick(5)
    })
    const on: ProfileLayer[] = [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.row' }] }]
    const off: ProfileLayer[] = [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.row', disabled: true }] }]
    const node = await bootNode({ plugins: [plugin], profile: off })
    await Promise.all([node.apply(on), node.apply(off)])
    await settle()
    assert.equal(node.fiberOf('row'), undefined)
    await node.dispose()
  })

  it('surfaces a row whose plugin failed to load', async () => {
    const broken = testPlugin({ id: 'fixture.broken' }, () => {
      throw new Error('broken apply')
    })
    await assert.rejects(
      bootNode({ plugins: [broken], profile: [{ name: 'p', insert: [{ id: 'b', plugin: 'fixture.broken' }] }], onLog: () => {} }),
      (error: unknown) => error instanceof NodeLoadError && error.rows.includes('b: failed'),
    )
  })

  it('refuses a requirement that no row provides', async () => {
    const orphan = testPlugin({ id: 'fixture.orphan', requires: ['nothing'] }, () => {})
    await assert.rejects(
      bootNode({ plugins: [orphan], profile: [{ name: 'p', insert: [{ id: 'o', plugin: 'fixture.orphan' }] }] }),
      /requires "nothing", which no row provides/,
    )
  })

  it('refuses to change pinned rows and to hot-swap a changed manifest', async () => {
    const order: string[] = []
    const base: ProfileLayer = { name: 'p', insert: [{ id: 'provider', plugin: 'fixture.pinned' }] }
    const node = await bootNode({ plugins: [providerPlugin('fixture.pinned', order)], profile: [base], pinned: ['provider'] })
    await assert.rejects(node.apply([base, { name: 'u', patch: [{ id: 'provider', disabled: true }] }]), /pinned/)
    await assert.rejects(node.replacePlugin(providerPlugin('fixture.pinned', order)), /pinned/)
    await node.dispose()

    const plain = await bootNode({ plugins: [providerPlugin('fixture.swap', order)], profile: [{ name: 'p', insert: [{ id: 's', plugin: 'fixture.swap' }] }] })
    const trusted = testPlugin({ id: 'fixture.swap', provides: ['permit'], trust: 'T1' }, (ctx) => provide(ctx, 'permit', 1))
    await assert.rejects(plain.replacePlugin(trusted), /changed its manifest/)
    await plain.dispose()
  })
})

describe('safe mode (both reviews)', () => {
  it('disables T0 rows that depend on disabled T1 services or slots, and still boots', async () => {
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
    assert.ok(isActive(node.fiberOf('core')!))
    await node.dispose()
  })
})
