import assert from 'node:assert/strict'
import test from 'node:test'
import { missingTrial, type LedgerObservation } from '../src/relay-smoke-build.ts'
import type { RelayObservedTrial } from '../src/relay-protocol.ts'
import { checkRelayMeasurement, relayPlanDigest } from '../src/relay-protocol.ts'
import {
  H, HEAD, LEDGER_ARM, T0, cycles, documentOf, done, failure, judge, ledgerOf, observation, probe, seal,
} from './relay-smoke-helpers.ts'

const costs = (rows: Array<[string, number]>): LedgerObservation['costs'] => rows.map(([key, inputTokens]) => ({ key, inputTokens, outputTokens: 100 }))
const observed = (doc: ReturnType<typeof documentOf>): RelayObservedTrial => {
  const slot = doc.raw.trials[0]
  assert.equal(slot.state, 'observed')
  return slot as RelayObservedTrial
}
const arm0 = (doc: ReturnType<typeof documentOf>) => doc.report!.arms[0]!

test('a complete observation validates and reduces to hand-counted numbers', () => {
  const ledger = ledgerOf([[{ item: 'I01', ok: true }, { item: 'I02', ok: true }], [{ item: 'I03', ok: false }], [{ item: 'I03', ok: true }, { item: 'I04', ok: true }]],
    costs([['m-1', 20_000], ['m-2', 21_000], ['m-3', 22_000]]))
  ledger.final = { cycle: 3, head: HEAD(3), items: { I01: 'done', I02: 'done', I03: 'done', I04: 'done', I05: 'open' }, evidence: ledger.seals[2]!.evidence }
  const doc = documentOf(observation({ status: 'failed', facts: cycles(3, { probes: k => k === 2 ? [false, true] : [true] }), ledger }))
  assert.ok(doc.checked.ok, JSON.stringify(doc.checked.ok ? '' : doc.checked.issues))
  const slot = observed(doc)
  assert.deepEqual(slot.cycles.map(c => c.state), ['observed', 'observed', 'observed', 'not_reached', 'not_reached', 'not_reached'])
  const t = arm0(doc).totals
  // I03 failed in cycle 2 and passed in cycle 3: one opportunity (the first), recorded failed; I04 is new in cycle 3.
  assert.deepEqual([t.items.expected, t.items.passed, t.items.failed, t.items.unknown], [4, 3, 1, 0])
  assert.deepEqual(arm0(doc).cycles.map(c => [c.items.expected, c.items.passed, c.items.failed]).slice(0, 3), [[2, 2, 0], [1, 0, 1], [1, 1, 0]])
  const whole = t.probes.wholeAnswer
  assert.deepEqual([whole.expected, whole.firstCorrect, whole.firstIncorrect, whole.finalCorrect, whole.retryRescued, whole.retryAttempts, whole.groupsWithoutOccasion], [2, 1, 1, 2, 1, 1, 1])
  assert.deepEqual([t.context.expected, t.context.observed, t.context.unknown, t.context.truncationEvents, t.context.windowMismatches], [3, 3, 0, 0, 0])
  assert.deepEqual([t.integrity.observed, t.integrity.reportedMatch, t.integrity.reportedMismatch, t.integrity.reportedValidationPassed], [3, 3, 0, 3])
  assert.deepEqual(doc.built.notes, ['items_never_assessed:I05'])
  assert.deepEqual(doc.report!.criteria.itemSuccessSlope.state, 'unevaluated')
  assert.equal(doc.report!.realEvidenceCredit, 0)
})

test('without the home database every ledger-derived group is unknown, not imputed', () => {
  const doc = documentOf(observation({ facts: cycles(3), ledger: null }))
  assert.ok(doc.checked.ok)
  for (const c of observed(doc).cycles.filter(c => c.state === 'observed')) {
    assert.deepEqual([c.items, c.context, c.integrity].map(g => g.state === 'unknown' ? g.reason : 'observed'), ['not_collected', 'not_collected', 'not_collected'])
  }
  const t = arm0(doc).totals
  assert.deepEqual([t.items.groupsUnknown, t.items.expected, t.items.passedOverExpected], [3, 0, null])
  assert.equal(t.context.groupsUnknown, 3)
  assert.equal(t.probes.wholeAnswer.expected, 2, 'probes come from events and stay observed')
})

