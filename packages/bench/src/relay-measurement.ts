// B3-a: descriptive reducer over a validated relay measurement envelope. It counts what was
// supplied. It evaluates no B3 exit criterion, credits no real evidence and imputes nothing.
import {
  RELAY_ARM_KINDS, RELAY_FIELD_KEYS, RELAY_OUTCOMES, checkRelayMeasurement, RelayMeasurementError,
  type RelayArmKind, type RelayMeasurementInput, type RelayObservedCycle, type RelayObservedTrial,
} from './relay-protocol.ts'

export const RELAY_REPORT_FORMAT = 'guanxi.b3.measurement-report/v1' as const
export const RELAY_CRITERIA = ['itemSuccessSlope', 'relayVsNaiveNonInferiority', 'criticalProbeAccuracy', 'guardedDeadEndRepeats', 'truncation', 'ledgerHandoffConsistency', 'etaP80Coverage'] as const
export type RelayCriterion = typeof RELAY_CRITERIA[number]
/** The only state a criterion can have in this slice. There is deliberately no passed/failed. */
export interface RelayUnevaluated { state: 'unevaluated'; reasons: readonly string[] }
type Outcome = typeof RELAY_OUTCOMES[number]
type Field = typeof RELAY_FIELD_KEYS[number]
type Num = { [k: string]: number | Num }

const frac = (n: number, d: number): number | null => d > 0 ? n / d : null
const zeroCounts = <T extends string>(keys: readonly T[]) => Object.fromEntries(keys.map(k => [k, 0])) as Record<T, number>
function add(to: Num, from: Num): void {
  for (const k of Object.keys(to)) {
    const a = to[k]!; const b = from[k]!
    if (typeof a === 'number' && typeof b === 'number') to[k] = a + b
    else if (typeof a === 'object' && typeof b === 'object') add(a, b)
  }
}

const bucket = () => ({ expected: 0, firstCorrect: 0, firstIncorrect: 0, firstUnknown: 0, finalCorrect: 0, finalIncorrect: 0, finalUnknown: 0, retryRescued: 0, retryAttempts: 0 })
const itemAcc = () => ({ groupsObserved: 0, groupsUnknown: 0, expected: 0, passed: 0, failed: 0, unknown: 0 })
const probeAcc = () => ({ groupsObserved: 0, groupsUnknown: 0, wholeAnswer: bucket(), criticalField: bucket(), byField: Object.fromEntries(RELAY_FIELD_KEYS.map(f => [f, bucket()])) as Record<Field, ReturnType<typeof bucket>> })
const contextAcc = () => ({ groupsObserved: 0, groupsUnknown: 0, expected: 0, observed: 0, unknown: 0, truncatedSamples: 0, truncationEvents: 0, windowMismatches: 0, overWindow: 0 })
const guardAcc = () => ({ groupsObserved: 0, groupsUnknown: 0, expected: 0, observed: 0, unknown: 0, guardedRepeats: 0, unguardedRepeats: 0, guardInactive: 0 })
const integrityAcc = () => ({ observed: 0, unknown: 0, reportedMatch: 0, reportedMismatch: 0, reportedValidationPassed: 0, reportedValidationFailed: 0 })
const cycleAcc = () => ({
  trialsMissing: 0, observed: 0, unknown: 0, notReached: 0,
  items: itemAcc(), probes: probeAcc(), context: contextAcc(), guards: guardAcc(), integrity: integrityAcc(),
})
type CycleAcc = ReturnType<typeof cycleAcc>

