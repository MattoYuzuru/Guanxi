/** Host-supplied deterministic judge inputs. The executor never authors this shape and this
 * module never parses JSON. A null optional fact is unknown, not healthy: it produces no
 * signal, and the caller retains the unknown. */
export interface JudgeObservation {
  observedAt: number
  heartbeatAt: number | null
  lease: { expiresAt: number; current: boolean } | null
  deadlineAt: number | null
  disk: { availableBytes: number; requiredBytes: number } | null
  cycle: number
  noProgressCycles: number
  sameFailureStreak: number
  editRevertStreak: number
  deadEndRepetitions: number
  protectedPathEdits: string[]
  outOfScopeEdits: string[]
  tokensThisItem: number
  tokenBudgetForItem: number | null
  crashed: boolean
}

/** Thresholds come only from run policy. This module has no defaults and no hidden ceiling. */
export interface JudgeSignalPolicy {
  heartbeatStallMs: number
  noProgressCycles: number
  repeatedFailureCycles: number
  editRevertCycles: number
  repeatedDeadEnds: number
  tokenBlowupRatio: number
}

type JudgeSignalCode =
  | 'heartbeat_stall'
  | 'lease_lost'
  | 'deadline'
  | 'crash'
  | 'disk'
  | 'no_progress'
  | 'repeated_failure'
  | 'edit_revert'
  | 'repeated_dead_end'
  | 'protected_path_edit'
  | 'out_of_scope_edit'
  | 'token_blowup'

export interface JudgeSignal {
  layer: 'J0' | 'J1'
  code: JudgeSignalCode
  observedAt: number
  source: 'harness.judge-signals'
  confidence: 'high' | 'medium'
}

const OBSERVATION_KEYS = [
  'observedAt', 'heartbeatAt', 'lease', 'deadlineAt', 'disk', 'cycle',
  'noProgressCycles', 'sameFailureStreak', 'editRevertStreak', 'deadEndRepetitions',
  'protectedPathEdits', 'outOfScopeEdits', 'tokensThisItem', 'tokenBudgetForItem', 'crashed',
] as const
const POLICY_KEYS = [
  'heartbeatStallMs', 'noProgressCycles', 'repeatedFailureCycles', 'editRevertCycles',
  'repeatedDeadEnds', 'tokenBlowupRatio',
] as const
const COUNT_KEYS = [
  'cycle', 'noProgressCycles', 'sameFailureStreak', 'editRevertStreak',
  'deadEndRepetitions', 'tokensThisItem',
] as const
const POLICY_COUNT_KEYS = [
  'noProgressCycles', 'repeatedFailureCycles', 'editRevertCycles', 'repeatedDeadEnds',
] as const
const LEASE_KEYS = ['expiresAt', 'current'] as const
const DISK_KEYS = ['availableBytes', 'requiredBytes'] as const
const SOURCE = 'harness.judge-signals' as const

function invalidObservation(): never {
  throw new Error('invalid_judge_observation')
}

function invalidPolicy(): never {
  throw new Error('invalid_judge_policy')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) if (typeof value[index] !== 'string') return false
  return true
}

function validateObservation(value: unknown): asserts value is JudgeObservation {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVATION_KEYS)) invalidObservation()
  const observedAt = value.observedAt
  if (!isCounter(observedAt)) invalidObservation()
  const heartbeatAt = value.heartbeatAt
  if (heartbeatAt !== null && (!isCounter(heartbeatAt) || heartbeatAt > observedAt)) invalidObservation()
  const lease = value.lease
  if (lease !== null && (!isRecord(lease) || !hasExactKeys(lease, LEASE_KEYS)
    || !isCounter(lease.expiresAt) || typeof lease.current !== 'boolean')) invalidObservation()
  const deadlineAt = value.deadlineAt
  if (deadlineAt !== null && !isCounter(deadlineAt)) invalidObservation()
  const disk = value.disk
  if (disk !== null && (!isRecord(disk) || !hasExactKeys(disk, DISK_KEYS)
    || !isCounter(disk.availableBytes) || !isCounter(disk.requiredBytes))) invalidObservation()
  for (const key of COUNT_KEYS) if (!isCounter(value[key])) invalidObservation()
  if (!isStringArray(value.protectedPathEdits) || !isStringArray(value.outOfScopeEdits)) invalidObservation()
  const budget = value.tokenBudgetForItem
  if (budget !== null && !isPositiveInteger(budget)) invalidObservation()
  if (typeof value.crashed !== 'boolean') invalidObservation()
}

function validatePolicy(value: unknown): asserts value is JudgeSignalPolicy {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) invalidPolicy()
  if (!isPositiveNumber(value.heartbeatStallMs)) invalidPolicy()
  for (const key of POLICY_COUNT_KEYS) if (!isPositiveInteger(value[key])) invalidPolicy()
  if (!isRatio(value.tokenBlowupRatio)) invalidPolicy()
}

function emit(layer: 'J0' | 'J1', code: JudgeSignalCode, observedAt: number): JudgeSignal {
  return { layer, code, observedAt, source: SOURCE, confidence: layer === 'J0' ? 'high' : 'medium' }
}

/** Deterministic J0/J1 evidence for one host observation. It executes no judge, model,
 * execution policy or relay loop, reads no clock or filesystem, and emits no diagnosis or
 * recommended action. This is not a calibrated classifier and establishes no empirical
 * precision, recall or night-gate coverage. Signals are emitted once in fixed J0→J1 order.
 * A missing optional fact yields no signal and is not a health claim. */
export function evaluateJudgeSignals(observation: JudgeObservation, policy: JudgeSignalPolicy): JudgeSignal[] {
  validateObservation(observation)
  validatePolicy(policy)
  const observedAt = observation.observedAt
  const signals: JudgeSignal[] = []

  if (observation.heartbeatAt !== null && observedAt - observation.heartbeatAt >= policy.heartbeatStallMs) {
    signals.push(emit('J0', 'heartbeat_stall', observedAt))
  }
  if (observation.lease !== null && (!observation.lease.current || observation.lease.expiresAt <= observedAt)) {
    signals.push(emit('J0', 'lease_lost', observedAt))
  }
  if (observation.deadlineAt !== null && observation.deadlineAt <= observedAt) {
    signals.push(emit('J0', 'deadline', observedAt))
  }
  if (observation.crashed) signals.push(emit('J0', 'crash', observedAt))
  if (observation.disk !== null && observation.disk.availableBytes < observation.disk.requiredBytes) {
    signals.push(emit('J0', 'disk', observedAt))
  }

  if (observation.noProgressCycles >= policy.noProgressCycles) signals.push(emit('J1', 'no_progress', observedAt))
  if (observation.sameFailureStreak >= policy.repeatedFailureCycles) signals.push(emit('J1', 'repeated_failure', observedAt))
  if (observation.editRevertStreak >= policy.editRevertCycles) signals.push(emit('J1', 'edit_revert', observedAt))
  if (observation.deadEndRepetitions >= policy.repeatedDeadEnds) signals.push(emit('J1', 'repeated_dead_end', observedAt))
  if (observation.protectedPathEdits.length > 0) signals.push(emit('J1', 'protected_path_edit', observedAt))
  if (observation.outOfScopeEdits.length > 0) signals.push(emit('J1', 'out_of_scope_edit', observedAt))
  // Division keeps the comparison finite for the largest valid safe-integer counters.
  if (observation.tokenBudgetForItem !== null
    && observation.tokensThisItem / observation.tokenBudgetForItem >= policy.tokenBlowupRatio) {
    signals.push(emit('J1', 'token_blowup', observedAt))
  }

  return signals
}
