import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RELAY_ERROR_CODES, RelayMeasurementError, checkRelayMeasurement, relayPlanDigest, validateRelayMeasurement, type RelayErrorCode,
} from '../src/relay-protocol.ts'
import { validatePlan, validateRecordedPlan, validateResults } from '../src/protocol.ts'
import { BASE, SEEDS, TASKS, addRetry, build, resign, trialOf, type Raw } from './relay-fixtures.ts'
import { plan as b1Plan } from './helpers.ts'

function expectIssue(raw: unknown, code: RelayErrorCode, rule?: string): void {
  const result = checkRelayMeasurement(raw)
  assert.equal(result.ok, false, `expected ${code}/${rule ?? '*'} but input was accepted`)
  if (result.ok) return
  assert.ok(result.issues.some(i => i.code === code && (rule === undefined || i.rule === rule)), `no ${code}/${rule ?? '*'} in ${JSON.stringify(result.issues)}`)
}
const relayCycle = (raw: Raw, k = 0) => trialOf(raw, 'task-a', 'arm-relay', 1).cycles[k]
const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v

test('a valid envelope is accepted, detached from the caller, and the digest is stable under unordered permutation', () => {
  const raw = build()
  const result = checkRelayMeasurement(raw)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.notEqual(result.value, raw)
  assert.notEqual(result.value.plan, raw.plan)
  assert.equal(validateRelayMeasurement(raw).planSha256, raw.planSha256)
  const permuted = reorder(raw) as Raw
  permuted.plan.tasks.reverse(); permuted.plan.seeds.reverse(); permuted.plan.arms.reverse(); permuted.evidence.reverse(); permuted.trials.reverse()
  assert.equal(relayPlanDigest(permuted.plan), raw.planSha256)
  assert.equal(checkRelayMeasurement(permuted).ok, true)
})

test('unknown fields, versions and supplied verdicts, verified flags and seals are rejected, never ignored', () => {
  expectIssue({ ...build(), format: 'guanxi.b3.measurement/v2' }, 'schema_invalid', 'format_unsupported')
  expectIssue({ ...build(), format: undefined }, 'schema_invalid', 'schema')
  expectIssue({ ...build(), extra: 1 }, 'schema_invalid', 'schema')
  for (const key of ['gate', 'b3Decision', 'verdict', 'passed', 'verified', 'authenticated', 'authenticity', 'realEvidenceCredit', 'sealVerified', 'sealHash', 'criteria']) {
    expectIssue({ ...build(), [key]: key === 'realEvidenceCredit' ? 1 : 'passed' }, 'schema_invalid', 'schema')
  }
  const nested = build(); nested.plan.stratum.verified = true
  expectIssue(nested, 'schema_invalid')
  const cycle = build(); relayCycle(cycle).integrity.value.verified = true
  expectIssue(cycle, 'schema_invalid')
  const seal = build(); relayCycle(seal).integrity.value.sealHash = 'a'.repeat(64)
  expectIssue(seal, 'schema_invalid')
  const origin = build(); origin.declaredOrigin = 'real'
  expectIssue(origin, 'schema_invalid')
  const free = build(); trialOf(free, 'task-a', 'arm-relay', 1).cycles[1] = { ordinal: 2, state: 'unknown', reason: 'the model said so' }
  expectIssue(free, 'schema_invalid')
  for (const bad of [null, [], 'x', 1, {}]) expectIssue(bad, 'schema_invalid')
})

