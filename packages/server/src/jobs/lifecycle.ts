import type { JobState, JobTerminalState } from '@guanxi/contract'

const NON_TERMINAL_TRANSITIONS = {
  queued: ['reserving', 'cancelling'],
  reserving: ['loading', 'cancelling'],
  loading: ['prefill', 'cancelling'],
  prefill: ['thinking', 'generating', 'cancelling'],
  thinking: ['generating', 'cancelling'],
  generating: ['waiting_tool', 'finalizing', 'cancelling'],
  waiting_tool: ['waiting_approval', 'prefill', 'cancelling'],
  waiting_approval: ['waiting_tool', 'cancelling'],
  finalizing: [],
  cancelling: [],
} as const satisfies Partial<Record<JobState, readonly JobState[]>>

const TERMINAL_TRANSITIONS = {
  queued: [],
  reserving: ['failed'],
  loading: ['failed'],
  prefill: ['failed'],
  thinking: ['failed'],
  generating: ['failed'],
  waiting_tool: ['failed'],
  waiting_approval: [],
  finalizing: ['completed', 'failed'],
  cancelling: ['cancelled'],
} as const satisfies Partial<Record<JobState, readonly JobTerminalState[]>>

const RECOVERY_TERMINAL_TRANSITIONS = {
  reserving: ['interrupted'],
  loading: ['interrupted'],
  prefill: ['interrupted'],
  thinking: ['interrupted'],
  generating: ['interrupted'],
  waiting_tool: ['interrupted'],
  waiting_approval: ['interrupted'],
  finalizing: ['interrupted'],
} as const satisfies Partial<Record<JobState, readonly JobTerminalState[]>>

export function isCanonicalNonTerminalTransition(from: JobState, to: JobState): boolean {
  return (NON_TERMINAL_TRANSITIONS[from as keyof typeof NON_TERMINAL_TRANSITIONS] ?? []).some(
    (candidate) => candidate === to,
  )
}

export function isCanonicalTerminalTransition(
  from: JobState,
  to: JobTerminalState,
): boolean {
  return (TERMINAL_TRANSITIONS[from as keyof typeof TERMINAL_TRANSITIONS] ?? []).some(
    (candidate) => candidate === to,
  )
}

/**
 * Process loss is the only current owner allowed to create `interrupted`.
 * Keeping these edges separate prevents the ordinary runtime failure path from
 * presenting a provider/internal error as an application restart.
 */
export function isCanonicalRecoveryTerminalTransition(
  from: JobState,
  to: JobTerminalState,
): boolean {
  return (
    RECOVERY_TERMINAL_TRANSITIONS[
      from as keyof typeof RECOVERY_TERMINAL_TRANSITIONS
    ] ?? []
  ).some((candidate) => candidate === to)
}
