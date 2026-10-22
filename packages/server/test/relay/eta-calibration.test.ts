import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  R3_ETA_GATE_RULE,
  parseEtaCorpus,
  scoreEta,
  type EtaCorpus,
  type EtaOrigin,
  type EtaSample,
} from '../../src/relay/eta-calibration.ts'

const T = 1_000_000

function sample(runId: string, patch: Partial<EtaSample> = {}): EtaSample {
  return {
    runId,
    origin: 'recorded',
    cohort: 'fixture',
    projectedAt: T,
    p50FinishAt: T + 100,
    p80FinishAt: T + 200,
    actualFinishAt: T + 150,
    outcome: 'completed',
    ...patch,
  }
}

function corpus(samples: EtaSample[]): EtaCorpus {
  return { version: 1, samples }
}

function validSample(): EtaSample {
  return sample('run-1')
}

function mutate(mutator: (value: EtaSample) => void): EtaCorpus {
  const value = corpus([validSample()])
  mutator(value.samples[0]!)
  return value
}

function rejects(value: unknown, path: string): void {
  assert.throws(() => parseEtaCorpus(value), (error: unknown) => {
    assert.ok(error instanceof TypeError)
    assert.ok(error.message.startsWith(path), `expected path ${path}, got ${error.message}`)
    return true
  })
}

function gateCorpus(runs: number, covered: number, origin: EtaOrigin = 'recorded'): EtaCorpus {
  return corpus(Array.from({ length: runs }, (_, index) => sample(`run-${index}`, {
    origin,
    cohort: 'gate',
    projectedAt: T + index,
    p50FinishAt: T + 10_000,
    p80FinishAt: T + 20_000,
    actualFinishAt: index < covered ? T + 20_000 : T + 20_001,
  })))
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

test('ETA parser rejects malformed documents and samples with a TypeError naming the path', () => {
  const invalid: [unknown, string][] = [
    [null, 'corpus'],
    [[], 'corpus'],
    [{ samples: [] }, 'corpus.version'],
    [{ version: 2, samples: [] }, 'corpus.version'],
    [{ version: '1', samples: [] }, 'corpus.version'],
    [{ version: 1, samples: [], extra: true }, 'corpus.extra'],
    [{ version: 1, samples: {} }, 'corpus.samples'],
  ]

  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).extra = true }), 'corpus.samples[0].extra'])
  invalid.push([mutate(value => { delete (value as unknown as Record<string, unknown>).runId }), 'corpus.samples[0].runId'])
  invalid.push([mutate(value => { value.runId = '' }), 'corpus.samples[0].runId'])
  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).runId = 1 }), 'corpus.samples[0].runId'])
  invalid.push([mutate(value => { value.cohort = '' }), 'corpus.samples[0].cohort'])
  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).origin = 'real' }), 'corpus.samples[0].origin'])
  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).outcome = 'done' }), 'corpus.samples[0].outcome'])
  for (const projectedAt of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push([mutate(value => { value.projectedAt = projectedAt }), 'corpus.samples[0].projectedAt'])
  }
  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).p50FinishAt = 'later' }), 'corpus.samples[0].p50FinishAt'])
  invalid.push([mutate(value => { value.p80FinishAt = -1 }), 'corpus.samples[0].p80FinishAt'])
  invalid.push([mutate(value => { (value as unknown as Record<string, unknown>).actualFinishAt = 1.5 }), 'corpus.samples[0].actualFinishAt'])

  for (const [value, path] of invalid) rejects(value, path)

  const valid = corpus([validSample()])
  assert.deepEqual(parseEtaCorpus(valid), valid)
  assert.deepEqual(parseEtaCorpus({ version: 1, samples: [] }), { version: 1, samples: [] })
  const nullable = corpus([sample('nullable', { p50FinishAt: null, p80FinishAt: null, actualFinishAt: null })])
  assert.deepEqual(parseEtaCorpus(nullable), nullable)
  const p80Only = corpus([sample('p80-only', { p50FinishAt: null })])
  assert.deepEqual(parseEtaCorpus(p80Only), p80Only)
  const p50Only = corpus([sample('p50-only', { p80FinishAt: null })])
  assert.deepEqual(parseEtaCorpus(p50Only), p50Only)
})