function unknownGroups(c: CycleAcc): void {
  c.items.groupsUnknown++; c.probes.groupsUnknown++; c.context.groupsUnknown++; c.guards.groupsUnknown++; c.integrity.unknown++
}
function addCycle(c: CycleAcc, cycle: RelayObservedCycle, windowTokens: number): void {
  c.observed++
  const items = cycle.items
  if (items.state === 'unknown') c.items.groupsUnknown++
  else {
    c.items.groupsObserved++; c.items.expected += items.manifest.opportunities.length
    for (const a of items.assessments) { if (a.state === 'unknown') c.items.unknown++; else if (a.result === 'passed') c.items.passed++; else c.items.failed++ }
  }
  const probes = cycle.probes
  if (probes.state === 'unknown') c.probes.groupsUnknown++
  else {
    c.probes.groupsObserved++
    for (const o of probes.manifest.occasions) {
      const rows = probes.grades.filter(g => g.occasion === o.id).sort((a, b) => a.attempt - b.attempt)
      const first = rows[0]!; const last = rows[rows.length - 1]!
      const targets = o.scope === 'whole_answer' ? [c.probes.wholeAnswer] : [c.probes.criticalField, c.probes.byField[o.field!]]
      for (const b of targets) {
        b.expected++
        if (first.state === 'unknown') b.firstUnknown++; else if (first.result === 'correct') b.firstCorrect++; else b.firstIncorrect++
        if (last.state === 'unknown') b.finalUnknown++; else if (last.result === 'correct') b.finalCorrect++; else b.finalIncorrect++
        b.retryAttempts += rows.length - 1
        if (first.state === 'observed' && first.result === 'incorrect' && rows.some(r => r.state === 'observed' && r.result === 'correct')) b.retryRescued++
      }
    }
  }
  const context = cycle.context
  if (context.state === 'unknown') c.context.groupsUnknown++
  else {
    c.context.groupsObserved++; c.context.expected += context.manifest.samples.length
    for (const s of context.samples) {
      if (s.state === 'unknown') { c.context.unknown++; continue }
      c.context.observed++
      if (s.truncationEvents > 0) { c.context.truncatedSamples++; c.context.truncationEvents += s.truncationEvents }
      if (s.actualWindowTokens !== windowTokens) c.context.windowMismatches++
      if (s.renderedTokens > s.actualWindowTokens) c.context.overWindow++
    }
  }
  const guards = cycle.guards
  if (guards.state === 'unknown') c.guards.groupsUnknown++
  else {
    c.guards.groupsObserved++; c.guards.expected += guards.manifest.checks.length
    for (const k of guards.checks) {
      if (k.state === 'unknown') { c.guards.unknown++; continue }
      c.guards.observed++
      if (!k.guardActive) c.guards.guardInactive++
      if (k.repeated) { if (k.guardActive) c.guards.guardedRepeats++; else c.guards.unguardedRepeats++ }
    }
  }
  const integrity = cycle.integrity
  if (integrity.state === 'unknown') c.integrity.unknown++
  else {
    c.integrity.observed++
    // Local agreement of two supplied strings. It never authenticates a canonical ledger or seal.
    if (integrity.value.ledgerSha256 === integrity.value.handoffLedgerSha256) c.integrity.reportedMatch++; else c.integrity.reportedMismatch++
    if (integrity.value.reportedValidation === 'passed') c.integrity.reportedValidationPassed++; else c.integrity.reportedValidationFailed++
  }
}

const bucketOut = (b: ReturnType<typeof bucket>, denominatorKnown: boolean) => ({
  ...b,
  firstAttemptCorrectOverExpected: denominatorKnown ? frac(b.firstCorrect, b.expected) : null,
  afterRetryCorrectOverExpected: denominatorKnown ? frac(b.finalCorrect, b.expected) : null,
  firstAttemptKnownOnlyAccuracy: denominatorKnown ? frac(b.firstCorrect, b.firstCorrect + b.firstIncorrect) : null,
  complete: denominatorKnown && b.firstUnknown === 0 && b.finalUnknown === 0,
})
function cycleOut(c: CycleAcc) {
  const i = c.items; const p = c.probes; const x = c.context; const g = c.guards
  // A denominator is known only when at least one group was observed and none is unknown or missing.
  const itemsKnown = i.groupsUnknown === 0 && i.groupsObserved > 0; const probesKnown = p.groupsUnknown === 0 && p.groupsObserved > 0
  const contextKnown = x.groupsUnknown === 0 && x.groupsObserved > 0; const guardsKnown = g.groupsUnknown === 0 && g.groupsObserved > 0
  return {
    cycles: { observed: c.observed, unknown: c.unknown, notReached: c.notReached, trialsMissing: c.trialsMissing },
    items: { ...i, denominatorKnown: itemsKnown, complete: itemsKnown && i.unknown === 0,
      passedOverExpected: itemsKnown ? frac(i.passed, i.expected) : null, knownOnlyPassed: itemsKnown ? frac(i.passed, i.passed + i.failed) : null },
    probes: {
      groupsObserved: p.groupsObserved, groupsUnknown: p.groupsUnknown, denominatorKnown: probesKnown,
      wholeAnswer: bucketOut(p.wholeAnswer, probesKnown), criticalField: bucketOut(p.criticalField, probesKnown),
      byField: Object.fromEntries(RELAY_FIELD_KEYS.map(f => [f, bucketOut(p.byField[f], probesKnown)])) as Record<Field, ReturnType<typeof bucketOut>>,
    },
    context: { ...x, denominatorKnown: contextKnown, complete: contextKnown && x.unknown === 0 },
    guards: { ...g, denominatorKnown: guardsKnown, complete: guardsKnown && g.unknown === 0 },
    integrity: { ...c.integrity, authenticated: 0 as const, complete: c.integrity.observed > 0 && c.integrity.unknown === 0 },
  }
}
export type RelayCycleReport = ReturnType<typeof cycleOut> & { ordinal: number }

