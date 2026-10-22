import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateJudgeSignals, type JudgeObservation, type JudgeSignal, type JudgeSignalPolicy } from '../../src/relay/judge-signals.ts'

const policy: JudgeSignalPolicy = {
  heartbeatStallMs: 10,
  noProgressCycles: 3,
  repeatedFailureCycles: 4,
  editRevertCycles: 5,
  repeatedDeadEnds: 6,
  tokenBlowupRatio: 2,
}

function healthy(): JudgeObservation {
  return {
    observedAt: 1_000,
    heartbeatAt: 999,
    lease: { expiresAt: 1_001, current: true },
    deadlineAt: 1_001,
    disk: { availableBytes: 10, requiredBytes: 10 },
    cycle: 2,
    noProgressCycles: 2,
    sameFailureStreak: 3,
    editRevertStreak: 4,
    deadEndRepetitions: 5,
    protectedPathEdits: [],
    outOfScopeEdits: [],
    tokensThisItem: 19,
    tokenBudgetForItem: 10,
    crashed: false,
  }
}

function observed(patch: Partial<JudgeObservation> = {}): JudgeObservation {
  return { ...healthy(), ...patch }
}

function allTriggered(): JudgeObservation {
  return observed({
    heartbeatAt: 990,
    lease: { expiresAt: 1_000, current: true },
    deadlineAt: 1_000,
    disk: { availableBytes: 9, requiredBytes: 10 },
    cycle: 7,
    noProgressCycles: 3,
    sameFailureStreak: 4,
    editRevertStreak: 5,
    deadEndRepetitions: 6,
    protectedPathEdits: ['synthetic-protected-path'],
    outOfScopeEdits: ['synthetic-out-of-scope-path'],
    tokensThisItem: 20,
    tokenBudgetForItem: 10,
    crashed: true,
  })
}

function codes(observation: JudgeObservation = healthy(), thresholds: JudgeSignalPolicy = policy): JudgeSignal['code'][] {
  return evaluateJudgeSignals(observation, thresholds).map(signal => signal.code)
}

function assertCodes(patch: Partial<JudgeObservation>, expected: JudgeSignal['code'][], thresholds: JudgeSignalPolicy = policy): void {
  assert.deepEqual(codes(observed(patch), thresholds), expected)
}

const observationError = (error: unknown): boolean => error instanceof Error && error.message === 'invalid_judge_observation'
const policyError = (error: unknown): boolean => error instanceof Error && error.message === 'invalid_judge_policy'

function failsObservation(value: unknown): void {
  assert.throws(() => evaluateJudgeSignals(value as JudgeObservation, policy), observationError)
}

function failsPolicy(value: unknown): void {
  assert.throws(() => evaluateJudgeSignals(healthy(), value as JudgeSignalPolicy), policyError)
}

test('a healthy synthetic observation emits no signal and absent optional facts stay unknown', () => {
  // An empty result means only that no configured signal fired; it is not proof of health.
  assert.deepEqual(evaluateJudgeSignals(healthy(), policy), [])
  assert.deepEqual(evaluateJudgeSignals(observed({ heartbeatAt: null, lease: null, deadlineAt: null, disk: null }), policy), [])
})