test('ETA parser enforces projectedAt < P50 <= P80 and duplicate (runId, projectedAt) identity', () => {
  rejects(mutate(value => { value.p50FinishAt = value.projectedAt }), 'corpus.samples[0].p50FinishAt')
  rejects(mutate(value => { value.p50FinishAt = value.projectedAt - 1 }), 'corpus.samples[0].p50FinishAt')
  rejects(mutate(value => { value.p80FinishAt = value.projectedAt }), 'corpus.samples[0].p80FinishAt')
  rejects(mutate(value => { value.p50FinishAt = value.projectedAt + 300 }), 'corpus.samples[0].p80FinishAt')
  rejects(mutate(value => { value.p80FinishAt = null; value.p50FinishAt = value.projectedAt - 1 }), 'corpus.samples[0].p50FinishAt')
  rejects(mutate(value => { value.p50FinishAt = null; value.p80FinishAt = value.projectedAt }), 'corpus.samples[0].p80FinishAt')

  const duplicate = corpus([
    validSample(),
    sample('run-1', { cohort: 'other', projectedAt: T, actualFinishAt: T + 300 }),
  ])
  rejects(duplicate, 'corpus.samples[1].runId')

  const later = corpus([
    validSample(),
    sample('run-1', {
      projectedAt: T + 1000,
      p50FinishAt: T + 1100,
      p80FinishAt: T + 1200,
      actualFinishAt: T + 1150,
    }),
  ])
  assert.deepEqual(parseEtaCorpus(later), later)
  const distinct = corpus([validSample(), sample('run-2')])
  assert.deepEqual(parseEtaCorpus(distinct), distinct)
  const equalQuantiles = corpus([sample('equal', { p50FinishAt: T + 200, p80FinishAt: T + 200 })])
  assert.deepEqual(parseEtaCorpus(equalQuantiles), equalQuantiles)
})

test('coverage is hand-computed over eligible projections by cohort, counting the P80 boundary', () => {
  const value = corpus([
    sample('a', { cohort: 'alpha', projectedAt: 100, p50FinishAt: 200, p80FinishAt: 300, actualFinishAt: 300 }),
    sample('b', { cohort: 'alpha', projectedAt: 100, p50FinishAt: 250, p80FinishAt: 400, actualFinishAt: 250 }),
    sample('c', { cohort: 'beta', projectedAt: 100, p50FinishAt: 200, p80FinishAt: 300, actualFinishAt: 301 }),
    sample('g', { cohort: 'beta', projectedAt: 110, p50FinishAt: null, p80FinishAt: 500, actualFinishAt: 450 }),
    sample('d', { cohort: 'alpha', projectedAt: 100, actualFinishAt: 200, outcome: 'canceled' }),
    sample('e', { cohort: 'beta', actualFinishAt: null }),
    sample('f', { cohort: 'alpha', p50FinishAt: null, p80FinishAt: null, actualFinishAt: 350 }),
  ])
  const result = scoreEta(value)

  assert.equal(result.perRun, 'first')
  assert.equal(result.samples, 7)
  assert.equal(result.selected, 7)
  assert.equal(result.runs, 7)
  assert.equal(result.eligible, 4)
  assert.equal(result.eligibleRuns, 4)
  assert.deepEqual(result.reasons, { not_completed: 1, unknown_actual: 1, unknown_projection: 1 })
  assert.deepEqual(
    {
      selected: result.overall.selected,
      eligible: result.overall.eligible,
      covered: result.overall.covered,
      p80Coverage: result.overall.p80Coverage,
      p50Eligible: result.overall.p50Eligible,
      p50Covered: result.overall.p50Covered,
      p50Coverage: result.overall.p50Coverage,
      runs: result.overall.runs,
    },
    {
      selected: 7,
      eligible: 4,
      covered: 3,
      p80Coverage: 0.75,
      p50Eligible: 3,
      p50Covered: 1,
      p50Coverage: 1 / 3,
      runs: 4,
    },
  )

  assert.deepEqual(result.cohorts.map(cohort => cohort.cohort), ['alpha', 'beta'])
  const alpha = result.cohorts[0]!
  assert.deepEqual(
    {
      selected: alpha.selected,
      eligible: alpha.eligible,
      covered: alpha.covered,
      p80Coverage: alpha.p80Coverage,
      p50Eligible: alpha.p50Eligible,
      p50Covered: alpha.p50Covered,
      p50Coverage: alpha.p50Coverage,
      runs: alpha.runs,
    },
    { selected: 4, eligible: 2, covered: 2, p80Coverage: 1, p50Eligible: 2, p50Covered: 1, p50Coverage: 0.5, runs: 2 },
  )
  const beta = result.cohorts[1]!
  assert.deepEqual(
    {
      selected: beta.selected,
      eligible: beta.eligible,
      covered: beta.covered,
      p80Coverage: beta.p80Coverage,
      p50Eligible: beta.p50Eligible,
      p50Covered: beta.p50Covered,
      p50Coverage: beta.p50Coverage,
      runs: beta.runs,
    },
    { selected: 3, eligible: 2, covered: 1, p80Coverage: 0.5, p50Eligible: 1, p50Covered: 0, p50Coverage: 0, runs: 2 },
  )
  assert.equal(result.gate.reason, 'insufficient_runs')
})