const etaAcc = () => ({ observedTrials: 0, selectedForecasts: 0, selectedMissing: 0, otherForecasts: 0, eligible: 0, covered: 0, uncovered: 0, excludedTainted: 0, excludedWrongCohort: 0, excludedNoncompleted: 0 })
const COMPLETED = new Set<Outcome>(['passed', 'failed', 'escalated'])
const infra = (x: { state: string; reason?: string }) => x.state !== 'observed' && x.reason === 'infra_tainted'
/** Infrastructure taint anywhere in a trial, not only in its supplied terminal outcome. */
function trialTainted(t: RelayObservedTrial): boolean {
  if (t.outcome === 'infra_error' || t.outcome === 'infra_tainted') return true
  return t.cycles.some(c => c.state !== 'observed' ? infra(c)
    : [c.items, c.probes, c.context, c.guards, c.integrity].some(infra) || (c.items.state === 'observed' && c.items.assessments.some(infra))
      || (c.probes.state === 'observed' && c.probes.grades.some(infra)) || (c.context.state === 'observed' && c.context.samples.some(infra))
      || (c.guards.state === 'observed' && c.guards.checks.some(infra)))
}

export interface RelayMeasurementReport {
  format: typeof RELAY_REPORT_FORMAT
  inputFormat: RelayMeasurementInput['format']
  planSha256: string
  experimentId: string
  declaredOrigin: RelayMeasurementInput['declaredOrigin']
  gate: 'measurement_only'
  b3Decision: 'unevaluated'
  authenticity: 'not_verified_offline'
  realEvidenceCredit: 0
  stratum: { provider: string; model: string; revision: string; quantization: string; windowTokens: number; eCalibration: 'observed' | 'unknown' }
  coverage: { trials: { expected: number; observed: number; missing: number }; cycles: { expected: number; observed: number; unknown: number; notReached: number; missing: number }; evidence: { total: number; unreferenced: number } }
  arms: Array<{
    id: string; kind: RelayArmKind; availability: 'planned' | 'unsupported'
    trials: { expected: number; observed: number; missing: number; tainted: number; outcomes: Record<Outcome, number> }
    cycles: RelayCycleReport[]
    totals: ReturnType<typeof cycleOut>
    eta: ReturnType<typeof etaAcc> & { coverageOverEligible: number | null; calibrated: false }
  }>
  pairedRelayVsNaive:
    | { state: 'unresolved'; reason: 'arm_kind_absent' | 'arm_unsupported' }
    | { state: 'descriptive'; includedTasks: number; excluded: Array<{ task: string; reason: 'missing_slot' | 'infra' | 'cancelled' | 'outcome_unknown' }>
        relay: { trials: number; passed: number }; naive: { trials: number; passed: number }; delta: null; interval: null }
  criteria: Record<RelayCriterion, RelayUnevaluated>
  unresolved: string[]
}

const NOT_REAL = 'real_evidence_absent'
const CRITERIA: Record<RelayCriterion, RelayUnevaluated> = {
  itemSuccessSlope: { state: 'unevaluated', reasons: ['estimand_not_preregistered', 'no_statistical_reducer', NOT_REAL] },
  relayVsNaiveNonInferiority: { state: 'unevaluated', reasons: ['estimand_not_preregistered', 'no_statistical_reducer', NOT_REAL] },
  criticalProbeAccuracy: { state: 'unevaluated', reasons: ['authenticity_not_verified_offline', 'per_field_grading_unauthenticated', NOT_REAL] },
  guardedDeadEndRepeats: { state: 'unevaluated', reasons: ['authenticity_not_verified_offline', 'observation_completeness_unauthenticated', NOT_REAL] },
  truncation: { state: 'unevaluated', reasons: ['authenticity_not_verified_offline', 'observation_completeness_unauthenticated', NOT_REAL] },
  ledgerHandoffConsistency: { state: 'unevaluated', reasons: ['authenticity_not_verified_offline', 'canonical_seal_not_loaded', NOT_REAL] },
  etaP80Coverage: { state: 'unevaluated', reasons: ['calibration_not_established', 'fewer_than_20_real_runs_unproven', NOT_REAL] },
}