test('J0 signals use inclusive boundaries, observedAt and high confidence', () => {
  assertCodes({ heartbeatAt: 990 }, ['heartbeat_stall'])
  assertCodes({ heartbeatAt: 991 }, [])
  assertCodes({ heartbeatAt: 1_000 }, [])
  assertCodes({ heartbeatAt: 989 }, ['heartbeat_stall'], { ...policy, heartbeatStallMs: 10.5 })
  assertCodes({ heartbeatAt: 990 }, [], { ...policy, heartbeatStallMs: 10.5 })
  assertCodes({ lease: { expiresAt: 1_000, current: true } }, ['lease_lost'])
  assertCodes({ lease: { expiresAt: 1_001, current: true } }, [])
  assertCodes({ lease: { expiresAt: 9_999, current: false } }, ['lease_lost'])
  assertCodes({ deadlineAt: 1_000 }, ['deadline'])
  assertCodes({ deadlineAt: 1_001 }, [])
  assertCodes({ deadlineAt: 0 }, ['deadline'])
  assertCodes({ crashed: true }, ['crash'])
  assertCodes({ disk: { availableBytes: 9, requiredBytes: 10 } }, ['disk'])
  assertCodes({ disk: { availableBytes: 10, requiredBytes: 10 } }, [])
  assertCodes({ disk: { availableBytes: 0, requiredBytes: 0 } }, [])
  const stall = evaluateJudgeSignals(observed({ heartbeatAt: 990 }), policy)
  assert.deepEqual(stall, [{ layer: 'J0', code: 'heartbeat_stall', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' }])
})

test('J1 signals use inclusive configured boundaries, medium confidence and nullable budgets', () => {
  assertCodes({ noProgressCycles: 3 }, ['no_progress'])
  assertCodes({ noProgressCycles: 2 }, [])
  assertCodes({ noProgressCycles: 1 }, ['no_progress'], { ...policy, noProgressCycles: 1 })
  assertCodes({ noProgressCycles: 0 }, [], { ...policy, noProgressCycles: 1 })
  assertCodes({ sameFailureStreak: 4 }, ['repeated_failure'])
  assertCodes({ sameFailureStreak: 3 }, [])
  assertCodes({ editRevertStreak: 5 }, ['edit_revert'])
  assertCodes({ editRevertStreak: 4 }, [])
  assertCodes({ deadEndRepetitions: 6 }, ['repeated_dead_end'])
  assertCodes({ deadEndRepetitions: 5 }, [])
  assertCodes({ protectedPathEdits: ['packages/server/test/relay/fixture.ts'] }, ['protected_path_edit'])
  assertCodes({ protectedPathEdits: ['a.ts', 'a.ts'] }, ['protected_path_edit'])
  assertCodes({ outOfScopeEdits: ['packages/web/src/app.tsx'] }, ['out_of_scope_edit'])
  assertCodes({ tokensThisItem: 20, tokenBudgetForItem: 10 }, ['token_blowup'])
  assertCodes({ tokensThisItem: 19, tokenBudgetForItem: 10 }, [])
  assertCodes({ tokensThisItem: 15, tokenBudgetForItem: 10 }, ['token_blowup'], { ...policy, tokenBlowupRatio: 1.5 })
  assertCodes({ tokensThisItem: 14, tokenBudgetForItem: 10 }, [], { ...policy, tokenBlowupRatio: 1.5 })
  assertCodes({ tokensThisItem: 200, tokenBudgetForItem: null }, [])
  assertCodes({ tokensThisItem: 0, tokenBudgetForItem: 10 }, [])
  const noProgress = evaluateJudgeSignals(observed({ noProgressCycles: 3 }), policy)
  assert.deepEqual(noProgress, [{ layer: 'J1', code: 'no_progress', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' }])
})

test('all codes are emitted exactly once in deterministic J0 then J1 order with exact fields', () => {
  const signals = evaluateJudgeSignals(allTriggered(), policy)
  assert.deepEqual(signals, [
    { layer: 'J0', code: 'heartbeat_stall', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' },
    { layer: 'J0', code: 'lease_lost', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' },
    { layer: 'J0', code: 'deadline', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' },
    { layer: 'J0', code: 'crash', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' },
    { layer: 'J0', code: 'disk', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'high' },
    { layer: 'J1', code: 'no_progress', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'repeated_failure', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'edit_revert', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'repeated_dead_end', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'protected_path_edit', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'out_of_scope_edit', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
    { layer: 'J1', code: 'token_blowup', observedAt: 1_000, source: 'harness.judge-signals', confidence: 'medium' },
  ])
  assert.equal(new Set(signals.map(signal => signal.code)).size, 12)
  for (const signal of signals) assert.deepEqual(Object.keys(signal).sort(), ['code', 'confidence', 'layer', 'observedAt', 'source'])
})

test('invalid observations are rejected independently with a stable error', () => {
  const missing = { ...healthy() } as Record<string, unknown>
  delete missing.observedAt
  const sparse = new Array(1) as unknown as string[]
  const withKey = (key: string, value: unknown): Record<string, unknown> => ({ ...healthy(), [key]: value })
  const invalid = [
    null,
    undefined,
    [],
    'observation',
    1,
    missing,
    { ...healthy(), extra: true },
    withKey('observedAt', -1),
    withKey('observedAt', 1.5),
    withKey('observedAt', Number.MAX_SAFE_INTEGER + 1),
    withKey('observedAt', Infinity),
    withKey('heartbeatAt', 1_001),
    withKey('heartbeatAt', -1),
    withKey('heartbeatAt', 1.5),
    withKey('lease', {}),
    withKey('lease', { expiresAt: 1_000 }),
    withKey('lease', { expiresAt: 1_000, current: 1 }),
    withKey('lease', { expiresAt: -1, current: true }),
    withKey('lease', { expiresAt: Number.MAX_SAFE_INTEGER + 1, current: true }),
    withKey('lease', { expiresAt: NaN, current: true }),
    withKey('lease', { expiresAt: 1_000, current: true, extra: true }),
    withKey('deadlineAt', -1),
    withKey('deadlineAt', 1.5),
    withKey('deadlineAt', Number.MAX_SAFE_INTEGER + 1),
    withKey('disk', { availableBytes: 0 }),
    withKey('disk', { availableBytes: -1, requiredBytes: 1 }),
    withKey('disk', { availableBytes: 0, requiredBytes: 1.5 }),
    withKey('disk', { availableBytes: 0, requiredBytes: Number.MAX_SAFE_INTEGER + 1 }),
    withKey('disk', { availableBytes: Infinity, requiredBytes: 1 }),
    withKey('disk', { availableBytes: 0, requiredBytes: 1, extra: true }),
    withKey('cycle', -1),
    withKey('cycle', 1.5),
    withKey('cycle', Number.MAX_SAFE_INTEGER + 1),
    withKey('noProgressCycles', -1),
    withKey('sameFailureStreak', Infinity),
    withKey('editRevertStreak', NaN),
    withKey('deadEndRepetitions', -1),
    withKey('protectedPathEdits', 'path'),
    withKey('protectedPathEdits', ['ok', 1]),
    withKey('protectedPathEdits', sparse),
    withKey('outOfScopeEdits', null),
    withKey('tokensThisItem', -1),
    withKey('tokensThisItem', 1.5),
    withKey('tokensThisItem', Number.MAX_SAFE_INTEGER + 1),
    withKey('tokenBudgetForItem', 0),
    withKey('tokenBudgetForItem', -1),
    withKey('tokenBudgetForItem', 1.5),
    withKey('tokenBudgetForItem', Number.MAX_SAFE_INTEGER + 1),
    withKey('tokenBudgetForItem', Infinity),
    withKey('crashed', 0),
  ]
  for (const value of invalid) failsObservation(value)
})

test('invalid policies are rejected independently with a stable error', () => {
  const missing = { ...policy } as Record<string, unknown>
  delete missing.tokenBlowupRatio
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    'policy',
    missing,
    { ...policy, extra: true },
    { ...policy, heartbeatStallMs: 0 },
    { ...policy, heartbeatStallMs: -1 },
    { ...policy, heartbeatStallMs: Infinity },
    { ...policy, heartbeatStallMs: NaN },
    { ...policy, heartbeatStallMs: '10' },
    { ...policy, tokenBlowupRatio: 1 },
    { ...policy, tokenBlowupRatio: 0 },
    { ...policy, tokenBlowupRatio: Infinity },
    { ...policy, tokenBlowupRatio: NaN },
    { ...policy, tokenBlowupRatio: '2' },
  ]
  for (const key of ['noProgressCycles', 'repeatedFailureCycles', 'editRevertCycles', 'repeatedDeadEnds'] as const) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) invalid.push({ ...policy, [key]: value })
  }
  for (const value of invalid) failsPolicy(value)
})

test('observation and policy validation are independent and observation is checked first', () => {
  failsObservation({ ...healthy(), cycle: -1 })
  failsPolicy({ ...policy, heartbeatStallMs: 0 })
  assert.throws(() => evaluateJudgeSignals({ ...healthy(), cycle: -1 }, { ...policy, heartbeatStallMs: 0 }), observationError)
})

test('errors and signals do not disclose payload or path text', () => {
  const canary = 'synthetic-private-path-7f3a'
  const invalid = observed({ cycle: -1, protectedPathEdits: [canary], outOfScopeEdits: [canary] })
  assert.throws(() => evaluateJudgeSignals(invalid, policy), (error: unknown) =>
    error instanceof Error && error.message === 'invalid_judge_observation' && !error.message.includes(canary))
  assert.throws(() => evaluateJudgeSignals(healthy(), { ...policy, tokenBlowupRatio: 1, marker: canary } as JudgeSignalPolicy), (error: unknown) =>
    error instanceof Error && error.message === 'invalid_judge_policy' && !error.message.includes(canary))
})

test('evaluation is deterministic, does not mutate inputs and returns only signal facts', () => {
  const observation = observed({ ...allTriggered(), protectedPathEdits: ['synthetic-private-path'], outOfScopeEdits: ['synthetic-private-path'] })
  const thresholds = { ...policy }
  const observationBefore = structuredClone(observation)
  const policyBefore = structuredClone(thresholds)
  const first = evaluateJudgeSignals(observation, thresholds)
  const second = evaluateJudgeSignals(observation, thresholds)
  assert.deepEqual(first, second)
  assert.notEqual(first, second)
  for (const [index, signal] of first.entries()) assert.notEqual(signal, second[index])
  assert.deepEqual(observation, observationBefore)
  assert.deepEqual(thresholds, policyBefore)
  assert.equal(JSON.stringify(first).includes('synthetic-private-path'), false)
  for (const signal of first) assert.deepEqual(Object.keys(signal).sort(), ['code', 'confidence', 'layer', 'observedAt', 'source'])
})

test('large safe integers and token ratios stay exact without overflow', () => {
  const huge = Number.MAX_SAFE_INTEGER
  assert.deepEqual(codes(observed({ tokensThisItem: huge, tokenBudgetForItem: 1 }), { ...policy, tokenBlowupRatio: huge }), ['token_blowup'])
  assert.deepEqual(codes(observed({ tokensThisItem: huge - 1, tokenBudgetForItem: 1 }), { ...policy, tokenBlowupRatio: huge }), [])
  assert.deepEqual(codes(observed({ tokensThisItem: 1, tokenBudgetForItem: huge }), { ...policy, tokenBlowupRatio: Number.MAX_VALUE }), [])
  assert.deepEqual(codes(observed({ noProgressCycles: huge }), { ...policy, noProgressCycles: huge }), ['no_progress'])
  assert.deepEqual(codes(observed({ noProgressCycles: huge - 1 }), { ...policy, noProgressCycles: huge }), [])
})
