/**
 * Child-process fixture for the cross-family re-review R4: the
 * optional-service cycle scenarios. A regression in the settle bound loops in
 * microtasks, which starves in-process test timers, so the parent test runs
 * this script with a hard timeout instead. Prints the apply counts.
 */
import { createKernel, definePlugin, optionalService, provide } from '../../src/index.ts'

const engines = { guanxi: '^0.1.0' }
const counts: Record<string, number> = {}

{
  const kernel = createKernel({ onLog: () => {} })
  let applies = 0
  await kernel.plugin(definePlugin({
    manifest: { id: 'x.a', engines, trust: 'T0', provides: ['a'], uses: ['b'] },
    apply(ctx) {
      applies += 1
      provide(ctx, 'a', 1)
      optionalService(ctx, 'b')
    },
  }))
  await kernel.plugin(definePlugin({
    manifest: { id: 'x.b', engines, trust: 'T0', provides: ['b'], requires: ['a'] },
    apply(ctx) {
      applies += 1
      provide(ctx, 'b', 2)
    },
  }))
  await kernel.dispose()
  counts['dependentCycle'] = applies
}

{
  const kernel = createKernel({ onLog: () => {} })
  let applies = 0
  const child = definePlugin({
    manifest: { id: 'x.child', engines, trust: 'T0', provides: ['c'] },
    apply(ctx) {
      provide(ctx, 'c', 1)
    },
  })
  await kernel.plugin(definePlugin({
    manifest: { id: 'x.parent', engines, trust: 'T0', uses: ['c'] },
    apply(ctx) {
      applies += 1
      ctx.plugin(child)
    },
  }))
  await kernel.dispose()
  counts['childCycle'] = applies
}

process.stdout.write(JSON.stringify(counts))
