import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ZodError } from 'zod'
import type { ConnectionBalance } from '@guanxi/contract'
import { claudeRateLimits, codexRateLimits } from '../../src/external-agents/quota.ts'
import type { QuotaObservation } from '../../src/external-agents/types.ts'
import { factFromBalance, factsFromQuotaObservation } from '../../src/notifications/producers.ts'
import { evaluateQuota } from '../../src/notifications/rules.ts'

const T0 = Date.parse('2026-10-21T00:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const reset = (minutes: number) => Date.parse(at(minutes)) / 1000

function observation(overrides: Partial<QuotaObservation> = {}): QuotaObservation {
  return {
    ownerAccountId: 'acct-a',
    billingAccount: 'billing-a',
    adapter: 'claude-code',
    nodeId: 'node-1',
    source: 'claude-code@0.94.0:claude:statusline.rate_limits',
    observedAt: at(0),
    confidence: 'high',
    windows: [],
    ...overrides,
  }
}

function balance(overrides: Partial<ConnectionBalance> = {}): ConnectionBalance {
  return {
    scope: 'account_balance',
    amount: 12.5,
    currency: 'USD',
    source: 'https://api.deepseek.com/user/balance',
    observedAt: at(0),
    confidence: 'high',
    ...overrides,
  }
}

test('a Claude statusline sample produces exact five-hour and seven-day facts', () => {
  const windows = claudeRateLimits({
    rate_limits: {
      five_hour: { used_percentage: 85, resets_at: reset(300) },
      seven_day: { used_percentage: 12.5, resets_at: reset(10_080) },
    },
  })
  const source = 'claude-code@0.94.0:claude:statusline.rate_limits'
  const result = factsFromQuotaObservation(observation({ source, windows }), 'conn-claude')

  assert.deepEqual(result, {
    facts: [
      {
        connectionId: 'conn-claude',
        window: 'five_hour',
        remainingPercent: 15,
        remainingAbsolute: null,
        resetsAt: new Date(reset(300) * 1000).toISOString(),
        source,
        observedAt: at(0),
        confidence: 'observed',
      },
      {
        connectionId: 'conn-claude',
        window: 'seven_day',
        remainingPercent: 87.5,
        remainingAbsolute: null,
        resetsAt: new Date(reset(10_080) * 1000).toISOString(),
        source,
        observedAt: at(0),
        confidence: 'observed',
      },
    ],
    skipped: [],
  })
})

test('Codex primary and secondary without a reported window length are skipped, not guessed', () => {
  // K5's parser keeps the documented used/reset values but drops windowDurationMins, so the
  // producer cannot tell whether primary means five hours or a week.
  const windows = codexRateLimits({
    rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: reset(300) },
      secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: reset(10_080) },
    },
  })
  const result = factsFromQuotaObservation(observation({ adapter: 'codex', source: 'codex@0.163.0:account/rateLimits/read', windows }), 'conn-codex')

  assert.deepEqual(result, {
    facts: [],
    skipped: [
      { window: 'codex.primary', reason: 'unknown_window_kind' },
      { window: 'codex.secondary', reason: 'unknown_window_kind' },
    ],
  })
})

test('unknown window names are skipped with the same explicit reason', () => {
  const result = factsFromQuotaObservation(observation({
    windows: [
      { name: 'mystery_window', usedPercent: 10, resetsAt: null },
      { name: '__proto__', usedPercent: 20, resetsAt: null },
      { name: 'toString', usedPercent: 25, resetsAt: null },
      { name: 'five_hour', usedPercent: 30, resetsAt: null },
    ],
  }), 'conn-1')

  assert.deepEqual(result.facts.map(fact => [fact.window, fact.remainingPercent]), [['five_hour', 70]])
  assert.deepEqual(result.skipped, [
    { window: 'mystery_window', reason: 'unknown_window_kind' },
    { window: '__proto__', reason: 'unknown_window_kind' },
    { window: 'toString', reason: 'unknown_window_kind' },
  ])
})

