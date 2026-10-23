/** Offline judge replay format and scorer. A replay corpus is data only: this module reads no
 * clock, filesystem, model or relay state. Synthetic corpora are explicitly not gate evidence;
 * only a fully recorded corpus with labelled R3 fault classes may evaluate the gate. */
import { evaluateJudgeSignals, type JudgeObservation, type JudgeSignalPolicy } from './judge-signals.ts'
import { JUDGE_UNKNOWN_FACTS, type JudgeUnknownFact } from './judge-host.ts'

export type FaultClass = 'loop' | 'protected_path_edit' | 'premature_done' | 'out_of_scope_edit' | 'stall'
export type ReplayOrigin = 'synthetic' | 'recorded'

export const FAULT_CLASSES: readonly FaultClass[] = [
  'loop',
  'protected_path_edit',
  'premature_done',
  'out_of_scope_edit',
  'stall',
]
export const REPLAY_ORIGINS: readonly ReplayOrigin[] = ['synthetic', 'recorded']

export interface ReplayStep {
  observation: JudgeObservation
  claimsDone?: boolean
  /** true/false is an explicit acceptance result; null means unknown. */
  acceptancePassed?: boolean | null
  /** Facts the collector declared unobserved. Their zero/empty observation fields are not
   * health evidence: a detector whose signal depends on one reports an unknown step. */
  unknownFacts?: readonly JudgeUnknownFact[]
}

export interface ReplayRun {
  id: string
  origin: ReplayOrigin
  policy: JudgeSignalPolicy
  /** Ordered by observation.observedAt, non-decreasing; equal host-clock milliseconds are valid. */
  steps: ReplayStep[]
  /** Ground truth: the fault exists from firstStep onward. */
  labels: { fault: FaultClass; firstStep: number }[]
}

export interface ReplayCorpus {
  version: 1
  runs: ReplayRun[]
}

export const R3_GATE_RULE = 'R3: recall>=0.9 and precision>=0.8 on a replay corpus' as const

export interface DetectorResult {
  /** Step indices where the detector fires. May be unsorted. */
  firedSteps: readonly number[]
  /** Step indices where the detector cannot decide. Unknown never counts as a firing. */
  unknownSteps?: readonly number[]
}

export type Detector = (run: ReplayRun) => DetectorResult

export interface LatencyScore {
  /** In steps, over true positives; null when there is no true positive. */
  median: number | null
  max: number | null
}

export interface CountScore {
  tp: number
  fp: number
  fn: number
  tn: number
}

export interface ClassScore extends CountScore {
  precision: number | null
  recall: number | null
  latency: LatencyScore
  unknown: number
}

export interface FaultClassScore extends ClassScore {
  fault: FaultClass
}

export type MicroScore = ClassScore

export interface OriginScore {
  runs: number
  labelledRuns: number
  classes: Record<FaultClass, FaultClassScore>
  micro: MicroScore
}

export interface GateScore {
  rule: typeof R3_GATE_RULE
  evaluated: boolean
  reason: 'synthetic_corpus' | 'not_all_runs_recorded' | 'missing_required_classes' | 'empty_corpus' | 'recorded_corpus'
  met?: boolean
}

export interface ReplayScore {
  runs: number
  labelledRuns: number
  classes: Record<FaultClass, FaultClassScore>
  micro: MicroScore
  origins: Record<ReplayOrigin, OriginScore>
  gate: GateScore
}

const CORPUS_KEYS = ['version', 'runs'] as const
const RUN_KEYS = ['id', 'origin', 'policy', 'steps', 'labels'] as const
const STEP_REQUIRED_KEYS = ['observation'] as const
const LABEL_KEYS = ['fault', 'firstStep'] as const
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
const REQUIRED_GATE_CLASSES: readonly FaultClass[] = ['loop', 'protected_path_edit', 'premature_done']
const LOOP_SIGNALS: ReadonlySet<string> = new Set(['no_progress', 'repeated_failure', 'edit_revert', 'repeated_dead_end'])

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeCount(value: unknown): value is number {
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

function isFaultClass(value: unknown): value is FaultClass {
  return typeof value === 'string' && (FAULT_CLASSES as readonly string[]).includes(value)
}

function exactObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'expected object')
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown key')
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing key')
  }
  return value
}

