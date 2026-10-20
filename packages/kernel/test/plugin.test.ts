import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PluginContractError,
  createKernel,
  effect,
  interval,
  on,
  optionalService,
  provide,
  service,
  timeout,
  type KernelLogRecord,
} from '../src/index.ts'
import { processResources } from '../src/node.ts'
import { settle, testPlugin, tick } from './helpers.ts'

describe('plugin contract', () => {
  it('fails a plugin that does not provide a declared service and reverts its effects', async () => {
    const logs: KernelLogRecord[] = []
    const kernel = createKernel({ onLog: (record) => logs.push(record) })
    const before = kernel.counters()
    const plugin = testPlugin({ provides: ['promised'] }, (ctx) => {
      on(ctx, 'fixture/event', () => {})
    })
    await assert.rejects(kernel.plugin(plugin), (error: unknown) => {
      return error instanceof PluginContractError && /did not provide promised/.test(error.message)
    })
    assert.deepEqual(kernel.counters(), before)
    assert.ok(logs.some((record) => record.level === 'error' && /did not provide promised/.test(record.message)))
  })

  it('refuses a service outside manifest.provides, late provides, and duplicate providers', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await assert.rejects(kernel.plugin(testPlugin({ provides: ['declared'] }, (ctx) => {
      provide(ctx, 'declared', 1)
      provide(ctx, 'other', 2)
    })), /"other" is not in manifest.provides/)
    assert.equal(kernel.service('declared'), undefined, 'the failed plugin left no service')

    let late = ''
    await kernel.plugin(testPlugin({ provides: ['early'] }, (ctx) => {
      provide(ctx, 'early', 1)
      queueMicrotask(() => {
        try {
          ctx.provide('early', 2)
        } catch (error) {
          late = (error as Error).message
        }
      })
    }))
    await settle()
    assert.match(late, /too late|already provided/)
    await assert.rejects(kernel.plugin(testPlugin({ provides: ['early'] }, (ctx) => provide(ctx, 'early', 3))), /already provided/)
  })

  it('lets a plugin read only the services its manifest names', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await kernel.plugin(testPlugin({ provides: ['clock'] }, (ctx) => provide(ctx, 'clock', 1)))
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => service(ctx, 'clock'))), /not in manifest.requires/)
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => optionalService(ctx, 'clock'))), /not in manifest.uses/)
    await kernel.plugin(testPlugin({ requires: ['clock'] }, (ctx) => assert.equal(service(ctx, 'clock'), 1)))
  })

  it('refuses to start a plugin whose engines range excludes the kernel', async () => {
    const kernel = createKernel({ onLog: () => {} })
    let applied = false
    const plugin = testPlugin({ engines: { guanxi: '^0.2.0' } }, () => {
      applied = true
    })
    await assert.rejects(kernel.plugin(plugin), /does not accept kernel 0\.1\.0/)
    assert.equal(applied, false)
  })

  it('waits for required services and unloads dependents before their provider', async () => {
    const kernel = createKernel()
    const order: string[] = []
    const provider = testPlugin({ provides: ['clock'] }, (ctx) => {
      provide(ctx, 'clock', { now: () => 1 })
      effect(ctx, () => () => order.push('provider down'))
    })
    const consumer = testPlugin({ requires: ['clock'], uses: ['missing'] }, (ctx) => {
      order.push(`consumer up ${service<{ now(): number }>(ctx, 'clock').now()}`)
      assert.equal(optionalService(ctx, 'missing'), undefined)
      effect(ctx, () => async () => {
        await tick()
        order.push('consumer down')
      })
    })
    const consumerHandle = await kernel.plugin(consumer)
    assert.equal(consumerHandle.state, 'pending', 'consumer waits without its service')
    const providerHandle = await kernel.plugin(provider)
    assert.equal(consumerHandle.state, 'active')
    await providerHandle.dispose()
    assert.deepEqual(order, ['consumer up 1', 'consumer down', 'provider down'])
    assert.equal(consumerHandle.state, 'pending')
    await kernel.plugin(provider)
    assert.equal(consumerHandle.state, 'active', 'consumer returns with its provider')
    await kernel.dispose()
    assert.equal(kernel.counters().fibers, 0)
  })

  it('restarts a plugin when an optional service appears or leaves', async () => {
    const kernel = createKernel()
    const seen: Array<number | undefined> = []
    await kernel.plugin(testPlugin({ uses: ['extra'] }, (ctx) => {
      seen.push(optionalService<number>(ctx, 'extra'))
    }))
    const provider = await kernel.plugin(testPlugin({ provides: ['extra'] }, (ctx) => provide(ctx, 'extra', 7)))
    await provider.dispose()
    assert.deepEqual(seen, [undefined, 7, undefined])
  })

  it('awaits an async apply, runs a returned cleanup, and rejects an async failure', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await kernel.plugin(testPlugin({ provides: ['late'] }, async (ctx) => {
      await tick(5)
      provide(ctx, 'late', 'ready')
    }))
    assert.equal(kernel.service('late'), 'ready')
    let cleaned = 0
    const handle = await kernel.plugin(testPlugin({}, () => () => {
      cleaned += 1
    }))
    await handle.dispose()
    assert.equal(cleaned, 1)
    await assert.rejects(kernel.plugin(testPlugin({}, async () => {
      await tick()
      throw new Error('late failure')
    })), /late failure/)
  })

  it('clears plugin-owned timers on unload', async () => {
    const kernel = createKernel()
    const before = processResources().timers
    let fired = 0
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      timeout(ctx, () => fired++, 60_000)
      interval(ctx, () => fired++, 60_000)
      const early = timeout(ctx, () => fired++, 60_000)
      void early()
    }))
    await settle(1)
    assert.equal(processResources().timers, before + 2)
    await handle.dispose()
    assert.equal(processResources().timers, before)
    assert.equal(fired, 0)
  })

  it('reports a plugin that throws during apply and leaves nothing behind', async () => {
    const logs: KernelLogRecord[] = []
    const kernel = createKernel({ onLog: (record) => logs.push(record) })
    const before = kernel.counters()
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => {
      on(ctx, 'fixture/event', () => {})
      throw new Error('boom in apply')
    })), /boom in apply/)
    assert.ok(logs.some((record) => /boom in apply/.test(record.message)))
    assert.deepEqual(kernel.counters(), before)
  })

  it('refuses objects that did not come from definePlugin', async () => {
    const kernel = createKernel()
    const forged = { name: 'x.forged', manifest: { trust: 'T2' }, apply() {} }
    await assert.rejects(kernel.plugin(forged as never), /only plugins built by definePlugin/)
  })

  it('reserves kernel/* events', async () => {
    const kernel = createKernel({ onLog: () => {} })
    await assert.rejects(kernel.plugin(testPlugin({}, (ctx) => on(ctx, 'kernel/anything', () => {}))), /reserved/)
  })
})
