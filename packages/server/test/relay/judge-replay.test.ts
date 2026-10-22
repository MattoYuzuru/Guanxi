import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FAULT_CLASSES,
  R3_GATE_RULE,
  parseReplayCorpus,
  score,
  type FaultClass,
  type ReplayCorpus,
  type ReplayRun,
  type ReplayStep,
} from '../../src/relay/judge-replay.ts'
import { generateCorpus } from '../../src/relay/judge-replay-inject.ts'
import type { JudgeObservation, JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'

const policy: JudgeSignalPolicy = {
  heartbeatStallMs: 100,
  noProgressCycles: 3,
  repeatedFailureCycles: 3,
  editRevertCycles: 3,
  repeatedDeadEnds: 3,
  tokenBlowupRatio: 2,
}

function observationAt(observedAt: number, patch: Partial<JudgeObservation> = {}): JudgeObservation {
  return {
    observedAt,
    heartbeatAt: observedAt - 1,
    lease: { expiresAt: observedAt + 1_000, current: true },
    deadlineAt: observedAt + 1_000,
    disk: { availableBytes: 10, requiredBytes: 10 },
    cycle: 1,
    noProgressCycles: 0,
    sameFailureStreak: 0,
    editRevertStreak: 0,
    deadEndRepetitions: 0,
    protectedPathEdits: [],
    outOfScopeEdits: [],
    tokensThisItem: 1,
    tokenBudgetForItem: 10,
    crashed: false,
    ...patch,
  }
}

function stepAt(
  observedAt: number,
  patch: Partial<JudgeObservation> = {},
  claimsDone?: boolean,
  acceptancePassed?: boolean | null,
): ReplayStep {
  const step: ReplayStep = { observation: observationAt(observedAt, patch) }
  if (claimsDone !== undefined) step.claimsDone = claimsDone
  if (acceptancePassed !== undefined) step.acceptancePassed = acceptancePassed
  return step
}

function step(
  index: number,
  patch: Partial<JudgeObservation> = {},
  claimsDone?: boolean,
  acceptancePassed?: boolean | null,
): ReplayStep {
  return stepAt(1_000_000 + index * 1_000, patch, claimsDone, acceptancePassed)
}

function run(
  id: string,
  steps: ReplayStep[],
  labels: ReplayRun['labels'] = [],
  origin: ReplayRun['origin'] = 'synthetic',
): ReplayRun {
  return { id, origin, policy: { ...policy }, steps, labels }
}

function corpus(runs: ReplayRun[]): ReplayCorpus {
  return { version: 1, runs }
}

function validCorpus(): ReplayCorpus {
  return corpus([run('run-1', [step(0), step(1)], [{ fault: 'loop', firstStep: 1 }], 'recorded')])
}

function mutateRun(mutator: (value: ReplayRun) => void): ReplayCorpus {
  const value = structuredClone(validCorpus())
  mutator(value.runs[0]!)
  return value
}

function mutateStep(mutator: (value: ReplayStep) => void): ReplayCorpus {
  return mutateRun(value => mutator(value.steps[0]!))
}

function mutateObservation(mutator: (value: JudgeObservation) => void): ReplayCorpus {
  return mutateStep(value => mutator(value.observation))
}

function mutateLabels(mutator: (value: ReplayRun['labels']) => void): ReplayCorpus {
  return mutateRun(value => mutator(value.labels))
}

function rejects(value: unknown, path: string): void {
  assert.throws(() => parseReplayCorpus(value), (error: unknown) => {
    assert.ok(error instanceof TypeError)
    assert.ok(error.message.startsWith(path), `expected path ${path}, got ${error.message}`)
    return true
  })
}

test('replay parser rejects malformed documents with a TypeError naming the path', () => {
  const invalid: [unknown, string][] = [
    [null, 'corpus'],
    [[], 'corpus'],
    [{ runs: [] }, 'corpus.version'],
    [{ version: 2, runs: [] }, 'corpus.version'],
    [{ version: '1', runs: [] }, 'corpus.version'],
    [{ version: 1, runs: [], extra: true }, 'corpus.extra'],
    [{ version: 1, runs: {} }, 'corpus.runs'],
  ]

  const extraRunKey = mutateRun(value => { (value as unknown as Record<string, unknown>).extra = true })
  invalid.push([extraRunKey, 'corpus.runs[0].extra'])
  const missingId = mutateRun(value => { delete (value as unknown as Record<string, unknown>).id })
  invalid.push([missingId, 'corpus.runs[0].id'])
  const emptyId = mutateRun(value => { value.id = '' })
  invalid.push([emptyId, 'corpus.runs[0].id'])
  const badOrigin = mutateRun(value => { (value as unknown as Record<string, unknown>).origin = 'real' })
  invalid.push([badOrigin, 'corpus.runs[0].origin'])
  const extraPolicyKey = mutateRun(value => { (value.policy as unknown as Record<string, unknown>).extra = true })
  invalid.push([extraPolicyKey, 'corpus.runs[0].policy.extra'])
  invalid.push([mutateRun(value => { value.policy.heartbeatStallMs = 0 }), 'corpus.runs[0].policy.heartbeatStallMs'])
  invalid.push([mutateRun(value => { value.policy.noProgressCycles = 0 }), 'corpus.runs[0].policy.noProgressCycles'])
  invalid.push([mutateRun(value => { value.policy.tokenBlowupRatio = 1 }), 'corpus.runs[0].policy.tokenBlowupRatio'])
  const badSteps = mutateRun(value => { (value as unknown as Record<string, unknown>).steps = {} })
  invalid.push([badSteps, 'corpus.runs[0].steps'])

  invalid.push([mutateStep(value => { (value as unknown as Record<string, unknown>).extra = true }), 'corpus.runs[0].steps[0].extra'])
  invalid.push([mutateStep(value => { delete (value as unknown as Record<string, unknown>).observation }), 'corpus.runs[0].steps[0].observation'])
  invalid.push([mutateStep(value => { (value as unknown as Record<string, unknown>).claimsDone = 'yes' }), 'corpus.runs[0].steps[0].claimsDone'])
  invalid.push([mutateStep(value => { (value as unknown as Record<string, unknown>).acceptancePassed = 'yes' }), 'corpus.runs[0].steps[0].acceptancePassed'])

  invalid.push([mutateObservation(value => { (value as unknown as Record<string, unknown>).extra = true }), 'corpus.runs[0].steps[0].observation.extra'])
  invalid.push([mutateObservation(value => { delete (value as unknown as Record<string, unknown>).observedAt }), 'corpus.runs[0].steps[0].observation.observedAt'])
  invalid.push([mutateObservation(value => { value.observedAt = -1 }), 'corpus.runs[0].steps[0].observation.observedAt'])
  invalid.push([mutateObservation(value => { value.heartbeatAt = value.observedAt + 1 }), 'corpus.runs[0].steps[0].observation.heartbeatAt'])
  invalid.push([mutateObservation(value => { (value.lease as unknown as Record<string, unknown>).extra = true }), 'corpus.runs[0].steps[0].observation.lease.extra'])
  invalid.push([mutateObservation(value => { delete (value.disk as unknown as Record<string, unknown>).requiredBytes }), 'corpus.runs[0].steps[0].observation.disk.requiredBytes'])
  invalid.push([mutateObservation(value => { value.protectedPathEdits = ['ok', 1] as unknown as string[] }), 'corpus.runs[0].steps[0].observation.protectedPathEdits[1]'])
  invalid.push([mutateObservation(value => { value.tokenBudgetForItem = 0 }), 'corpus.runs[0].steps[0].observation.tokenBudgetForItem'])
  invalid.push([mutateObservation(value => { (value as unknown as Record<string, unknown>).crashed = 0 }), 'corpus.runs[0].steps[0].observation.crashed'])

  invalid.push([corpus([run('run-1', [stepAt(1_000_000), stepAt(1_000_000)])]), 'corpus.runs[0].steps[1].observation.observedAt'])
  invalid.push([corpus([run('run-1', [stepAt(1_000_000), stepAt(999_000)])]), 'corpus.runs[0].steps[1].observation.observedAt'])

  const badLabels = mutateRun(value => { (value as unknown as Record<string, unknown>).labels = {} })
  invalid.push([badLabels, 'corpus.runs[0].labels'])
  invalid.push([mutateLabels(value => { (value[0] as unknown as Record<string, unknown>).extra = true }), 'corpus.runs[0].labels[0].extra'])
  invalid.push([mutateLabels(value => { (value[0] as unknown as Record<string, unknown>).fault = 'panic' }), 'corpus.runs[0].labels[0].fault'])
  invalid.push([mutateLabels(value => { value[0]!.firstStep = -1 }), 'corpus.runs[0].labels[0].firstStep'])
  invalid.push([mutateLabels(value => { value[0]!.firstStep = 2 }), 'corpus.runs[0].labels[0].firstStep'])
  invalid.push([mutateLabels(value => { value[0]!.firstStep = 1.5 }), 'corpus.runs[0].labels[0].firstStep'])
  invalid.push([mutateLabels(value => { value.push({ fault: 'loop', firstStep: 0 }) }), 'corpus.runs[0].labels[1].fault'])

  invalid.push([corpus([run('same', [step(0)]), run('same', [step(0)])]), 'corpus.runs[1].id'])

  for (const [value, path] of invalid) rejects(value, path)
  assert.deepEqual(parseReplayCorpus(validCorpus()), validCorpus())
  assert.deepEqual(parseReplayCorpus({ version: 1, runs: [] }), { version: 1, runs: [] })
  const nullable = corpus([run('nullable', [
    stepAt(1_000_000, {
      heartbeatAt: null,
      lease: null,
      deadlineAt: null,
      disk: null,
      tokenBudgetForItem: null,
    }, true, null),
  ])])
  assert.deepEqual(parseReplayCorpus(nullable), nullable)
})

test('run-level confusion matrix, precision, recall and latency are exact', () => {
  const hit = run('hit', [0, 1, 2, 3].map(index =>
    step(index, index >= 1 ? { noProgressCycles: 3 } : {})), [{ fault: 'loop', firstStep: 1 }])
  const late = run('late', [0, 1, 2, 3].map(index =>
    step(index, index >= 2 ? { noProgressCycles: 3 } : {})), [{ fault: 'loop', firstStep: 1 }])
  const miss = run('miss', [step(0), step(1), step(2)], [{ fault: 'loop', firstStep: 1 }])
  const healthy = run('healthy', [step(0), step(1)])

  const result = score(corpus([hit, late, miss, healthy]))
  assert.deepEqual(
    { tp: result.classes.loop.tp, fp: result.classes.loop.fp, fn: result.classes.loop.fn, tn: result.classes.loop.tn },
    { tp: 2, fp: 0, fn: 1, tn: 1 },
  )
  assert.equal(result.classes.loop.precision, 1)
  assert.equal(result.classes.loop.recall, 2 / 3)
  assert.deepEqual(result.classes.loop.latency, { median: 0.5, max: 1 })
  assert.equal(result.classes.loop.unknown, 0)

  for (const fault of ['protected_path_edit', 'premature_done', 'out_of_scope_edit', 'stall'] as const) {
    assert.deepEqual(
      { tp: result.classes[fault].tp, fp: result.classes[fault].fp, fn: result.classes[fault].fn, tn: result.classes[fault].tn },
      { tp: 0, fp: 0, fn: 0, tn: 4 },
    )
    assert.equal(result.classes[fault].precision, null)
    assert.equal(result.classes[fault].recall, null)
    assert.deepEqual(result.classes[fault].latency, { median: null, max: null })
  }

  assert.deepEqual(
    { tp: result.micro.tp, fp: result.micro.fp, fn: result.micro.fn, tn: result.micro.tn },
    { tp: 2, fp: 0, fn: 1, tn: 17 },
  )
  assert.equal(result.micro.precision, 1)
  assert.equal(result.micro.recall, 2 / 3)
  assert.deepEqual(result.micro.latency, { median: 0.5, max: 1 })
  assert.equal(result.runs, 4)
  assert.equal(result.labelledRuns, 3)
  assert.equal(result.origins.synthetic.runs, 4)
  assert.equal(result.origins.recorded.runs, 0)
  assert.deepEqual(result.origins.synthetic.micro, result.micro)
  assert.equal(result.origins.synthetic.classes.loop.tp, 2)
  assert.equal(result.origins.recorded.micro.tn, 0)
  assert.equal(result.gate.evaluated, false)
  assert.equal(result.gate.reason, 'synthetic_corpus')
  assert.equal(result.gate.rule, R3_GATE_RULE)
  assert.equal(Object.hasOwn(result.gate, 'met'), false)
})

test('a firing before firstStep counts as a false positive while a later firing still detects', () => {
  const replay = corpus([run('early', [0, 1, 2, 3, 4].map(index =>
    step(index, index === 1 || index === 3 ? { noProgressCycles: 3 } : {})),
  [{ fault: 'loop', firstStep: 2 }])])
  const result = score(replay)
  assert.deepEqual(
    { tp: result.classes.loop.tp, fp: result.classes.loop.fp, fn: result.classes.loop.fn, tn: result.classes.loop.tn },
    { tp: 1, fp: 1, fn: 0, tn: 0 },
  )
  assert.equal(result.classes.loop.precision, 0.5)
  assert.equal(result.classes.loop.recall, 1)
  assert.deepEqual(result.classes.loop.latency, { median: 1, max: 1 })
})

test('an early-only labelled firing is both a false positive and a false negative', () => {
  const replay = corpus([run('early-only', [0, 1, 2].map(index =>
    step(index, index === 1 ? { noProgressCycles: 3 } : {})),
  [{ fault: 'loop', firstStep: 2 }])])
  const result = score(replay)
  assert.deepEqual(
    { tp: result.classes.loop.tp, fp: result.classes.loop.fp, fn: result.classes.loop.fn, tn: result.classes.loop.tn },
    { tp: 0, fp: 1, fn: 1, tn: 0 },
  )
  assert.equal(result.classes.loop.precision, 0)
  assert.equal(result.classes.loop.recall, 0)
  assert.deepEqual(result.classes.loop.latency, { median: null, max: null })
})

test('premature done uses explicit failing acceptance and reports unknown separately', () => {
  const replay = corpus([
    run('explicit-failure', [step(0), step(1, {}, true, false), step(2, {}, true, false)], [{ fault: 'premature_done', firstStep: 1 }]),
    run('unknown', [step(0, {}, true), step(1, {}, true, null)], [{ fault: 'premature_done', firstStep: 1 }]),
    run('passing', [step(0), step(1, {}, true, true)]),
  ])
  const result = score(replay)
  assert.deepEqual(
    { tp: result.classes.premature_done.tp, fp: result.classes.premature_done.fp, fn: result.classes.premature_done.fn, tn: result.classes.premature_done.tn },
    { tp: 1, fp: 0, fn: 1, tn: 1 },
  )
  assert.equal(result.classes.premature_done.unknown, 2)
  assert.equal(result.classes.premature_done.recall, 0.5)
  assert.deepEqual(result.classes.premature_done.latency, { median: 0, max: 0 })
})

test('seeded synthetic corpus is deterministic, complete and never evaluated as the gate', () => {
  const options = { seed: 12345, runs: 240, faultRate: 0.35, policy }
  const generated = generateCorpus(options)
  assert.deepEqual(generated, generateCorpus(options))
  assert.equal(generated.runs.length, 240)
  assert.ok(generated.runs.every(value => value.origin === 'synthetic'))
  assert.deepEqual(parseReplayCorpus(generated), generated)

  const labelled = new Set<FaultClass>()
  for (const value of generated.runs) for (const label of value.labels) labelled.add(label.fault)
  assert.deepEqual([...labelled].sort(), [...FAULT_CLASSES].sort())

  const first = score(generated)
  const second = score(generated)
  assert.deepEqual(first, second)
  assert.equal(first.runs, 240)
  assert.equal(first.gate.evaluated, false)
  assert.equal(first.gate.reason, 'synthetic_corpus')
  assert.equal(Object.hasOwn(first.gate, 'met'), false)
  assert.ok(first.classes.loop.tp > 0)
  assert.ok(first.classes.protected_path_edit.tp > 0)
  assert.ok(first.classes.premature_done.tp > 0)
  assert.ok(first.classes.out_of_scope_edit.tp > 0)
  assert.ok(first.classes.stall.tp > 0)
})

test('recorded corpus with all required classes can evaluate the gate; missing class cannot', () => {
  const record = (): ReplayCorpus => corpus([
    run('recorded-loop', [step(0, { noProgressCycles: 3 }), step(1)], [{ fault: 'loop', firstStep: 0 }], 'recorded'),
    run('recorded-protected', [step(0), step(1, { protectedPathEdits: ['synthetic/protected/test.ts'] })],
      [{ fault: 'protected_path_edit', firstStep: 1 }], 'recorded'),
    run('recorded-premature', [step(0), step(1, {}, true, false)],
      [{ fault: 'premature_done', firstStep: 1 }], 'recorded'),
  ])

  const complete = score(record())
  assert.equal(complete.gate.evaluated, true)
  assert.equal(complete.gate.reason, 'recorded_corpus')
  assert.equal(complete.gate.met, true)
  assert.equal(complete.gate.met, complete.micro.recall !== null && complete.micro.precision !== null
    && complete.micro.recall >= 0.9 && complete.micro.precision >= 0.8)
  assert.equal(complete.gate.rule, R3_GATE_RULE)
  assert.equal(complete.origins.recorded.runs, 3)
  assert.equal(complete.origins.synthetic.runs, 0)
  assert.equal(complete.origins.recorded.classes.loop.tp, 1)
  assert.equal(complete.origins.recorded.micro.tp, 3)
  assert.equal(complete.origins.recorded.micro.fp, 0)

  const missing = record()
  missing.runs = missing.runs.filter(value => value.id !== 'recorded-premature')
  const missingScore = score(missing)
  assert.equal(missingScore.gate.evaluated, false)
  assert.equal(missingScore.gate.reason, 'missing_required_classes')
  assert.equal(Object.hasOwn(missingScore.gate, 'met'), false)

  const missed = record()
  missed.runs.find(value => value.id === 'recorded-premature')!.steps[1]!.acceptancePassed = true
  const missedScore = score(missed)
  assert.equal(missedScore.gate.evaluated, true)
  assert.equal(missedScore.gate.met, false)
  assert.equal(missedScore.classes.premature_done.fn, 1)

  const noisy = record()
  noisy.runs.push(run('recorded-noise', [step(0, { noProgressCycles: 3 }), step(1)], [], 'recorded'))
  const noisyScore = score(noisy)
  assert.equal(noisyScore.gate.evaluated, true)
  assert.equal(noisyScore.gate.met, false)
  assert.equal(noisyScore.classes.loop.fp, 1)
  assert.equal(noisyScore.classes.loop.precision, 0.5)

  const optionalNoise = record()
  optionalNoise.runs.push(run('recorded-optional-noise',
    [step(0, { outOfScopeEdits: ['synthetic/out-of-scope/noise.ts'] }), step(1)], [], 'recorded'))
  const optionalScore = score(optionalNoise)
  assert.equal(optionalScore.gate.evaluated, true)
  assert.equal(optionalScore.gate.met, false)
  assert.equal(optionalScore.classes.out_of_scope_edit.fp, 1)

  const mixed = record()
  mixed.runs[0]!.origin = 'synthetic'
  const mixedScore = score(mixed)
  assert.equal(mixedScore.gate.evaluated, false)
  assert.equal(mixedScore.gate.reason, 'not_all_runs_recorded')

  const unlabelledMixed = record()
  unlabelledMixed.runs.push(run('synthetic-healthy', [step(0), step(1)]))
  const unlabelledMixedScore = score(unlabelledMixed)
  assert.equal(unlabelledMixedScore.gate.evaluated, false)
  assert.equal(unlabelledMixedScore.gate.reason, 'not_all_runs_recorded')
})

test('a custom detector replaces the default for exactly one class', () => {
  const replay = corpus([
    run('custom-loop', [step(0), step(1), step(2, { noProgressCycles: 3 }), step(3, { noProgressCycles: 3 })],
      [{ fault: 'loop', firstStep: 1 }]),
    run('protected', [step(0), step(1, { protectedPathEdits: ['synthetic/protected/test.ts'] })],
      [{ fault: 'protected_path_edit', firstStep: 1 }]),
  ])
  const defaultScore = score(replay)
  assert.equal(defaultScore.classes.loop.tp, 1)
  assert.deepEqual(defaultScore.classes.loop.latency, { median: 1, max: 1 })
  assert.equal(defaultScore.classes.protected_path_edit.tp, 1)

  const replaced = score(replay, {
    loop: value => ({ firedSteps: value.id === 'custom-loop' ? [1] : [] }),
  })
  assert.equal(replaced.classes.loop.tp, 1)
  assert.equal(replaced.classes.loop.fp, 0)
  assert.deepEqual(replaced.classes.loop.latency, { median: 0, max: 0 })
  assert.equal(replaced.classes.protected_path_edit.tp, 1)

  const missed = score(replay, { loop: () => ({ firedSteps: [] }) })
  assert.equal(missed.classes.loop.tp, 0)
  assert.equal(missed.classes.loop.fn, 1)
  assert.equal(missed.classes.protected_path_edit.tp, 1)
})

test('generator near-miss negatives produce no default firing or unknown', () => {
  const generated = generateCorpus({ seed: 7, runs: 24, faultRate: 0, policy })
  assert.ok(generated.runs.every(value => value.labels.length === 0))
  assert.ok(generated.runs.some(value => value.steps.every(candidate =>
    candidate.observation.noProgressCycles === policy.noProgressCycles - 1
    && candidate.observation.sameFailureStreak === policy.repeatedFailureCycles - 1
    && candidate.observation.editRevertStreak === policy.editRevertCycles - 1
    && candidate.observation.deadEndRepetitions === policy.repeatedDeadEnds - 1)))
  assert.ok(generated.runs.some(value => value.steps.some(candidate =>
    candidate.claimsDone === true && candidate.acceptancePassed === true)))
  assert.ok(generated.runs.some(value => value.steps.every(candidate =>
    candidate.observation.heartbeatAt !== null
    && candidate.observation.observedAt - candidate.observation.heartbeatAt === Math.ceil(policy.heartbeatStallMs) - 1)))

  for (const value of generated.runs) {
    const result = score(corpus([value]))
    for (const fault of FAULT_CLASSES) {
      assert.deepEqual(
        {
          tp: result.classes[fault].tp,
          fp: result.classes[fault].fp,
          fn: result.classes[fault].fn,
          tn: result.classes[fault].tn,
          unknown: result.classes[fault].unknown,
        },
        { tp: 0, fp: 0, fn: 0, tn: 1, unknown: 0 },
        `${value.id} ${fault}`,
      )
    }
  }
})
