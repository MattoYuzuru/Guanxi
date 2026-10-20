/**
 * The egress scrubber as a kernel plugin (K2). It provides a frozen,
 * method-only `egress.scrubber` facade and closes the instance on unload, so a
 * consumer that kept a stale reference fails closed instead of scrubbing with
 * an empty registry.
 */
import { definePlugin, effect, provide } from '@guanxi/kernel'
import { SecretScrubber } from './scrubber.ts'
import { EGRESS_SCRUBBER_SERVICE } from './types.ts'

export const egressScrubberPlugin = definePlugin({
  manifest: {
    id: 'guanxi.egress-scrubber',
    engines: { guanxi: '^0.1.0' },
    provides: [EGRESS_SCRUBBER_SERVICE],
    trust: 'T0',
  },
  apply(ctx) {
    const scrubber = new SecretScrubber()
    effect(ctx, () => () => scrubber.close(), 'scrubber.close()')
    provide(ctx, EGRESS_SCRUBBER_SERVICE, scrubber.facade())
  },
})