test('omitted slots, rows and cycles are malformed; duplicate and foreign keys are distinct codes', () => {
  const omitted = build(); omitted.trials.pop()
  expectIssue(omitted, 'missing_slot', 'trial_omitted')
  const dup = build(); dup.trials.push(structuredClone(dup.trials[0]))
  expectIssue(dup, 'duplicate_key', 'trial_key_repeat')
  const foreignTask = build(); foreignTask.trials[0].task = 'task-z'
  expectIssue(foreignTask, 'identity_mismatch', 'trial_key_foreign')
  const foreignSeed = build(); foreignSeed.trials[0].seed = 99
  expectIssue(foreignSeed, 'identity_mismatch', 'trial_key_foreign')
  const unsupportedArm = build(); unsupportedArm.trials[0].arm = 'arm-large'
  expectIssue(unsupportedArm, 'identity_mismatch', 'trial_key_foreign')
  const shortCycles = build(); trialOf(shortCycles, 'task-a', 'arm-relay', 1).cycles.pop()
  expectIssue(shortCycles, 'missing_slot', 'cycle_slots')
  const noAssessment = build(); relayCycle(noAssessment).items.assessments.pop()
  expectIssue(noAssessment, 'missing_slot', 'assessment_row_omitted')
  const dupAssessment = build(); relayCycle(dupAssessment).items.assessments.push(structuredClone(relayCycle(dupAssessment).items.assessments[0]))
  expectIssue(dupAssessment, 'duplicate_key', 'assessment_row_repeat')
  const foreignAssessment = build(); relayCycle(foreignAssessment).items.assessments[0].opportunity = 'o-other'
  expectIssue(foreignAssessment, 'identity_mismatch', 'assessment_row_foreign')
  const headReset = build()
  const reassess = { ...structuredClone(relayCycle(headReset).items.assessments[0]), head: 'c'.repeat(40) }
  relayCycle(headReset).items.assessments.push(reassess)
  expectIssue(headReset, 'duplicate_key', 'assessment_row_repeat')
  const repeatedOpportunity = build(); relayCycle(repeatedOpportunity, 1).items.manifest.opportunities[0] = 'o-1-1'
  relayCycle(repeatedOpportunity, 1).items.assessments[0].opportunity = 'o-1-1'
  expectIssue(repeatedOpportunity, 'duplicate_key', 'opportunity_repeat')
  const noFirst = build(); relayCycle(noFirst).probes.grades = relayCycle(noFirst).probes.grades.slice(1)
  expectIssue(noFirst, 'missing_slot', 'probe_first_attempt_omitted')
  const noSample = build(); relayCycle(noSample).context.samples.pop()
  expectIssue(noSample, 'missing_slot', 'sample_row_omitted')
  const noGuard = build(); relayCycle(noGuard).guards.checks.pop()
  expectIssue(noGuard, 'missing_slot', 'guard_row_omitted')
  const dupEvidence = build(); dupEvidence.evidence.push(structuredClone(dupEvidence.evidence[0]))
  expectIssue(dupEvidence, 'duplicate_key', 'evidence_repeat')
  const dupArmKind = build(); dupArmKind.plan.arms[1].kind = 'ledger_relay'
  expectIssue(dupArmKind, 'duplicate_key', 'arm_kind_repeat')
  const dupSeed = build(); dupSeed.plan.seeds = [1, 1]
  expectIssue(dupSeed, 'duplicate_key', 'seed_repeat')
})

test('swapped plan, stratum, acceptance and evidence bindings reject the whole input', () => {
  for (const patch of [
    (r: Raw) => { r.plan.stratum.model = 'other-model' }, (r: Raw) => { r.plan.stratum.quantization = { kind: 'not_applicable' } },
    (r: Raw) => { r.plan.stratum.windowTokens = 8192 }, (r: Raw) => { r.plan.stratum.resourceProfileSha256 = 'e'.repeat(64) },
    (r: Raw) => { r.plan.acceptanceSha256 = 'e'.repeat(64) }, (r: Raw) => { r.plan.arms[0].harnessSha256 = 'e'.repeat(64) },
    (r: Raw) => { r.plan.horizon = 2 }, (r: Raw) => { r.planSha256 = 'e'.repeat(64) },
  ]) { const r = build(); patch(r); expectIssue(r, 'identity_mismatch', 'plan_digest') }
  const acceptance = build(); relayCycle(acceptance).items.assessments[0].acceptanceSha256 = 'e'.repeat(64)
  expectIssue(resign(acceptance), 'identity_mismatch', 'acceptance_digest')
  const foreignEvidence = build(); foreignEvidence.evidence[1].task = 'task-z'
  expectIssue(foreignEvidence, 'identity_mismatch', 'evidence_foreign')
  const tampered = build(); tampered.evidence[2].cycle = 3
  expectIssue(tampered, 'reference_mismatch', 'evidence_digest')
  const wrongTrial = build(); wrongTrial.evidence.find((e: Raw) => e.id === relayCycle(wrongTrial).receiptRef).seed = 2
  expectIssue(resign(wrongTrial), 'reference_mismatch', 'ref_binding')
  const wrongCycle = build(); wrongCycle.evidence.find((e: Raw) => e.id === relayCycle(wrongCycle).receiptRef).cycle = 2
  expectIssue(resign(wrongCycle), 'reference_mismatch', 'ref_binding')
  const wrongKind = build(); wrongKind.evidence.find((e: Raw) => e.id === relayCycle(wrongKind).receiptRef).kind = 'seal_reference'
  expectIssue(resign(wrongKind), 'reference_mismatch', 'ref_kind')
  const unresolved = build(); relayCycle(unresolved).receiptRef = 'ev-missing'
  expectIssue(unresolved, 'reference_mismatch', 'ref_unresolved')
  const badManifest = build(); relayCycle(badManifest).items.manifest.sha256 = 'e'.repeat(64)
  expectIssue(badManifest, 'reference_mismatch', 'manifest_digest')
  const attempt = build(); relayCycle(attempt).attempt = 'att-9'
  expectIssue(attempt, 'reference_mismatch', 'cycle_attempt_unknown')
})

