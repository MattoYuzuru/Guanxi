import { definePlugin, effect, interval, provide, service } from '@guanxi/kernel'
import type { Connections } from '../connections/service.ts'
import type { EgressScrubber } from '../egress/types.ts'
import { EGRESS_SCRUBBER_SERVICE } from '../egress/types.ts'
import { EXTERNAL_AGENT_SERVICE, type ExternalAgentService } from '../external-agents/plugin.ts'
import { DURABLE_RUNS_SERVICE, type DurableRunsService } from '../runs/plugin.ts'
import { LeadService, type LeadServiceOptions } from './service.ts'

export const LEAD_SERVICE = 'lead.external'
export const LEAD_PLUGIN_ID = 'guanxi.external-leads'
export type LeadPluginConfig = Omit<LeadServiceOptions, 'runs' | 'agents' | 'scrubber' | 'billing'> & { tickMs?: number }

/** T0 host API. Loading it starts no inference; a lead exists only after `startLead`. It requires the
 * host's explicit always-on assertion (`runs.alwaysOn`) before any lead can hibernate. */
export function createLeadPlugin(config: LeadPluginConfig) {
  return definePlugin({
    manifest: {
      id: LEAD_PLUGIN_ID, engines: { guanxi: '^0.1.0' }, trust: 'T0',
      requires: [DURABLE_RUNS_SERVICE, EXTERNAL_AGENT_SERVICE, EGRESS_SCRUBBER_SERVICE, 'connections.registry'], provides: [LEAD_SERVICE],
    },
    apply(ctx) {
      const connections = service<Connections>(ctx, 'connections.registry')
      const lead = new LeadService({ ...config,
        runs: service<DurableRunsService>(ctx, DURABLE_RUNS_SERVICE).store,
        agents: service<ExternalAgentService>(ctx, EXTERNAL_AGENT_SERVICE),
        scrubber: service<EgressScrubber>(ctx, EGRESS_SCRUBBER_SERVICE),
        billing: (owner, connectionId) => connections.store.get(owner, connectionId).facts.billing ?? null })
      effect(ctx, () => () => lead.close(), 'externalLeads.close()')
      lead.pump()
      interval(ctx, () => lead.pump(), config.tickMs ?? 1_000)
      provide(ctx, LEAD_SERVICE, Object.freeze({
        startLead: lead.startLead.bind(lead), resume: lead.resume.bind(lead), cancel: lead.cancel.bind(lead),
        pump: lead.pump.bind(lead), idle: lead.idle.bind(lead), health: lead.health.bind(lead), normalizeTask: lead.normalizeTask.bind(lead),
        sessions: () => lead.store.sessionStates().map(row => ({ runId: row.run_id, acpSessionId: row.acp_session_id, loadSession: row.load_session === 1,
          turns: row.turns, failures: row.failures, retryAt: row.retry_at, fallbackUsed: row.fallback_used === 1, task: row.task, state: row.run_state })),
      }))
    },
  })
}
export type LeadHostService = Pick<LeadService, 'startLead' | 'resume' | 'cancel' | 'pump' | 'idle' | 'health' | 'normalizeTask'> & {
  sessions(): { runId: string; acpSessionId: string | null; loadSession: boolean; turns: number; failures: number; retryAt: number; fallbackUsed: boolean; task: string; state: string | null }[]
}