function reduce(input: RelayMeasurementInput, referenced: ReadonlySet<string>): RelayMeasurementReport {
  const { plan } = input
  const taskIds = [...plan.tasks].sort(); const seeds = [...plan.seeds].sort((a, b) => a - b)
  const slots = new Map(input.trials.map(t => [JSON.stringify([t.task, t.arm, t.seed]), t]))
  const armsSorted = [...plan.arms].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const armReports: RelayMeasurementReport['arms'] = []
  const outcomeOf = new Map<string, Outcome | 'missing'>()
  const unresolved = new Set<string>()
  let trialsObserved = 0; let trialsMissing = 0; let trialsExpected = 0
  const cyc = { expected: 0, observed: 0, unknown: 0, notReached: 0, missing: 0 }

  for (const arm of armsSorted) {
    const acc = Array.from({ length: plan.horizon }, cycleAcc)
    const outcomes = zeroCounts(RELAY_OUTCOMES)
    const eta = etaAcc()
    let observed = 0; let missing = 0; let expected = 0; let tainted = 0
    if (arm.availability.state === 'planned') {
      for (const task of taskIds) for (const seed of seeds) {
        expected++
        const slot = slots.get(JSON.stringify([task, arm.id, seed]))!
        if (slot.state === 'missing') {
          missing++; outcomeOf.set(JSON.stringify([task, arm.id, seed]), 'missing')
          acc.forEach(c => { c.trialsMissing++; unknownGroups(c) })
          cyc.expected += plan.horizon; cyc.missing += plan.horizon
          continue
        }
        const taint = trialTainted(slot)
        if (taint) tainted++
        observed++; outcomes[slot.outcome]++; outcomeOf.set(JSON.stringify([task, arm.id, seed]), taint ? 'infra_tainted' : slot.outcome)
        slot.cycles.forEach((c, i) => {
          cyc.expected++
          const a = acc[i]!
          if (c.state === 'observed') { cyc.observed++; addCycle(a, c, plan.stratum.windowTokens) }
          else if (c.state === 'unknown') { cyc.unknown++; a.unknown++; unknownGroups(a) }
          else { cyc.notReached++; a.notReached++ }
        })
        addEta(eta, slot, plan.eta.selectionCycle, plan.eta.cohortId, taint)
      }
    }
    trialsObserved += observed; trialsMissing += missing; trialsExpected += expected
    const totals = cycleAcc()
    acc.forEach(c => add(totals, c))
    armReports.push({
      id: arm.id, kind: arm.kind, availability: arm.availability.state,
      trials: { expected, observed, missing, tainted, outcomes },
      cycles: acc.map((c, i) => ({ ordinal: i + 1, ...cycleOut(c) })), totals: cycleOut(totals),
      eta: { ...eta, coverageOverEligible: frac(eta.covered, eta.eligible), calibrated: false },
    })
  }

  const kinds = new Set(plan.arms.map(a => a.kind))
  for (const k of RELAY_ARM_KINDS) if (!kinds.has(k)) unresolved.add(`arm_kind_absent:${k}`)
  for (const a of plan.arms) if (a.availability.state === 'unsupported') unresolved.add(`arm_unsupported:${a.kind}`)
  if (plan.stratum.eCalibration.state === 'unknown') unresolved.add('e_calibration_unknown')
  if (trialsMissing) unresolved.add('trials_missing')
  if (cyc.unknown) unresolved.add('cycles_unknown')
  if (cyc.notReached) unresolved.add('cycles_not_reached')
  let criticalExpected = 0
  for (const a of armReports) {
    if (a.availability !== 'planned') continue // listed as arm_unsupported; it has no observations to complete
    const t = a.totals
    if (t.items.groupsUnknown || t.items.unknown) unresolved.add('items_unknown')
    if (t.probes.groupsUnknown || !t.probes.wholeAnswer.complete || !t.probes.criticalField.complete) unresolved.add('probes_unknown')
    if (t.context.groupsUnknown || t.context.unknown) unresolved.add('context_unknown')
    if (t.guards.groupsUnknown || t.guards.unknown) unresolved.add('guards_unknown')
    if (t.integrity.unknown) unresolved.add('integrity_unknown')
    if (a.eta.selectedMissing) unresolved.add('eta_selected_forecast_missing')
    criticalExpected += t.probes.criticalField.expected
  }
  if (!criticalExpected) unresolved.add('critical_field_grades_absent')
  const unreferenced = input.evidence.filter(e => !referenced.has(e.id)).length
  if (unreferenced) unresolved.add('evidence_unreferenced')
  if (input.declaredOrigin === 'synthetic_fixture') unresolved.add('origin_synthetic_fixture')
  unresolved.add('authenticity_not_verified_offline')

  return {
    format: RELAY_REPORT_FORMAT, inputFormat: input.format, planSha256: input.planSha256, experimentId: plan.experimentId,
    declaredOrigin: input.declaredOrigin, gate: 'measurement_only', b3Decision: 'unevaluated', authenticity: 'not_verified_offline', realEvidenceCredit: 0,
    stratum: { provider: plan.stratum.provider, model: plan.stratum.model, revision: plan.stratum.revision,
      quantization: plan.stratum.quantization.kind === 'quantized' ? plan.stratum.quantization.id : 'not_applicable',
      windowTokens: plan.stratum.windowTokens, eCalibration: plan.stratum.eCalibration.state },
    coverage: { trials: { expected: trialsExpected, observed: trialsObserved, missing: trialsMissing }, cycles: cyc, evidence: { total: input.evidence.length, unreferenced } },
    arms: armReports, pairedRelayVsNaive: paired(input, taskIds, seeds, outcomeOf, armReports),
    criteria: structuredClone(CRITERIA), unresolved: [...unresolved].sort(),
  }
}

