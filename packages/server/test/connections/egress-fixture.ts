import { definePlugin } from '@guanxi/kernel'
import { EGRESS_SERVICE, type EgressScrubber } from '../../src/connections/egress.ts'

// Consumer integration fixture only; production fails closed until K2 merges.
function createLocalScrubber(): EgressScrubber {
  const pending = new Set(['vault'])
  const ready = new Set<string>()
  const waiters = new Set<() => void>()
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
    expect(source) { if (!ready.has(source)) pending.add(source) },
    ready(source) {
      ready.add(source); pending.delete(source)
      if (!pending.size) { for (const resolve of waiters) resolve(); waiters.clear() }
    },
    isReady() { return pending.size === 0 }, pendingSources() { return [...pending].sort() },
    whenReady() { return pending.size ? new Promise<void>(resolve => waiters.add(resolve)) : Promise.resolve() },
  }
}

export const fixtureEgressPlugin = definePlugin({
  manifest: { id: 'test.egress', engines: { guanxi: '^0.1.0' }, provides: [EGRESS_SERVICE], trust: 'T0' },
  apply(ctx) { ctx.provide(EGRESS_SERVICE, createLocalScrubber()) },
})