test('a truncation error attaches to the last call that has a recorded count', () => {
  const facts = [...cycles(2).filter(f => f.kind !== 'sealed' || f.cycle !== 2), done(2, T0 + 200_000 + 3_000, 'm-2b'), failure(2, T0 + 200_000 + 4_000, 'truncation_protocol')]
  const ledger = ledgerOf([[], []], costs([['m-1', 20_000], ['m-2', 21_000], ['m-2b', 22_000]]))
  const samples = (doc: ReturnType<typeof documentOf>) => {
    const c = observed(doc).cycles[1]!
    assert.equal(c.state, 'observed')
    return c.state === 'observed' && c.context.state === 'observed' ? c.context.samples : []
  }
  const doc = documentOf(observation({ status: 'failed', statusError: 'truncation_protocol', facts, ledger }))
  assert.ok(doc.checked.ok)
  assert.deepEqual(samples(doc).map(s => s.state === 'observed' ? s.truncationEvents : -1), [0, 1])
  assert.equal(arm0(doc).totals.context.truncationEvents, 1)
  assert.equal(arm0(doc).totals.context.truncatedSamples, 1)
  // The last call has no recorded count: the event moves to the previous call that has one.
  const partial = documentOf(observation({ status: 'failed', facts, ledger: ledgerOf([[], []], costs([['m-1', 20_000], ['m-2', 21_000]])) }))
  assert.deepEqual(samples(partial).map(s => s.state === 'observed' ? s.truncationEvents : -1), [1, -1])
  // No call with a count at all: nothing is invented and the loss is named.
  const none = documentOf(observation({ status: 'failed', facts, ledger: ledgerOf([[], []], []) }))
  assert.equal(arm0(none).totals.context.truncationEvents, 0)
  assert.ok(none.built.notes.includes('truncation_unattached'))
  assert.equal(arm0(none).totals.context.unknown, 3)
})

test('integrity is passed only when the runner re-hash, the handoff and the bundle agree', () => {
  const run = (overrides: Parameters<typeof seal>[2]) => {
    const ledger = ledgerOf([[]]); ledger.seals[0] = seal(1, [], overrides)
    const doc = documentOf(observation({ facts: cycles(1), ledger }))
    assert.ok(doc.checked.ok)
    return arm0(doc).totals.integrity
  }
  assert.deepEqual(pick(run({})), [1, 0, 1, 0])
  assert.deepEqual(pick(run({ handoffLedgerSha256: H('e') })), [0, 1, 0, 1])
  assert.deepEqual(pick(run({ bundleMatchesHandoff: false })), [1, 0, 0, 1])
  assert.deepEqual(pick(run({ artifactMatchesHandoff: false })), [1, 0, 0, 1])
  assert.deepEqual(pick(run({ bundleMatchesHandoff: null })), [1, 0, 0, 1], 'an unverifiable bundle is not a pass')
  const unreadable = documentOf(observation({ facts: cycles(1), ledger: ledgerOf([[]]).seals.length ? { ...ledgerOf([[]]), seals: [seal(1, [], { handoffLedgerSha256: null })] } : null }))
  assert.equal(arm0(unreadable).totals.integrity.unknown, 1)
  function pick(i: ReturnType<typeof arm0>['totals']['integrity']) { return [i.reportedMatch, i.reportedMismatch, i.reportedValidationPassed, i.reportedValidationFailed] }
})

test('an arm without a ledger handoff has no integrity facts at all', () => {
  const doc = documentOf(observation({ facts: cycles(2), ledger: ledgerOf([[], []]) }), { ...LEDGER_ARM, ledgerHandoff: false })
  assert.ok(doc.checked.ok)
  for (const c of observed(doc).cycles.slice(0, 2)) assert.deepEqual(c.state === 'observed' ? c.integrity : null, { state: 'unknown', reason: 'unsupported' })
})

