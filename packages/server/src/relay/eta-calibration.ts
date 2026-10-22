/** Offline ETA P80 coverage corpus and scorer. A calibration corpus is data only: this module
 * reads no clock, filesystem, model or relay state. Synthetic samples are explicitly not gate
 * evidence; only a fully recorded corpus with at least 20 distinct eligible runs may evaluate
 * the R3 ETA gate. A passed gate measures this corpus, not live calibration: ETA projections
 * keep their own `low` confidence and `unvalidated` calibration until real runs are collected. */

export const ETA_ORIGINS = ['synthetic', 'recorded'] as const
export type EtaOrigin = (typeof ETA_ORIGINS)[number]

export const ETA_OUTCOMES = ['completed', 'canceled', 'failed', 'interrupted'] as const
export type EtaOutcome = (typeof ETA_OUTCOMES)[number]

export const ETA_INELIGIBLE_REASONS = ['not_completed', 'unknown_actual', 'unknown_projection'] as const
export type EtaIneligibleReason = (typeof ETA_INELIGIBLE_REASONS)[number]

export const ETA_PER_RUN_MODES = ['first', 'last', 'all'] as const
export type EtaPerRun = (typeof ETA_PER_RUN_MODES)[number]

export interface EtaSample {
  runId: string
  origin: EtaOrigin
  cohort: string
  /** Non-negative safe integer milliseconds. */
  projectedAt: number
  p50FinishAt: number | null
  p80FinishAt: number | null
  actualFinishAt: number | null
  outcome: EtaOutcome
}

export interface EtaCorpus {
  version: 1
  samples: EtaSample[]
}

export const R3_ETA_GATE_RULE = 'R3: ETA P80 coverage in [0.7, 0.9] over >= 20 runs' as const

export interface WilsonInterval {
  lower: number
  upper: number
}

export interface EtaCoverageScore {
  /** Selected projections contributing to this overall or cohort row. */
  selected: number
  /** Selected projections that are completed with known actual and P80 finish times. */
  eligible: number
  /** Eligible projections whose actual finish is at or before P80 (the boundary counts). */
  covered: number
  /** covered / eligible; null when there is no eligible sample. */
  p80Coverage: number | null
  /** Eligible projections that also have a known P50 finish time. */
  p50Eligible: number
  /** p50Eligible projections whose actual finish is at or before P50 (the boundary counts). */
  p50Covered: number
  /** p50Covered / p50Eligible; null when no eligible projection has a known P50. */
  p50Coverage: number | null
  /** Distinct run ids among eligible projections. */
  runs: number
  /** Wilson 95% interval for p80Coverage; null when there is no eligible sample. */
  wilson95: WilsonInterval | null
}

export interface EtaCohortScore extends EtaCoverageScore {
  cohort: string
}

export type EtaGateReason =
  | 'empty_corpus'
  | 'synthetic_corpus'
  | 'not_all_samples_recorded'
  | 'insufficient_runs'
  | 'recorded_corpus'

export interface EtaGate {
  rule: typeof R3_ETA_GATE_RULE
  evaluated: boolean
  reason: EtaGateReason
  /** Present only when evaluated. Point-estimate coverage inside the inclusive gate range. */
  met?: boolean
  /** Present only when evaluated. Whether the Wilson interval lies inside the gate range.
   * Information only: it never decides `met`. */
  wilsonInside?: boolean
}

export interface EtaScore {
  /** Selection mode used for this score. */
  perRun: EtaPerRun
  /** Samples in the corpus. */
  samples: number
  /** Projections selected by the per-run mode. */
  selected: number
  /** Distinct run ids in the corpus. */
  runs: number
  /** Selected eligible projections (the P80 denominator). */
  eligible: number
  /** Distinct run ids among selected eligible projections (the gate run count). */
  eligibleRuns: number
  /** Selected projections excluded from eligibility, by precedence reason. */
  reasons: Record<EtaIneligibleReason, number>
  overall: EtaCoverageScore
  /** One row per cohort represented by the selected projections, sorted by cohort. */
  cohorts: EtaCohortScore[]
  gate: EtaGate
}

const CORPUS_KEYS = ['version', 'samples'] as const
const SAMPLE_KEYS = [
  'runId', 'origin', 'cohort', 'projectedAt', 'p50FinishAt', 'p80FinishAt', 'actualFinishAt', 'outcome',
] as const
const WILSON_Z = 1.96
const GATE_MIN_RUNS = 20

