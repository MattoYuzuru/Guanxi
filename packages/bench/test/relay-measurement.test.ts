import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELAY_CRITERIA, reduceRelayMeasurement, type RelayMeasurementReport } from '../src/relay-measurement.ts'
import { RelayMeasurementError } from '../src/relay-protocol.ts'
import { addEvidence, addRetry, build, resign, trialOf, type Raw } from './relay-fixtures.ts'

const arm = (report: RelayMeasurementReport, id: string) => report.arms.find(a => a.id === id)!
const relayCycle = (raw: Raw, k = 0, task = 'task-a', seed = 1) => trialOf(raw, task, 'arm-relay', seed).cycles[k]
const reduce = (raw: Raw) => reduceRelayMeasurement(raw)
const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v) } return v }
function finiteNumbers(v: unknown, path = ''): void {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite at ${path}`)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) finiteNumbers(x, `${path}.${k}`)
}

test('valid fixture: exact hand counts, constants fixed, every criterion unevaluated', () => {
  const r = reduce(build())
  assert.deepEqual([r.gate, r.b3Decision, r.authenticity, r.realEvidenceCredit, r.declaredOrigin], ['measurement_only', 'unevaluated', 'not_verified_offline', 0, 'synthetic_fixture'])
  assert.deepEqual(r.coverage, { trials: { expected: 8, observed: 8, missing: 0 }, cycles: { expected: 24, observed: 24, unknown: 0, notReached: 0, missing: 0 }, evidence: { total: 361, unreferenced: 0 } })
  assert.equal(r.stratum.quantization, 'q4-fixture'); assert.equal(r.stratum.eCalibration, 'unknown')
  assert.deepEqual(r.arms.map(a => [a.id, a.availability, a.trials.expected]), [['arm-large', 'unsupported', 0], ['arm-naive', 'planned', 4], ['arm-relay', 'planned', 4]])
  const relay = arm(r, 'arm-relay'); const naive = arm(r, 'arm-naive')
  assert.deepEqual(relay.cycles.map(c => c.items.expected), [8, 8, 8])
  assert.deepEqual([relay.totals.items.expected, relay.totals.items.passed, relay.totals.items.failed, relay.totals.items.unknown], [24, 24, 0, 0])
  assert.deepEqual([naive.totals.items.passed, naive.totals.items.failed], [20, 4])
  assert.deepEqual(naive.cycles.map(c => c.items.failed), [0, 0, 4])
  assert.equal(naive.totals.items.passedOverExpected, 20 / 24)
  assert.deepEqual([relay.totals.probes.wholeAnswer.expected, relay.totals.probes.criticalField.expected, relay.totals.probes.byField.head.expected, relay.totals.probes.byField.ledgerHash.expected, relay.totals.probes.byField.nextItem.expected], [12, 24, 12, 12, 0])
  assert.deepEqual([relay.totals.probes.criticalField.firstCorrect, relay.totals.probes.criticalField.firstAttemptCorrectOverExpected], [24, 1])
  assert.equal(relay.totals.probes.byField.nextItem.firstAttemptCorrectOverExpected, null)
  assert.deepEqual([relay.totals.context.expected, relay.totals.context.observed, relay.totals.context.truncatedSamples, relay.totals.context.truncationEvents, relay.totals.context.windowMismatches], [24, 24, 0, 0, 0])
  assert.deepEqual([relay.totals.guards.expected, relay.totals.guards.guardedRepeats, relay.totals.guards.unguardedRepeats], [12, 0, 0])
  assert.deepEqual([relay.totals.integrity.observed, relay.totals.integrity.reportedMatch, relay.totals.integrity.authenticated], [12, 12, 0])
  assert.deepEqual([relay.eta.eligible, relay.eta.covered, relay.eta.coverageOverEligible, relay.eta.otherForecasts, relay.eta.calibrated], [4, 4, 1, 4, false])
  assert.deepEqual(Object.keys(r.criteria), [...RELAY_CRITERIA])
  for (const c of Object.values(r.criteria)) { assert.equal(c.state, 'unevaluated'); assert.ok(c.reasons.length >= 2); assert.ok(c.reasons.includes('real_evidence_absent')) }
  assert.deepEqual(r.unresolved, ['arm_kind_absent:mini_swe_control', 'arm_kind_absent:observation_masking', 'arm_unsupported:single_large_window', 'authenticity_not_verified_offline',
    'e_calibration_unknown', 'origin_synthetic_fixture'])
  finiteNumbers(r)
})

test('a perfect-looking fixture and a recorded label never earn a verdict or credit', () => {
  const fixture = reduce(build()); const recorded = reduce(build({ origin: 'recorded_observation' }))
  assert.equal(recorded.declaredOrigin, 'recorded_observation')
  assert.equal(recorded.realEvidenceCredit, 0)
  assert.equal(recorded.authenticity, 'not_verified_offline')
  assert.deepEqual({ ...recorded, declaredOrigin: 'synthetic_fixture', unresolved: [] }, { ...fixture, unresolved: [] })
  assert.ok(!recorded.unresolved.includes('origin_synthetic_fixture'))
  const keys = JSON.stringify(Object.keys(recorded)) + JSON.stringify(Object.keys(recorded.criteria.truncation))
  assert.doesNotMatch(keys, /pass|verdict|eligible|accepted|met/i)
  assert.ok(Object.values(recorded.criteria).every(c => c.state === 'unevaluated'))
  assert.ok(!JSON.stringify(recorded.criteria).includes('"passed"'))
})

test('whole-answer probes never become field grades; retry rescue does not improve first-attempt accuracy', () => {
  const whole = build()
  for (const t of whole.trials) for (const c of t.cycles) {
    const m = c.probes.manifest
    m.occasions = m.occasions.filter((o: Raw) => o.scope === 'whole_answer'); c.probes.grades = c.probes.grades.filter((g: Raw) => g.occasion === 'p-whole')
  }
  const w = arm(reduce(resign(whole)), 'arm-relay').totals.probes
  assert.equal(w.wholeAnswer.expected, 12); assert.equal(w.wholeAnswer.firstAttemptCorrectOverExpected, 1)
  assert.equal(w.criticalField.expected, 0); assert.equal(w.criticalField.firstAttemptCorrectOverExpected, null)
  assert.equal(w.criticalField.complete, false) // no denominator means no complete per-field evidence
  assert.equal(w.criticalField.groupsWithoutOccasion, 12)
  assert.ok(reduce(resign(whole)).unresolved.includes('critical_field_grades_absent'))
  assert.ok(reduce(resign(whole)).unresolved.includes('critical_field_grades_partial'))

  // Mixed: cycle 2 has whole-answer probes only, cycles 1 and 3 keep head and ledgerHash.
  const mixed = build()
  for (const t of mixed.trials) {
    const c = t.cycles[1]
    c.probes.manifest.occasions = c.probes.manifest.occasions.filter((o: Raw) => o.scope === 'whole_answer')
    c.probes.grades = c.probes.grades.filter((g: Raw) => g.occasion === 'p-whole')
  }
  const mx = arm(reduce(resign(mixed)), 'arm-relay').totals.probes
  assert.deepEqual([mx.criticalField.expected, mx.criticalField.complete, mx.criticalField.groupsWithoutOccasion], [16, false, 4])
  assert.deepEqual([mx.byField.head.expected, mx.byField.head.complete, mx.byField.head.groupsWithoutOccasion], [8, false, 4])
  assert.deepEqual([mx.wholeAnswer.expected, mx.wholeAnswer.complete], [12, true])
  assert.ok(reduce(resign(mixed)).unresolved.includes('critical_field_grades_partial'))

  const retry = build()
  { const c = relayCycle(retry); c.probes.grades[1].result = 'incorrect'; addRetry(retry, 0, c.probes.grades[1], 'correct') }
  const p = arm(reduce(resign(retry)), 'arm-relay').totals.probes.criticalField
  assert.deepEqual([p.expected, p.firstCorrect, p.firstIncorrect, p.finalCorrect, p.retryRescued, p.retryAttempts], [24, 23, 1, 24, 1, 1])
  assert.equal(p.firstAttemptCorrectOverExpected, 23 / 24)
  assert.equal(p.afterRetryCorrectOverExpected, 1)
  assert.ok(p.firstAttemptCorrectOverExpected! < 0.96)

  // A known first failure followed by an unknown retry is not complete: the final field grade is unknown.
  const finalUnknown = build()
  { const c = relayCycle(finalUnknown); c.probes.grades[1].result = 'incorrect'; c.probes.grades.push({ occasion: 'p-head', attempt: 2, state: 'unknown', reason: 'purged' }) }
  const fu = arm(reduce(resign(finalUnknown)), 'arm-relay').totals.probes.criticalField
  assert.deepEqual([fu.firstIncorrect, fu.finalUnknown, fu.complete], [1, 1, false])
  assert.ok(reduce(resign(finalUnknown)).unresolved.includes('probes_unknown'))
})

test('duplicate (scope, field) probe occasions are rejected so the denominator cannot double count', () => {
  const raw = build()
  const c = relayCycle(raw)
  c.probes.manifest.occasions.push({ id: 'p-head-2', scope: 'critical_field', field: 'head' })
  c.probes.grades.push({ occasion: 'p-head-2', attempt: 1, state: 'observed', ref: addEvidence(raw, 'probe_grading', 'task-a', 'arm-relay', 1, 'att-1', 1), result: 'correct' })
  assert.throws(() => reduce(resign(raw)), (e: unknown) => e instanceof RelayMeasurementError && e.code === 'duplicate_key')
  // The valid fixture has one head occasion per observed group, so the counts stay at 24 / 12.
  const p = arm(reduce(build()), 'arm-relay').totals.probes
  assert.deepEqual([p.criticalField.expected, p.byField.head.expected], [24, 12])
})

test('unknown stays unknown: one unknown grade gives a conservative incomplete fraction, an unknown manifest gives null', () => {
  const raw = build(); { const g = relayCycle(raw).probes.grades[1]; delete g.ref; delete g.result; g.state = 'unknown'; g.reason = 'purged' }
  const p = arm(reduce(resign(raw)), 'arm-relay').totals.probes
  assert.deepEqual([p.criticalField.firstCorrect, p.criticalField.firstUnknown, p.criticalField.expected], [23, 1, 24])
  assert.equal(p.criticalField.firstAttemptCorrectOverExpected, 23 / 24)
  assert.equal(p.criticalField.complete, false)
  assert.equal(p.criticalField.firstAttemptKnownOnlyAccuracy, 1)
  assert.ok(reduce(resign(raw)).unresolved.includes('probes_unknown'))

  const unknownGroup = build(); relayCycle(unknownGroup).probes = { state: 'unknown', reason: 'not_collected' }
  const q = arm(reduce(resign(unknownGroup)), 'arm-relay').totals.probes
  assert.equal(q.denominatorKnown, false); assert.equal(q.criticalField.firstAttemptCorrectOverExpected, null); assert.equal(q.wholeAnswer.afterRetryCorrectOverExpected, null)
  assert.equal(q.criticalField.firstAttemptKnownOnlyAccuracy, null) // no fraction survives an unknown denominator

  const noOpportunity = build()
  for (const t of noOpportunity.trials) for (const c of t.cycles) { c.items.manifest.opportunities = []; c.items.assessments = [] }
  const i = arm(reduce(resign(noOpportunity)), 'arm-relay').totals.items
  assert.deepEqual([i.expected, i.passedOverExpected, i.knownOnlyPassed, i.denominatorKnown], [0, null, null, true])

  const missingManifest = build(); relayCycle(missingManifest).items = { state: 'unknown', reason: 'not_collected' }
  const m = reduce(resign(missingManifest))
  assert.equal(arm(m, 'arm-relay').totals.items.denominatorKnown, false); assert.equal(arm(m, 'arm-relay').totals.items.passedOverExpected, null)
  assert.equal(arm(m, 'arm-relay').totals.items.expected, 22)
  assert.ok(m.unresolved.includes('items_unknown'))

  const unknownItem = build(); { const a = relayCycle(unknownItem).items.assessments[0]; for (const k of ['ref', 'head', 'acceptanceSha256', 'assessedAtMs', 'result']) delete a[k]; a.state = 'unknown'; a.reason = 'verifier_missing' }
  const u = arm(reduce(resign(unknownItem)), 'arm-relay').totals.items
  assert.deepEqual([u.passed, u.unknown, u.passedOverExpected, u.complete], [23, 1, 23 / 24, false])
})

test('zero-tolerance counters: violations stay visible, unknown plus zero violations is never complete', () => {
  const none = build(); { const s = relayCycle(none).context.samples[0]; for (const k of ['ref', 'actualWindowTokens', 'renderedTokens', 'truncationEvents']) delete s[k]; s.state = 'unknown'; s.reason = 'unavailable' }
  const unknown = arm(reduce(resign(none)), 'arm-relay').totals.context
  assert.deepEqual([unknown.truncatedSamples, unknown.unknown, unknown.complete], [0, 1, false])

  const trunc = build(); { const s = relayCycle(trunc, 1).context.samples[1]; s.truncationEvents = 3; s.renderedTokens = 40000; s.actualWindowTokens = 8192 }
  const c = arm(reduce(resign(trunc)), 'arm-relay').totals.context
  assert.deepEqual([c.truncatedSamples, c.truncationEvents, c.windowMismatches, c.overWindow], [1, 3, 1, 1])
  assert.equal(reduce(resign(trunc)).criteria.truncation.state, 'unevaluated')

  const guarded = build(); { const k = relayCycle(guarded).guards.checks[0]; k.repeated = true }
  const unguarded = build(); { const k = relayCycle(unguarded).guards.checks[0]; k.repeated = true; k.guardActive = false }
  const gg = arm(reduce(resign(guarded)), 'arm-relay').totals.guards; const ug = arm(reduce(resign(unguarded)), 'arm-relay').totals.guards
  assert.deepEqual([gg.guardedRepeats, gg.unguardedRepeats, gg.guardInactive], [1, 0, 0])
  assert.deepEqual([ug.guardedRepeats, ug.unguardedRepeats, ug.guardInactive], [0, 1, 1])

  const noGuard = build(); { const k = relayCycle(noGuard).guards.checks[0]; for (const f of ['ref', 'guardActive', 'repeated']) delete k[f]; k.state = 'unknown'; k.reason = 'not_collected' }
  const ng = arm(reduce(resign(noGuard)), 'arm-relay').totals.guards
  assert.deepEqual([ng.guardedRepeats, ng.unknown, ng.complete], [0, 1, false])
})

test('integrity is reported agreement only: equal strings are not authentication, mismatches and purged sources stay visible', () => {
  const equal = arm(reduce(build()), 'arm-relay').totals.integrity
  assert.deepEqual([equal.reportedMatch, equal.authenticated], [12, 0])
  const mismatch = build(); relayCycle(mismatch).integrity.value.handoffLedgerSha256 = 'e'.repeat(64)
  const m = arm(reduce(resign(mismatch)), 'arm-relay').totals.integrity
  assert.deepEqual([m.reportedMatch, m.reportedMismatch, m.authenticated, m.complete], [11, 1, 0, true])
  const failedValidation = build(); relayCycle(failedValidation).integrity.value.reportedValidation = 'failed'
  assert.deepEqual([arm(reduce(resign(failedValidation)), 'arm-relay').totals.integrity.reportedValidationFailed], [1])
  const purged = build(); relayCycle(purged).integrity = { state: 'unknown', reason: 'purged' }
  const p = reduce(resign(purged))
  assert.deepEqual([arm(p, 'arm-relay').totals.integrity.unknown, arm(p, 'arm-relay').totals.integrity.reportedMatch, arm(p, 'arm-relay').totals.integrity.complete], [1, 11, false])
  assert.ok(p.unresolved.includes('integrity_unknown'))
  assert.equal(p.criteria.ledgerHandoffConsistency.state, 'unevaluated')
})

test('ETA: equality is covered, ineligible forecasts are excluded and counted, several forecasts are one', () => {
  const edge = build(); trialOf(edge, 'task-a', 'arm-relay', 1).forecasts[1].p80RemainingMs = 2099
  const e = arm(reduce(resign(edge)), 'arm-relay').eta
  assert.deepEqual([e.eligible, e.covered, e.uncovered, e.coverageOverEligible], [4, 3, 1, 0.75])

  const raw = build()
  trialOf(raw, 'task-a', 'arm-relay', 1).forecasts[1].taint = 'tainted'
  trialOf(raw, 'task-a', 'arm-relay', 2).forecasts[1].cohortId = 'cohort-other'
  Object.assign(trialOf(raw, 'task-b', 'arm-relay', 1), { outcome: 'cancelled' })
  trialOf(raw, 'task-b', 'arm-relay', 2).forecasts.pop()
  const x = arm(reduce(resign(raw)), 'arm-relay').eta
  assert.deepEqual([x.observedTrials, x.selectedForecasts, x.selectedMissing, x.excludedTainted, x.excludedWrongCohort, x.excludedNoncompleted, x.eligible], [4, 3, 1, 1, 1, 1, 0])
  assert.equal(x.coverageOverEligible, null); assert.equal(x.calibrated, false)
  const unknownClock = build(); trialOf(unknownClock, 'task-a', 'arm-relay', 1).finishedAtMs = { state: 'unknown', reason: 'unavailable' }
  assert.deepEqual([arm(reduce(resign(unknownClock)), 'arm-relay').eta.excludedNoncompleted, arm(reduce(resign(unknownClock)), 'arm-relay').eta.eligible], [1, 3])
  assert.equal(reduce(resign(raw)).criteria.etaP80Coverage.state, 'unevaluated')
})

test('paired comparison: any infra, missing, cancelled or unknown seed removes the whole task from both arms; no delta is produced', () => {
  const infra = build(); trialOf(infra, 'task-a', 'arm-naive', 2).outcome = 'infra_tainted'
  const p = reduce(resign(infra)).pairedRelayVsNaive
  assert.ok(p.state === 'descriptive')
  if (p.state !== 'descriptive') return
  assert.deepEqual([p.includedTasks, p.excluded, p.relay, p.naive, p.delta, p.interval], [1, [{ task: 'task-a', reason: 'infra' }], { trials: 2, passed: 2 }, { trials: 2, passed: 2 }, null, null])
  assert.equal(arm(reduce(resign(infra)), 'arm-naive').trials.tainted, 1) // raw counts still show the taint

  const failedRun = build(); trialOf(failedRun, 'task-b', 'arm-relay', 1).outcome = 'failed'; trialOf(failedRun, 'task-b', 'arm-naive', 1).outcome = 'escalated'
  const f = reduce(resign(failedRun)).pairedRelayVsNaive
  assert.ok(f.state === 'descriptive' && f.includedTasks === 2 && f.relay.passed === 3 && f.naive.passed === 3)

  for (const [outcome, reason] of [['cancelled', 'cancelled'], ['unknown', 'outcome_unknown']] as const) {
    const raw = build(); trialOf(raw, 'task-b', 'arm-relay', 1).outcome = outcome
    const r = reduce(resign(raw)).pairedRelayVsNaive
    assert.ok(r.state === 'descriptive' && r.excluded[0]!.reason === reason && r.relay.trials === 2 && r.naive.trials === 2)
  }
  const missing = build()
  Object.assign(trialOf(missing, 'task-a', 'arm-relay', 1), { state: 'missing', reason: 'not_collected' })
  const t = trialOf(missing, 'task-a', 'arm-relay', 1); for (const k of ['runId', 'outcome', 'attempts', 'startedAtMs', 'finishedAtMs', 'cycles', 'forecasts']) delete t[k]
  const m = reduce(resign(missing))
  assert.ok(m.pairedRelayVsNaive.state === 'descriptive' && m.pairedRelayVsNaive.excluded[0]!.reason === 'missing_slot' && m.pairedRelayVsNaive.includedTasks === 1)
  assert.deepEqual([m.coverage.trials.missing, arm(m, 'arm-relay').trials.missing, arm(m, 'arm-relay').cycles[0]!.cycles.trialsMissing, arm(m, 'arm-relay').totals.items.denominatorKnown], [1, 1, 1, false])
  assert.ok(m.unresolved.includes('trials_missing'))

  const noNaive = build(); noNaive.plan.arms = noNaive.plan.arms.filter((a: Raw) => a.id !== 'arm-naive'); noNaive.trials = noNaive.trials.filter((t: Raw) => t.arm !== 'arm-naive'); noNaive.evidence = noNaive.evidence.filter((e: Raw) => e.arm !== 'arm-naive')
  assert.deepEqual(reduce(resign(noNaive)).pairedRelayVsNaive, { state: 'unresolved', reason: 'arm_kind_absent' })
  const unsupported = build(); unsupported.plan.arms[0].availability = { state: 'unsupported', reason: 'unsupported', ref: 'ev-1' }
  unsupported.trials = unsupported.trials.filter((t: Raw) => t.arm !== 'arm-relay')
  assert.deepEqual(reduce(resign(unsupported)).pairedRelayVsNaive, { state: 'unresolved', reason: 'arm_unsupported' })
})

test('early terminal, unknown and missing cycles are retained and never imputed', () => {
  const raw = build()
  const t = trialOf(raw, 'task-a', 'arm-relay', 1)
  t.outcome = 'failed'; t.cycles[1] = { ordinal: 2, state: 'not_reached', reason: 'not_reached' }; t.cycles[2] = { ordinal: 3, state: 'not_reached', reason: 'infra_tainted' }
  t.forecasts = []
  const u = trialOf(raw, 'task-a', 'arm-relay', 2); u.cycles[0] = { ordinal: 1, state: 'unknown', reason: 'purged' }
  const r = reduce(resign(raw))
  const relay = arm(r, 'arm-relay')
  assert.deepEqual(r.coverage.cycles, { expected: 24, observed: 21, unknown: 1, notReached: 2, missing: 0 })
  assert.equal(relay.trials.observed, 4)
  assert.deepEqual(relay.cycles.map(c => [c.cycles.observed, c.cycles.unknown, c.cycles.notReached]), [[3, 1, 0], [3, 0, 1], [3, 0, 1]])
  assert.deepEqual(relay.cycles.map(c => c.items.expected), [6, 6, 6]) // not-reached cycles add no opportunities, no score is imputed
  assert.equal(relay.cycles[0]!.items.denominatorKnown, false)
  assert.ok(r.unresolved.includes('cycles_unknown') && r.unresolved.includes('cycles_not_reached'))
  assert.equal(relay.eta.selectedMissing, 1)
  finiteNumbers(r)
})

test('reports are invariant under unordered permutation and key order; ordered sequences are not silently sorted', () => {
  const raw = build()
  const shuffled = JSON.parse(JSON.stringify(raw)) as Raw
  shuffled.trials.reverse(); shuffled.evidence.reverse(); shuffled.plan.tasks.reverse(); shuffled.plan.seeds.reverse(); shuffled.plan.arms.reverse()
  for (const t of shuffled.trials) for (const c of t.cycles) { c.items.manifest.opportunities.reverse(); c.items.assessments.reverse(); c.probes.manifest.occasions.reverse(); c.probes.grades.reverse(); c.context.samples.reverse() }
  assert.deepEqual(reduce(shuffled), reduce(raw))
  const cycles = JSON.parse(JSON.stringify(raw)) as Raw
  trialOf(cycles, 'task-a', 'arm-relay', 1).cycles.reverse()
  assert.throws(() => reduce(cycles), (e: unknown) => e instanceof RelayMeasurementError && e.code === 'chronology_invalid')
})

test('input is not mutated, output is not aliased to input, repeated reduction is deterministic', () => {
  const raw = build()
  const before = JSON.stringify(raw)
  const frozen = deepFreeze(JSON.parse(before))
  const a = reduce(frozen); const b = reduce(frozen)
  assert.deepEqual(a, b)
  a.unresolved.push('tamper'); a.criteria.truncation.reasons = ['tamper']; a.arms[0]!.trials.outcomes.passed = 99
  assert.deepEqual(reduce(frozen), b)
  assert.equal(JSON.stringify(frozen), before)
  assert.notStrictEqual(reduce(frozen).criteria, reduce(frozen).criteria)
})

test('reduce refuses malformed input with the fixed error and never reports a partial result', () => {
  const bad = build(); bad.trials.pop()
  assert.throws(() => reduce(bad), (e: unknown) => e instanceof RelayMeasurementError && e.code === 'missing_slot' && e.message === 'relay_measurement_missing_slot')
  assert.throws(() => reduce({ ...build(), gate: 'passed' }), (e: unknown) => e instanceof RelayMeasurementError && e.code === 'schema_invalid')
  assert.throws(() => reduce(null), RelayMeasurementError)
})

test('infrastructure taint inside a cycle slot excludes the whole task from the paired comparison and the ETA', () => {
  const raw = build()
  const t = trialOf(raw, 'task-a', 'arm-relay', 1)
  t.outcome = 'failed'; t.cycles[2] = { ordinal: 3, state: 'not_reached', reason: 'infra_tainted' }
  const r = reduce(resign(raw))
  assert.ok(r.pairedRelayVsNaive.state === 'descriptive' && r.pairedRelayVsNaive.includedTasks === 1)
  if (r.pairedRelayVsNaive.state === 'descriptive') assert.deepEqual(r.pairedRelayVsNaive.excluded, [{ task: 'task-a', reason: 'infra' }])
  assert.deepEqual([arm(r, 'arm-relay').trials.tainted, arm(r, 'arm-relay').trials.outcomes.failed, arm(r, 'arm-relay').trials.outcomes.infra_tainted], [1, 1, 0])
  assert.deepEqual([arm(r, 'arm-relay').eta.excludedTainted, arm(r, 'arm-relay').eta.eligible], [1, 3])
  const group = build(); { const c = relayCycle(group); c.guards = { state: 'unknown', reason: 'infra_tainted' } }
  assert.equal(arm(reduce(resign(group)), 'arm-relay').trials.tainted, 1)
  const row = build(); { const s = relayCycle(row).context.samples[0]; for (const k of ['ref', 'actualWindowTokens', 'renderedTokens', 'truncationEvents']) delete s[k]; s.state = 'unknown'; s.reason = 'infra_tainted' }
  assert.equal(arm(reduce(resign(row)), 'arm-relay').trials.tainted, 1)
  const itemRow = build(); { const a = relayCycle(itemRow).items.assessments[0]; for (const k of ['ref', 'head', 'acceptanceSha256', 'assessedAtMs', 'result']) delete a[k]; a.state = 'unknown'; a.reason = 'infra_tainted' }
  const ir = reduce(resign(itemRow))
  assert.equal(arm(ir, 'arm-relay').trials.tainted, 1)
  assert.ok(ir.pairedRelayVsNaive.state === 'descriptive')
  if (ir.pairedRelayVsNaive.state === 'descriptive') assert.deepEqual(ir.pairedRelayVsNaive.excluded, [{ task: 'task-a', reason: 'infra' }])
  const probeRow = build(); { const g = relayCycle(probeRow).probes.grades[1]; for (const k of ['ref', 'result']) delete g[k]; g.state = 'unknown'; g.reason = 'infra_tainted' }
  const pr = reduce(resign(probeRow))
  assert.equal(arm(pr, 'arm-relay').trials.tainted, 1)
  assert.ok(pr.pairedRelayVsNaive.state === 'descriptive')
  if (pr.pairedRelayVsNaive.state === 'descriptive') assert.deepEqual(pr.pairedRelayVsNaive.excluded, [{ task: 'task-a', reason: 'infra' }])
  for (const clock of ['startedAtMs', 'finishedAtMs'] as const) {
    const rawClock = build()
    trialOf(rawClock, 'task-a', 'arm-relay', 1)[clock] = { state: 'unknown', reason: 'infra_tainted' }
    const cr = reduce(resign(rawClock))
    assert.equal(arm(cr, 'arm-relay').trials.tainted, 1, clock)
    assert.ok(cr.pairedRelayVsNaive.state === 'descriptive')
    if (cr.pairedRelayVsNaive.state === 'descriptive') assert.deepEqual(cr.pairedRelayVsNaive.excluded, [{ task: 'task-a', reason: 'infra' }], clock)
  }
})

test('empty or unsupported arms never read as complete; missing trials get their own cycle bucket; unreferenced evidence is flagged', () => {
  const r = reduce(build())
  const large = arm(r, 'arm-large').totals
  assert.deepEqual([large.items.complete, large.items.denominatorKnown, large.probes.criticalField.complete, large.context.complete, large.guards.complete, large.integrity.complete], [false, false, false, false, false, false])
  const early = build()
  for (const t of early.trials.filter((x: Raw) => x.arm === 'arm-relay')) t.cycles = t.cycles.map((_: Raw, i: number) => ({ ordinal: i + 1, state: 'not_reached', reason: 'not_reached' })), t.forecasts = []
  const e = reduce(resign(early))
  assert.equal(arm(e, 'arm-relay').totals.items.complete, false); assert.equal(arm(e, 'arm-relay').totals.items.expected, 0)
  const missing = build()
  Object.assign(trialOf(missing, 'task-a', 'arm-relay', 1), { state: 'missing', reason: 'not_collected' })
  const m = trialOf(missing, 'task-a', 'arm-relay', 1); for (const k of ['runId', 'outcome', 'attempts', 'startedAtMs', 'finishedAtMs', 'cycles', 'forecasts']) delete m[k]
  const c = reduce(resign(missing)).coverage.cycles
  assert.deepEqual(c, { expected: 24, observed: 21, unknown: 0, notReached: 0, missing: 3 })
  assert.equal(c.observed + c.unknown + c.notReached + c.missing, c.expected)
  const extra = build(); extra.evidence.push({ id: 'ev-unused', kind: 'calibration', task: null, arm: null, seed: null, attempt: null, cycle: null, metaSha256: '' })
  const u = reduce(resign(extra))
  assert.equal(u.coverage.evidence.unreferenced, 1); assert.ok(u.unresolved.includes('evidence_unreferenced'))
})