function parsePolicy(value: unknown, path: string): JudgeSignalPolicy {
  const record = exactObject(value, path, POLICY_KEYS)
  if (!isPositiveNumber(record.heartbeatStallMs)) fail(`${path}.heartbeatStallMs`, 'expected positive finite number')
  for (const key of POLICY_COUNT_KEYS) {
    if (!isPositiveInteger(record[key])) fail(`${path}.${key}`, 'expected positive safe integer')
  }
  if (!isRatio(record.tokenBlowupRatio)) fail(`${path}.tokenBlowupRatio`, 'expected finite number greater than 1')
  return record as unknown as JudgeSignalPolicy
}

function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'expected array of strings')
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(`${path}[${index}]`, 'missing element')
    if (typeof value[index] !== 'string') fail(`${path}[${index}]`, 'expected string')
  }
  return value as string[]
}

function parseObservation(value: unknown, path: string): JudgeObservation {
  const record = exactObject(value, path, OBSERVATION_KEYS)
  if (!isSafeCount(record.observedAt)) fail(`${path}.observedAt`, 'expected non-negative safe integer')
  const observedAt = record.observedAt
  const heartbeatAt = record.heartbeatAt
  if (heartbeatAt !== null && (!isSafeCount(heartbeatAt) || heartbeatAt > observedAt)) {
    fail(`${path}.heartbeatAt`, 'expected null or safe integer not after observedAt')
  }
  const lease = record.lease
  if (lease !== null) {
    if (!isRecord(lease)) fail(`${path}.lease`, 'expected null or object')
    const leaseRecord = exactObject(lease, `${path}.lease`, LEASE_KEYS)
    if (!isSafeCount(leaseRecord.expiresAt)) fail(`${path}.lease.expiresAt`, 'expected non-negative safe integer')
    if (typeof leaseRecord.current !== 'boolean') fail(`${path}.lease.current`, 'expected boolean')
  }
  if (record.deadlineAt !== null && !isSafeCount(record.deadlineAt)) {
    fail(`${path}.deadlineAt`, 'expected null or non-negative safe integer')
  }
  const disk = record.disk
  if (disk !== null) {
    if (!isRecord(disk)) fail(`${path}.disk`, 'expected null or object')
    const diskRecord = exactObject(disk, `${path}.disk`, DISK_KEYS)
    if (!isSafeCount(diskRecord.availableBytes)) fail(`${path}.disk.availableBytes`, 'expected non-negative safe integer')
    if (!isSafeCount(diskRecord.requiredBytes)) fail(`${path}.disk.requiredBytes`, 'expected non-negative safe integer')
  }
  for (const key of COUNT_KEYS) {
    if (!isSafeCount(record[key])) fail(`${path}.${key}`, 'expected non-negative safe integer')
  }
  parseStringArray(record.protectedPathEdits, `${path}.protectedPathEdits`)
  parseStringArray(record.outOfScopeEdits, `${path}.outOfScopeEdits`)
  if (record.tokenBudgetForItem !== null && !isPositiveInteger(record.tokenBudgetForItem)) {
    fail(`${path}.tokenBudgetForItem`, 'expected null or positive safe integer')
  }
  if (typeof record.crashed !== 'boolean') fail(`${path}.crashed`, 'expected boolean')
  return record as unknown as JudgeObservation
}

function parseStep(value: unknown, path: string): ReplayStep {
  const record = exactObject(value, path, STEP_REQUIRED_KEYS, ['claimsDone', 'acceptancePassed', 'unknownFacts'])
  parseObservation(record.observation, `${path}.observation`)
  if (Object.hasOwn(record, 'claimsDone') && typeof record.claimsDone !== 'boolean') {
    fail(`${path}.claimsDone`, 'expected boolean')
  }
  if (Object.hasOwn(record, 'acceptancePassed')
    && record.acceptancePassed !== null
    && typeof record.acceptancePassed !== 'boolean') {
    fail(`${path}.acceptancePassed`, 'expected null or boolean')
  }
  if (Object.hasOwn(record, 'unknownFacts')) {
    const facts = record.unknownFacts
    if (!Array.isArray(facts)) fail(`${path}.unknownFacts`, 'expected array')
    const seen = new Set<string>()
    for (let index = 0; index < facts.length; index++) {
      const fact = facts[index]
      if (typeof fact !== 'string' || !(JUDGE_UNKNOWN_FACTS as readonly string[]).includes(fact)) {
        fail(`${path}.unknownFacts[${index}]`, 'expected a known unknown fact')
      }
      if (seen.has(fact)) fail(`${path}.unknownFacts[${index}]`, 'duplicate unknown fact')
      seen.add(fact)
    }
  }
  return record as unknown as ReplayStep
}