function fail(path: string, message: string): never {
  throw new TypeError(`${path}: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function exactObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'expected object')
  const allowed = new Set(requiredKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown key')
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing key')
  }
  return value
}

function parseSample(value: unknown, path: string): EtaSample {
  const record = exactObject(value, path, SAMPLE_KEYS)
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    fail(`${path}.runId`, 'expected non-empty string')
  }
  if (typeof record.cohort !== 'string' || record.cohort.length === 0) {
    fail(`${path}.cohort`, 'expected non-empty string')
  }
  if (record.origin !== 'synthetic' && record.origin !== 'recorded') {
    fail(`${path}.origin`, 'expected synthetic or recorded')
  }
  if (!(ETA_OUTCOMES as readonly unknown[]).includes(record.outcome)) {
    fail(`${path}.outcome`, 'expected completed, canceled, failed or interrupted')
  }
  if (!isSafeTime(record.projectedAt)) {
    fail(`${path}.projectedAt`, 'expected non-negative safe integer')
  }
  const projectedAt = record.projectedAt
  const p50 = record.p50FinishAt
  const p80 = record.p80FinishAt
  if (p50 !== null && !isSafeTime(p50)) {
    fail(`${path}.p50FinishAt`, 'expected null or non-negative safe integer')
  }
  if (p80 !== null && !isSafeTime(p80)) {
    fail(`${path}.p80FinishAt`, 'expected null or non-negative safe integer')
  }
  if (p50 !== null && p50 <= projectedAt) {
    fail(`${path}.p50FinishAt`, 'expected a finish time after projectedAt')
  }
  if (p80 !== null && p80 <= projectedAt) {
    fail(`${path}.p80FinishAt`, 'expected a finish time after projectedAt')
  }
  if (p50 !== null && p80 !== null && p50 > p80) {
    fail(`${path}.p80FinishAt`, 'expected P80 at or after P50')
  }
  if (record.actualFinishAt !== null && !isSafeTime(record.actualFinishAt)) {
    fail(`${path}.actualFinishAt`, 'expected null or non-negative safe integer')
  }
  return record as unknown as EtaSample
}

/** Strict ETA corpus parser. Unknown keys, malformed versions and values, a known finish not
 * after projectedAt, reversed P50/P80 and duplicate (runId, projectedAt) pairs fail with a
 * TypeError whose message starts with the offending path. P50 and P80 are independently
 * nullable. Input is validated, not cloned. */
export function parseEtaCorpus(value: unknown): EtaCorpus {
  const record = exactObject(value, 'corpus', CORPUS_KEYS)
  if (record.version !== 1) fail('corpus.version', 'expected 1')
  if (!Array.isArray(record.samples)) fail('corpus.samples', 'expected array')
  const samples: EtaSample[] = []
  const seen = new Set<string>()
  for (let index = 0; index < record.samples.length; index++) {
    const samplePath = `corpus.samples[${index}]`
    const sample = parseSample(record.samples[index], samplePath)
    const key = JSON.stringify([sample.runId, sample.projectedAt])
    if (seen.has(key)) fail(`${samplePath}.runId`, 'duplicate (runId, projectedAt)')
    seen.add(key)
    samples.push(sample)
  }
  return { version: 1, samples }
}

type EligibleSample = EtaSample & { actualFinishAt: number; p80FinishAt: number }

/** Precedence is explicit: a non-completed outcome is reported before a missing actual, and a
 * missing actual is reported before a missing P80. */
function ineligibleReason(sample: EtaSample): EtaIneligibleReason | null {
  if (sample.outcome !== 'completed') return 'not_completed'
  if (sample.actualFinishAt === null) return 'unknown_actual'
  if (sample.p80FinishAt === null) return 'unknown_projection'
  return null
}

function isEligibleSample(sample: EtaSample): sample is EligibleSample {
  return ineligibleReason(sample) === null
}

/** Selection happens before eligibility classification: `first`/`last` choose one projection
 * per run by projectedAt, then that projection is accepted or counted by reason. */
function selectSamples(samples: readonly EtaSample[], perRun: EtaPerRun): EtaSample[] {
  if (perRun === 'all') return [...samples]
  const selected = new Map<string, EtaSample>()
  for (const sample of samples) {
    const current = selected.get(sample.runId)
    const replace = current === undefined
      || (perRun === 'first' ? sample.projectedAt < current.projectedAt : sample.projectedAt > current.projectedAt)
    if (replace) selected.set(sample.runId, sample)
  }
  return [...selected.values()]
}

/** Two-sided Wilson score interval for a binomial proportion with z = 1.96, clamped to [0, 1].
 * With p = covered / n and z² = 3.8416:
 *   denominator = 1 + z²/n
 *   centre      = (p + z²/(2n)) / denominator
 *   margin      = (z / denominator) * sqrt(p(1-p)/n + z²/(4n²))
 *   interval    = [max(0, centre - margin), min(1, centre + margin)]
 * Returns null for an empty denominator. */
function wilson95(covered: number, eligible: number): WilsonInterval | null {
  if (eligible === 0) return null
  const p = covered / eligible
  const z2 = WILSON_Z * WILSON_Z
  const denominator = 1 + z2 / eligible
  const centre = (p + z2 / (2 * eligible)) / denominator
  const margin = (WILSON_Z / denominator)
    * Math.sqrt((p * (1 - p)) / eligible + z2 / (4 * eligible * eligible))
  return { lower: Math.max(0, centre - margin), upper: Math.min(1, centre + margin) }
}

function coverageOf(selected: readonly EtaSample[], eligible: readonly EligibleSample[]): EtaCoverageScore {
  let covered = 0
  let p50Eligible = 0
  let p50Covered = 0
  const runs = new Set<string>()
  for (const sample of eligible) {
    runs.add(sample.runId)
    if (sample.actualFinishAt <= sample.p80FinishAt) covered += 1
    if (sample.p50FinishAt !== null) {
      p50Eligible += 1
      if (sample.actualFinishAt <= sample.p50FinishAt) p50Covered += 1
    }
  }
  return {
    selected: selected.length,
    eligible: eligible.length,
    covered,
    p80Coverage: eligible.length === 0 ? null : covered / eligible.length,
    p50Eligible,
    p50Covered,
    p50Coverage: p50Eligible === 0 ? null : p50Covered / p50Eligible,
    runs: runs.size,
    wilson95: wilson95(covered, eligible.length),
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resolvePerRun(opts: { perRun?: EtaPerRun } | undefined): EtaPerRun {
  if (opts === undefined) return 'first'
  if (!isRecord(opts)) throw new TypeError('opts: expected object')
  for (const key of Object.keys(opts)) {
    if (key !== 'perRun') throw new TypeError(`opts.${key}: unknown key`)
  }
  const perRun = opts.perRun
  if (perRun === undefined) return 'first'
  if (typeof perRun !== 'string' || !(ETA_PER_RUN_MODES as readonly string[]).includes(perRun)) {
    throw new TypeError('opts.perRun: expected first, last or all')
  }
  return perRun as EtaPerRun
}

/** The gate is evaluated only for a non-empty, fully recorded corpus with at least 20 distinct
 * eligible runs. `met` is the point estimate inside the inclusive [0.7, 0.9] range; the Wilson
 * interval is reported as information only and never changes `met`. */
function evaluateGate(
  samples: readonly EtaSample[],
  overall: EtaCoverageScore,
  eligibleRuns: number,
): EtaGate {
  const rule = R3_ETA_GATE_RULE
  if (samples.length === 0) return { rule, evaluated: false, reason: 'empty_corpus' }
  if (samples.every(sample => sample.origin === 'synthetic')) {
    return { rule, evaluated: false, reason: 'synthetic_corpus' }
  }
  if (!samples.every(sample => sample.origin === 'recorded')) {
    return { rule, evaluated: false, reason: 'not_all_samples_recorded' }
  }
  if (eligibleRuns < GATE_MIN_RUNS) {
    return { rule, evaluated: false, reason: 'insufficient_runs' }
  }
  const coverage = overall.p80Coverage
  const interval = overall.wilson95
  return {
    rule,
    evaluated: true,
    reason: 'recorded_corpus',
    met: coverage !== null && coverage >= 0.7 && coverage <= 0.9,
    wilsonInside: interval !== null && interval.lower >= 0.7 && interval.upper <= 0.9,
  }
}

/** Score a parsed corpus. `first` (default) selects the earliest projectedAt per run, `last`
 * the latest and `all` every projection. Coverage is computed over selected projections;
 * ineligible selected projections are counted by reason. Pure and deterministic: the input is
 * never mutated. */
export function scoreEta(corpus: EtaCorpus, opts?: { perRun?: EtaPerRun }): EtaScore {
  const perRun = resolvePerRun(opts)
  const selected = selectSamples(corpus.samples, perRun)
  const reasons: Record<EtaIneligibleReason, number> = {
    not_completed: 0,
    unknown_actual: 0,
    unknown_projection: 0,
  }
  const eligible: EligibleSample[] = []
  for (const sample of selected) {
    const reason = ineligibleReason(sample)
    if (reason === null) eligible.push(sample as EligibleSample)
    else reasons[reason] += 1
  }
  const overall = coverageOf(selected, eligible)

  const byCohort = new Map<string, EtaSample[]>()
  for (const sample of selected) {
    const members = byCohort.get(sample.cohort)
    if (members === undefined) byCohort.set(sample.cohort, [sample])
    else members.push(sample)
  }
  const cohorts = [...byCohort.keys()].sort(compareText).map(cohort => {
    const members = byCohort.get(cohort)!
    return { cohort, ...coverageOf(members, members.filter(isEligibleSample)) }
  })

  return {
    perRun,
    samples: corpus.samples.length,
    selected: selected.length,
    runs: new Set(corpus.samples.map(sample => sample.runId)).size,
    eligible: eligible.length,
    eligibleRuns: overall.runs,
    reasons,
    overall,
    cohorts,
    gate: evaluateGate(corpus.samples, overall, overall.runs),
  }
}
