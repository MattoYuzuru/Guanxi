import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PluginContractError,
  createKernel,
  effect,
  interval,
  isActive,
  on,
  optionalService,
  provide,
  service,
  timeout,
  type KernelLogRecord,
} from '../src/index.ts'
import { processResources } from '../src/node.ts'
import { settle, testPlugin } from './helpers.ts'

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
    assert.equal((kernel.root.logger as unknown as { buffer: unknown[] }).buffer.length, 0)
  })

  it('fails a plugin that provides an undeclared service', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const plugin = testPlugin({}, (ctx) => {
      ctx.provide('sneaky', {})
    })
    await assert.rejects(kernel.plugin(plugin), /provided undeclared sneaky/)
    assert.equal(kernel.root.get('sneaky'), undefined)
  })

  it('refuses provide() for a name outside manifest.provides', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const plugin = testPlugin({ provides: ['declared'] }, (ctx) => {
      provide(ctx, 'declared', 1)
      provide(ctx, 'other', 2)
    })
    await assert.rejects(kernel.plugin(plugin), /"other" is not in manifest.provides/)
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
        await settle(1)
        order.push('consumer down')
      })
    })
    const consumerHandle = await kernel.plugin(consumer)
    assert.equal(isActive(consumerHandle.fiber), false, 'consumer waits without its service')
    const providerHandle = await kernel.plugin(provider)
    await consumerHandle.fiber.await()
    assert.equal(isActive(consumerHandle.fiber), true)
    await providerHandle.dispose()
    assert.deepEqual(order, ['consumer up 1', 'consumer down', 'provider down'])
    assert.equal(isActive(consumerHandle.fiber), false)
    await kernel.plugin(provider)
    await consumerHandle.fiber.await()
    assert.equal(isActive(consumerHandle.fiber), true, 'consumer returns with its provider')
    await kernel.dispose()
    assert.equal(kernel.counters().fibers, 0)
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
    assert.equal(processResources().timers, before + 2)
    await handle.dispose()
    assert.equal(processResources().timers, before)
    assert.equal(fired, 0)
  })

  it('reports a plugin that throws during apply instead of hiding it', async () => {
    const logs: KernelLogRecord[] = []
    const kernel = createKernel({ onLog: (record) => logs.push(record) })
    const before = kernel.counters()
    const plugin = testPlugin({}, (ctx) => {
      on(ctx, 'fixture/event', () => {})
      throw new Error('boom in apply')
    })
    await assert.rejects(kernel.plugin(plugin), /boom in apply/)
    assert.ok(logs.some((record) => /boom in apply/.test(record.message)))
    assert.deepEqual(kernel.counters(), before)
  })
})
