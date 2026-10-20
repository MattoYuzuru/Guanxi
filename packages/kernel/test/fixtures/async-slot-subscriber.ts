/**
 * Child-process fixture for the cross-family re-review R3: an async slot
 * subscriber that rejects must be reported, not become an unhandled
 * rejection, on ordinary publish and on hold release.
 */
import { createKernel, declareSlot, definePlugin } from '../../src/index.ts'

const logged: string[] = []
const kernel = createKernel({ onLog: (record) => logged.push(record.message) })
let heard = 0
kernel.slots.subscribe(async () => {
  throw new Error('async slot observer broke')
})
kernel.slots.subscribe(() => {
  heard += 1
})
const owner = definePlugin({
  manifest: { id: 'fixture.async-slot', engines: { guanxi: '^0.1.0' }, trust: 'T0', contributes: { slotDeclarations: ['probe.slot'] } },
  apply(ctx) {
    declareSlot(ctx, 'probe.slot')
  },
})
const handle = await kernel.plugin(owner)
const release = kernel.slots.hold()
await handle.dispose()
release()
await new Promise((resolve) => setTimeout(resolve, 20))
process.stdout.write(JSON.stringify({
  heard: heard >= 2,
  logged: logged.filter((line) => line.includes('async slot observer broke')).length,
}))
