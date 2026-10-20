import { ConnectionError } from './errors.ts'
/** Temporary copy of K2's stable interface. Delete after K2 merges. */
import { definePlugin } from '@guanxi/kernel'
export const EGRESS_SERVICE = 'egress.scrubber'
/** K2's published bound; import it from egress/types.ts after integration. */
export const MIN_SECRET_LENGTH = 8
export type SecretRef = `secret://${string}`
export interface EgressScrubber {
  register(ref: SecretRef, value: string): void
  unregister(ref: SecretRef): boolean
  scrub<T>(value: T): T
}

/** K2's documented pre-merge stub: no unprotected data can leave the node. */
export const temporaryEgressPlugin = definePlugin({
  manifest: { id: 'guanxi.k3-temporary-egress', engines: { guanxi: '^0.1.0' }, provides: [EGRESS_SERVICE], trust: 'T0' },
  apply(ctx) {
    const stub: EgressScrubber = {
      register() {}, unregister() { return false },
      scrub() { throw new ConnectionError('egress_unavailable', 'egress.scrubber is not available before K2 merges') },
    }
    ctx.provide(EGRESS_SERVICE, stub)
  },
})
