/**
 * Negative control for the K1 leak census: a plugin that bypasses the context
 * (raw timer, listener on the root, entry kept outside its fiber) must show up
 * in exactly the counters the reload gate compares.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKernel, declareSlot } from '../src/index.ts'
import { processResources } from '../src/node.ts'
import { testPlugin } from './helpers.ts'

describe('leak census', () => {
  it('detects timers and listeners a plugin leaks past its unload', async () => {
    const kernel = createKernel()
    const handles: NodeJS.Timeout[] = []
    const leaky = testPlugin({}, (ctx) => {
      handles.push(setInterval(() => {}, 60_000))
      ctx.root.on('fixture/leak', () => {})
    })
    const before = { kernel: kernel.counters(), process: processResources() }
    try {
      for (let cycle = 0; cycle < 10; cycle += 1) {
        const handle = await kernel.plugin(leaky)
        await handle.dispose()
      }
      const after = { kernel: kernel.counters(), process: processResources() }
      assert.equal(after.process.timers - before.process.timers, 10)
      assert.equal(after.process.handles - before.process.handles, 10)
      assert.equal(after.kernel.listeners - before.kernel.listeners, 10)
      assert.notDeepEqual(after, before)
    } finally {
      for (const handle of handles) clearInterval(handle)
    }
  })

  it('counts slot entries that outlive their slot as orphans', async () => {
    const kernel = createKernel()
    const owner = await kernel.plugin(testPlugin({ contributes: { slotDeclarations: ['probe.slot'] } }, (ctx) => {
      declareSlot(ctx, 'probe.slot')
    }))
    // A contributor that bypasses the manifest-derived injection: Cordis does
    // not know it depends on the slot, so the slot can vanish first.
    const sneaky = await kernel.plugin(testPlugin({}, (ctx) => {
      ctx.effect(() => {
        const slots = kernel.slots as unknown as { entries: Map<string, Map<string, unknown>> }
        slots.entries.set('probe.slot', new Map([['sneaky/x', {}]]))
        return () => {}
      })
    }))
    assert.equal(kernel.counters().slotEntries, 1)
    await owner.dispose()
    assert.equal(kernel.counters().slotOrphans, 1)
    await sneaky.dispose()
  })
})
