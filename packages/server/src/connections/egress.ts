/** K2 seam: replace the temporary provider below with K2's service after merge. */
import { definePlugin } from '@guanxi/kernel'
export const EGRESS_SERVICE = 'egress.scrubber'
export interface EgressScrubber {
  register(ref: string, value: string): void
  unregister(ref: string): void
  scrub<T>(value: T): T
}

/** Temporary exact-match bridge, not K2's rule-based scrubber. Never logs input. */
export function createLocalScrubber(): EgressScrubber {
  const secrets = new Map<string, string>()
  const scrub = <T>(value: T): T => {
    const entries = [...secrets.values()].sort((a, b) => b.length - a.length)
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') {
        for (const secret of entries) item = (item as string).split(secret).join('[REDACTED]')
        return item
      }
      if (Array.isArray(item)) return item.map(visit)
      if (item && typeof item === 'object') return Object.fromEntries(
        Object.entries(item).map(([key, val]) => [visit(key), visit(val)]),
      )
      return item
    }
    return visit(value) as T
  }
  return {
    register(ref, value) { if (!value) throw new Error('Empty secret'); secrets.set(ref, value) },
    unregister(ref) { secrets.delete(ref) }, scrub,
  }
}
export const temporaryEgressPlugin = definePlugin({
  manifest: { id: 'guanxi.k3-temporary-egress', engines: { guanxi: '^0.1.0' }, provides: [EGRESS_SERVICE], trust: 'T0' },
  apply(ctx) { ctx.provide(EGRESS_SERVICE, createLocalScrubber()) },
})