test('malformed numbers, digests and identifiers are refused without coercion', () => {
  const cases: Array<(r: Raw) => void> = [
    r => { r.recordedAtMs = -1 }, r => { r.recordedAtMs = 1.5 }, r => { r.recordedAtMs = 2 ** 53 }, r => { r.recordedAtMs = Number.NaN },
    r => { r.recordedAtMs = Infinity }, r => { r.recordedAtMs = '1000' }, r => { r.plan.horizon = 0 }, r => { r.plan.horizon = 65 },
    r => { r.plan.stratum.windowTokens = 0 }, r => { r.planSha256 = 'A'.repeat(64) }, r => { r.planSha256 = 'a'.repeat(63) },
    r => { r.plan.sourceCommit = 'abc' }, r => { r.plan.tasks[0] = '../escape' }, r => { r.plan.tasks[0] = 'has space' }, r => { r.plan.tasks[0] = 'a'.repeat(200) },
    r => { relayCycle(r).context.samples[0].truncationEvents = -1 }, r => { relayCycle(r).context.samples[0].renderedTokens = 0.5 },
    r => { relayCycle(r).probes.grades[0].attempt = 0 }, r => { relayCycle(r).probes.grades[0].attempt = 9 },
    r => { trialOf(r, 'task-a', 'arm-relay', 1).forecasts[0].p80RemainingMs = Number.MAX_VALUE },
  ]
  for (const mutate of cases) { const r = build(); mutate(r); expectIssue(r, 'schema_invalid') }
})

