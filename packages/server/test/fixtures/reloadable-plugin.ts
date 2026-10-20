/**
 * A plugin module the K1 reload test imports again for every cycle
 * (`?v=<n>`), the way source hot reload replaces code. Each import is a new
 * ES module record that Node never frees.
 */
import { contribute, definePlugin, interval, on, service } from '@guanxi/kernel'
import type { ResourceGovernor } from '../../src/runtime/resource-governor.ts'

export const loadedAt = new URL(import.meta.url).searchParams.get('v')

export const plugin = definePlugin({
  manifest: {
    id: 'fixture.reloadable',
    engines: { guanxi: '^0.1.0' },
    requires: ['governor'],
    contributes: { slots: ['sidebar.items'] },
    trust: 'T0',
  },
  apply(ctx) {
    ;(globalThis as { __k1Instances?: Array<WeakRef<object>> }).__k1Instances?.push(new WeakRef(ctx))
    const governor = service<ResourceGovernor>(ctx, 'governor')
    on(ctx, 'fixture/tick', () => governor.snapshot())
    interval(ctx, () => governor.snapshot(), 60_000)
    contribute(ctx, 'sidebar.items', { id: 'reloadable', value: { version: loadedAt } })
  },
})