function parseLabels(value: unknown, path: string, stepCount: number): { fault: FaultClass; firstStep: number }[] {
  if (!Array.isArray(value)) fail(path, 'expected array')
  const seen = new Set<FaultClass>()
  for (let index = 0; index < value.length; index++) {
    const labelPath = `${path}[${index}]`
    const record = exactObject(value[index], labelPath, LABEL_KEYS)
    if (!isFaultClass(record.fault)) fail(`${labelPath}.fault`, 'expected fault class')
    if (!isSafeCount(record.firstStep)) fail(`${labelPath}.firstStep`, 'expected non-negative safe integer')
    if (record.firstStep >= stepCount) fail(`${labelPath}.firstStep`, `expected an index below steps length ${stepCount}`)
    if (seen.has(record.fault)) fail(`${labelPath}.fault`, 'duplicate label for fault class')
    seen.add(record.fault)
  }
  return value as { fault: FaultClass; firstStep: number }[]
}

function parseRun(value: unknown, path: string): ReplayRun {
  const record = exactObject(value, path, RUN_KEYS)
  if (typeof record.id !== 'string' || record.id.length === 0) fail(`${path}.id`, 'expected non-empty string')
  if (record.origin !== 'synthetic' && record.origin !== 'recorded') {
    fail(`${path}.origin`, 'expected synthetic or recorded')
  }
  const policy = parsePolicy(record.policy, `${path}.policy`)
  if (!Array.isArray(record.steps)) fail(`${path}.steps`, 'expected array')
  const steps: ReplayStep[] = []
  let previousObservedAt: number | null = null
  for (let index = 0; index < record.steps.length; index++) {
    const stepPath = `${path}.steps[${index}]`
    const step = parseStep(record.steps[index], stepPath)
    const observedAt = step.observation.observedAt
    // A host clock can return the same millisecond at two boundaries. Equal times are valid;
    // order is carried by the corpus order, never invented by the parser.
    if (previousObservedAt !== null && observedAt < previousObservedAt) {
      fail(`${stepPath}.observation.observedAt`, 'expected non-decreasing time')
    }
    previousObservedAt = observedAt
    steps.push(step)
  }
  const labels = parseLabels(record.labels, `${path}.labels`, steps.length)
  return { id: record.id, origin: record.origin, policy, steps, labels }
}

/** Strict replay parser. Unknown keys, malformed versions and values, non-increasing
 * observation times, out-of-range or duplicate labels and duplicate run ids fail with a
 * TypeError whose message starts with the offending path. Input is validated, not cloned. */
export function parseReplayCorpus(value: unknown): ReplayCorpus {
  const record = exactObject(value, 'corpus', CORPUS_KEYS)
  if (record.version !== 1) fail('corpus.version', 'expected 1')
  if (!Array.isArray(record.runs)) fail('corpus.runs', 'expected array')
  const runs: ReplayRun[] = []
  const ids = new Set<string>()
  for (let index = 0; index < record.runs.length; index++) {
    const runPath = `corpus.runs[${index}]`
    const run = parseRun(record.runs[index], runPath)
    if (ids.has(run.id)) fail(`${runPath}.id`, 'duplicate run id')
    ids.add(run.id)
    runs.push(run)
  }
  return { version: 1, runs }
}

/** A signal whose observation source is declared unobserved is not a healthy zero when it does
 * not fire. The step stays out of firedSteps and is reported as unknown instead. */
const SIGNAL_UNKNOWN_FACTS: Readonly<Record<string, readonly JudgeUnknownFact[]>> = {
  heartbeat_stall: ['heartbeat'],
  lease_lost: ['lease'],
  deadline: ['deadline'],
  disk: ['disk'],
  crash: ['crash'],
  repeated_failure: ['failureStreak'],
  edit_revert: ['editRevert'],
  repeated_dead_end: ['deadEnds'],
  protected_path_edit: ['pathEdits'],
  out_of_scope_edit: ['pathEdits'],
  token_blowup: ['tokenBudget', 'itemTokens'],
}

function signalDetector(matches: (code: string) => boolean): Detector {
  return run => {
    const firedSteps: number[] = []
    const unknown = new Set<number>()
    for (let index = 0; index < run.steps.length; index++) {
      const step = run.steps[index]!
      const signals = evaluateJudgeSignals(step.observation, run.policy)
      let fired = false
      for (const signal of signals) if (matches(signal.code)) fired = true
      if (fired) { firedSteps.push(index); continue }
      const facts = step.unknownFacts ?? []
      if (facts.some(fact => Object.entries(SIGNAL_UNKNOWN_FACTS)
        .some(([code, needed]) => matches(code) && needed.includes(fact)))) unknown.add(index)
    }
    return { firedSteps, unknownSteps: [...unknown].sort((left, right) => left - right) }
  }
}