function addEta(eta: ReturnType<typeof etaAcc>, t: RelayObservedTrial, selectionCycle: number, cohortId: string, tainted: boolean): void {
  eta.observedTrials++
  const selected = t.forecasts.find(f => f.cycle === selectionCycle)
  eta.otherForecasts += t.forecasts.length - (selected ? 1 : 0)
  if (!selected) { eta.selectedMissing++; return }
  eta.selectedForecasts++
  if (selected.taint === 'tainted' || tainted) { eta.excludedTainted++; return }
  if (selected.cohortId !== cohortId) { eta.excludedWrongCohort++; return }
  if (!COMPLETED.has(t.outcome) || t.finishedAtMs.state !== 'observed') { eta.excludedNoncompleted++; return }
  eta.eligible++
  // Inclusive at equality; actual remaining time is completion minus the forecast's issue time.
  if (t.finishedAtMs.value - selected.issuedAtMs <= selected.p80RemainingMs) eta.covered++; else eta.uncovered++
}

function paired(input: RelayMeasurementInput, tasks: string[], seeds: number[], outcomeOf: Map<string, Outcome | 'missing'>, arms: RelayMeasurementReport['arms']): RelayMeasurementReport['pairedRelayVsNaive'] {
  const relay = arms.find(a => a.kind === 'ledger_relay'); const naive = arms.find(a => a.kind === 'naive_compaction')
  if (!relay || !naive) return { state: 'unresolved', reason: 'arm_kind_absent' }
  if (relay.availability !== 'planned' || naive.availability !== 'planned') return { state: 'unresolved', reason: 'arm_unsupported' }
  const excluded: Array<{ task: string; reason: 'missing_slot' | 'infra' | 'cancelled' | 'outcome_unknown' }> = []
  const r = { trials: 0, passed: 0 }; const n = { trials: 0, passed: 0 }
  for (const task of tasks) {
    const rows = [relay, naive].flatMap(a => seeds.map(s => ({ arm: a.id, o: outcomeOf.get(JSON.stringify([task, a.id, s]))! })))
    // Any problem in any declared seed of either arm removes the whole task from both sides.
    const reason = rows.some(x => x.o === 'missing') ? 'missing_slot' : rows.some(x => x.o === 'infra_error' || x.o === 'infra_tainted') ? 'infra'
      : rows.some(x => x.o === 'cancelled') ? 'cancelled' : rows.some(x => x.o === 'unknown') ? 'outcome_unknown' : null
    if (reason) { excluded.push({ task, reason }); continue }
    for (const x of rows) { const side = x.arm === relay.id ? r : n; side.trials++; if (x.o === 'passed') side.passed++ }
  }
  return { state: 'descriptive', includedTasks: tasks.length - excluded.length, excluded, relay: r, naive: n, delta: null, interval: null }
}

/** Parse, validate and describe. Throws `RelayMeasurementError` (fixed codes) on malformed input. */
export function reduceRelayMeasurement(raw: unknown): RelayMeasurementReport {
  const checked = checkRelayMeasurement(raw)
  if (!checked.ok) throw new RelayMeasurementError(checked.issues)
  return reduce(checked.value, checked.referencedEvidence)
}
