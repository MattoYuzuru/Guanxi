import { definePlugin, effect, provide, service } from '@guanxi/kernel'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubber } from '../egress/types.ts'
import { SESSION_LOG_SERVICE } from '../session-log/plugin.ts'
import type { SessionLog } from '../session-log/log.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from '../runs/plugin.ts'
import { Federation, type FederationOptions } from './service.ts'
import type { ResourceGovernor } from '../runtime/resource-governor.ts'

export const FEDERATION_SERVICE = 'federation.base'
export const FEDERATION_PLUGIN_ID = 'guanxi.federation'
export type FederationHostOptions = Omit<FederationOptions, 'scrubber' | 'log' | 'runs' | 'attempts'> & {
  attempts?: Omit<NonNullable<FederationOptions['attempts']>, 'governor'>
}
export function createFederationPlugin(host: FederationHostOptions) {
  return definePlugin({
    manifest: { id: FEDERATION_PLUGIN_ID, engines: { guanxi: '^0.1.0' }, trust: 'T0',
      requires: [EGRESS_SCRUBBER_SERVICE, SESSION_LOG_SERVICE, DURABLE_RUNS_SERVICE, ...(host.attempts ? ['governor'] : [])], provides: [FEDERATION_SERVICE] },
    apply(ctx) {
      const { attempts, ...options } = host
      const federation = new Federation({ ...options, ...(attempts ? { attempts: { ...attempts, governor: service<ResourceGovernor>(ctx, 'governor') } } : {}), scrubber: service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE),
        log: service<SessionLog>(ctx, SESSION_LOG_SERVICE), runs: service<DurableRunsService>(ctx, DURABLE_RUNS_SERVICE).store })
      effect(ctx, () => () => federation.close(), 'federation.close()')
      provide(ctx, FEDERATION_SERVICE, federation)
    },
  })
}
