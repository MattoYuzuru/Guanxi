/**
 * The legacy Resource Governor as a kernel plugin (K1 strangler step).
 *
 * The governor itself is unchanged. The plugin only owns its lifetime: it
 * provides the instance as the `governor` service and closes it on unload,
 * exactly as application shutdown does (queued tickets are rejected, the active
 * owner is asked to abort, unload completes when the active lease is released).
 */
import { definePlugin, effect, provide } from '@guanxi/kernel'
import { ResourceGovernor, type ResourceGovernorOptions } from './resource-governor.ts'

export const RESOURCE_GOVERNOR_SERVICE = 'governor'

export const resourceGovernorPlugin = definePlugin<ResourceGovernorOptions | undefined>({
  manifest: {
    id: 'guanxi.resource-governor',
    engines: { guanxi: '^0.1.0' },
    provides: [RESOURCE_GOVERNOR_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const governor = new ResourceGovernor(config ?? {})
    effect(ctx, () => () => governor.close(), 'governor.close()')
    provide(ctx, RESOURCE_GOVERNOR_SERVICE, governor)
  },
})