/** Rule-based J0 premature-done detector. A done claim with explicit acceptance=false is a
 * firing. A done claim with acceptance null or absent is unknown, never a firing. */
function detectPrematureDone(run: ReplayRun): DetectorResult {
  const firedSteps: number[] = []
  const unknownSteps: number[] = []
  for (let index = 0; index < run.steps.length; index++) {
    const step = run.steps[index]!
    if (step.claimsDone !== true) continue
    if (step.acceptancePassed === false) firedSteps.push(index)
    else if (step.acceptancePassed !== true) unknownSteps.push(index)
  }
  return { firedSteps, unknownSteps }
}

export const DEFAULT_DETECTORS: Readonly<Record<FaultClass, Detector>> = Object.freeze({
  loop: signalDetector(code => LOOP_SIGNALS.has(code)),
  protected_path_edit: signalDetector(code => code === 'protected_path_edit'),
  out_of_scope_edit: signalDetector(code => code === 'out_of_scope_edit'),
  stall: signalDetector(code => code === 'heartbeat_stall'),
  premature_done: detectPrematureDone,
})

function resolveDetectors(custom?: Partial<Record<FaultClass, Detector>>): Record<FaultClass, Detector> {
  const resolved = { ...DEFAULT_DETECTORS } as Record<FaultClass, Detector>
  if (custom === undefined) return resolved
  if (!isRecord(custom)) throw new TypeError('detectors: expected object')
  for (const fault of FAULT_CLASSES) {
    if (!Object.hasOwn(custom, fault)) continue
    const detector = custom[fault]
    if (detector === undefined) continue
    if (typeof detector !== 'function') throw new TypeError(`detectors.${fault}: expected function`)
    resolved[fault] = detector
  }
  return resolved
}

function detectorSteps(result: unknown, run: ReplayRun, path: string, key: 'firedSteps' | 'unknownSteps'): number[] {
  if (!isRecord(result)) throw new TypeError(`${path}: expected detector result object`)
  const value = result[key]
  if (value === undefined && key === 'unknownSteps') return []
  if (!Array.isArray(value)) throw new TypeError(`${path}.${key}: expected array`)
  const seen = new Set<number>()
  const steps: number[] = []
  for (let index = 0; index < value.length; index++) {
    const step = value[index]
    if (!isSafeCount(step) || step >= run.steps.length) {
      throw new TypeError(`${path}.${key}[${index}]: expected step index below ${run.steps.length}`)
    }
    if (seen.has(step)) throw new TypeError(`${path}.${key}[${index}]: duplicate step index`)
    seen.add(step)
    steps.push(step)
  }
  return steps
}

interface Outcome {
  tp: boolean
  fp: boolean
  fn: boolean
  tn: boolean
  latency: number | null
  unknown: number
}

function runOutcome(run: ReplayRun, fault: FaultClass, detector: Detector): Outcome {
  const result = detector(run)
  const firedSteps = detectorSteps(result, run, `detectors.${fault}(${run.id})`, 'firedSteps')
  const unknownSteps = detectorSteps(result, run, `detectors.${fault}(${run.id})`, 'unknownSteps')
  const label = run.labels.find(candidate => candidate.fault === fault)
  if (label === undefined) {
    const fired = firedSteps.length > 0
    return { tp: false, fp: fired, fn: false, tn: !fired, latency: null, unknown: unknownSteps.length }
  }
  const onsetFirings = firedSteps.filter(step => step >= label.firstStep)
  const early = firedSteps.some(step => step < label.firstStep)
  const tp = onsetFirings.length > 0
  let latency: number | null = null
  if (tp) {
    let firstOnset = onsetFirings[0]!
    for (const step of onsetFirings) if (step < firstOnset) firstOnset = step
    latency = firstOnset - label.firstStep
  }
  // A firing before onset is a run-level false positive even when a later firing detects the
  // fault. If no firing lands at/after onset the run is also a false negative.
  return {
    tp,
    fp: early,
    fn: !tp,
    tn: false,
    latency,
    unknown: unknownSteps.length,
  }
}

interface Accumulator {
  tp: number
  fp: number
  fn: number
  tn: number
  latencies: number[]
  unknown: number
}

function emptyAccumulator(): Accumulator {
  return { tp: 0, fp: 0, fn: 0, tn: 0, latencies: [], unknown: 0 }
}

