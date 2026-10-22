import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateQuota } from '../../src/notifications/rules.ts'
import type { Alert, AlertConfig, DependentRun, QuotaFact, WindowState } from '../../src/notifications/types.ts'

const T0 = Date.parse('2026-10-21T00:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function fact(overrides: Partial<QuotaFact> = {}): QuotaFact {
  return {
    connectionId: 'conn-1',
    window: 'five_hour',
    remainingPercent: 50,
    remainingAbsolute: null,
    resetsAt: null,
    source: 'claude-statusline',
    observedAt: at(0),
    confidence: 'observed',
    ...overrides,
  }
}

interface StepOptions extends Partial<Pick<QuotaFact, 'connectionId' | 'window' | 'resetsAt' | 'source' | 'confidence'>> {
  config?: AlertConfig
  dependentRuns?: DependentRun[]
  refusal?: boolean
}

function step(previous: WindowState | null, remainingPercent: number | null, minute: number, options: StepOptions = {}) {
  const { config, dependentRuns, refusal, ...factPatch } = options
  return evaluateQuota({
    fact: fact({ remainingPercent, observedAt: at(minute), ...factPatch }),
    previous,
    config,
    dependentRuns,
    refusal,
    now: at(minute + 1),
  })
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

test('ADR-0033 validation: thresholds fire once per instance and re-arm after a reset', () => {
  const percents = [100, 25, 19, 11, 9, 11, 9.5, 10.5, 8, 4, 3]
  let state: WindowState | null = null
  const alerts: Alert[] = []
  for (const [index, remainingPercent] of percents.entries()) {
    const result = step(state, remainingPercent, index)
    state = result.state
    alerts.push(...result.alerts)
  }

  if (state === null) assert.fail('threshold sequence produced no state')
  assert.equal(alerts.length, 3, 'jitter must not duplicate a fired threshold')
  assert.deepEqual(alerts.map(alert => alert.kind), ['threshold', 'threshold', 'threshold'])
  assert.deepEqual(alerts.map(alert => alert.threshold), [20, 10, 5])
  assert.deepEqual(alerts.map(alert => alert.severity), ['info', 'warning', 'critical'])
  assert.ok(alerts.every(alert => alert.instanceKey === 'no-reset'))
  assert.deepEqual(state.fired, [20, 10, 5])

  const resetAt = new Date(T0 + 12 * 60_000 + 5_000).toISOString()
  const afterReset = step(state, 100, 11, { resetsAt: resetAt })
  assert.equal(afterReset.alerts.length, 0)
  assert.equal(afterReset.state.instanceKey, resetAt)
  assert.deepEqual(afterReset.state.fired, [])

  const rearmed = step(afterReset.state, 15, 12, { resetsAt: resetAt })
  assert.equal(rearmed.alerts.length, 1, 'the 20% threshold must re-arm in the new instance')
  assert.equal(rearmed.alerts[0]?.kind, 'threshold')
  assert.equal(rearmed.alerts[0]?.threshold, 20)
  assert.equal(rearmed.alerts[0]?.severity, 'info')
  assert.deepEqual(rearmed.state.fired, [20])
})

test('a multi-threshold crossing fires highest-first with the generalised severities', () => {
  const first = step(null, 25, 0)
  assert.equal(first.alerts.length, 0)
  const crossing = step(first.state, 4, 1)
  assert.equal(crossing.alerts.length, 3)
  assert.deepEqual(crossing.alerts.map(alert => alert.threshold), [20, 10, 5])
  assert.deepEqual(crossing.alerts.map(alert => alert.severity), ['info', 'warning', 'critical'])
  assert.ok(crossing.alerts.every(alert => alert.kind === 'threshold'))

  const exact = step(null, 20, 0)
  assert.equal(exact.alerts.length, 1, 'the threshold fires at exactly its value')
  assert.equal(exact.alerts[0]?.threshold, 20)
})

test('a provider reset without a new timestamp re-arms above 50 points but not at 40', () => {
  let result = step(null, 40, 0)
  result = step(result.state, 10, 1)
  assert.deepEqual(result.alerts.map(alert => alert.threshold), [20, 10])

  const fortyPointRise = step(result.state, 50, 2)
  assert.equal(fortyPointRise.alerts.length, 0)
  assert.equal(fortyPointRise.state.instanceKey, 'no-reset')
  assert.deepEqual(fortyPointRise.state.fired, [20, 10])
  const afterForty = step(fortyPointRise.state, 4, 3)
  assert.deepEqual(afterForty.alerts.map(alert => alert.threshold), [5])
  assert.deepEqual(afterForty.state.fired, [20, 10, 5])

  let synthetic = step(null, 10, 10)
  assert.deepEqual(synthetic.alerts.map(alert => alert.threshold), [20, 10])
  synthetic = step(synthetic.state, 70, 11)
  assert.equal(synthetic.alerts.length, 0)
  assert.equal(synthetic.state.instanceKey, `no-reset#${at(11)}`)
  assert.deepEqual(synthetic.state.fired, [])

  const afterSynthetic = step(synthetic.state, 15, 12)
  assert.equal(afterSynthetic.state.instanceKey, `no-reset#${at(11)}`, 'later facts stay in the synthetic instance')
  assert.deepEqual(afterSynthetic.alerts.map(alert => alert.threshold), [20])
  assert.equal(afterSynthetic.alerts.length, 1)

  let jitter = step(null, 9, 20)
  assert.deepEqual(jitter.alerts.map(alert => alert.threshold), [20, 10])
  jitter = step(jitter.state, 13, 21)
  assert.equal(jitter.alerts.length, 0, 'rising above 10 + hysteresis does not re-arm 10')
  const afterJitter = step(jitter.state, 4, 22)
  assert.deepEqual(afterJitter.alerts.map(alert => alert.threshold), [5])

  let exactFifty = step(null, 40, 30)
  exactFifty = step(exactFifty.state, 10, 31)
  assert.deepEqual(exactFifty.alerts.map(alert => alert.threshold), [20, 10])
  const fiftyRise = step(exactFifty.state, 60, 32)
  assert.equal(fiftyRise.alerts.length, 0, 'a rise of exactly 50 points is not a reset')
  assert.equal(fiftyRise.state.instanceKey, 'no-reset')
  const afterFifty = step(fiftyRise.state, 4, 33)
  assert.deepEqual(afterFifty.alerts.map(alert => alert.threshold), [5])

  const aliasA = '2026-10-21T00:21:30Z'
  const aliasB = '2026-10-21T00:21:30.000Z'
  let alias = step(null, 20, 20, { resetsAt: aliasA })
  assert.deepEqual(alias.alerts.map(alert => alert.threshold), [20])
  alias = step(alias.state, 9, 21, { resetsAt: aliasB })
  assert.equal(alias.alerts.length, 1, 'equivalent reset spellings keep one instance')
  assert.deepEqual(alias.alerts.map(alert => alert.threshold), [10])
  assert.equal(alias.state.instanceKey, aliasA)
})

test('an unknown percent fires nothing and preserves fired thresholds', () => {
  let result = step(null, 30, 0)
  assert.equal(result.alerts.length, 0)
  result = step(result.state, 9, 1)
  assert.deepEqual(result.alerts.map(alert => alert.threshold), [20, 10])
  const firedBeforeUnknown = [...result.state.fired]

  const unknown = step(result.state, null, 2)
  assert.equal(unknown.alerts.length, 0)
  assert.deepEqual(unknown.state.fired, firedBeforeUnknown)
  assert.equal(unknown.state.lastPercent, null)
  assert.equal(unknown.state.lastObservedAt, at(2))

  const afterUnknown = step(unknown.state, 5, 3)
  assert.equal(afterUnknown.alerts.length, 1, 'unknown input must not re-arm or forecast')
  assert.deepEqual(afterUnknown.alerts.map(alert => alert.threshold), [5])
})

test('an exhausted alert fires once per instance and again after a reset', () => {
  const resetA = at(300)
  const resetB = at(600)
  let result = step(null, 50, 0, { resetsAt: resetA })
  result = step(result.state, 50, 1, { resetsAt: resetA, refusal: true })
  assert.equal(result.alerts.length, 1)
  assert.equal(result.alerts[0]?.kind, 'exhausted')
  assert.equal(result.alerts[0]?.severity, 'critical')
  assert.equal(result.alerts[0]?.threshold, null)
  const firstKey = result.alerts[0]?.idempotencyKey

  const repeated = step(result.state, 50, 2, { resetsAt: resetA, refusal: true })
  assert.equal(repeated.alerts.length, 0)
  assert.equal(repeated.state.exhaustedFired, true)

  const reset = step(repeated.state, 50, 3, { resetsAt: resetB })
  assert.equal(reset.alerts.length, 0)
  assert.equal(reset.state.exhaustedFired, false)
  const afterReset = step(reset.state, 50, 4, { resetsAt: resetB, refusal: true })
  assert.equal(afterReset.alerts.length, 1)
  assert.equal(afterReset.alerts[0]?.kind, 'exhausted')
  assert.notEqual(afterReset.alerts[0]?.idempotencyKey, firstKey)
})

test('forecast fires only before a reset or dependent ETA and once per instance', () => {
  const reset3h = at(180)
  let first = step(null, 50, 0, { resetsAt: reset3h })
  let result = step(first.state, 30, 60, { resetsAt: reset3h })
  assert.equal(result.alerts.length, 1)
  assert.equal(result.alerts[0]?.kind, 'forecast')
  assert.equal(result.alerts[0]?.severity, 'warning')
  assert.deepEqual(result.alerts[0]?.forecast, { exhaustsAt: at(150), before: 'reset' })

  const once = step(result.state, 29, 61, { resetsAt: reset3h })
  assert.equal(once.alerts.length, 0, 'forecast must fire once per instance even when still due')

  const offsetlessFirst = evaluateQuota({
    fact: fact({ remainingPercent: 50, resetsAt: '2026-10-21T05:00:00', observedAt: '2026-10-21T00:00:00' }),
    previous: null,
    now: '2026-10-21T00:01:00',
  })
  const offsetlessForecast = evaluateQuota({
    fact: fact({ remainingPercent: 30, resetsAt: '2026-10-21T05:00:00', observedAt: '2026-10-21T01:00:00' }),
    previous: offsetlessFirst.state,
    now: '2026-10-21T01:01:00',
  })
  assert.deepEqual(
    offsetlessForecast.alerts[0]?.forecast,
    { exhaustsAt: '2026-10-21T02:30:00.000Z', before: 'reset' },
    'offsetless ISO timestamps are interpreted as UTC',
  )

  first = step(null, 50, 0, { resetsAt: at(120) })
  result = step(first.state, 30, 60, { resetsAt: at(120) })
  assert.equal(result.alerts.length, 0, 'exhaustion after the reset must not forecast')
  assert.equal(result.state.forecastFired, false)

  first = step(null, 50, 0, { resetsAt: at(150) })
  result = step(first.state, 30, 60, { resetsAt: at(150) })
  assert.equal(result.alerts.length, 0, 'exhaustion exactly at the reset is not strictly before')

  first = step(null, 50, 0, { resetsAt: reset3h })
  result = step(first.state, 30, 60, {
    resetsAt: reset3h,
    dependentRuns: [{ runId: 'run-a', etaP80: at(180) }, { runId: 'run-b', etaP80: at(240) }],
  })
  assert.deepEqual(result.alerts[0]?.forecast, { exhaustsAt: at(150), before: 'dependent_run_eta', runId: 'run-a' })

  first = step(null, 50, 0)
  result = step(first.state, 30, 60, {
    dependentRuns: [{ runId: 'run-early', etaP80: at(120) }, { runId: 'run-late', etaP80: at(240) }],
  })
  assert.equal(result.alerts.length, 1, 'a later dependent run that outlives the window must forecast')
  assert.deepEqual(result.alerts[0]?.forecast, { exhaustsAt: at(150), before: 'dependent_run_eta', runId: 'run-late' })

  first = step(null, 30, 0, { resetsAt: reset3h })
  assert.equal(first.alerts.length, 0, 'the first observation cannot forecast')
  first = step(null, 50, 0, { resetsAt: reset3h })
  assert.equal(step(first.state, 50, 60, { resetsAt: reset3h }).alerts.length, 0, 'flat values cannot forecast')
  assert.equal(step(first.state, 60, 60, { resetsAt: reset3h }).alerts.length, 0, 'rising values cannot forecast')
  const noReset = step(null, 50, 0)
  assert.equal(step(noReset.state, 30, 60).alerts.length, 0, 'no reset and no dependent run cannot forecast')
})

test('an out-of-order observation returns the previous state unchanged', () => {
  let result = step(null, 50, 0)
  result = step(result.state, 12, 2)
  const previous = deepFreeze(result.state)
  const snapshot = structuredClone(previous)

  const staleLow = evaluateQuota({
    fact: fact({ remainingPercent: 4, observedAt: at(1) }),
    previous,
    refusal: true,
    now: at(3),
  })
  assert.deepEqual(staleLow, { state: previous, alerts: [] })

  const staleHigh = evaluateQuota({
    fact: fact({ remainingPercent: 90, observedAt: at(0.5) }),
    previous,
    now: at(3),
  })
  assert.deepEqual(staleHigh, { state: previous, alerts: [] }, 'a stale rise must not fake a provider reset')
  assert.deepEqual(previous, snapshot)

  const oldReset = at(10)
  const currentReset = at(41.5)
  let shifted = step(null, 50, 20, { resetsAt: oldReset })
  shifted = step(shifted.state, 25, 30, { resetsAt: currentReset })
  shifted = step(shifted.state, 9, 40, { resetsAt: currentReset })
  assert.deepEqual(shifted.alerts.map(alert => alert.threshold), [20, 10])
  const current = deepFreeze(shifted.state)
  const currentSnapshot = structuredClone(current)

  const staleOldReset = evaluateQuota({
    fact: fact({ remainingPercent: 4, resetsAt: oldReset, observedAt: at(35) }),
    previous: current,
    now: at(41),
  })
  assert.deepEqual(staleOldReset, { state: current, alerts: [] }, 'an old-reset fact must not regress the current instance')
  assert.deepEqual(current, currentSnapshot)

  const next = step(current, 4, 41, { resetsAt: currentReset })
  assert.equal(next.alerts.length, 1, 'the current instance keeps its fired thresholds')
  assert.deepEqual(next.alerts.map(alert => alert.threshold), [5])
})

test('evaluation is deterministic and never mutates the previous state', () => {
  const resetAt = at(180)
  const initial = step(null, 30, 0, { resetsAt: resetAt })
  const previous = deepFreeze(structuredClone(initial.state))
  const snapshot = structuredClone(previous)
  const config = deepFreeze<AlertConfig>({ thresholds: [20, 10, 5], hysteresisPoints: 2 })
  const input = {
    fact: fact({ remainingPercent: 4, resetsAt: resetAt, observedAt: at(60), source: 'local-meter', confidence: 'estimated' as const }),
    previous,
    config,
    refusal: true,
    now: at(61),
  }

  const first = evaluateQuota(input)
  const second = evaluateQuota(input)
  assert.deepEqual(first, second)
  assert.deepEqual(previous, snapshot)
  assert.equal(first.alerts.length, 5)
  assert.deepEqual(first.alerts.map(alert => alert.kind), ['threshold', 'threshold', 'threshold', 'forecast', 'exhausted'])
  assert.ok(first.alerts.every(alert =>
    alert.facts.source === 'local-meter' &&
    alert.facts.observedAt === at(60) &&
    alert.facts.confidence === 'estimated' &&
    alert.facts.remainingPercent === 4 &&
    alert.facts.resetsAt === resetAt
  ), 'every alert carries the provenance of the fact')
})

test('validation rejects malformed facts, timestamps, thresholds and hysteresis', () => {
  const valid = { fact: fact(), previous: null, now: at(1) }
  const throws = (run: () => unknown, pattern: RegExp) => {
    assert.throws(run, (error: unknown) => error instanceof TypeError && pattern.test(error.message))
  }

  for (const remainingPercent of [101, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    throws(
      () => evaluateQuota({ ...valid, fact: { ...valid.fact, remainingPercent } }),
      /remainingPercent/,
    )
  }
  throws(() => evaluateQuota({ ...valid, fact: { ...valid.fact, observedAt: 'not-a-time' } }), /observedAt/)
  for (const observedAt of ['0', 'October 21, 2026']) {
    throws(() => evaluateQuota({ ...valid, fact: { ...valid.fact, observedAt } }), /observedAt/)
  }
  throws(() => evaluateQuota({ ...valid, fact: { ...valid.fact, resetsAt: 'not-a-time' } }), /resetsAt/)
  throws(() => evaluateQuota({ ...valid, now: 'not-a-time' }), /now/)

  const config = (thresholds: number[], hysteresisPoints = 2): AlertConfig => ({ thresholds, hysteresisPoints })
  throws(() => evaluateQuota({ ...valid, config: config([20, 20]) }), /thresholds/)
  throws(
    () => evaluateQuota({ ...valid, config: { thresholds: '20' as unknown as number[], hysteresisPoints: 2 } }),
    /thresholds/,
  )
  for (const threshold of [0, 100, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    throws(() => evaluateQuota({ ...valid, config: config([threshold]) }), /thresholds/)
  }
  throws(() => evaluateQuota({ ...valid, config: config([20], -1) }), /hysteresisPoints/)
  throws(() => evaluateQuota({ ...valid, config: config([20], Number.NaN) }), /hysteresisPoints/)
  throws(() => evaluateQuota({ ...valid, config: config([20], Number.POSITIVE_INFINITY) }), /hysteresisPoints/)

  assert.doesNotThrow(() => evaluateQuota({ ...valid, fact: { ...valid.fact, remainingPercent: 0 } }))
  assert.doesNotThrow(() => evaluateQuota({ ...valid, fact: { ...valid.fact, remainingPercent: 100 } }))
})

test('idempotency keys are unique per alert and stable across identical calls', () => {
  const resetAt = at(180)
  const initial = step(null, 30, 0, { resetsAt: resetAt })
  const previous = deepFreeze(structuredClone(initial.state))
  const input = {
    fact: fact({ remainingPercent: 4, resetsAt: resetAt, observedAt: at(60) }),
    previous,
    refusal: true,
    now: at(61),
  }

  const first = evaluateQuota(input)
  const second = evaluateQuota(input)
  const ids = first.alerts.map(alert => alert.idempotencyKey)
  assert.equal(ids.length, 5)
  assert.equal(new Set(ids).size, 5)
  assert.deepEqual(ids, second.alerts.map(alert => alert.idempotencyKey))
  assert.equal(ids[0], `conn-1|five_hour|${resetAt}|threshold|20`)
  assert.equal(ids[1], `conn-1|five_hour|${resetAt}|threshold|10`)
  assert.equal(ids[2], `conn-1|five_hour|${resetAt}|threshold|5`)
  assert.equal(ids[3], `conn-1|five_hour|${resetAt}|forecast|-`)
  assert.equal(ids[4], `conn-1|five_hour|${resetAt}|exhausted|-`)
})

test('a custom threshold list works with zero hysteresis and generalised severities', () => {
  const custom: AlertConfig = { thresholds: [50, 25], hysteresisPoints: 0 }
  let result = step(null, 60, 0, { config: custom })
  assert.equal(result.alerts.length, 0)
  result = step(result.state, 40, 1, { config: custom })
  assert.equal(result.alerts.length, 1)
  assert.equal(result.alerts[0]?.threshold, 50)
  assert.equal(result.alerts[0]?.severity, 'info')

  const last = step(result.state, 20, 2, { config: custom })
  assert.equal(last.alerts.length, 1)
  assert.equal(last.alerts[0]?.threshold, 25)
  assert.equal(last.alerts[0]?.severity, 'critical')
  assert.deepEqual(last.state.fired, [50, 25])

  const single = step(null, 30, 0, { config: { thresholds: [40], hysteresisPoints: 0 } })
  assert.equal(single.alerts.length, 1)
  assert.equal(single.alerts[0]?.severity, 'warning', 'a single threshold is a warning')
})

test('a provider reset hidden behind an unknown reading still re-arms', () => {
  let result = step(null, 10, 0)
  assert.deepEqual(result.alerts.map(alert => alert.threshold), [20, 10])
  result = step(result.state, null, 1)
  assert.equal(result.state.lastKnownPercent, 10)
  result = step(result.state, 100, 2)
  assert.notEqual(result.state.instanceKey, 'no-reset', 'a +90 rise against the last known value is a new instance')
  result = step(result.state, 15, 3)
  assert.deepEqual(result.alerts.map(alert => alert.threshold), [20])
})

test('dependent ETAs and connection ids are validated', () => {
  const first = step(null, 50, 0)
  assert.throws(() => step(first.state, 30, 60, { dependentRuns: [{ runId: 'r', etaP80: 'not-a-time' }] }), TypeError)
  assert.throws(() => step(null, 50, 0, { connectionId: 'a|b' }), TypeError)
})
