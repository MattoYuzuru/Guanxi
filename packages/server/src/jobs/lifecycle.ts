import type { JobState, JobTerminalState } from '@alamo/contract'

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
  loading: ['failed', 'interrupted'],
  prefill: ['failed', 'interrupted'],
  thinking: ['failed', 'interrupted'],
  generating: ['failed', 'interrupted'],
  waiting_tool: ['failed', 'interrupted'],
  waiting_approval: [],
  finalizing: ['completed', 'failed'],
  cancelling: ['cancelled'],
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
