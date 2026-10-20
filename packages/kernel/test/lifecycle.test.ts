/**
 * Lifecycle races known in upstream Cordis 4.0.0-rc.11 and how the kernel's
 * guard contains them. See upstream-canary.test.ts for the unguarded behaviour.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIBER_STATE, createKernel, effect, on, provide, type Context } from '../src/index.ts'
import { deferred, settle, testPlugin, tick } from './helpers.ts'

describe('kernel lifecycle guard', () => {
  it('rejects effects, listeners and child plugins registered while a fiber unloads', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const before = kernel.counters()
    const attempts: string[] = []
    const provider = testPlugin({ provides: ['dep'] }, (ctx) => provide(ctx, 'dep', {}))
    const consumer = testPlugin({ requires: ['dep'] }, (ctx) => {
      effect(ctx, () => () => {
        for (const [label, register] of [
          ['effect', () => effect(ctx, () => () => {})],
          ['listener', () => on(ctx, 'late', () => {})],
          ['plugin', () => ctx.plugin(testPlugin({}, () => {}))],
        ] as const) {
          try {
            register()
            attempts.push(`${label}: accepted`)
          } catch (error) {
            attempts.push(`${label}: ${(error as Error).message}`)
          }
        }
      })
    })
    const providerHandle = await kernel.plugin(provider)
    const consumerHandle = await kernel.plugin(consumer)
    await providerHandle.dispose()
    assert.equal(consumerHandle.fiber.state, FIBER_STATE.pending)
    assert.deepEqual(attempts.map((line) => line.replace(/plugin ".*"/, 'plugin X')), [
      'effect: cannot create effect on unloading plugin X',
      'listener: cannot create effect on unloading plugin X',
      'plugin: cannot create effect on unloading plugin X',
    ])
    await consumerHandle.dispose()
    assert.deepEqual(kernel.counters(), before)
  })

  it('rejects effects on a plugin that never activated, so disposing it leaks nothing', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    const handle = await kernel.plugin(testPlugin({ requires: ['never-provided'] }, () => {}))
    assert.equal(handle.fiber.state, FIBER_STATE.pending)
    assert.throws(() => on(handle.fiber.ctx, 'observer', () => {}), /pending plugin/)
    await handle.dispose()
    assert.deepEqual(kernel.counters(), before)
  })

  it('drains a plugin disposed during its async apply; later registrations fail loudly', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const before = kernel.counters()
    let cleaned = 0
    let late = ''
    const gate = deferred()
    const resumed = deferred()
    const fiber = kernel.root.plugin(testPlugin({}, async (ctx: Context) => {
      on(ctx, 'early', () => {})
      effect(ctx, () => () => cleaned++)
      await gate.promise
      try {
        on(ctx, 'late', () => {})
      } catch (error) {
        late = (error as Error).message
      }
      resumed.resolve()
    }))
    await tick()
    await fiber.dispose()
    gate.resolve()
    await resumed.promise
    await settle()
    assert.equal(cleaned, 1)
    assert.match(late, /inactive context/)
    assert.deepEqual(kernel.counters(), before)
  })

  it('converges to exactly one instance after 100 unawaited dispose/reload pairs', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    let live = 0
    const plugin = testPlugin({}, async (ctx: Context) => {
      live += 1
      on(ctx, 'tick', () => {})
      effect(ctx, () => () => {
        live -= 1
      })
      await tick()
    })
    let fiber = kernel.root.plugin(plugin)
    for (let index = 0; index < 100; index += 1) {
      void fiber.dispose()
      fiber = kernel.root.plugin(plugin)
    }
    await fiber
    await settle(5)
    assert.equal(live, 1)
    assert.equal(kernel.counters().fibers, before.fibers + 1)
    assert.equal(kernel.counters().listeners, before.listeners + 1)
    await fiber.dispose()
    assert.equal(live, 0)
    assert.deepEqual(kernel.counters(), before)
  })
})
