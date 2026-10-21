import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Budget } from '../src/budget.ts'
import { checkedQuote, preparedRequestAdmission, preparedRequestSha256, type RequestQuote, type RequestUsage } from '../src/request-admission.ts'
import { plan } from './helpers.ts'

const now = new Date('2026-10-21T12:00:00Z')
const prepared = { messages: [{ role: 'user', content: 'synthetic private fixture content' }] }
const usage = (tokens = 2, costMicrousd = 2): RequestUsage => ({ tokens, costMicrousd,
  source: 'fixture:usage-v1', observedAt: now.toISOString(), confidence: 'verified' })
function quote(patch: Partial<RequestQuote> = {}): RequestQuote {
  const fact = { source: 'fixture:authoritative-v1', observedAt: '2026-10-21T11:59:00Z', validUntil: '2026-10-21T12:01:00Z', confidence: 'verified' as const }
  return { provider: 'fixture', model: 'fixture-metered', preparedSha256: preparedRequestSha256(prepared),
    inputTokenBound: 5, outputTokenLimit: 5, meter: { ...fact, format: 'provider-request-upper-bound' },
    price: { ...fact, currency: 'USD', inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000, requestMicrousd: 0 }, ...patch }
}
function experiment(patch = {}) {
  return plan({ tasks: plan().tasks.slice(0, 1), arms: [plan().arms[0]!, { id: 'candidate', kind: 'guanxi', version: 'fixture-v1' }],
    model: 'fixture-metered', provider: 'fixture', connection: 'secret://fixture/model',
    maxTrialMicrousd: 30, maxTrialTokens: 30, maxSteps: 3, armCapMicrousd: 30, dailyTokenCap: 60, ...patch })
}
const identity = (requestId: string, arm = 'control') => ({ runId: 'test', task: 'task-0', arm, seed: 0, requestId })

test('both control and Guanxi arms consume independent equal trial envelopes before dispatch', () => {
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(experiment())
    let calls = 0
    for (const arm of ['control', 'candidate']) {
      for (let i = 0; i < 3; i++) {
        const gate = preparedRequestAdmission(budget, identity(`${arm}-${i}`, arm), 5, () => quote())
        // K3 invokes this hook after its scrubbed request is prepared, before transport.
        gate.onPrepared(prepared); calls++
        gate.settle(usage())
      }
      const refused = preparedRequestAdmission(budget, identity(`${arm}-over`, arm), 5, () => quote())
      assert.throws(() => { refused.onPrepared(prepared); calls++ }, /request_budget_exceeded/)
    }
    assert.equal(calls, 6)
    assert.equal(budget.requestRows().length, 6)
    assert.equal(budget.rows()[0]!.dollars, 60, 'request holds consume the precharged run envelope without double charging')
  } finally { budget.close() }
})

test('money, token and step refusal each prevent the next dispatch with other bounds nonbinding', () => {
  for (const limits of [{ maxTrialMicrousd: 15, maxTrialTokens: 100, maxSteps: 10 },
    { maxTrialMicrousd: 100, maxTrialTokens: 15, maxSteps: 10 },
    { maxTrialMicrousd: 100, maxTrialTokens: 100, maxSteps: 1 }]) {
    const budget = new Budget(':memory:', () => now)
    try {
      budget.reserve(experiment({ ...limits, armCapMicrousd: 100, dailyTokenCap: 200 }))
      budget.admitRequest(identity('first'), quote()); budget.settleRequest('test', 'first', usage())
      let dispatched = false
      assert.throws(() => { budget.admitRequest(identity('next'), quote()); dispatched = true }, /request_budget_exceeded/)
      assert.equal(dispatched, false)
      assert.equal(budget.requestRows().length, 1)
    } finally { budget.close() }
  }
})