test('eligibility reasons use fixed precedence and classify only selected projections', () => {
  const value = corpus([
    sample('run-a', { projectedAt: 100, p50FinishAt: T + 100, p80FinishAt: null, actualFinishAt: null, outcome: 'canceled' }),
    sample('run-a', { projectedAt: 200, p50FinishAt: 250, p80FinishAt: 300, actualFinishAt: 250 }),
  ])
  const first = scoreEta(value)
  assert.equal(first.selected, 1)
  assert.deepEqual(first.reasons, { not_completed: 1, unknown_actual: 0, unknown_projection: 0 })
  assert.equal(first.eligible, 0)
  assert.equal(first.overall.p80Coverage, null)
  assert.equal(first.overall.p50Coverage, null)
  assert.equal(first.overall.wilson95, null)
  assert.deepEqual(first.cohorts.map(cohort => cohort.cohort), ['fixture'])
  assert.equal(first.cohorts[0]!.eligible, 0)
  assert.equal(first.cohorts[0]!.p80Coverage, null)

  const all = scoreEta(value, { perRun: 'all' })
  assert.equal(all.selected, 2)
  assert.deepEqual(all.reasons, { not_completed: 1, unknown_actual: 0, unknown_projection: 0 })
  assert.equal(all.eligible, 1)
  assert.equal(all.overall.p80Coverage, 1)

  const unknownActual = scoreEta(corpus([
    sample('unknown-actual', { actualFinishAt: null, p80FinishAt: null }),
  ]))
  assert.deepEqual(unknownActual.reasons, { not_completed: 0, unknown_actual: 1, unknown_projection: 0 })

  const unknownProjection = scoreEta(corpus([
    sample('unknown-projection', { p80FinishAt: null, actualFinishAt: T + 999 }),
  ]))
  assert.deepEqual(unknownProjection.reasons, { not_completed: 0, unknown_actual: 0, unknown_projection: 1 })

  const noP50 = scoreEta(corpus([sample('p80-only', { p50FinishAt: null })]))
  assert.equal(noP50.overall.eligible, 1)
  assert.equal(noP50.overall.p80Coverage, 1)
  assert.equal(noP50.overall.p50Eligible, 0)
  assert.equal(noP50.overall.p50Coverage, null)
})

