import { definePlugin } from '@guanxi/kernel'
import { EGRESS_SERVICE, type EgressScrubber } from '../../src/connections/egress.ts'

// Consumer integration fixture only; production fails closed until K2 merges.
function createLocalScrubber(): EgressScrubber {
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
    unregister(ref) { return secrets.delete(ref) }, scrub,
  }
}

export const fixtureEgressPlugin = definePlugin({
  manifest: { id: 'test.egress', engines: { guanxi: '^0.1.0' }, provides: [EGRESS_SERVICE], trust: 'T0' },
  apply(ctx) { ctx.provide(EGRESS_SERVICE, createLocalScrubber()) },
})
