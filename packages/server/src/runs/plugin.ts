import { definePlugin, effect, interval, provide, service } from '@guanxi/kernel'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubber } from '../egress/types.ts'
import { SESSION_LOG_SERVICE } from '../session-log/plugin.ts'
import type { SessionLog } from '../session-log/log.ts'
import { RunStore, type RunStoreOptions } from './store.ts'

export const DURABLE_RUNS_SERVICE = 'runs.durable'
export const DURABLE_RUNS_PLUGIN_ID = 'guanxi.durable-runs'

export function createDurableRunsPlugin(host: Omit<RunStoreOptions, 'log' | 'scrubber'> & { tickMs?: number }) {
  return definePlugin({
    manifest: {
      id: DURABLE_RUNS_PLUGIN_ID, engines: { guanxi: '^0.1.0' }, trust: 'T0',
      requires: [SESSION_LOG_SERVICE, EGRESS_SCRUBBER_SERVICE], provides: [DURABLE_RUNS_SERVICE],
    },
    apply(ctx) {
      const store = new RunStore({ ...host, log: service<SessionLog>(ctx, SESSION_LOG_SERVICE),
        scrubber: service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE) })
      effect(ctx, () => () => store.close(), 'durableRuns.close()')
      let failure: string | null = null
      let reconciled = false
      const pump = () => {
        try {
          store.heartbeat()
          if (!service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE).isReady()) {
            failure = 'egress_not_ready'
            return
          }
          if (!reconciled) { store.reconcile(); reconciled = !store.failures().some((f) => f.operation === 'reconcile') }
          store.tick()
          store.dispatch()
          failure = store.failures().length ? 'run_failure' : null
        } catch (error) {
          // Codes only; never log an arbitrary exception or workspace content.
          failure = error instanceof Error && 'code' in error ? String(error.code) : 'storage_error'
        }
      }
      pump()
      interval(ctx, pump, host.tickMs ?? 1_000)
      provide(ctx, DURABLE_RUNS_SERVICE, Object.freeze({ store, health: () => ({ failure }) }))
    },
  })
}
export interface DurableRunsService { readonly store: RunStore; health(): { failure: string | null } }
