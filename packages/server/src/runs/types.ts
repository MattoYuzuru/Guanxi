import type { RunState } from '@guanxi/contract'
import type { Db } from '../store/db.ts'

export type { RunState }
/** A host-owned metadata operation bound to the home generation that admitted it. */
export interface HomeFence {
  /** Throw unless the captured generation still owns the durable-runs home. */
  assert(): void
  /** Assert the captured generation inside the same SQLite transaction as `body`. */
  transaction<T>(operation: string, body: (db: Db) => T): T
}
export interface HomeAuthority {
  homeFence(): HomeFence
}
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'canceled', 'rejected'])
export type TerminalRunState = 'completed' | 'failed' | 'canceled' | 'rejected'
export interface Run {
  id: string
  session_id: string
  parent_id: string | null
  state: RunState
  version: number
  wake_seq: number
  cancel_count: number
  created_at: number
  updated_at: number
}
export interface Attempt {
  id: string
  run_id: string
  ordinal: number
  wake_seq: number | null
  state: 'delivered' | 'started' | 'sleeping' | 'completed' | 'lost' | 'canceled'
  epoch: number
  token: number
  first_model_at: number | null
}
export interface PromiseRecord {
  id: string
  parent_id: string
  child_id: string
  delegation_key: string
  deadline_policy: 'cancel_wrap_up' | 'detach'
  cancel_policy: 'cancel' | 'detach'
  detached: number
  outcome: TerminalRunState | 'deadline' | null
  resolved_at: number | null
}
export interface Wake {
  run_id: string
  wake_seq: number
  kind: 'resolution' | 'escalation' | 'quota'
  source_key: string
  attempt_id: string | null
  deliveries: number
  acknowledged_at: number | null
  suppressed_at: number | null
}
export type RunErrorCode = 'stale_lease' | 'writer_busy' | 'closed' | 'run_not_found' |
  'budget_exhausted' | 'quota_exhausted' | 'report_budget_exhausted' | 'invalid_transition' | 'egress_not_ready' | 'idempotency_conflict' | 'invalid_input' | 'no_always_on_home'
export class RunError extends Error {
  readonly code: RunErrorCode
  readonly status: number
  constructor(code: RunErrorCode) {
    super(code)
    this.name = 'RunError'
    this.code = code
    this.status = code === 'stale_lease' ? 409 : 400
  }
}
