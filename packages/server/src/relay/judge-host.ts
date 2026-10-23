import { RelayError, type Ledger } from './types.ts'
import type { JudgeObservation, JudgeSignalPolicy, JudgeSignal } from './judge-signals.ts'

/** The two synchronous executor boundaries where a trusted host may observe J0/J1 facts.
 * Sampling is not a timer: it happens once per cycle before orient and once before the
 * fresh handoff narrative. */
export type JudgePhase = 'cycle_start' | 'pre_seal'
export type JudgeUnknownFact = 'heartbeat' | 'lease' | 'deadline' | 'disk' | 'tokenBudget'
  | 'failureStreak' | 'editRevert' | 'deadEnds' | 'pathEdits' | 'crash' | 'itemTokens'
/** Every name a collector may declare unobserved (see `RelayJudgeInput.unobserved`). */
export const JUDGE_UNKNOWN_FACTS: readonly JudgeUnknownFact[] = ['heartbeat', 'lease', 'deadline', 'disk', 'tokenBudget',
  'failureStreak', 'editRevert', 'deadEnds', 'pathEdits', 'crash', 'itemTokens']

export interface RelayJudgeAttempt {
  id: string
  runId: string
  epoch: number
  token: number
}

/** Fenced detached summary only; no raw host/path observations cross into model context. */
export interface RelayJudgeSummary {
  attempt: RelayJudgeAttempt
  cycle: number
  phase: JudgePhase
  signals: JudgeSignal[]
  unknownFacts: JudgeUnknownFact[]
}

export interface RelayJudgeCollectInput {
  attempt: RelayJudgeAttempt
  ledger: Readonly<Ledger>
  signal: AbortSignal
}

/** T0 host observation, like RuntimeMeter and RelayWorkspace. It is never parsed from model
 * JSON or HTTP and is not a public wire shape. The executor evaluates the returned observation
 * through the reviewed pure judge-signals module; it does not take actions from it. */
export interface RelayJudgeInput {
  policy: JudgeSignalPolicy
  collect(input: RelayJudgeCollectInput): Promise<JudgeObservation>
  /** Facts this collector does not observe although the observation shape has a required field for them (a streak or a
   * list that is reported as zero or empty). They are published as unknown, never as healthy. */
  unobserved?: readonly JudgeUnknownFact[]
}

export interface PreparedRelayJudge {
  readonly policy: Readonly<JudgeSignalPolicy>
  readonly unobserved: readonly JudgeUnknownFact[]
  collect(input: RelayJudgeCollectInput): Promise<JudgeObservation>
}

const POLICY_KEYS = [
  'heartbeatStallMs', 'noProgressCycles', 'repeatedFailureCycles', 'editRevertCycles',
  'repeatedDeadEnds', 'tokenBlowupRatio',
] as const

function invalidConfig(): never {
  throw new RelayError('judge_config_invalid')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
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

/** Validate and detach the flat policy. This has no defaults: every threshold comes from the
 * host policy, and an invalid value fails admission with a fixed code that carries no content. */
function copyPolicy(value: unknown): Readonly<JudgeSignalPolicy> {
  if (!isRecord(value) || !hasExactKeys(value, POLICY_KEYS)) invalidConfig()
  const heartbeatStallMs = value.heartbeatStallMs
  const noProgressCycles = value.noProgressCycles
  const repeatedFailureCycles = value.repeatedFailureCycles
  const editRevertCycles = value.editRevertCycles
  const repeatedDeadEnds = value.repeatedDeadEnds
  const tokenBlowupRatio = value.tokenBlowupRatio
  if (!isPositiveNumber(heartbeatStallMs) || !isPositiveInteger(noProgressCycles)
    || !isPositiveInteger(repeatedFailureCycles) || !isPositiveInteger(editRevertCycles)
    || !isPositiveInteger(repeatedDeadEnds) || !isRatio(tokenBlowupRatio)) invalidConfig()
  return Object.freeze({
    heartbeatStallMs,
    noProgressCycles,
    repeatedFailureCycles,
    editRevertCycles,
    repeatedDeadEnds,
    tokenBlowupRatio,
  })
}

/** Copy the policy and validate the collector function. The collector is never invoked here. */
export function prepareJudgeSignals(input: RelayJudgeInput): PreparedRelayJudge {
  if (!isRecord(input)) invalidConfig()
  const collect = input.collect
  if (typeof collect !== 'function') invalidConfig()
  const unobserved = input.unobserved === undefined ? [] : input.unobserved
  if (!Array.isArray(unobserved) || unobserved.some(name => !JUDGE_UNKNOWN_FACTS.includes(name))) invalidConfig()
  return Object.freeze({ policy: copyPolicy(input.policy), unobserved: Object.freeze([...unobserved]),
    collect: collect.bind(input) as RelayJudgeInput['collect'] })
}

/** Absent optional observation fields are unknown, not healthy. The names are fixed so an
 * empty signal list can never be read as proof of health. */
export function judgeUnknownFacts(observation: JudgeObservation, unobserved: readonly JudgeUnknownFact[] = []): JudgeUnknownFact[] {
  const unknown: JudgeUnknownFact[] = []
  if (observation.heartbeatAt === null) unknown.push('heartbeat')
  if (observation.lease === null) unknown.push('lease')
  if (observation.deadlineAt === null) unknown.push('deadline')
  if (observation.disk === null) unknown.push('disk')
  if (observation.tokenBudgetForItem === null) unknown.push('tokenBudget')
  // Declared by the collector, in the fixed order of the names, once each.
  for (const name of JUDGE_UNKNOWN_FACTS) if (unobserved.includes(name) && !unknown.includes(name)) unknown.push(name)
  return unknown
}