test('unsettled crash holds survive reopening and neither request IDs nor new IDs replay a trial', () => {
  const directory = mkdtempSync(join(tmpdir(), 'b1-request-ledger-')), path = join(directory, 'budget.sqlite')
  const a = new Budget(path, () => now)
  a.reserve(experiment()); a.admitRequest(identity('original'), quote()); a.close()
  const b = new Budget(path, () => now), c = new Budget(path, () => now)
  try {
    assert.throws(() => b.admitRequest(identity('original'), quote()), /request_already_admitted/)
    assert.throws(() => c.admitRequest(identity('new-after-crash'), quote()), /request_in_flight_or_unreconciled/)
    b.settleRequest('test', 'original', null)
    assert.throws(() => c.admitRequest(identity('another'), quote()), /request_trial_halted/)
    assert.equal(c.requestRows()[0]!.state, 'unknown')
    assert.equal(c.requestRows()[0]!.cost, 10)
    assert.equal(c.rows()[0]!.dollars, 60)
    assert.equal(readFileSync(path).includes(Buffer.from('synthetic private fixture content')), false)
  } finally { b.close(); c.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('a usage breach is durably charged and halts only that trial; settlement is replay-safe', () => {
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(experiment())
    budget.admitRequest(identity('breach'), quote())
    assert.throws(() => budget.settleRequest('test', 'breach', usage(11, 11)), /request_bound_violated/)
    assert.throws(() => budget.settleRequest('test', 'breach', usage(11, 11)), /request_bound_violated/)
    assert.equal(budget.requestRows()[0]!.state, 'breached')
    assert.throws(() => budget.admitRequest(identity('next'), quote()), /request_trial_halted/)
    budget.admitRequest(identity('unrelated-arm', 'candidate'), quote())
    budget.settleRequest('test', 'unrelated-arm', usage())
    budget.settleRequest('test', 'unrelated-arm', usage())
    assert.throws(() => budget.settleRequest('test', 'unrelated-arm', usage(3, 3)), /request_already_settled/)
    assert.equal(budget.rows()[0]!.dollars, 60)
  } finally { budget.close() }
})

test('unknown/stale/unverified/mismatched quotes refuse before dispatch without a request debit', () => {
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(experiment())
    const bad = [null, quote({ preparedSha256: '0'.repeat(64) }), quote({ outputTokenLimit: 6 }),
      quote({ provider: 'different' }), quote({ model: 'different' }),
      quote({ price: { ...quote().price, validUntil: now.toISOString() } }),
      quote({ meter: { ...quote().meter, observedAt: '2026-10-21T12:00:01Z' } }),
      { ...quote(), price: { ...quote().price, confidence: 'unknown' } }]
    let calls = 0
    for (const value of bad) {
      const gate = preparedRequestAdmission(budget, identity('denied'), 5, () => value as RequestQuote | null)
      assert.throws(() => { gate.onPrepared(prepared); calls++ })
    }
    assert.equal(calls, 0); assert.equal(budget.requestRows().length, 0)
  } finally { budget.close() }
})

test('run closure, deadline and UTC day boundary refuse new requests', () => {
  let clock = now
  const budget = new Budget(':memory:', () => clock)
  try {
    budget.reserve(experiment())
    clock = new Date('2026-10-21T12:00:30Z')
    budget.admitRequest(identity('first'), quote()); budget.settleRequest('test', 'first', usage())
    clock = new Date('2026-10-21T12:02:00Z')
    const current = quote({ meter: { ...quote().meter, validUntil: '2026-10-22T13:00:00Z' }, price: { ...quote().price, validUntil: '2026-10-22T13:00:00Z' } })
    assert.throws(() => budget.admitRequest(identity('late'), current), /request_run_expired/)
    clock = new Date('2026-10-22T00:00:00Z')
    assert.throws(() => budget.admitRequest(identity('next-day'), current), /request_run_expired/)
    clock = now
    budget.settle('test')
    assert.throws(() => budget.admitRequest(identity('after-settle'), quote()), /request_run_not_open/)
  } finally { budget.close() }
})

test('a foreign trial or reused request ID cannot borrow another arm reservation', () => {
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(experiment())
    for (const changed of [{ task: 'foreign' }, { arm: 'foreign' }, { seed: 1 }]) {
      assert.throws(() => budget.admitRequest({ ...identity('foreign'), ...changed }, quote()), /request_trial_unknown/)
    }
    budget.admitRequest(identity('one'), quote()); budget.settleRequest('test', 'one', usage())
    assert.throws(() => budget.admitRequest(identity('one', 'candidate'), quote()), /request_already_admitted/)
    assert.equal(budget.requestRows().length, 1)
  } finally { budget.close() }
})

test('quote arithmetic rounds every category up and refuses unsafe integer totals', () => {
  const q = quote({ inputTokenBound: 1, outputTokenLimit: 1, price: { ...quote().price, inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1, requestMicrousd: 3 } })
  assert.equal(checkedQuote(q, now).costMicrousd, 5)
  assert.throws(() => checkedQuote(quote({ inputTokenBound: Number.MAX_SAFE_INTEGER }), now), /overflow/)
  assert.throws(() => checkedQuote(quote({ inputTokenBound: 1_000_001, price: { ...quote().price, inputMicrousdPerMillion: Number.MAX_SAFE_INTEGER } }), now), /overflow/)
})

test('a prepared hook cannot be reused and usage without provenance cannot settle its hold', () => {
  const budget = new Budget(':memory:', () => now)
  try {
    budget.reserve(experiment())
    const gate = preparedRequestAdmission(budget, identity('one'), 5, () => quote())
    gate.onPrepared(prepared)
    assert.throws(() => gate.onPrepared(prepared), /request_already_admitted/)
    assert.throws(() => gate.settle({ tokens: 1, costMicrousd: 1 } as RequestUsage))
    assert.equal(budget.requestRows()[0]!.state, 'reserved')
    gate.settle(usage())
  } finally { budget.close() }
})