test('a cycle that never sealed takes its items from the final snapshot and has unknown integrity', () => {
  const ledger = ledgerOf([[{ item: 'I01', ok: true }]])
  ledger.final = { cycle: 2, head: HEAD(2), items: {}, evidence: [{ item: 'I01', head: HEAD(1), ok: true }, { item: 'I02', head: HEAD(2), ok: false }] }
  const facts = cycles(2).filter(f => !(f.kind === 'sealed' && f.cycle === 2))
  const doc = documentOf(observation({ status: 'interrupted', facts, ledger }))
  assert.ok(doc.checked.ok, JSON.stringify(doc.checked.ok ? '' : doc.checked.issues))
  const c2 = observed(doc).cycles[1]!
  assert.equal(c2.state === 'observed' && c2.integrity.state === 'unknown' ? c2.integrity.reason : null, 'unavailable')
  assert.deepEqual(arm0(doc).cycles[1]!.items.failed, 1)
  assert.equal(observed(doc).outcome, 'infra_error')
})

test('guarded and unguarded dead-end repeats follow the arm profile; unseen dead ends stay unknown', () => {
  const withJudge = (signals: string[], unknownFacts: string[]) => cycles(2).flatMap(f => f.kind === 'cycle_begin' && f.cycle === 2 ? [f, judge(2, f.atMs + 10, signals, unknownFacts)] : [f])
  const guarded = documentOf(observation({ facts: withJudge(['repeated_dead_end'], ['heartbeat']), ledger: ledgerOf([[], []]) }))
  assert.deepEqual([arm0(guarded).totals.guards.observed, arm0(guarded).totals.guards.guardedRepeats, arm0(guarded).totals.guards.unguardedRepeats], [1, 1, 0])
  const open = documentOf(observation({ facts: withJudge(['repeated_dead_end'], ['heartbeat']), ledger: ledgerOf([[], []]) }), { ...LEDGER_ARM, deadEndGuard: false })
  assert.deepEqual([arm0(open).totals.guards.guardedRepeats, arm0(open).totals.guards.unguardedRepeats], [0, 1])
  const clean = documentOf(observation({ facts: withJudge([], []), ledger: ledgerOf([[], []]) }))
  assert.deepEqual([arm0(clean).totals.guards.observed, arm0(clean).totals.guards.guardedRepeats], [1, 0])
  const blind = documentOf(observation({ facts: withJudge(['repeated_dead_end'], ['deadEnds']), ledger: ledgerOf([[], []]) }))
  assert.deepEqual([arm0(blind).totals.guards.observed, arm0(blind).totals.guards.guardedRepeats, arm0(blind).totals.guards.groupsUnknown], [0, 0, 2], 'a judge that did not observe dead ends proves nothing')
})

test('probe attempts: a damaged handoff is incorrect, and a cycle after the first with no probe fact is unknown', () => {
  const facts = cycles(3).filter(f => !(f.kind === 'probe' && f.cycle === 3)).flatMap(f => f.kind === 'probe' && f.cycle === 2 ? [probe(2, f.atMs, 0, true, true), probe(2, f.atMs + 1, 1, true)] : [f])
  const doc = documentOf(observation({ facts, ledger: ledgerOf([[], [], []]) }))
  assert.ok(doc.checked.ok)
  const whole = arm0(doc).totals.probes.wholeAnswer
  assert.deepEqual([whole.expected, whole.firstIncorrect, whole.finalCorrect, whole.retryRescued], [1, 1, 1, 1])
  assert.equal(arm0(doc).totals.probes.groupsUnknown, 1)
})

test('windows: the observed window is recorded, a missing one makes samples unknown', () => {
  const ledger = ledgerOf([[]], costs([['m-1', 30_000]]))
  const small = documentOf(observation({ facts: cycles(1), ledger, windowTokens: 8192 }))
  assert.equal(arm0(small).totals.context.windowMismatches, 1, 'a window other than the planned one is visible')
  assert.equal(arm0(small).totals.context.overWindow, 1)
  const none = documentOf(observation({ facts: cycles(1), ledger, windowTokens: null }))
  assert.deepEqual([arm0(none).totals.context.observed, arm0(none).totals.context.unknown], [0, 1])
})

