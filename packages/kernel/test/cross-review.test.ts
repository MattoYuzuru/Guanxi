/**
 * Regression tests for the GPT/Codex cross-family review of K1 at 2f28508
 * (REVIEW-GPT.md). Each reproduces the reviewer's scenario and fails on the
 * code before its fix.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'
import {
  KernelLifecycleError,
  KernelTimeoutError,
  ManifestError,
  createKernel,
  declareSlot,
  definePlugin,
  effect,
  on,
  parseManifest,
  provide,
  type GuanxiPlugin,
  type PluginContext,
} from '../src/index.ts'
import { bootNode, processResources } from '../src/node.ts'
import { deferred, settle, testPlugin, tick } from './helpers.ts'

const run = promisify(execFile)

describe('H1: a disposed node stays closed', () => {
  it('refuses apply() after dispose, and an apply queued behind dispose', { timeout: 5_000 }, async () => {
    const known = testPlugin({ id: 'x.known' }, (ctx) => on(ctx, 'x', () => {}))
    const row = [{ name: 'p', insert: [{ id: 'k', plugin: 'x.known' }] }]
    const node = await bootNode({ plugins: [known], profile: [] })
    await node.dispose()
    await assert.rejects(node.apply(row), /disposed/)
    assert.equal(node.counters().fibers, 0)
    assert.equal(node.counters().listeners, 0)

    const second = await bootNode({ plugins: [known], profile: [] })
    const disposing = second.dispose()
    const queued = second.apply(row)
    await disposing
    await assert.rejects(queued, /disposed/)
    assert.equal(second.counters().fibers, 0)
    await assert.rejects(second.replacePlugin(known), /disposed/)
  })
})

describe('H2: an early disposer in flight still blocks teardown', () => {
  it('waits for a started cleanup before the unload completes', { timeout: 5_000 }, async () => {
    const kernel = createKernel()
    const release = deferred()
    let cleaned = false
    let early: (() => Promise<void>) | undefined
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      early = effect(ctx, () => async () => {
        await release.promise
        cleaned = true
      }, 'socket')
    }))
    void early!()
    const unloading = handle.dispose()
    await tick(10)
    assert.equal(handle.state, 'unloading', 'teardown waits for the started cleanup')
    release.resolve()
    await unloading
    assert.equal(cleaned, true)
    assert.equal(kernel.counters().effects, 0)
  })

  it('bounds an early cleanup that never finishes and reports it', { timeout: 5_000 }, async () => {
    const kernel = createKernel({ stepTimeoutMs: 50, onLog: () => {} })
    let early: (() => Promise<void>) | undefined
    const handle = await kernel.plugin(testPlugin({ id: 'x.stuck-early' }, (ctx) => {
      early = effect(ctx, () => () => new Promise(() => {}), 'never')
    }))
    void early!()
    await assert.rejects(handle.dispose(), (error: unknown) => error instanceof KernelTimeoutError && /x\.stuck-early \(cleanup never\)/.test(error.message))
    assert.equal(handle.state, 'disposed')
  })
})

describe('H3: a throwing slot subscriber cannot poison ownership', () => {
  it('keeps notifying other subscribers and lets a failed load leave no declaration', { timeout: 5_000 }, async () => {
    const logs: string[] = []
    const kernel = createKernel({ onLog: (record) => logs.push(record.message) })
    const stop = kernel.slots.subscribe(() => {
      throw new Error('observer broke')
    })
    let heard = 0
    kernel.slots.subscribe(() => heard++)
    const owner = () => testPlugin({ id: 'x.slot-owner', contributes: { slotDeclarations: ['probe.slot'] } }, (ctx) => {
      declareSlot(ctx, 'probe.slot')
    })
    const first = await kernel.plugin(owner())
    assert.ok(heard > 0, 'the next subscriber still heard the change')
    assert.ok(logs.some((line) => /observer broke/.test(line)))
    assert.equal(kernel.slots.isDeclared('probe.slot'), true)
    await first.dispose()
    assert.equal(kernel.slots.isDeclared('probe.slot'), false)
    stop()
    const retry = await kernel.plugin(owner())
    assert.equal(retry.state, 'active', 'retry is not refused as "already declared"')
    await kernel.dispose()
    assert.equal(kernel.slots.isDeclared('probe.slot'), false)
  })
})

describe('H4: a rejected load leaves nothing behind', () => {
  it('rolls back a provider whose load timed out a dependent it woke', { timeout: 5_000 }, async () => {
    const kernel = createKernel({ stepTimeoutMs: 25, onLog: () => {} })
    const consumer = await kernel.plugin(testPlugin({ id: 'x.stuck-consumer', requires: ['dep'] }, () => new Promise(() => {})))
    assert.equal(consumer.state, 'pending')
    const provider = testPlugin({ id: 'x.provider', provides: ['dep'] }, (ctx) => provide(ctx, 'dep', 1))
    await assert.rejects(kernel.plugin(provider), KernelTimeoutError)
    assert.equal(kernel.service('dep'), undefined, 'the rejected load left no service')
    assert.equal(kernel.counters().fibers, 1, 'only the (failed) consumer remains')
    await consumer.dispose()
    const retry = await kernel.plugin(testPlugin({ id: 'x.provider-2', provides: ['dep'] }, (ctx) => provide(ctx, 'dep', 2)))
    assert.equal(retry.state, 'active')
  })
})

describe('H5: async listener rejections stay isolated', () => {
  it('logs the rejection and keeps the process alive (child process)', { timeout: 20_000 }, async () => {
    const script = fileURLToPath(new URL('./fixtures/async-listener-rejection.ts', import.meta.url))
    const { stdout } = await run(process.execPath, [script], { timeout: 15_000 })
    assert.deepEqual(JSON.parse(stdout), { heard: ['second'], logged: true })
  })
})

describe('M1: child loads run the same validation as root loads', () => {
  it('refuses raw, malformed, incompatible and T2 children', { timeout: 5_000 }, async () => {
    const real = definePlugin({ manifest: { id: 'x.real-child', engines: { guanxi: '^0.1.0' }, trust: 'T0' }, apply() {} })
    const brand = Object.getOwnPropertySymbols(real)[0]!
    const branded = (manifest: unknown) => ({ [brand]: '0.1.0', name: 'x', manifest, apply() { ran.push('ran') } })
    const ran: string[] = []
    const children: Array<[string, unknown, RegExp]> = [
      ['raw', { name: 'x.raw', manifest: real.manifest, apply() { ran.push('raw') } }, /only plugins built by definePlugin/],
      ['malformed', branded({ id: 'Bad' }), /manifest\.id/],
      ['incompatible', branded({ id: 'x.newer', engines: { guanxi: '^9.0.0' }, trust: 'T0' }), /does not accept kernel/],
      ['T2', branded({ id: 'x.untrusted', engines: { guanxi: '^0.1.0' }, trust: 'T2' }), /T2 plugins run out of process/],
    ]
    const kernel = createKernel()
    const outcomes: string[] = []
    await kernel.plugin(testPlugin({}, (ctx) => {
      for (const [label, child, pattern] of children) {
        try {
          ctx.plugin(child as GuanxiPlugin)
          outcomes.push(`${label}: accepted`)
        } catch (error) {
          outcomes.push(`${label}: ${pattern.test((error as Error).message) ? 'refused' : (error as Error).message}`)
        }
      }
    }))
    await settle()
    assert.deepEqual(outcomes, ['raw: refused', 'malformed: refused', 'incompatible: refused', 'T2: refused'])
    assert.deepEqual(ran, [])
  })
})

describe('M2: the slot registry is not a plugin service', () => {
  it('refuses requires/uses of the reserved slots service', () => {
    for (const field of ['requires', 'uses', 'provides']) {
      assert.throws(
        () => parseManifest({ id: 'x.grab', engines: { guanxi: '^0.1.0' }, trust: 'T0', [field]: ['slots'] }),
        (error: unknown) => error instanceof ManifestError && /reserved for the kernel/.test(error.message),
      )
    }
  })
})

describe('M3: an unload request silences the activation at once', () => {
  it('delivers no event after dispose() is requested, even behind another transition', { timeout: 5_000 }, async () => {
    const kernel = createKernel()
    const heard: string[] = []
    let saved: PluginContext | undefined
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      saved = ctx
      on(ctx, 'ping', () => heard.push('ping'))
    }))
    const gate = deferred()
    const busy = kernel.plugin(testPlugin({}, async () => {
      await gate.promise
    }))
    const closing = handle.dispose()
    kernel.emit('ping')
    assert.throws(() => saved!.emit('ping'), KernelLifecycleError)
    gate.resolve()
    await busy
    await closing
    assert.deepEqual(heard, [])
  })
})

describe('M4: a cleanup returned by an abandoned apply still runs', () => {
  it('clears the late resource once the abandoned apply returns its cleanup', { timeout: 5_000 }, async () => {
    const kernel = createKernel({ stepTimeoutMs: 25, onLog: () => {} })
    const timers = processResources().timers
    const release = deferred()
    let cleaned = 0
    await assert.rejects(kernel.plugin(testPlugin({}, async () => {
      const handle = setInterval(() => {}, 60_000)
      await release.promise
      return () => {
        clearInterval(handle)
        cleaned += 1
      }
    })), KernelTimeoutError)
    assert.equal(processResources().timers, timers + 1, 'the abandoned apply still holds its timer')
    release.resolve()
    await settle()
    assert.equal(cleaned, 1)
    assert.equal(processResources().timers, timers)
  })
})

describe('M7: entries() is a detached snapshot', () => {
  it('cannot corrupt the reconciliation baseline', { timeout: 5_000 }, async () => {
    const running: number[] = []
    const plugin = testPlugin<{ value: number }>({ id: 'x.valued' }, (_ctx, config) => {
      running.push(config.value)
    })
    const layer = (value: number) => [{ name: 'p', insert: [{ id: 'row', plugin: 'x.valued', config: { value } }] }]
    const node = await bootNode({ plugins: [plugin], profile: layer(1) })
    const snapshot = node.entries() as unknown as Array<{ config: { value: number } }>
    snapshot[0]!.config.value = 2
    ;(snapshot as unknown[]).length = 0
    await node.apply(layer(2))
    assert.deepEqual(running, [1, 2], 'the change was detected and applied')
    assert.deepEqual(node.entries().map((entry) => entry.config), [{ value: 2 }])
    await node.dispose()
  })
})

describe('L1: cleanups run in exact reverse order', () => {
  it('reverts three async effects last-in first-out, each completing before the next', { timeout: 5_000 }, async () => {
    const kernel = createKernel()
    const order: string[] = []
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      for (const name of ['first', 'second', 'third']) {
        effect(ctx, () => async () => {
          order.push(`${name} start`)
          await tick(name === 'third' ? 5 : 1)
          order.push(`${name} end`)
        }, name)
      }
    }))
    await handle.dispose()
    assert.deepEqual(order, ['third start', 'third end', 'second start', 'second end', 'first start', 'first end'])
  })
})

describe('L2: host objects expose methods only', () => {
  it('returns facades without internal fields', { timeout: 5_000 }, async () => {
    const kernel = createKernel()
    assert.deepEqual(Object.keys(kernel).sort(), ['counters', 'dispose', 'emit', 'plugin', 'service', 'slots'])
    assert.ok(Object.isFrozen(kernel))
    const node = await bootNode({ plugins: [], profile: [] })
    assert.deepEqual(
      Object.keys(node).sort(),
      ['apply', 'counters', 'dispose', 'emit', 'entries', 'plugin', 'replacePlugin', 'service', 'slots', 'stateOf'],
    )
    await node.dispose()
  })
})

describe('Re-review R1: rollback re-settles the surviving plugins', () => {
  it('brings an optional consumer and its downstream dependent back after a provider load is rolled back', { timeout: 5_000 }, async () => {
    const kernel = createKernel({ stepTimeoutMs: 20, onLog: () => {} })
    const heard: string[] = []
    const optional = await kernel.plugin(testPlugin({ id: 'x.optional', uses: ['dep'], provides: ['feature'] }, (ctx) => {
      provide(ctx, 'feature', ctx.optionalService('dep') ?? 'without dep')
      on(ctx, 'ping', () => heard.push('ping'))
    }))
    const downstream = await kernel.plugin(testPlugin({ id: 'x.downstream', requires: ['feature'] }, () => {}))
    await kernel.plugin(testPlugin({ id: 'x.stuck', requires: ['dep'] }, () => new Promise(() => {})))
    await assert.rejects(
      kernel.plugin(testPlugin({ id: 'x.dep-provider', provides: ['dep'] }, (ctx) => provide(ctx, 'dep', 1))),
      KernelTimeoutError,
    )
    assert.equal(kernel.service('dep'), undefined)
    assert.equal(optional.state, 'active', 'the optional consumer runs again without dep')
    assert.equal(kernel.service('feature'), 'without dep')
    assert.equal(downstream.state, 'active', 'its dependent is back too')
    kernel.emit('ping')
    assert.deepEqual(heard, ['ping'])
  })
})
