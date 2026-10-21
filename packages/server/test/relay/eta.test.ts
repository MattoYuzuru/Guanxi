import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { etaInputSchema, projectEta, type EtaInput } from '../../src/relay/eta.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { hash } from '../../src/relay/handoff.ts'
import { fixture, plan } from './fixture.ts'

const now = 1_800_000_000_000
export function etaInput(): EtaInput {
  const scope = { model: 'fixture-model', host: 'fixture-host', repo: 'fixture-repo' }
  return { scope, estimates: [{ item: 'one', remainingMs: 1000 }],
    history: [1, 2, 3, 4, 5].map((ratio, index) => ({ id: `observation-${index}`, scope: { ...scope },
      estimatedMs: 1000, actualMs: ratio * 1000, completedAt: now - index, source: 'fixture:timed-task', infraTainted: false })),
    policy: { simulations: 1000, seed: 1, minSamples: 5, maxAgeMs: 10000 } }
}
const ledger = { plan, items: { one: 'open' as const } }

test('ETA empirical quantiles are reproducible, order independent and report their complete unvalidated basis', () => {
  const input = etaInput(), result = projectEta(ledger, input, now)
  assert.equal(result.p50RemainingMs, 3000)
  assert.equal(result.p80RemainingMs, 5000)
  assert.equal(result.p50FinishAt, now + 3000)
  assert.equal(result.p80FinishAt, now + 5000)
  assert.equal(result.confidence, 'low')
  assert.equal(result.calibration, 'unvalidated')
  assert.equal(result.observedAt, now)
  assert.deepEqual(result.scope, input.scope)
  assert.deepEqual(result.basis, { remainingItems: ['one'], plannedRemainingMs: 1000, samples: 5, excludedSamples: 0,
    oldestSampleAt: now - 4, newestSampleAt: now, sources: ['fixture:timed-task'], policy: input.policy,
    assumption: 'serial-items-independent-ratios' })
  assert.deepEqual(projectEta(ledger, { ...input, history: [...input.history].reverse() }, now), result)
})

test('ETA uses only recent untainted completed observations from the exact model/host/repository cohort', () => {
  const input = etaInput(), original = projectEta(ledger, input, now)
  const unrelated = ['model', 'host', 'repo'].map(key => ({ ...input.history[0]!, id: `other-${key}`,
    scope: { ...input.scope, [key]: 'other' }, actualMs: 1_000_000 }))
  input.history.push(...unrelated,
    { ...input.history[0]!, id: 'old', completedAt: now - 10001, actualMs: 1_000_000 },
    { ...input.history[0]!, id: 'future', completedAt: now + 1, actualMs: 1_000_000 },
    { ...input.history[0]!, id: 'tainted', infraTainted: true, actualMs: 1_000_000 })
  const result = projectEta(ledger, input, now)
  assert.equal(result.basis.samples, 5)
  assert.equal(result.basis.excludedSamples, 6)
  assert.equal(result.p50RemainingMs, original.p50RemainingMs)
  assert.equal(result.p80RemainingMs, original.p80RemainingMs)
  input.history = input.history.filter(h => h.id !== 'observation-0')
  assert.equal(projectEta(ledger, input, now).status, 'unknown')
})

test('ETA cold starts and missing estimates publish null quantiles instead of invented confidence', () => {
  const input = etaInput(); input.history = []
  const cold = projectEta(ledger, input, now)
  assert.equal(cold.status, 'unknown'); assert.equal(cold.reason, 'insufficient_history')
  assert.equal(cold.confidence, 'unknown'); assert.equal(cold.basis.plannedRemainingMs, 1000)
  for (const value of [cold.p50RemainingMs, cold.p80RemainingMs, cold.p50FinishAt, cold.p80FinishAt]) assert.equal(value, null)
  input.estimates = []
  const missing = projectEta(ledger, input, now)
  assert.equal(missing.reason, 'missing_estimates'); assert.equal(missing.basis.plannedRemainingMs, null)
  assert.equal(missing.p80RemainingMs, null)
})

test('ETA burns down verified done items while dependency-blocked items still contribute to serial remaining work', () => {
  const input = etaInput()
  input.history = input.history.map(h => ({ ...h, actualMs: 2000 }))
  input.estimates.push({ item: 'two', remainingMs: 3000 })
  const two = { plan: { ...plan, items: [...plan.items, { ...plan.items[0]!, id: 'two', dependsOn: ['one'] }] },
    items: { one: 'open' as const, two: 'open' as const } }
  assert.equal(projectEta(two, input, now).p80RemainingMs, 8000)
  const partlyDone = projectEta({ ...two, items: { one: 'done', two: 'verification_requested' } }, input, now)
  assert.deepEqual(partlyDone.basis.remainingItems, ['two']); assert.equal(partlyDone.p80RemainingMs, 6000)
  const done = projectEta({ ...two, items: { one: 'done', two: 'done' } }, { ...input, history: [] }, now)
  assert.equal(done.status, 'complete'); assert.equal(done.reason, null)
  assert.equal(done.p50RemainingMs, 0); assert.equal(done.p80RemainingMs, 0)
  assert.equal(done.p80FinishAt, now); assert.deepEqual(done.basis.remainingItems, [])
})