test('per-run first, last and all select projections deterministically', () => {
  const value = corpus([
    sample('r1', { projectedAt: 100, p50FinishAt: 200, p80FinishAt: 300, actualFinishAt: 250 }),
    sample('r1', { projectedAt: 200, p50FinishAt: 300, p80FinishAt: 400, actualFinishAt: 250 }),
    sample('r1', { projectedAt: 300, p50FinishAt: 400, p80FinishAt: 500, actualFinishAt: 550 }),
    sample('r2', { projectedAt: 100, p50FinishAt: 200, p80FinishAt: 300, actualFinishAt: 200 }),
    sample('r2', { projectedAt: 200, p50FinishAt: 300, p80FinishAt: 400, actualFinishAt: 250 }),
  ])
  const first = scoreEta(value)
  const last = scoreEta(value, { perRun: 'last' })
  const all = scoreEta(value, { perRun: 'all' })

  assert.equal(first.perRun, 'first')
  assert.equal(first.selected, 2)
  assert.equal(first.overall.p80Coverage, 1)
  assert.equal(last.perRun, 'last')
  assert.equal(last.selected, 2)
  assert.equal(last.overall.p80Coverage, 0.5)
  assert.equal(all.perRun, 'all')
  assert.equal(all.selected, 5)
  assert.equal(all.overall.covered, 4)
  assert.equal(all.overall.p80Coverage, 0.8)
  assert.equal(all.eligibleRuns, 2)
  assert.deepEqual(first, scoreEta(value, { perRun: 'first' }))

  assert.throws(() => scoreEta(value, { perRun: 'middle' } as never),
    (error: unknown) => error instanceof TypeError && error.message.startsWith('opts.perRun'))
  assert.throws(() => scoreEta(value, { extra: true } as never),
    (error: unknown) => error instanceof TypeError && error.message.startsWith('opts.extra'))
  assert.throws(() => scoreEta(value, null as never),
    (error: unknown) => error instanceof TypeError && error.message.startsWith('opts'))
})

test('Wilson 95% interval matches hand-computed values for 16/20 and 0/5', () => {
  const sixteen = scoreEta(gateCorpus(20, 16))
  assert.equal(sixteen.overall.p80Coverage, 0.8)
  const interval = sixteen.overall.wilson95
  assert.ok(interval !== null)
  assert.ok(Math.abs(interval.lower - 0.5839782779742401) < 1e-12, `lower ${interval.lower}`)
  assert.ok(Math.abs(interval.upper - 0.9193436467288) < 1e-12, `upper ${interval.upper}`)
  assert.equal(sixteen.gate.evaluated, true)
  assert.equal(sixteen.gate.met, true)
  assert.equal(sixteen.gate.wilsonInside, false)

  const zero = scoreEta(gateCorpus(5, 0))
  assert.equal(zero.overall.p80Coverage, 0)
  assert.deepEqual(zero.overall.wilson95, { lower: 0, upper: 0.43449149475208104 })
  assert.equal(zero.gate.reason, 'insufficient_runs')
})

test('gate labels synthetic, mixed, empty and insufficient corpora without a verdict', () => {
  const synthetic = scoreEta(gateCorpus(20, 16, 'synthetic'))
  assert.deepEqual(synthetic.gate, {
    rule: R3_ETA_GATE_RULE,
    evaluated: false,
    reason: 'synthetic_corpus',
  })
  assert.equal(Object.hasOwn(synthetic.gate, 'met'), false)
  assert.equal(Object.hasOwn(synthetic.gate, 'wilsonInside'), false)

  const empty = scoreEta(corpus([]))
  assert.deepEqual(empty.gate, { rule: R3_ETA_GATE_RULE, evaluated: false, reason: 'empty_corpus' })
  assert.equal(empty.selected, 0)
  assert.equal(empty.runs, 0)
  assert.equal(empty.overall.p80Coverage, null)
  assert.equal(empty.overall.wilson95, null)
  assert.deepEqual(empty.cohorts, [])

  const mixed = gateCorpus(20, 16)
  mixed.samples.push(sample('run-0', {
    origin: 'synthetic',
    projectedAt: T + 50,
    p50FinishAt: T + 100,
    p80FinishAt: T + 200,
    actualFinishAt: T + 150,
  }))
  const mixedScore = scoreEta(mixed)
  assert.equal(mixedScore.selected, 20)
  assert.equal(mixedScore.eligible, 20)
  assert.equal(mixedScore.gate.evaluated, false)
  assert.equal(mixedScore.gate.reason, 'not_all_samples_recorded')
  assert.equal(Object.hasOwn(mixedScore.gate, 'met'), false)

  const nineteen = scoreEta(gateCorpus(19, 15))
  assert.equal(nineteen.gate.evaluated, false)
  assert.equal(nineteen.gate.reason, 'insufficient_runs')
  assert.equal(Object.hasOwn(nineteen.gate, 'met'), false)

  const repeated = corpus(Array.from({ length: 19 }, (_, index) => [
    sample(`run-${index}`, {
      projectedAt: T + index,
      p50FinishAt: T + 10_000,
      p80FinishAt: T + 20_000,
      actualFinishAt: T + 20_000,
    }),
    sample(`run-${index}`, {
      projectedAt: T + 500 + index,
      p50FinishAt: T + 10_000,
      p80FinishAt: T + 20_000,
      actualFinishAt: T + 20_000,
    }),
  ]).flat())
  const repeatedScore = scoreEta(repeated, { perRun: 'all' })
  assert.equal(repeatedScore.selected, 38)
  assert.equal(repeatedScore.eligible, 38)
  assert.equal(repeatedScore.eligibleRuns, 19)
  assert.equal(repeatedScore.gate.reason, 'insufficient_runs')
})

