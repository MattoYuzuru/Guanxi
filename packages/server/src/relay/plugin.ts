import { definePlugin, interval } from '@guanxi/kernel'
import type { Db } from '../store/db.ts'
import type { SessionLog } from '../session-log/log.ts'
import type { Connections } from '../connections/service.ts'
import type { DurableRunsService } from '../runs/plugin.ts'
import type { Attempt } from '../runs/types.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { DEFAULT_RELAY_LIMITS, type Plan, type Caps, type Reserves, type RelayLimits } from './types.ts'
import type { RuntimeMeter } from './model.ts'
import type { RelayWorkspace } from './workspace.ts'
import { ConnectionRelayModel } from './model.ts'
import { RelayExecutor } from './executor.ts'
import { RelayStore } from './store.ts'
import { invariant } from './types.ts'
import { RelayStarts, type RelayStartHost } from './start.ts'
import type { EtaInput } from './eta.ts'
import type { RelayJudgeInput } from './judge-host.ts'
import type { RelayCascadeInput } from './judge-cascade.ts'
import { JudgeJournalStore } from './judge-journal.ts'

export const RELAY_SERVICE = 'agent.relay'
const JOURNAL_PURGE_INTERVAL_MS = 10 * 60 * 1_000
export interface RelayConfig { db: Db; limits?: Partial<RelayLimits>; startHost?: RelayStartHost }
export interface RelayInput {
  connectionId: string; model: string; meter: RuntimeMeter; workspace: RelayWorkspace; reserves: Reserves; limits?: Partial<RelayLimits>
  eta?: EtaInput
  judgeSignals?: RelayJudgeInput
  cascade?: RelayCascadeInput
}
/** T0 internal API. Workspace and runtime attestations are supplied by the execution host,
 * never parsed from model JSON or HTTP. Merely loading the plugin starts no inference. */
export const relayPlugin = definePlugin<RelayConfig>({
  manifest: { id: 'guanxi.relay', engines: { guanxi: '^0.1.0' }, trust: 'T0', provides: [RELAY_SERVICE],
    requires: ['runs.durable', 'connections.registry', 'session.log', 'egress.scrubber'] },
  apply(ctx, config) {
    const runs = ctx.service<DurableRunsService>('runs.durable')
    const connections = ctx.service<Connections>('connections.registry')
    const scrubber = ctx.service<EgressScrubber>('egress.scrubber')
    const store = new RelayStore(config.db, runs.store, scrubber)
    // D-199 journal is owned by this node and bounded by the reasoning retention. It is
    // constructed even before a judge runs so a periodic purge can empty an old node.
    const journal = new JudgeJournalStore(config.db, { scrubber })
    const purgeJournal = () => {
      try {
        journal.purgeExpired()
      } catch {
        // The next tick retries; a local sidecar purge never stops the relay.
      }
    }
    purgeJournal()
    interval(ctx, purgeJournal, JOURNAL_PURGE_INTERVAL_MS)
    const publicStarts = new RelayStarts(config.db, runs.store, ctx.service<SessionLog>('session.log'), connections, scrubber, store,
      config.startHost ?? { project: async () => { throw new Error('relay_project_unavailable') }, nodePorts: () => [] })
    const active = new Map<string, { executor: RelayExecutor; promise: Promise<unknown> }>()
    let closed = false
    ctx.provide(RELAY_SERVICE, Object.freeze({
      publicStarts,
      init: (a: Attempt, plan: Plan, caps: Caps) => { invariant(!closed, 'relay_closed'); store.init(a, plan, caps) },
      read: (id: string) => store.read(id),
      async execute(a: Attempt, input: RelayInput) {
        invariant(!closed && !active.has(a.run_id), 'relay_busy')
        invariant(!input.eta || input.eta.scope.model === input.model, 'eta_model')
        const limits = { ...DEFAULT_RELAY_LIMITS, ...config.limits, ...input.limits }
        const cascade = input.cascade
          ? {
              ...input.cascade,
              journal: input.cascade.journal === undefined ? journal : input.cascade.journal
            }
          : undefined
        const executor = new RelayExecutor(store, new ConnectionRelayModel(connections, input.connectionId, input.model, input.meter), input.workspace, input.reserves, scrubber, limits, input.eta, input.judgeSignals, cascade)
        const promise = executor.run(a)
        active.set(a.run_id, { executor, promise })
        try { return await promise } finally { active.delete(a.run_id) }
      },
      stop: (id: string) => active.get(id)?.executor.stop(),
      recover: (a: Attempt) => { invariant(!closed && !active.has(a.run_id), 'relay_busy'); store.recover(a) },
    }))
    ctx.effect(() => async () => { closed = true; for (const a of active.values()) a.executor.stop(); await publicStarts.close(); await Promise.allSettled([...active.values()].map(a => a.promise)) }, 'relay.stop')
  },
})
export interface RelayService {
  readonly publicStarts: RelayStarts
  init(a: Attempt, plan: Plan, caps: Caps): void
  read(id: string): import('./types.ts').Ledger
  execute(a: Attempt, input: RelayInput): Promise<import('./types.ts').Ledger>
  stop(id: string): void
  recover(a: Attempt): void
}
