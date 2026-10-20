/**
 * Child-process fixture for the cross-family review H5: an async listener
 * that rejects must not become an unhandled rejection. Node's default mode
 * exits non-zero on one; this script exits 0 and prints what it observed.
 */
import { createKernel, definePlugin, on } from '../../src/index.ts'

const logged: string[] = []
const kernel = createKernel({ onLog: (record) => logged.push(record.message) })
const heard: string[] = []
await kernel.plugin(definePlugin({
  manifest: { id: 'fixture.async-listener', engines: { guanxi: '^0.1.0' }, trust: 'T0' },
  apply(ctx) {
    on(ctx, 'x', async () => {
      throw new Error('async listener broke')
    })
    on(ctx, 'x', () => heard.push('second'))
  },
}))
kernel.emit('x')
await new Promise((resolve) => setTimeout(resolve, 20))
await kernel.dispose()
process.stdout.write(JSON.stringify({ heard, logged: logged.some((line) => line.includes('async listener broke')) }))