test('gate point estimate is inclusive at 0.7 and 0.9 and can disagree with the Wilson interval', () => {
  const low = scoreEta(gateCorpus(20, 14))
  assert.equal(low.gate.evaluated, true)
  assert.equal(low.gate.reason, 'recorded_corpus')
  assert.equal(low.gate.met, true)
  assert.equal(low.gate.wilsonInside, false)

  const high = scoreEta(gateCorpus(20, 18))
  assert.equal(high.gate.met, true)
  assert.equal(high.gate.wilsonInside, false)

  const over = scoreEta(gateCorpus(20, 19))
  assert.equal(over.overall.p80Coverage, 0.95)
  assert.equal(over.gate.evaluated, true)
  assert.equal(over.gate.met, false)
  assert.equal(over.gate.wilsonInside, false)

  const perfect = scoreEta(gateCorpus(20, 20))
  assert.equal(perfect.gate.met, false)

  const precise = scoreEta(gateCorpus(100, 80))
  assert.equal(precise.gate.evaluated, true)
  assert.equal(precise.gate.met, true)
  assert.equal(precise.gate.wilsonInside, true)
  assert.equal(precise.gate.rule, R3_ETA_GATE_RULE)
})

test('scoreEta is pure, deterministic and does not mutate its input', () => {
  const value = gateCorpus(20, 16)
  value.samples.push(sample('run-0', {
    projectedAt: T + 50,
    p50FinishAt: T + 10_000,
    p80FinishAt: T + 20_000,
    actualFinishAt: T + 19_999,
  }))
  const before = structuredClone(value)
  deepFreeze(value)

  const first = scoreEta(value, { perRun: 'all' })
  const second = scoreEta(value, { perRun: 'all' })
  assert.deepEqual(first, second)
  assert.deepEqual(value, before)
  assert.equal(first.selected, 21)
  assert.equal(first.overall.p80Coverage, 17 / 21)
})

test('the gate uses one projection per run, so many projections from one run cannot pass it', () => {
  const samples: EtaSample[] = []
  for (let i = 1; i < 20; i++) samples.push(sample(`r${i}`, { actualFinishAt: T + 500 }))
  for (let j = 0; j < 80; j++) samples.push(sample('r0', { projectedAt: T + j, p50FinishAt: T + 300, p80FinishAt: T + 400, actualFinishAt: T + 350 }))
  const all = scoreEta(corpus(samples), { perRun: 'all' })
  assert.ok((all.overall.p80Coverage ?? 0) > 0.8, 'per-projection coverage alone would pass')
  assert.equal(all.gate.evaluated, true)
  assert.equal(all.gate.met, false, 'the gate uses the earliest projection of each run')
  assert.equal(scoreEta(corpus(samples), { perRun: 'last' }).gate.met, false)
})

test('a projection made at or after the actual finish is rejected', () => {
  rejects(mutate(value => { value.actualFinishAt = value.projectedAt }), 'corpus.samples[0].actualFinishAt')
  rejects(mutate(value => { value.actualFinishAt = value.projectedAt - 1 }), 'corpus.samples[0].actualFinishAt')
})
