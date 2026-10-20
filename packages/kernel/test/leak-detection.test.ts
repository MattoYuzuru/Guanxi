/**
 * Controls for the K1 leak census: the counters the reload gate compares move
 * when something is really registered or leaked.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKernel, declareSlot, effect, on } from '../src/index.ts'
import { processResources } from '../src/node.ts'
import { testPlugin } from './helpers.ts'

describe('leak census', () => {
  it('detects timers a plugin leaks past its unload', async () => {
    const kernel = createKernel()
    const handles: NodeJS.Timeout[] = []
    const leaky = testPlugin({}, () => {
      handles.push(setInterval(() => {}, 60_000))
    })
    const before = processResources()
    try {
      for (let cycle = 0; cycle < 10; cycle += 1) {
        const handle = await kernel.plugin(leaky)
        await handle.dispose()
      }
      const after = processResources()
      assert.equal(after.timers - before.timers, 10)
      assert.equal(after.handles - before.handles, 10)
    } finally {
      for (const handle of handles) clearInterval(handle)
    }
  })

  it('counts live listeners and effects, and returns to zero on unload', async () => {
    const kernel = createKernel()
    const before = kernel.counters()
    const handle = await kernel.plugin(testPlugin({}, (ctx) => {
      on(ctx, 'a', () => {})
      on(ctx, 'b', () => {})
      effect(ctx, () => () => {})
    }))
    const live = kernel.counters()
    assert.equal(live.listeners - before.listeners, 2)
    assert.equal(live.effects - before.effects, 3, 'two listeners and one effect')
    assert.equal(live.fibers - before.fibers, 1)
    await handle.dispose()
    assert.deepEqual(kernel.counters(), before)
  })

  it('counts slot entries that outlive their slot as orphans', async () => {
    const kernel = createKernel()
    const owner = await kernel.plugin(testPlugin({ contributes: { slotDeclarations: ['probe.slot'] } }, (ctx) => {
      declareSlot(ctx, 'probe.slot')
    }))
    // An entry planted behind the kernel's back: no contributor fiber owns it.
    const slots = kernel.slots as unknown as { entries: Map<string, Map<string, unknown>> }
    slots.entries.set('probe.slot', new Map([['sneaky/x', {}]]))
    assert.equal(kernel.counters().slotEntries, 1)
    await owner.dispose()
    assert.equal(kernel.counters().slotOrphans, 1)
  })
})

describe('retained lifecycle objects', () => {
  const collect = async () => {
    const { setFlagsFromString } = await import('node:v8')
    const { runInNewContext } = await import('node:vm')
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    for (let round = 0; round < 6; round += 1) {
      gc()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }

  it('lets disposed fibers and contexts be collected, and detects one that is retained', { timeout: 10_000 }, async () => {
    const { retainedObjects } = await import('../src/node.ts')
    const kernel = createKernel()
    const plugin = testPlugin({}, (ctx) => on(ctx, 'x', () => {}))
    for (let cycle = 0; cycle < 10; cycle += 1) await (await kernel.plugin(plugin)).dispose()
    await collect()
    assert.deepEqual(retainedObjects(kernel), { fibers: 0, contexts: 0 })

    const kept: unknown[] = []
    const retaining = testPlugin({}, (ctx) => {
      kept.push(ctx)
    })
    for (let cycle = 0; cycle < 10; cycle += 1) await (await kernel.plugin(retaining)).dispose()
    await collect()
    assert.deepEqual(retainedObjects(kernel), { fibers: 10, contexts: 10 }, 'a retained context keeps its fiber alive')
    kept.length = 0
  })
})