test('a null usedPercent stays unknown instead of becoming zero or one hundred', () => {
  const result = factsFromQuotaObservation(observation({
    windows: [
      { name: 'five_hour', usedPercent: null, resetsAt: at(60) },
      { name: 'seven_day', usedPercent: 100, resetsAt: null },
    ],
  }), 'conn-1')

  const fiveHour = result.facts.find(fact => fact.window === 'five_hour')
  const sevenDay = result.facts.find(fact => fact.window === 'seven_day')
  assert.equal(fiveHour?.remainingPercent, null)
  assert.equal(fiveHour?.remainingAbsolute, null)
  assert.equal(fiveHour?.resetsAt, at(60))
  assert.equal(sevenDay?.remainingPercent, 0, 'a fully used window has zero remaining')
})

test('usedPercent above 100 clamps remainingPercent into the range', () => {
  const result = factsFromQuotaObservation(observation({
    windows: [
      { name: 'five_hour', usedPercent: 125, resetsAt: null },
      { name: 'seven_day', usedPercent: 100.5, resetsAt: null },
    ],
  }), 'conn-1')

  assert.deepEqual(result.facts.map(fact => fact.remainingPercent), [0, 0])

  const unused = factsFromQuotaObservation(observation({
    windows: [{ name: 'five_hour', usedPercent: 0, resetsAt: null }],
  }), 'conn-1')
  assert.equal(unused.facts[0]?.remainingPercent, 100)
})

test('vendor confidence maps high to observed and medium or low to estimated', () => {
  for (const [confidence, expected] of [['high', 'observed'], ['medium', 'estimated'], ['low', 'estimated']] as const) {
    const result = factsFromQuotaObservation(observation({
      confidence,
      windows: [{ name: 'five_hour', usedPercent: 50, resetsAt: null }],
    }), 'conn-1')
    assert.equal(result.facts[0]?.confidence, expected, `confidence ${confidence}`)
  }
})

test('a balance with a positive initial amount yields a clamped percentage', () => {
  const withInitial = factFromBalance(balance(), 'conn-balance', { initialAmount: 50 })
  assert.deepEqual(withInitial, {
    facts: [{
      connectionId: 'conn-balance',
      window: 'balance',
      remainingPercent: 25,
      remainingAbsolute: 12.5,
      resetsAt: null,
      source: 'https://api.deepseek.com/user/balance#account_balance#USD',
      observedAt: at(0),
      confidence: 'observed',
    }],
    skipped: [],
  })

  const overInitial = factFromBalance(balance({ amount: 75 }), 'conn-balance', { initialAmount: 50 })
  assert.equal(overInitial.facts[0]?.remainingPercent, 100)
  assert.equal(overInitial.facts[0]?.remainingAbsolute, 75, 'the decimal amount is kept as reported')

  const estimated = factFromBalance(balance({ confidence: 'medium' }), 'conn-balance')
  assert.equal(estimated.facts[0]?.confidence, 'estimated')
})

test('a balance without a usable initial amount keeps an unknown percentage', () => {
  for (const initialAmount of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = factFromBalance(balance(), 'conn-balance', { initialAmount })
    assert.equal(result.facts.length, 1)
    assert.equal(result.facts[0]?.remainingPercent, null, `initialAmount ${String(initialAmount)}`)
    assert.equal(result.facts[0]?.remainingAbsolute, 12.5)
  }
})