function addOutcome(accumulator: Accumulator, outcome: Outcome): void {
  if (outcome.tp) accumulator.tp += 1
  if (outcome.fp) accumulator.fp += 1
  if (outcome.fn) accumulator.fn += 1
  if (outcome.tn) accumulator.tn += 1
  if (outcome.latency !== null) accumulator.latencies.push(outcome.latency)
  accumulator.unknown += outcome.unknown
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function max(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let maximum = values[0]!
  for (const value of values) if (value > maximum) maximum = value
  return maximum
}

function scoreAccumulator(accumulator: Accumulator): ClassScore {
  const { tp, fp, fn, tn } = accumulator
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    latency: { median: median(accumulator.latencies), max: max(accumulator.latencies) },
    unknown: accumulator.unknown,
  }
}

function sumAccumulators(accumulators: readonly Accumulator[]): Accumulator {
  const total = emptyAccumulator()
  for (const accumulator of accumulators) {
    total.tp += accumulator.tp
    total.fp += accumulator.fp
    total.fn += accumulator.fn
    total.tn += accumulator.tn
    total.latencies.push(...accumulator.latencies)
    total.unknown += accumulator.unknown
  }
  return total
}

interface Aggregate {
  classes: Record<FaultClass, FaultClassScore>
  micro: MicroScore
  labelledRuns: number
}

function aggregate(runs: readonly ReplayRun[], detectors: Record<FaultClass, Detector>): Aggregate {
  const classes = {} as Record<FaultClass, FaultClassScore>
  const accumulators: Accumulator[] = []
  for (const fault of FAULT_CLASSES) {
    const accumulator = emptyAccumulator()
    for (const run of runs) addOutcome(accumulator, runOutcome(run, fault, detectors[fault]))
    accumulators.push(accumulator)
    classes[fault] = { fault, ...scoreAccumulator(accumulator) }
  }
  return {
    classes,
    micro: scoreAccumulator(sumAccumulators(accumulators)),
    labelledRuns: runs.filter(run => run.labels.length > 0).length,
  }
}

function originScore(runs: readonly ReplayRun[], origin: ReplayOrigin, detectors: Record<FaultClass, Detector>): OriginScore {
  const selected = runs.filter(run => run.origin === origin)
  const aggregateScore = aggregate(selected, detectors)
  return {
    runs: selected.length,
    labelledRuns: aggregateScore.labelledRuns,
    classes: aggregateScore.classes,
    micro: aggregateScore.micro,
  }
}

/** The R3 rule is evaluated only on a non-empty, fully recorded corpus with at least one
 * labelled run for loop, protected_path_edit and premature_done. `met` requires EACH required
 * class to reach the thresholds, so a large class cannot hide another at zero recall; the
 * optional classes (stall, out_of_scope_edit) are reported but do not decide the gate. */
function evaluateGate(runs: readonly ReplayRun[], classes: Record<FaultClass, ClassScore>): GateScore {
  if (runs.length === 0) {
    return { rule: R3_GATE_RULE, evaluated: false, reason: 'empty_corpus' }
  }
  if (runs.every(run => run.origin === 'synthetic')) {
    return { rule: R3_GATE_RULE, evaluated: false, reason: 'synthetic_corpus' }
  }
  if (!runs.every(run => run.origin === 'recorded')) {
    return { rule: R3_GATE_RULE, evaluated: false, reason: 'not_all_runs_recorded' }
  }
  const missing = REQUIRED_GATE_CLASSES.some(fault =>
    !runs.some(run => run.labels.some(label => label.fault === fault)))
  if (missing) {
    return { rule: R3_GATE_RULE, evaluated: false, reason: 'missing_required_classes' }
  }
  return {
    rule: R3_GATE_RULE,
    evaluated: true,
    reason: 'recorded_corpus',
    met: REQUIRED_GATE_CLASSES.every(fault => {
      const c = classes[fault]
      return c.precision !== null && c.recall !== null && c.recall >= 0.9 && c.precision >= 0.8
    }),
  }
}

/** Score a parsed corpus. One run may contribute both a true positive and (when it fired before
 * onset) a false positive; a positive run with only early or no firing contributes a false
 * negative. Precision and recall are null when their denominator is zero. */
export function score(
  corpus: ReplayCorpus,
  detectors?: Partial<Record<FaultClass, Detector>>,
): ReplayScore {
  const active = resolveDetectors(detectors)
  const overall = aggregate(corpus.runs, active)
  return {
    runs: corpus.runs.length,
    labelledRuns: overall.labelledRuns,
    classes: overall.classes,
    micro: overall.micro,
    origins: {
      synthetic: originScore(corpus.runs, 'synthetic', active),
      recorded: originScore(corpus.runs, 'recorded', active),
    },
    gate: evaluateGate(corpus.runs, overall.classes),
  }
}
