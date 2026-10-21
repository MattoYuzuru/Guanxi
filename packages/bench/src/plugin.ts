import { definePlugin, effect, provide, service } from '@guanxi/kernel'
import { Budget } from './budget.ts'
import { runBench, type Executor } from './runner.ts'
import { validatePlan } from './protocol.ts'
/** Structural R1 contract: B1 owns no shared run/store migration or server registration. */
export interface RunHome {
  create(): { id: string }
  start(id: string): unknown
  renew(attempt: any): void
  complete(attempt: any, outcome: 'completed' | 'failed' | 'canceled'): void
}
export function createBenchPlugin(options: { ledger: string; executor: Executor }) {
  return definePlugin({
    manifest: { id: 'guanxi.bench', engines: { guanxi: '^0.1.0' }, trust: 'T0',
      requires: ['runs.durable', 'egress.scrubber'], provides: ['bench.runner'] },
    apply(ctx) {
      const home = service<{ store: RunHome }>(ctx, 'runs.durable').store
      const scrubber = service<{ isReady(): boolean }>(ctx, 'egress.scrubber')
      const budget = new Budget(options.ledger)
      const active = new Map<string, { abort: AbortController; done: Promise<unknown> }>()
      let closed = false
      effect(ctx, () => async () => {
        closed = true
        for (const job of active.values()) job.abort.abort()
        await Promise.allSettled([...active.values()].map(job => job.done))
        budget.close()
      }, 'bench.cleanup')
      provide(ctx, 'bench.runner', {
        run(raw: unknown) {
          if (closed || !scrubber.isReady()) throw new Error('bench_unavailable')
          const plan = validatePlan(raw)
          const run = home.create(); const attempt = home.start(run.id)
          const abort = new AbortController()
          const timer = setInterval(() => { try { home.renew(attempt) } catch { abort.abort() } }, 1000)
          const done = runBench(plan, budget, options.executor, { signal: abort.signal }).then(
            trials => { home.complete(attempt, 'completed'); return { runId: run.id, trials } },
            () => { home.complete(attempt, abort.signal.aborted ? 'canceled' : 'failed'); throw new Error('bench_failed') },
          ).finally(() => { clearInterval(timer); active.delete(run.id) })
          active.set(run.id, { abort, done })
          return { runId: run.id, done, cancel: () => abort.abort() }
        },
      })
    },
  })
}
