/**
 * Regression tests for the lifecycle race classes found in upstream Cordis
 * 4.0.0-rc.11 during the K1 spike (cordiverse/cordis #96, #176, #185, #91,
 * #194, #218, #127). The own kernel is designed so they cannot occur; each test
 * reproduces the upstream scenario against it.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KernelLifecycleError,
  KernelTimeoutError,
  createKernel,
  effect,
  interval,
  on,
  provide,
  type PluginContext,
} from '../src/index.ts'
import { bootNode, processResources } from '../src/node.ts'
import { deferred, settle, testPlugin, tick } from './helpers.ts'

describe('registrations outside a live activation (#96, #176, #91, #127)', () => {
  it('refuses effects, listeners and child plugins registered while a plugin unloads', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const before = kernel.counters()
    const attempts: string[] = []
    const child = testPlugin({}, () => {})
    const provider = testPlugin({ provides: ['dep'] }, (ctx) => provide(ctx, 'dep', {}))
    const consumer = testPlugin({ requires: ['dep'] }, (ctx) => {
      effect(ctx, () => () => {
        for (const [label, register] of [
          ['effect', () => effect(ctx, () => () => {})],
          ['listener', () => on(ctx, 'late', () => {})],
          ['plugin', () => ctx.plugin(child)],
        ] as const) {
          try {
            register()
            attempts.push(`${label}: accepted`)
          } catch (error) {
            attempts.push(`${label}: ${error instanceof KernelLifecycleError ? 'refused' : String(error)}`)
          }
        }
      })
    })
    const providerHandle = await kernel.plugin(provider)
    const consumerHandle = await kernel.plugin(consumer)
    await providerHandle.dispose()
    assert.equal(consumerHandle.state, 'pending')
    assert.deepEqual(attempts, ['effect: refused', 'listener: refused', 'plugin: refused'])
    await consumerHandle.dispose()
    assert.equal(consumerHandle.state, 'disposed')
    assert.deepEqual(kernel.counters(), before)
  })

  it('disposes a plugin that never activated without leaving anything behind', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    const handle = await kernel.plugin(testPlugin({ requires: ['never-provided'] }, () => {}))
    assert.equal(handle.state, 'pending')
    await handle.dispose()
    assert.equal(handle.state, 'disposed')
    assert.deepEqual(kernel.counters(), before)
  })

  it('refuses timers and listeners from a continuation of a failed apply', async () => {
    const kernel = createKernel({ onLog: () => {} })
    const timers = processResources().timers
    const before = kernel.counters()
    const later = deferred()
    const outcome = deferred<string>()
    await assert.rejects(kernel.plugin(testPlugin({}, async (ctx) => {
      void later.promise.then(() => {
        try {
          interval(ctx, () => {}, 60_000)
          on(ctx, 'late', () => {})
          outcome.resolve('accepted')
        } catch (error) {
          outcome.resolve(error instanceof KernelLifecycleError ? 'refused' : String(error))
        }
      })
      throw new Error('apply failed')
    })), /apply failed/)
    later.resolve()
    assert.equal(await outcome.promise, 'refused')
    assert.equal(processResources().timers, timers)
    assert.deepEqual(kernel.counters(), before)
  })

  it('aborts a running async apply on dispose, refuses its later registrations, and reverts the earlier ones', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    let cleaned = 0
    let late = ''
    let child = ''
    const gate = deferred()
    const entered = deferred<PluginContext>()
    const loading = kernel.plugin(testPlugin({}, async (ctx) => {
      on(ctx, 'early', () => {})
      effect(ctx, () => () => cleaned++)
      entered.resolve(ctx)
      await gate.promise
      try {
        on(ctx, 'late', () => {})
      } catch (error) {
        late = error instanceof KernelLifecycleError ? 'refused' : String(error)
      }
      try {
        ctx.plugin(testPlugin({}, () => {}))
      } catch (error) {
        child = error instanceof KernelLifecycleError ? 'refused' : String(error)
      }
    }))
    const ctx = await entered.promise
    // The host asks to unload while apply is still running.
    const disposing = kernel.dispose()
    assert.equal(ctx.signal.aborted, true, 'the plugin can see the unload at once')
    gate.resolve()
    await loading.catch(() => undefined)
    await disposing
    assert.equal(cleaned, 1)
    assert.equal(late, 'refused')
    assert.equal(child, 'refused')
    assert.deepEqual(kernel.counters(), before)
  })

  it('refuses a stale context after the plugin restarted', async () => {
    const kernel = createKernel()
    const contexts: PluginContext[] = []
    await kernel.plugin(testPlugin({ uses: ['extra'] }, (ctx) => {
      contexts.push(ctx)
    }))
    await kernel.plugin(testPlugin({ provides: ['extra'] }, (ctx) => provide(ctx, 'extra', 1)))
    assert.equal(contexts.length, 2, 'the plugin restarted when its optional service appeared')
    assert.throws(() => contexts[0]!.on('stale', () => {}), KernelLifecycleError)
    assert.doesNotThrow(() => contexts[1]!.on('fresh', () => {}))
  })
})

describe('ordering and isolation (#185)', () => {
  it('unloads dependents before their provider and keeps going when a cleanup or listener throws', async () => {
    const logs: string[] = []
    const kernel = createKernel({ onLog: (record) => logs.push(record.message) })
    const order: string[] = []
    const provider = await kernel.plugin(testPlugin({ provides: ['dep'] }, (ctx) => {
      provide(ctx, 'dep', 1)
      effect(ctx, () => () => order.push('provider cleanup'), 'provider')
    }))
    await kernel.plugin(testPlugin({ requires: ['dep'] }, (ctx) => {
      on(ctx, 'ping', () => {
        throw new Error('listener boom')
      })
      on(ctx, 'ping', () => order.push('second listener ran'))
      effect(ctx, () => () => order.push('consumer cleanup 1'), 'one')
      effect(ctx, () => () => {
        throw new Error('cleanup boom')
      }, 'two')
    }))
    kernel.emit('ping')
    await provider.dispose()
    assert.deepEqual(order, ['second listener ran', 'consumer cleanup 1', 'provider cleanup'])
    assert.ok(logs.some((line) => /listener boom/.test(line)))
    assert.ok(logs.some((line) => /cleanup "two" failed: .*cleanup boom/s.test(line)))
  })

  it('converges to exactly one instance after 100 unawaited unload/load pairs', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    let live = 0
    const plugin = testPlugin({}, async (ctx) => {
      live += 1
      on(ctx, 'tick', () => {})
      effect(ctx, () => () => {
        live -= 1
      })
      await tick()
    })
    let handle = kernel.plugin(plugin)
    for (let index = 0; index < 100; index += 1) {
      const previous = handle
      void previous.then((loaded) => loaded.dispose())
      handle = kernel.plugin(plugin)
    }
    const last = await handle
    await settle(5)
    assert.equal(live, 1)
    assert.equal(kernel.counters().fibers, before.fibers + 1)
    assert.equal(kernel.counters().listeners, before.listeners + 1)
    await last.dispose()
    assert.equal(live, 0)
    assert.deepEqual(kernel.counters(), before)
  })
})

describe('config updates and rebinds through profiles (#194, #218)', () => {
  it('applies concurrent config changes in order and ends on the last one', async () => {
    const seen: number[] = []
    const plugin = testPlugin<{ value: number }>({ id: 'fixture.configured' }, async (ctx, config) => {
      await tick(config.value === 1 ? 10 : 0)
      seen.push(config.value)
      effect(ctx, () => () => seen.push(-config.value))
    })
    const layer = (value: number) => [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.configured', config: { value } }] }]
    const node = await bootNode({ plugins: [plugin], profile: layer(0) })
    await Promise.all([node.apply(layer(1)), node.apply(layer(2))])
    assert.deepEqual(seen, [0, -0, 1, -1, 2])
    assert.equal(node.stateOf('row'), 'active')
    await node.dispose()
  })

  it('rebinds a row to another plugin', async () => {
    const calls: string[] = []
    const first = testPlugin({ id: 'fixture.first' }, (ctx) => {
      calls.push('first up')
      effect(ctx, () => () => calls.push('first down'))
    })
    const second = testPlugin({ id: 'fixture.second' }, () => {
      calls.push('second up')
    })
    const node = await bootNode({ plugins: [first, second], profile: [{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.first' }] }] })
    await node.apply([{ name: 'p', insert: [{ id: 'row', plugin: 'fixture.second' }] }])
    assert.deepEqual(calls, ['first up', 'first down', 'second up'])
    await node.dispose()
  })
})

describe('bounded steps', () => {
  it('abandons a stuck cleanup, finishes the unload, reports it, and keeps the kernel usable', async () => {
    const kernel = createKernel({ stepTimeoutMs: 50, onLog: () => {} })
    const before = kernel.counters()
    const handle = await kernel.plugin(testPlugin({ id: 'test.hung-cleanup' }, (ctx) => {
      on(ctx, 'x', () => {})
      effect(ctx, () => () => new Promise(() => {}), 'slow-close')
    }))
    const started = Date.now()
    await assert.rejects(handle.dispose(), (error: unknown) => {
      return error instanceof KernelTimeoutError && /test\.hung-cleanup \(cleanup slow-close\)/.test(error.message)
    })
    assert.ok(Date.now() - started < 1_000)
    assert.equal(handle.state, 'disposed')
    assert.deepEqual(kernel.counters(), before, 'the rest of the teardown ran')
    const next = await kernel.plugin(testPlugin({}, () => {}))
    assert.equal(next.state, 'active', 'the kernel is not wedged')
    await kernel.dispose()
  })

  it('fails a stuck apply, leaves nothing behind, and refuses what the abandoned apply does later', async () => {
    const kernel = createKernel({ stepTimeoutMs: 50, onLog: () => {} })
    const before = kernel.counters()
    const timers = processResources().timers
    const release = deferred()
    let late = ''
    await assert.rejects(kernel.plugin(testPlugin({ id: 'test.slow-apply' }, async (ctx) => {
      interval(ctx, () => {}, 60_000)
      await release.promise
      try {
        interval(ctx, () => {}, 60_000)
      } catch (error) {
        late = error instanceof KernelLifecycleError ? 'refused' : String(error)
      }
    })), KernelTimeoutError)
    assert.deepEqual(kernel.counters(), before)
    assert.equal(processResources().timers, timers)
    release.resolve()
    await settle()
    assert.equal(late, 'refused')
    assert.deepEqual(kernel.counters(), before)
  })
})
