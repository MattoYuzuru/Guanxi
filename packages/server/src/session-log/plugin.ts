/**
 * The session log as a kernel plugin (K2). The host binds it to the node's
 * database; it requires the egress scrubber, so the log never stores a payload
 * the scrubber has not seen. Unload releases every writer row this process
 * holds and ends every subscription.
 */
import { definePlugin, effect, interval, provide, service } from '@guanxi/kernel'
import type { Db } from '../store/db.ts'
import { EGRESS_SCRUBBER_SERVICE, type EgressScrubber } from '../egress/types.ts'
import { SessionLog, type SessionLogOptions } from './log.ts'

export const SESSION_LOG_SERVICE = 'session.log'
export const SESSION_LOG_PLUGIN_ID = 'guanxi.session-log'
export const REASONING_PURGE_INTERVAL_MS = 10 * 60 * 1_000

export function createSessionLogPlugin(
  host: { db: Db } & Omit<SessionLogOptions, 'db' | 'scrubber'> & { purgeIntervalMs?: number },
) {
  return definePlugin({
    manifest: {
      id: SESSION_LOG_PLUGIN_ID,
      engines: { guanxi: '^0.1.0' },
      provides: [SESSION_LOG_SERVICE],
      requires: [EGRESS_SCRUBBER_SERVICE],
      trust: 'T0',
    },
    apply(ctx) {
      const { purgeIntervalMs, ...options } = host
      const log = new SessionLog({ ...options, scrubber: service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE) })
      effect(ctx, () => () => log.close(), 'sessionLog.close()')
      const purge = () => {
        try {
          log.purgeExpiredReasoning()
        } catch {
          // The next tick retries; a purge failure never stops the node.
        }
      }
      interval(ctx, purge, purgeIntervalMs ?? REASONING_PURGE_INTERVAL_MS)
      provide(ctx, SESSION_LOG_SERVICE, log)
    },
  })
}
