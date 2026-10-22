/** Seeded synthetic replay corpora. Every run is labelled origin 'synthetic'; this generator
 * exists to exercise the offline scorer and is never R3 gate evidence. Healthy runs include
 * near-miss negatives one step below the configured thresholds so precision is meaningful. */
import {
  FAULT_CLASSES,
  parseReplayCorpus,
  type FaultClass,
  type ReplayCorpus,
  type ReplayRun,
  type ReplayStep,
} from './judge-replay.ts'
import type { JudgeObservation, JudgeSignalPolicy } from './judge-signals.ts'

export interface GenerateCorpusOptions {
  seed: number
  runs: number
  faultRate: number
  policy: JudgeSignalPolicy
}

type HealthyPattern = 'clean' | 'loop_near_miss' | 'done_near_miss' | 'stall_near_miss'

const HEALTHY_PATTERNS: readonly HealthyPattern[] = [
  'clean',
  'loop_near_miss',
  'done_near_miss',
  'stall_near_miss',
]

const LOOP_THRESHOLD_KEYS = [
  'noProgressCycles',
  'repeatedFailureCycles',
  'editRevertCycles',
  'repeatedDeadEnds',
] as const

interface ObservationState {
  heartbeatGap: number
  noProgressCycles?: number
  sameFailureStreak?: number
  editRevertStreak?: number
  deadEndRepetitions?: number
  protectedPathEdits?: readonly string[]
  outOfScopeEdits?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randomInt(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}

function observation(observedAt: number, cycle: number, state: ObservationState): JudgeObservation {
  return {
    observedAt,
    heartbeatAt: observedAt - state.heartbeatGap,
    lease: { expiresAt: observedAt + 60_000, current: true },
    deadlineAt: observedAt + 120_000,
    disk: { availableBytes: 10_000_000, requiredBytes: 1_000_000 },
    cycle,
    noProgressCycles: state.noProgressCycles ?? 0,
    sameFailureStreak: state.sameFailureStreak ?? 0,
    editRevertStreak: state.editRevertStreak ?? 0,
    deadEndRepetitions: state.deadEndRepetitions ?? 0,
    protectedPathEdits: [...(state.protectedPathEdits ?? [])],
    outOfScopeEdits: [...(state.outOfScopeEdits ?? [])],
    tokensThisItem: 10 + cycle * 10,
    tokenBudgetForItem: 1_000,
    crashed: false,
  }
}

function buildRun(
  random: () => number,
  runIndex: number,
  fault: FaultClass | null,
  healthyPattern: HealthyPattern,
  policy: JudgeSignalPolicy,
): ReplayRun {
  const stepCount = randomInt(random, 6, 12)
  const onset = randomInt(random, 1, stepCount - 2)
  const nearMissGap = Math.max(0, Math.ceil(policy.heartbeatStallMs) - 1)
  const healthyGap = Math.min(1, nearMissGap)
  const stallGap = Math.max(1, Math.ceil(policy.heartbeatStallMs))
  const loopCounter = fault === 'loop'
    ? LOOP_THRESHOLD_KEYS[randomInt(random, 0, LOOP_THRESHOLD_KEYS.length - 1)]!
    : null
  const loopThreshold = loopCounter === null ? null : policy[loopCounter]
  const baseTime = 1_700_000_000_000 + runIndex * 100_000
  const steps: ReplayStep[] = []
  const labels: { fault: FaultClass; firstStep: number }[] = []

  for (let index = 0; index < stepCount; index++) {
    const state: ObservationState = { heartbeatGap: healthyGap }

    if (fault === null) {
      if (healthyPattern === 'loop_near_miss') {
        state.noProgressCycles = policy.noProgressCycles - 1
        state.sameFailureStreak = policy.repeatedFailureCycles - 1
        state.editRevertStreak = policy.editRevertCycles - 1
        state.deadEndRepetitions = policy.repeatedDeadEnds - 1
      } else if (healthyPattern === 'stall_near_miss') {
        state.heartbeatGap = nearMissGap
      }
    } else if (fault === 'loop' && loopCounter !== null && loopThreshold !== null) {
      const belowThreshold = loopThreshold - 1
      const value = index < onset ? belowThreshold : loopThreshold
      if (loopCounter === 'noProgressCycles') state.noProgressCycles = value
      else if (loopCounter === 'repeatedFailureCycles') state.sameFailureStreak = value
      else if (loopCounter === 'editRevertCycles') state.editRevertStreak = value
      else state.deadEndRepetitions = value
    } else if (fault === 'protected_path_edit') {
      if (index >= onset) state.protectedPathEdits = [`synthetic/protected/run-${runIndex}/test.ts`]
    } else if (fault === 'out_of_scope_edit') {
      if (index >= onset) state.outOfScopeEdits = [`synthetic/out-of-scope/run-${runIndex}/file.ts`]
    } else if (fault === 'stall') {
      if (index >= onset) state.heartbeatGap = stallGap
    }

    const step: ReplayStep = { observation: observation(baseTime + index * 1_000, index, state) }
    if (fault === 'premature_done') {
      if (index >= onset) {
        step.claimsDone = true
        step.acceptancePassed = false
      }
    } else if (fault === null && healthyPattern === 'done_near_miss' && index >= stepCount - 2) {
      step.claimsDone = true
      step.acceptancePassed = true
    }
    steps.push(step)
  }

  if (fault !== null) labels.push({ fault, firstStep: onset })
  return {
    id: `synthetic-${String(runIndex).padStart(4, '0')}-${fault ?? healthyPattern}`,
    origin: 'synthetic',
    policy: { ...policy },
    steps,
    labels,
  }
}

/** Generate a deterministic synthetic corpus for a seed. Faulty runs rotate through all five
 * fault classes so a corpus large enough to contain five faults covers every class. Healthy
 * runs rotate through clean, loop near-miss, passing done claim and heartbeat near-miss
 * patterns. The result is parsed strictly before it is returned. */
export function generateCorpus(options: GenerateCorpusOptions): ReplayCorpus {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options: expected object')
  }
  const { seed, runs, faultRate, policy } = options
  if (!Number.isSafeInteger(seed)) throw new TypeError('options.seed: expected safe integer')
  if (!Number.isSafeInteger(runs) || runs <= 0) throw new TypeError('options.runs: expected positive safe integer')
  if (typeof faultRate !== 'number' || !Number.isFinite(faultRate) || faultRate < 0 || faultRate > 1) {
    throw new TypeError('options.faultRate: expected finite number between 0 and 1')
  }
  if (!isRecord(policy)) throw new TypeError('options.policy: expected object')

  const random = mulberry32(seed)
  const generated: ReplayRun[] = []
  let faultIndex = 0
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const faulty = random() < faultRate
    const healthyPattern = HEALTHY_PATTERNS[runIndex % HEALTHY_PATTERNS.length]!
    const fault = faulty ? FAULT_CLASSES[faultIndex++ % FAULT_CLASSES.length]! : null
    generated.push(buildRun(random, runIndex, fault, healthyPattern, policy))
  }
  return parseReplayCorpus({ version: 1, runs: generated })
}
