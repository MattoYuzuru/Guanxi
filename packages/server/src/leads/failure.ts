/** The reason shown to a person when a wake cannot be delivered again and again. The original code stays in the run's notes. */
export type WakeFailureReason = 'admission_stuck' | 'quota_exhausted' | 'agent_unavailable'

const ADMISSION = new Set(['account_busy', 'cleanup_unconfirmed', 'admission_unavailable', 'admission_release_failed', 'account_policy_conflict'])

export function typedWakeFailure(code: string): WakeFailureReason {
  if (ADMISSION.has(code)) return 'admission_stuck'
  if (code === 'quota_exhausted') return 'quota_exhausted'
  return 'agent_unavailable'
}