test('chronology: reversed, overlapping, duplicate and out-of-order records reject', () => {
  const t = (r: Raw) => trialOf(r, 'task-a', 'arm-relay', 1)
  const analysis = build(); analysis.recordedAtMs = analysis.analysisAsOfMs + 1
  expectIssue(analysis, 'chronology_invalid', 'recorded_after_analysis')
  const span = build(); { const c = relayCycle(span); [c.startedAtMs, c.endedAtMs] = [c.endedAtMs, c.startedAtMs] }
  expectIssue(span, 'chronology_invalid', 'cycle_span')
  const swapped = build(); { const cs = t(swapped).cycles; [cs[0], cs[1]] = [cs[1], cs[0]] }
  expectIssue(swapped, 'chronology_invalid', 'cycle_order')
  const dupCycle = build(); t(dupCycle).cycles[1].ordinal = 1
  expectIssue(dupCycle, 'duplicate_key', 'cycle_repeat')
  const overlap = build(); relayCycle(overlap, 1).startedAtMs = relayCycle(overlap, 0).endedAtMs - 1
  expectIssue(overlap, 'chronology_invalid', 'cycle_overlap')
  const afterRecorded = build(); relayCycle(afterRecorded, 2).endedAtMs = afterRecorded.recordedAtMs + 1
  expectIssue(afterRecorded, 'chronology_invalid', 'after_recorded')
  const epoch = build(); t(epoch).attempts.push({ id: 'att-2', epoch: 1, receiptRef: t(epoch).attempts[0].receiptRef })
  expectIssue(epoch, 'chronology_invalid', 'attempt_epoch_order')
  const dupAttempt = build(); t(dupAttempt).attempts.push({ ...t(dupAttempt).attempts[0], epoch: 2 })
  expectIssue(dupAttempt, 'duplicate_key', 'attempt_repeat')
  const afterTerminal = build(); t(afterTerminal).cycles[1] = { ordinal: 2, state: 'not_reached', reason: 'not_reached' }
  expectIssue(afterTerminal, 'chronology_invalid', 'cycle_after_terminal')
  const trialSpan = build(); t(trialSpan).finishedAtMs.value = BASE - 1
  expectIssue(trialSpan, 'chronology_invalid', 'trial_span')
  const assignment = build(); relayCycle(assignment).items.manifest.assignedAtMs = relayCycle(assignment).endedAtMs + 1
  expectIssue(resign(assignment), 'chronology_invalid', 'assignment_outside_cycle')
  const assessed = build(); relayCycle(assessed).items.assessments[0].assessedAtMs = relayCycle(assessed).items.manifest.assignedAtMs - 1
  expectIssue(assessed, 'chronology_invalid', 'assessment_outside_cycle')
  const late = build(); t(late).forecasts[1].issuedAtMs = t(late).finishedAtMs.value + 1
  expectIssue(late, 'chronology_invalid', 'forecast_after_completion')
  const early = build(); t(early).forecasts[0].issuedAtMs = BASE - 1
  expectIssue(early, 'chronology_invalid', 'forecast_before_start')
  const hindsight = build(); t(hindsight).forecasts[0].issuedAtMs = relayCycle(hindsight, 0).endedAtMs + 1
  expectIssue(hindsight, 'chronology_invalid', 'forecast_after_cycle')
  const dupForecast = build(); t(dupForecast).forecasts[0].cycle = 2
  expectIssue(dupForecast, 'duplicate_key', 'forecast_cycle_repeat')
  const regress = build()
  t(regress).attempts.push({ id: 'att-2', epoch: 2, receiptRef: 'ev-extra' })
  regress.evidence.push({ id: 'ev-extra', kind: 'attempt_receipt', task: 'task-a', arm: 'arm-relay', seed: 1, attempt: 'att-2', cycle: null, metaSha256: '' })
  relayCycle(regress, 0).attempt = 'att-2'
  expectIssue(resign(regress), 'chronology_invalid', 'cycle_attempt_regress')
})

test('probe rules: scope and field agree, retries only follow failures, attempts are contiguous', () => {
  const scope = build(); relayCycle(scope).probes.manifest.occasions[0].field = 'head'
  expectIssue(resign(scope), 'schema_invalid', 'probe_field_scope')
  const critical = build(); relayCycle(critical).probes.manifest.occasions[1].field = null
  expectIssue(resign(critical), 'schema_invalid', 'probe_field_scope')
  const afterCorrect = build(); addRetry(afterCorrect, 0, relayCycle(afterCorrect).probes.grades[1], 'correct')
  expectIssue(resign(afterCorrect), 'chronology_invalid', 'probe_retry_after_correct')
  const gap = build(); { const c = relayCycle(gap); c.probes.grades[1] = { ...c.probes.grades[1], result: 'incorrect' }; addRetry(gap, 0, c.probes.grades[1], 'correct', 3) }
  expectIssue(resign(gap), 'missing_slot', 'probe_attempt_gap')
  const repeat = build(); { const c = relayCycle(repeat); c.probes.grades.push(structuredClone(c.probes.grades[0])) }
  expectIssue(repeat, 'duplicate_key', 'probe_row_repeat')
  const guard = build(); relayCycle(guard).guards.manifest.checks.push({ id: 'g-1', deadEnd: 'd-2' })
  expectIssue(resign(guard), 'duplicate_key')
})

test('errors carry fixed codes and never echo supplied values, keys or locations', () => {
  const marker = 'SECRET-MARKER-9f3'
  const inputs: Raw[] = []
  const unknownKey = build(); unknownKey[marker] = 'x'; inputs.push(unknownKey)
  const badId = build(); badId.plan.experimentId = `${marker} /etc/passwd`; inputs.push(badId)
  const badReason = build(); relayCycle(badReason).items = { state: 'unknown', reason: marker }; inputs.push(badReason)
  const badFormat = build(); badFormat.format = marker; inputs.push(badFormat)
  const nestedKey = build(); relayCycle(nestedKey).integrity.value[marker] = 'x'; inputs.push(nestedKey)
  const foreign = build(); foreign.trials[0].task = marker.toLowerCase(); inputs.push(foreign)
  const ref = build(); relayCycle(ref).receiptRef = marker; inputs.push(ref)
  for (const raw of inputs) {
    const result = checkRelayMeasurement(raw)
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).toLowerCase().includes('secret-marker'), JSON.stringify(result))
    assert.throws(() => validateRelayMeasurement(raw), (error: unknown) => {
      assert.ok(error instanceof RelayMeasurementError)
      assert.ok((RELAY_ERROR_CODES as readonly string[]).includes(error.code))
      assert.match(error.message, /^relay_measurement_[a-z_]+$/)
      assert.ok(!JSON.stringify([error.message, error.issues, error.stack?.split('\n')[0]]).toLowerCase().includes('secret-marker'))
      return true
    })
  }
})

