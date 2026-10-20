/**
 * Regression tests for the independent reviews of the own kernel (K1, after
 * D-183). Each fails on the code before its fix.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KernelLifecycleError,
  ManifestError,
  createKernel,
  definePlugin,
  effect,
  on,
  optionalService,
  parseManifest,
  provide,
  type PluginContext,
  type ProfileLayer,
} from '../src/index.ts'
import { bootNode } from '../src/node.ts'
import { testPlugin } from './helpers.ts'

describe('own-kernel review: contexts and services', () => {
  it('refuses service() and emit() from a stale context', async () => {
    const kernel = createKernel()
    const contexts: PluginContext[] = []
    await kernel.plugin(testPlugin({ provides: ['base'] }, (ctx) => provide(ctx, 'base', 1)))
    await kernel.plugin(testPlugin({ requires: ['base'], uses: ['extra'] }, (ctx) => {
      contexts.push(ctx)
    }))
    await kernel.plugin(testPlugin({ provides: ['extra'] }, (ctx) => provide(ctx, 'extra', 2)))
    const stale = contexts[0]!
    assert.throws(() => stale.service('base'), KernelLifecycleError)
    assert.throws(() => stale.optionalService('extra'), KernelLifecycleError)
    assert.throws(() => stale.emit('ping'), KernelLifecycleError)
    assert.equal(contexts[1]!.service('base'), 1)
  })

  it('keeps the slot registry out of plugin reach', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => ctx.service('slots'))), /not in manifest.requires/)
    const forged = { manifest: parseManifest({ id: 'x.forged', engines: { guanxi: '^0.1.0' }, trust: 'T0', contributes: { slotDeclarations: ['s.x'] } }) }
    assert.throws(() => kernel.slots.declare(forged as never, 's.x'), /context created by the kernel/)
  })

  it('re-checks the manifest of a branded plugin object at load', async () => {
    const kernel = createKernel()
    const real = definePlugin({ manifest: { id: 'x.real', engines: { guanxi: '^0.1.0' }, trust: 'T0' }, apply() {} })
    const forged = { ...real, manifest: { ...real.manifest, trust: 'T2' } }
    for (const symbol of Object.getOwnPropertySymbols(real)) (forged as Record<symbol, unknown>)[symbol] = (real as unknown as Record<symbol, unknown>)[symbol]
    await assert.rejects(kernel.plugin(forged as never), /T2 plugins run out of process/)
  })

  it('refuses a manifest that uses a service it provides', () => {
    assert.throws(
      () => parseManifest({ id: 'x.self', engines: { guanxi: '^0.1.0' }, trust: 'T0', provides: ['a'], uses: ['a'] }),
      ManifestError,
    )
  })

  it('stops delivering events to a plugin as soon as it starts to unload', async () => {
    const kernel = createKernel()
    const heard: string[] = []
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      on(ctx, 'ping', () => heard.push('ping'))
      effect(ctx, () => () => kernel.emit('ping'))
    }))
    kernel.emit('ping')
    await handle.dispose()
    assert.deepEqual(heard, ['ping'])
  })

  it('refuses to load into a disposed kernel', async () => {
    const kernel = createKernel()
    await kernel.dispose()
    await assert.rejects(kernel.plugin(testPlugin({}, () => {})), /disposed/)
  })
})

describe('own-kernel review: optional-service cycles', () => {
  it('settles when a plugin uses a service that its own dependent provides', async () => {
    const kernel = createKernel({ onLog: () => {} })
    let applies = 0
    await kernel.plugin(testPlugin({ id: 'x.a', provides: ['a'], uses: ['b'] }, (ctx) => {
      applies += 1
      provide(ctx, 'a', 1)
      optionalService(ctx, 'b')
    }))
    await kernel.plugin(testPlugin({ id: 'x.b', provides: ['b'], requires: ['a'] }, (ctx) => {
      applies += 1
      provide(ctx, 'b', 2)
    }))
    assert.ok(applies < 10, `${applies} applies`)
    await kernel.dispose()
  })

  it('settles when a parent uses a service its own child provides', async () => {
    const kernel = createKernel({ onLog: () => {} })
    let applies = 0
    const child = testPlugin({ id: 'x.child', provides: ['c'] }, (ctx) => provide(ctx, 'c', 1))
    await kernel.plugin(testPlugin({ id: 'x.parent', uses: ['c'] }, (ctx) => {
      applies += 1
      ctx.plugin(child)
    }))
    assert.ok(applies < 10, `${applies} applies`)
    await kernel.dispose()
  })
})

describe('own-kernel review: children', () => {
  it('lets a parent cleanup dispose its child without a deadlock', async () => {
    const kernel = createKernel({ stepTimeoutMs: 200 })
    const child = testPlugin({ id: 'x.owned' }, () => {})
    const handle = await kernel.plugin(testPlugin({ id: 'x.owner' }, (ctx) => {
      const owned = ctx.plugin(child)
      effect(ctx, () => () => owned.dispose())
    }))
    const started = Date.now()
    await handle.dispose()
    assert.ok(Date.now() - started < 150, 'no step timeout')
  })

  it('rejects ready() for a child that failed', async () => {
    const kernel = createKernel({ onLog: () => {} })
    let failing: ReturnType<PluginContext['plugin']> | undefined
    await kernel.plugin(testPlugin({ id: 'x.failing-parent' }, (ctx) => {
      failing = ctx.plugin(testPlugin({ id: 'x.failing-child' }, () => {
        throw new Error('child broke')
      }))
    }))
    assert.equal(failing!.state, 'failed')
    await assert.rejects(failing!.ready(), /child broke/)
  })
})

describe('own-kernel review: node profiles', () => {
  const plain = (id: string, manifest: Record<string, unknown> = {}, apply: (ctx: PluginContext) => void = () => {}) =>
    testPlugin({ id, ...manifest }, apply)

  it('refuses a change that would restart a pinned row through its dependencies', async () => {
    const node = await bootNode({
      plugins: [
        plain('x.store', { provides: ['store'] }, (ctx) => provide(ctx, 'store', 1)),
        plain('x.held', { requires: ['store'], uses: ['extra'] }),
        plain('x.extra', { provides: ['extra'] }, (ctx) => provide(ctx, 'extra', 1)),
      ],
      profile: [{ name: 'p', insert: [{ id: 'store', plugin: 'x.store' }, { id: 'held', plugin: 'x.held' }] }],
      pinned: ['held'],
    })
    const base: ProfileLayer = { name: 'p', insert: [{ id: 'store', plugin: 'x.store' }, { id: 'held', plugin: 'x.held' }] }
    await assert.rejects(node.apply([base, { name: 'u', patch: [{ id: 'store', config: { v: 2 } }] }]), /row "held" is pinned/)
    await assert.rejects(node.apply([base, { name: 'u', insert: [{ id: 'extra', plugin: 'x.extra' }] }]), /row "held" is pinned/)
    assert.equal(node.stateOf('held'), 'active')
    await node.dispose()
  })

  it('retries a failed row on the next apply', async () => {
    let broken = true
    const flaky = plain('x.flaky', {}, () => {
      if (broken) throw new Error('not yet')
    })
    const profile: ProfileLayer[] = [{ name: 'p', insert: [{ id: 'f', plugin: 'x.flaky' }] }]
    const node = await bootNode({ plugins: [plain('x.other')], profile: [], onLog: () => {} })
    await node.dispose()
    const second = await bootNode({ plugins: [flaky], profile: [], onLog: () => {} })
    await assert.rejects(second.apply(profile), /f: failed/)
    broken = false
    await second.apply(profile)
    assert.equal(second.stateOf('f'), 'active')
    await second.dispose()
  })

  it('refuses rows that require each other in a cycle', async () => {
    await assert.rejects(
      bootNode({
        plugins: [
          plain('x.left', { provides: ['l'], requires: ['r'] }, (ctx) => provide(ctx, 'l', 1)),
          plain('x.right', { provides: ['r'], requires: ['l'] }, (ctx) => provide(ctx, 'r', 1)),
        ],
        profile: [{ name: 'p', insert: [{ id: 'left', plugin: 'x.left' }, { id: 'right', plugin: 'x.right' }] }],
      }),
      /cycle: left → right → left/,
    )
  })

  it('boots safe mode from the base layer even when a user layer is broken', async () => {
    const strict = plain('x.strict', {}, (ctx) => {
      if ((ctx as unknown as { config?: unknown }).config) throw new Error('bad config')
    })
    const configured = definePlugin<{ crash?: boolean } | undefined>({
      manifest: { id: 'x.configured', engines: { guanxi: '^0.1.0' }, trust: 'T0' },
      apply(_ctx, config) {
        if (config?.crash) throw new Error('user config broke it')
      },
    })
    const node = await bootNode({
      plugins: [strict, configured],
      safeMode: true,
      profile: [
        { name: 'base', insert: [{ id: 'configured', plugin: 'x.configured' }] },
        { name: 'user', insert: [{ id: 'ghost', plugin: 'x.unknown' }], patch: [{ id: 'configured', config: { crash: true } }] },
      ],
    })
    assert.equal(node.stateOf('configured'), 'active')
    assert.deepEqual(node.entries().map((entry) => entry.id), ['configured'])
    await node.dispose()
  })
})