test('cycles past the horizon are dropped with a note; a missing begin makes that cycle unknown', () => {
  const beyond = documentOf(observation({ facts: cycles(8), ledger: ledgerOf(Array.from({ length: 8 }, () => [])) }))
  assert.ok(beyond.checked.ok)
  assert.equal(observed(beyond).cycles.length, 6)
  assert.ok(beyond.built.notes.includes('cycles_beyond_horizon'))
  const gap = documentOf(observation({ facts: cycles(3).filter(f => !(f.kind === 'cycle_begin' && f.cycle === 2)), ledger: null }))
  assert.ok(gap.checked.ok)
  assert.deepEqual(observed(gap).cycles.slice(0, 3).map(c => c.state), ['observed', 'unknown', 'observed'])
})

test('attempts follow the epochs of the seals and each cycle names its own attempt', () => {
  const ledger = ledgerOf([[], [], []]); ledger.seals[2] = { ...ledger.seals[2]!, epoch: 2 }
  const doc = documentOf(observation({ facts: cycles(3), ledger }))
  assert.ok(doc.checked.ok)
  assert.deepEqual(observed(doc).attempts.map(a => [a.id, a.epoch]), [['att-1', 1], ['att-2', 2]])
  assert.deepEqual(observed(doc).cycles.slice(0, 3).map(c => c.state === 'observed' ? c.attempt : null), ['att-1', 'att-1', 'att-2'])
})

test('a head that is not a commit id makes that assessment unknown instead of a guess', () => {
  const ledger = ledgerOf([[{ item: 'I01', ok: true }]]); ledger.seals[0]!.evidence = [{ item: 'I01', head: 'not-a-commit', ok: true }]
  const doc = documentOf(observation({ facts: cycles(1), ledger }))
  assert.ok(doc.checked.ok)
  assert.deepEqual([arm0(doc).totals.items.unknown, arm0(doc).totals.items.passed], [1, 0])
})

test('runs that never started are missing slots with a fixed reason; a hostile run id is replaced', () => {
  assert.deepEqual(documentOf(observation({ endedBy: 'start_failed', runId: null, status: null })).raw.trials[0], missingTrial('ll-money-text', 'ledger-relay', 0, 'unavailable'))
  assert.deepEqual(documentOf(observation({ runId: null, status: null })).raw.trials[0], missingTrial('ll-money-text', 'ledger-relay', 0, 'not_collected'))
  const hostile = documentOf(observation({ runId: 'a b/../c', facts: cycles(1) }))
  assert.ok(hostile.checked.ok)
  assert.match(observed(hostile).runId, /^run-[a-f0-9]{16}$/)
})

test('a deadline or abort is a cancelled outcome and the trial keeps what was seen', () => {
  const doc = documentOf(observation({ status: 'running', endedBy: 'deadline', facts: cycles(2), ledger: ledgerOf([[], []]) }))
  assert.ok(doc.checked.ok)
  assert.equal(observed(doc).outcome, 'cancelled')
  assert.equal(arm0(doc).trials.outcomes.cancelled, 1)
})

test('timestamps never go backwards inside a trial even when the runner clock lags the events', () => {
  const doc = documentOf(observation({ startedAtMs: T0 + 5_000_000, finishedAtMs: T0, facts: cycles(2), ledger: ledgerOf([[], []]) }))
  assert.ok(doc.checked.ok, JSON.stringify(doc.checked.ok ? '' : doc.checked.issues))
})

test('evidence digests and the plan digest verify, and every record is referenced', () => {
  const doc = documentOf(observation({ facts: cycles(2), ledger: ledgerOf([[{ item: 'I01', ok: true }], []]) }))
  assert.ok(doc.checked.ok)
  assert.equal(doc.raw.planSha256, relayPlanDigest(doc.raw.plan))
  assert.equal(doc.report!.coverage.evidence.unreferenced, 0)
  assert.equal(doc.raw.declaredOrigin, 'synthetic_fixture')
})

test('the plan digest binds the document: an edited plan is refused', () => {
  const doc = documentOf(observation({ facts: cycles(1), ledger: null }))
  const tampered = structuredClone(doc.raw); tampered.plan.eta.cohortId = 'someone-else'
  const checked = checkRelayMeasurement(tampered)
  assert.ok(!checked.ok)
  assert.equal(checked.ok ? '' : checked.issues[0]!.rule, 'plan_digest')
})