test('explicit missing and unknown slots are valid, visible, and carry no hidden defaults', () => {
  const raw = build()
  Object.assign(raw.trials[0], { state: 'missing', reason: 'not_collected' }); for (const k of ['runId', 'outcome', 'attempts', 'startedAtMs', 'finishedAtMs', 'cycles', 'forecasts']) delete raw.trials[0][k]
  const t = trialOf(raw, 'task-a', 'arm-relay', 2)
  t.cycles[0] = { ordinal: 1, state: 'unknown', reason: 'purged' }
  t.cycles[1].items = { state: 'unknown', reason: 'verifier_missing' }
  t.cycles[2] = { ordinal: 3, state: 'not_reached', reason: 'infra_tainted' }
  assert.equal(checkRelayMeasurement(resign(raw)).ok, true)
  const lying = build(); Object.assign(lying.trials[0], { state: 'missing', reason: 'not_collected', outcome: 'passed' })
  expectIssue(lying, 'schema_invalid')
})

test('B3 input is refused by the B1 validators and B1 records cannot enter the B3 format', () => {
  const raw = build()
  assert.throws(() => validatePlan(raw))
  assert.throws(() => validateRecordedPlan(raw.plan))
  assert.throws(() => validateResults(b1Plan(), raw.trials))
  const p = b1Plan()
  expectIssue(p, 'schema_invalid')
  expectIssue({ plan: p, trials: [], recordedAt: '2026-10-22T00:00:00.000Z' }, 'schema_invalid')
  assert.equal(validatePlan({ ...p }).version, 1) // existing B1 acceptance is unchanged
})

test('the modules are pure: no IO, clock, network, environment or unrelated imports', () => {
  for (const file of ['relay-protocol.ts', 'relay-measurement.ts']) {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
    const imports = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/^\} from ['"]([^'"]+)['"]/gm)].map(m => m[1])
    for (const spec of imports) assert.ok(['node:crypto', 'zod', './relay-protocol.ts'].includes(spec!), `${file} imports ${spec}`)
    for (const banned of ['Date.now', 'new Date', 'performance.now', 'fetch(', 'process.env', 'setTimeout', 'Math.random', 'randomUUID', 'writeFile', 'readFile', 'child_process', 'node:fs', 'node:net', 'node:http']) {
      assert.ok(!source.includes(banned), `${file} contains ${banned}`)
    }
  }
})

test('the fixture shape is what the hand counts assume', () => {
  const raw = build()
  assert.deepEqual(raw.plan.tasks, TASKS); assert.deepEqual(raw.plan.seeds, SEEDS)
  assert.equal(raw.trials.length, 8)
})