test('scope and currency are carried in the source suffix', () => {
  const allowance = factFromBalance(balance({
    scope: 'key_allowance',
    source: 'https://openrouter.ai/api/v1/key',
  }), 'conn-openrouter', { initialAmount: 10 })
  assert.equal(allowance.facts[0]?.source, 'https://openrouter.ai/api/v1/key#key_allowance#USD')

  const alreadyMarked = factFromBalance(balance({
    scope: 'key_allowance',
    source: 'https://openrouter.ai/api/v1/key#key_allowance',
  }), 'conn-openrouter')
  assert.equal(alreadyMarked.facts[0]?.source, 'https://openrouter.ai/api/v1/key#key_allowance#USD', 'no doubled suffix')

  const account = factFromBalance(balance(), 'conn-deepseek')
  assert.equal(account.facts[0]?.source, 'https://api.deepseek.com/user/balance#account_balance#USD')

  const cny = factFromBalance(balance({ currency: 'CNY' }), 'conn-deepseek')
  assert.equal(cny.facts[0]?.source, 'https://api.deepseek.com/user/balance#account_balance#CNY', 'currency is never dropped')
  const legacy = factFromBalance(balance({ scope: undefined, currency: null }), 'conn-legacy')
  assert.equal(legacy.facts[0]?.source, 'https://api.deepseek.com/user/balance#scope_unknown#currency_unknown')
})

test('a balance without an observation time or with unknown confidence is not a fact', () => {
  const unobserved = factFromBalance(balance({ observedAt: null }), 'conn-balance')
  assert.deepEqual(unobserved, {
    facts: [],
    skipped: [{ window: null, reason: 'missing_observed_at' }],
  })

  const oldShape = factFromBalance(balance({ observedAt: undefined }), 'conn-balance')
  assert.deepEqual(oldShape.skipped, [{ window: null, reason: 'missing_observed_at' }])

  const unknown = factFromBalance(balance({ confidence: 'unknown' }), 'conn-balance')
  assert.deepEqual(unknown, {
    facts: [],
    skipped: [{ window: null, reason: 'unknown_confidence' }],
  })

  const both = factFromBalance(balance({ observedAt: null, confidence: 'unknown' }), 'conn-balance')
  assert.deepEqual(both.skipped, [{ window: null, reason: 'missing_observed_at' }])
})

test('a known-provenance balance with a null amount keeps the value unknown', () => {
  const result = factFromBalance(balance({ amount: null, currency: null }), 'conn-balance', { initialAmount: 50 })
  assert.equal(result.facts.length, 1)
  assert.equal(result.facts[0]?.remainingAbsolute, null)
  assert.equal(result.facts[0]?.remainingPercent, null)
  assert.deepEqual(result.skipped, [])
})

test('both producers validate their input with the existing schemas', () => {
  assert.throws(() => factsFromQuotaObservation(observation({
    windows: [{ name: 'five_hour', usedPercent: -1, resetsAt: null }],
  }), 'conn-1'), ZodError)

  assert.throws(() => factFromBalance(balance({ observedAt: 'not-a-timestamp' }), 'conn-balance'), ZodError)
})

test('produced facts drive a 20% threshold alert with the producer provenance', () => {
  const windows = claudeRateLimits({
    rate_limits: {
      five_hour: { used_percentage: 85, resets_at: reset(300) },
      seven_day: { used_percentage: 10, resets_at: reset(10_080) },
    },
  })
  const produced = factsFromQuotaObservation(observation({
    source: 'claude-code@0.94.0:claude:statusline.rate_limits',
    windows,
  }), 'conn-claude')
  const fact = produced.facts.find(item => item.window === 'five_hour')
  if (fact === undefined) assert.fail('the Claude sample produced no five_hour fact')

  const evaluation = evaluateQuota({ fact, previous: null, now: at(1) })

  assert.equal(evaluation.alerts.length, 1)
  const alert = evaluation.alerts[0]
  if (alert === undefined) assert.fail('the 15% reading produced no alert')
  assert.equal(alert.kind, 'threshold')
  assert.equal(alert.threshold, 20)
  assert.equal(alert.severity, 'info')
  assert.equal(alert.connectionId, 'conn-claude')
  assert.equal(alert.window, 'five_hour')
  assert.deepEqual(alert.facts, {
    remainingPercent: 15,
    resetsAt: new Date(reset(300) * 1000).toISOString(),
    source: 'claude-code@0.94.0:claude:statusline.rate_limits',
    observedAt: at(0),
    confidence: 'observed',
  })
})