test('ETA throughput sanity reports fresh contradictions, stale observations and unknown forecasts without rewriting the distribution', () => {
  const input = etaInput()
  input.throughput = { remainingTokens: 100, tokensPerSecond: 10, observedAt: now, source: 'fixture:runtime-counter', maxAgeMs: 1000 }
  const result = projectEta(ledger, input, now)
  assert.equal(result.p80RemainingMs, 5000)
  assert.deepEqual(result.throughput, { status: 'below_runtime_floor', minimumRemainingMs: 10000, source: 'fixture:runtime-counter', observedAt: now })
  input.throughput.remainingTokens = 1
  assert.equal(projectEta(ledger, input, now).throughput.status, 'consistent')
  input.history = []
  assert.equal(projectEta(ledger, input, now).throughput.status, 'forecast_unknown')
  for (const time of [now - 1001, now + 1]) {
    input.throughput.observedAt = time
    const stale = projectEta(ledger, input, now)
    assert.equal(stale.throughput.status, 'stale'); assert.equal(stale.throughput.minimumRemainingMs, null)
  }
})

test('ETA rejects duplicate weighting, unknown items, invalid policy/numbers and arithmetic overflow', () => {
  const input = etaInput()
  assert.equal(etaInputSchema.safeParse({ ...input, history: [...input.history, input.history[0]!] }).success, false)
  assert.equal(etaInputSchema.safeParse({ ...input, estimates: [...input.estimates, input.estimates[0]!] }).success, false)
  for (const field of ['simulations', 'minSamples', 'maxAgeMs'])
    assert.equal(etaInputSchema.safeParse({ ...input, policy: { ...input.policy, [field]: 0 } }).success, false)
  for (const actualMs of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(etaInputSchema.safeParse({ ...input, history: [{ ...input.history[0]!, actualMs }] }).success, false)
  assert.throws(() => projectEta(ledger, { ...input, estimates: [{ item: 'unknown', remainingMs: 1 }] }, now), /eta_item/)
  assert.throws(() => projectEta(ledger, input, NaN), /eta_clock/)
  assert.throws(() => projectEta(ledger, { ...input, estimates: [{ item: 'one', remainingMs: Number.MAX_SAFE_INTEGER }] }, now), /eta_overflow/)
})

test('ETA writes use the existing fence transaction: stale attempts change no ledger bytes and append no event', () => {
  const f = fixture()
  try {
    f.relay.updateEta(f.attempt, etaInput())
    const snapshot = f.relay.read(f.run.id)
    assert.equal(snapshot.eta!.p80RemainingMs, 5000)
    f.store.cancel(f.run.id)
    const before = f.db.prepare('SELECT snapshot FROM relay_runs WHERE run_id=?').get(f.run.id)!.snapshot
    const events = f.log.readAll(f.run.session_id, 'person').length
    assert.throws(() => f.relay.updateEta(f.attempt, { ...etaInput(), history: [] }), /stale_lease|invalid_transition/)
    assert.equal(f.db.prepare('SELECT snapshot FROM relay_runs WHERE run_id=?').get(f.run.id)!.snapshot, before)
    assert.equal(f.log.readAll(f.run.session_id, 'person').length, events)
  } finally { f.close() }
})

test('ETA is opt-in and observations persist across store reconstruction without resuming work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-r3-eta-'))
  const f = fixture({ path: join(root, 'node.sqlite') })
  try {
    assert.equal(f.relay.read(f.run.id).eta, null)
    f.relay.updateEta(f.attempt, etaInput())
    const expected = f.relay.read(f.run.id).eta
    const rebuilt = new RelayStore(f.db, f.store, f.scrubber, () => now + 100)
    assert.deepEqual(rebuilt.read(f.run.id).eta, expected)
    assert.equal(f.prompts.length, 0)
    assert.equal(rebuilt.read(f.run.id).pendingCall, null)
  } finally { f.close(); await rm(root, { recursive: true, force: true }) }
})

test('ETA sampling at executor boundaries survives handoff hash validation, burns down final gates and freezes caller input', async () => {
  const input = etaInput(), f = fixture({ eta: input })
  input.estimates[0]!.remainingMs = 999999
  const verify = f.workspace.verify
  let observedInitial = false
  f.workspace.verify = async (...args) => {
    if (!observedInitial) { assert.equal(f.relay.read(f.run.id).eta!.p80RemainingMs, 5000); observedInitial = true }
    return verify(...args)
  }
  try {
    const ledger = await f.executor.run(f.attempt)
    assert.equal(ledger.state, 'finish'); assert.equal(ledger.eta!.status, 'complete')
    assert.equal(ledger.eta!.p80RemainingMs, 0)
    const notes = f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note').map(e => JSON.parse(String(e.data.text)))
    assert.equal(notes.filter(n => n.relay === 'eta_observed').length, 2)
    const sealed = f.db.prepare('SELECT ledger,handoff FROM relay_seals WHERE run_id=?').get(f.run.id)!
    const snapshot = JSON.parse(String(sealed.ledger)), handoff = JSON.parse(String(sealed.handoff))
    assert.equal(handoff.ledgerHash, hash(snapshot)); assert.equal(snapshot.eta.p80RemainingMs, 0)
    const initial = notes.find(n => n.relay === 'eta_observed')
    assert.ok(initial)
    assert.equal(observedInitial, true)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n, 1)
  } finally { f.close() }
})