test('every remaining structural rule fails when violated', () => {
  const t = (r: Raw) => trialOf(r, 'task-a', 'arm-relay', 1)
  const cases: Array<[string, (r: Raw) => void, RelayErrorCode, string]> = [
    ['trial after recorded', r => { t(r).finishedAtMs.value = r.recordedAtMs + 1 }, 'chronology_invalid', 'after_recorded'],
    ['trial start after cycle', r => { t(r).startedAtMs.value = relayCycle(r, 0).startedAtMs + 1 }, 'chronology_invalid', 'cycle_before_trial'],
    ['trial end before cycle', r => { t(r).finishedAtMs.value = relayCycle(r, 2).endedAtMs - 1 }, 'chronology_invalid', 'cycle_after_trial'],
    ['forecast after recorded', r => { t(r).forecasts[1].issuedAtMs = r.recordedAtMs + 1 }, 'chronology_invalid', 'after_recorded'],
    ['forecast cycle range', r => { t(r).forecasts[1].cycle = 4 }, 'schema_invalid', 'forecast_cycle_range'],
    ['eta cycle range', r => { r.plan.eta.selectionCycle = 4 }, 'schema_invalid', 'eta_cycle_range'],
    ['forecast id repeat', r => { t(r).forecasts[1].id = 'f-1' }, 'duplicate_key', 'forecast_repeat'],
    ['arm id repeat', r => { r.plan.arms[1].id = 'arm-relay' }, 'duplicate_key', 'arm_repeat'],
    ['task repeat', r => { r.plan.tasks = ['task-a', 'task-a'] }, 'duplicate_key', 'task_repeat'],
    ['probe occasion repeat', r => { relayCycle(r).probes.manifest.occasions[1].id = 'p-whole' }, 'duplicate_key', 'probe_occasion_repeat'],
    ['probes manifest digest', r => { relayCycle(r).probes.manifest.sha256 = 'e'.repeat(64) }, 'reference_mismatch', 'manifest_digest'],
    ['context manifest digest', r => { relayCycle(r).context.manifest.sha256 = 'e'.repeat(64) }, 'reference_mismatch', 'manifest_digest'],
    ['guards manifest digest', r => { relayCycle(r).guards.manifest.sha256 = 'e'.repeat(64) }, 'reference_mismatch', 'manifest_digest'],
    ['calibration ref', r => { r.plan.stratum.eCalibration = { state: 'observed', ref: 'ev-nope', effectiveTokens: 20000 } }, 'reference_mismatch', 'ref_unresolved'],
    ['unsupported arm ref', r => { r.plan.arms[2].availability.ref = 'ev-nope' }, 'reference_mismatch', 'ref_unresolved'],
    ['evidence foreign seed', r => { r.evidence[1].seed = 77 }, 'identity_mismatch', 'evidence_foreign'],
    ['evidence foreign arm', r => { r.evidence[1].arm = 'arm-zzz' }, 'identity_mismatch', 'evidence_foreign'],
    ['reused grading record', r => { relayCycle(r).probes.grades[1].ref = relayCycle(r).probes.grades[0].ref }, 'reference_mismatch', 'ref_reuse'],
    ['reused runtime sample record', r => { relayCycle(r).context.samples[1].ref = relayCycle(r).context.samples[0].ref }, 'reference_mismatch', 'ref_reuse'],
    ['reused cycle receipt', r => { relayCycle(r, 1).receiptRef = relayCycle(r, 0).receiptRef }, 'reference_mismatch', 'ref_reuse'],
    ['forecast for an unreached cycle', r => { t(r).cycles[2] = { ordinal: 3, state: 'not_reached', reason: 'not_reached' }; t(r).forecasts[1].cycle = 3 }, 'chronology_invalid', 'forecast_cycle_not_reached'],
  ]
  for (const [name, patch, code, rule] of cases) {
    const r = build(); patch(r)
    const result = checkRelayMeasurement(name.includes('digest') ? r : resign(r))
    assert.equal(result.ok, false, name)
    if (!result.ok) assert.ok(result.issues.some(i => i.code === code && i.rule === rule), `${name}: ${JSON.stringify(result.issues.slice(0, 3))}`)
  }
  const shared = build(); relayCycle(shared).items.assessments[1].ref = relayCycle(shared).items.assessments[0].ref
  assert.equal(checkRelayMeasurement(resign(shared)).ok, true) // one verifier run may back several items of one cycle
})

test('hostile input yields a fixed schema_invalid and is bounded before parsing', () => {
  const getter = { get format(): string { throw new Error('SECRET-GETTER-TEXT') } }
  const result = checkRelayMeasurement(getter)
  assert.deepEqual(result, { ok: false, issues: [{ code: 'schema_invalid', rule: 'unreadable', location: 'input' }] })
  assert.throws(() => validateRelayMeasurement(new Proxy({}, { get() { throw new Error('SECRET-PROXY-TEXT') } })), (e: unknown) => e instanceof RelayMeasurementError && !e.message.includes('SECRET'))
  const huge = { ...build(), evidence: new Array(50_001).fill(null) }
  const started = process.hrtime.bigint()
  expectIssue(huge, 'schema_invalid', 'bounds')
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 250, 'bounds are checked before every element is parsed')
})
