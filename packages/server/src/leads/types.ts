import { createHash } from 'node:crypto'
import type { LeadDelegateInput } from '@guanxi/contract'
import type { Attempt } from '../runs/types.ts'

export class LeadError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'LeadError'; this.code = code }
}
export function leadInvariant(value: unknown, code: string): asserts value {
  if (!value) throw new LeadError(code)
}
export const code = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'lead_failed'

/** Node-side context of one child start. The brief is already validated and scrubbed. */
export interface ChildLaunch {
  leadRunId: string
  childRunId: string
  brief: Readonly<LeadDelegateInput>
  /** The fenced R1 attempt of the child. The starter's executor completes, signals or fails it. */
  attempt: Attempt
  /** Attempts the child had before this one; a restart passes more than zero. */
  previousAttempts: number
  ownerAccountId: string
  actorAccountId: string
  projectId: string
}
export interface ChildHandle { done: Promise<void> }
/** Pluggable executor of delegated work. Tests use a fake; production uses `relayChildStarter`. */
export interface ChildStarter {
  start(launch: ChildLaunch): ChildHandle | Promise<ChildHandle>
  /** Idempotent: ask the executor to stop work for a canceled child. */
  stop(childRunId: string): void | Promise<void>
}

/** Facts the node already holds about a child. Free text is clipped and scrubbed by the packet builder. */
export interface ChildReport {
  items: { id: string; title: string; status: 'open' | 'verification_requested' | 'done' }[]
  gates: { item: string; ok: boolean; head: string; output: string }[]
  head: string | null
  diffstat: string
  handoff: { ref: string; cycle: number | null } | null
  narrative: string
  openQuestions: string[]
  metrics: { cycles: number | null; tokens: number | null; moneyMicros: number | null }
}
export interface ChildReporter { report(childRunId: string): ChildReport | null }

export type LeadNotice =
  | { kind: 'lead_unavailable'; runId: string; wakeSeq: number | null; code: string; retryAt: number | null }
  | { kind: 'lead_failed'; runId: string; wakeSeq: number | null; code: string }
  | { kind: 'cleanup_unconfirmed'; runId: string; wakeSeq: number | null; code: string }
  | { kind: 'child_start_failed'; runId: string; childRunId: string; code: string }
  /** The child lost its executor after real work began; it is not replayed and the lead waits for its deadline. */
  | { kind: 'child_interrupted'; runId: string; childRunId: string }

/** Owner ceilings for what a lead may ask a delegated run to do. Immutable boot policy, never lead input. */
export interface LeadLimits {
  /** All four required: a lead cannot ask for "no cap". */
  maxCaps: { cycles: number; tokens: number; moneyMicros: number; wallMs: number }
  maxDeadlineMs: number
  /** Default false: the owner's cancel always cancels the child. */
  allowDetach?: boolean
}

export type LeadOutcome = 'hibernated' | 'completed' | 'yielded' | 'unavailable' | 'input_required' | 'failed' | 'canceled'
export interface LeadTurnResult { runId: string; wakeSeq: number | null; outcome: LeadOutcome; code: string | null }

/** Stable key order, so a stored brief or packet hashes the same after a round trip. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  }
  return JSON.stringify(value)
}
export const digestOf = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
