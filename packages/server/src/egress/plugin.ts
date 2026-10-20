/**
 * The egress scrubber as a kernel plugin (K2). It provides a frozen,
 * method-only `egress.scrubber` facade and closes the instance on unload, so a
 * consumer that kept a stale reference fails closed instead of scrubbing with
 * an empty registry. Its config may declare `expectedSources`, which keep the
 * scrubber not ready from boot until each source has registered and called
 * `ready`.
 */
import { definePlugin, effect, provide } from '@guanxi/kernel'
import { SecretScrubber } from './scrubber.ts'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubberConfig } from './types.ts'

export const egressScrubberPlugin = definePlugin<EgressScrubberConfig | undefined>({
  manifest: {
    id: 'guanxi.egress-scrubber',
    engines: { guanxi: '^0.1.0' },
    provides: [EGRESS_SCRUBBER_SERVICE],
    trust: 'T0',
  },
  apply(ctx, config) {
    const scrubber = new SecretScrubber({ expectedSources: config?.expectedSources ?? [] })
    effect(ctx, () => () => scrubber.close(), 'scrubber.close()')
    provide(ctx, EGRESS_SCRUBBER_SERVICE, scrubber.facade())
  },
})
