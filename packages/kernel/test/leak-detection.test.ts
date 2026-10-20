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
