import type { Connections } from '../../server/src/connections/service.ts'
import type { EgressScrubber } from '../../server/src/egress/types.ts'
import type { Attempt } from '../../server/src/runs/types.ts'
import type { RunStore } from '../../server/src/runs/store.ts'
import type { SessionLog } from '../../server/src/session-log/log.ts'
import type { Budget } from './budget.ts'
import { createK2TrialRetention, type K2TrialRetention, type RetentionPolicy } from './k2-retention.ts'
import { createTrialGateway, type BillingAdapter, type TrialGatewayConfig } from './k3-gateway.ts'
import type { PrivateChannelHost } from './private-channel.ts'
import type { TrialBinding } from './trial-binding.ts'

export interface TrialHostConfig {
  binding: TrialBinding
  attempt: Attempt
  budget: Budget
  k3: Pick<Connections, 'snapshot' | 'complete'>
  billing: BillingAdapter
  runs: Pick<RunStore, 'append' | 'get' | 'renew'>
  session: Pick<SessionLog, 'session' | 'readAll'>
  scrubber: EgressScrubber
  retentionPolicy: RetentionPolicy
}

export interface BoundTrialHost {
  readonly host: PrivateChannelHost & Required<Pick<PrivateChannelHost, 'retainAndProject'>>
  readonly gateway: ReturnType<typeof createTrialGateway>
  readonly retention: K2TrialRetention
}

/**
 * New production composition. K3 receives the actual R1 run id while the budget
 * ledger keeps the experiment id; the child never receives either identity.
 */
export function createBoundTrialHost(config: TrialHostConfig): BoundTrialHost {
  const { binding, attempt } = config
  if (attempt.id !== binding.attemptId || attempt.run_id !== binding.runId) {
    throw new Error('binding_attempt_mismatch')
  }
  const run = config.runs.get(binding.runId)
  if (run.session_id !== binding.sessionId) throw new Error('binding_session_mismatch')
  const retention = createK2TrialRetention({
    binding, attempt, runs: config.runs, session: config.session,
    scrubber: config.scrubber, policy: config.retentionPolicy,
  })
  const gateway = createTrialGateway({
    budget: config.budget,
    k3: config.k3,
    accountId: binding.accountId,
    connectionId: binding.connectionId,
    provider: binding.provider,
    model: binding.model,
    outputTokenLimit: binding.outputTokenLimit,
    trial: {
      runId: binding.experimentId,
      task: binding.taskId,
      arm: binding.armId,
      seed: binding.seed,
    },
    k3RunId: binding.runId,
    attemptFence: { assert: () => config.runs.renew(attempt) },
    billing: config.billing,
  })
  const host = Object.freeze({
    model: Object.freeze({ api: binding.modelApi, provider: binding.provider, id: binding.model }),
    gateway,
    retain: retention.retain,
    retainAndProject: retention.retainAndProject,
  })
  return Object.freeze({ host, gateway, retention })
}

export type { TrialGatewayConfig }
