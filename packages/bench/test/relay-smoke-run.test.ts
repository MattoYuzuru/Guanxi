import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeClock, FakeRelay, defaultScenario, type FakeScenario } from '../src/relay-smoke-fake.ts'
import type { RelaySource } from '../src/relay-smoke-source.ts'
import { SmokeSourceError } from '../src/relay-smoke-source.ts'
import { memoryStore, parseSmokeConfig, resolveArms, runSmoke, trialKey, type RunDeps } from '../src/relay-smoke-run.ts'
import { config, T0 } from './relay-smoke-helpers.ts'

const BOTH = [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true, url: 'http://127.0.0.1:4651' }]
const SHARED = [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true }]
function rig(options: ConstructorParameters<typeof FakeRelay>[1] = {}, source?: (fake: FakeRelay) => RelaySource) {
  const clock = new FakeClock(T0)
  const fake = new FakeRelay(clock, options)
  const store = memoryStore()
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({ source: source ? source(fake) : fake, now: clock.now, sleep: clock.sleep, store, ...extra })
  return { clock, fake, store, deps }
}
const reportOf = <T extends { report: unknown }>(r: T) => r.report as NonNullable<Awaited<ReturnType<typeof runSmoke>>['report']>

test('two arms over two tasks produce a valid document, a descriptive pairing and exit 0', async () => {
  const r = rig()
  const result = await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'], arms: BOTH }), r.deps())
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.summary.document, { valid: true, issues: [] })
  assert.equal(result.summary.expectedTrials, 4)
  assert.equal(r.fake.started.length, 4)
  const report = reportOf(result)
  assert.deepEqual(report.coverage.trials, { expected: 4, observed: 4, missing: 0 })
  assert.equal(report.gate, 'measurement_only'); assert.equal(report.b3Decision, 'unevaluated'); assert.equal(report.realEvidenceCredit, 0)
  const paired = report.pairedRelayVsNaive
  assert.equal(paired.state, 'descriptive')
  if (paired.state === 'descriptive') assert.deepEqual([paired.includedTasks, paired.relay.passed, paired.naive.passed, paired.delta, paired.interval], [2, 2, 0, null, null])
  assert.ok(result.summary.trials.every(t => t.cycles === 5 && t.ledgerRead))
})

test('a fake source can only produce a synthetic fixture, an HTTP source is labelled as recorded but earns no credit', async () => {
  const r = rig()
  const fake = await runSmoke(config(), r.deps())
  assert.equal(fake.measurement!.declaredOrigin, 'synthetic_fixture')
  const r2 = rig({}, f => Object.create(f, { kind: { value: 'http' } }) as RelaySource)
  const recorded = await runSmoke(config(), r2.deps())
  assert.equal(recorded.measurement!.declaredOrigin, 'recorded_observation')
  assert.equal(reportOf(recorded).realEvidenceCredit, 0)
  assert.ok(reportOf(recorded).unresolved.includes('authenticity_not_verified_offline'))
})

test('start keys are idempotent, unique per trial, and the relay is capped at the horizon', async () => {
  const r = rig()
  await assert.doesNotReject(runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'], seeds: [0, 1], arms: BOTH, horizon: 7 }), r.deps()))
  const keys = r.fake.started.map(s => s.input.key)
  assert.equal(new Set(keys).size, 8)
  for (const key of keys) assert.match(key, /^b3s-[a-f0-9]{16}$/)
  assert.equal(trialKey('exp', 't', 'a', 0), trialKey('exp', 't', 'a', 0))
  for (const other of [trialKey('exp2', 't', 'a', 0), trialKey('exp', 't2', 'a', 0), trialKey('exp', 't', 'a2', 0), trialKey('exp', 't', 'a', 1), trialKey('exp', 't', 'a', 0, 'x')]) assert.notEqual(other, trialKey('exp', 't', 'a', 0))
  for (const s of r.fake.started) {
    assert.equal(s.input.caps.cycles, 7, 'the relay cannot run more cycles than the document has slots')
    assert.equal(s.input.consent, 'full-access'); assert.equal(s.input.projectId, 'project-1')
    assert.deepEqual(s.input.plan.items.map(i => i.acceptance[0]), s.input.plan.items.map(() => 'node'))
  }
})

test('a rerun resumes: finished trials are not started again', async () => {
  const r = rig()
  const cfg = config({ tasks: ['ll-money-text', 'll-rules-fx'], arms: BOTH })
  const first = await runSmoke(cfg, r.deps())
  const second = await runSmoke(cfg, r.deps())
  assert.equal(r.fake.started.length, 4)
  assert.deepEqual(second.measurement, first.measurement)
})

test('a start that failed is retried on the next run; meanwhile its slot is explicitly missing', async () => {
  let refuse = true
  const r = rig({ failStart: (arm) => refuse && arm === 'ledger-relay' ? 'runtime_meter_unavailable' : null })
  const cfg = config({ arms: BOTH })
  const first = await runSmoke(cfg, r.deps())
  assert.equal(first.exitCode, 3)
  assert.deepEqual(first.measurement!.trials.map(t => [t.arm, t.state]), [['ledger-relay', 'missing'], ['naive-compaction', 'observed']])
  assert.equal(first.summary.trials[0]!.endedBy, 'start_failed')
  refuse = false
  const second = await runSmoke(cfg, r.deps())
  assert.equal(second.exitCode, 0)
  assert.equal(r.fake.started.length, 2)
  assert.deepEqual(second.measurement!.trials.map(t => t.state), ['observed', 'observed'])
})

test('an operator abort stops the active relay, leaves later trials missing and still validates', async () => {
  const abort = new AbortController()
  const r = rig({ pollsBeforeDone: 3 })
  const deps = r.deps({ signal: abort.signal, sleep: async (ms, signal) => { await r.clock.sleep(ms, signal); if (r.fake.started.length === 2) abort.abort() } })
  const result = await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'], arms: BOTH }), deps)
  assert.equal(result.exitCode, 3)
  assert.equal(r.fake.started.length, 2, 'no trial starts after the abort')
  assert.deepEqual(r.fake.stopped, [r.fake.started[1]!.input.key], 'the active relay is stopped on SIGINT, and only that one')
  const states = result.measurement!.trials.map(t => t.state === 'observed' ? t.outcome : t.state)
  assert.deepEqual(states, ['passed', 'cancelled', 'missing', 'missing'])
  assert.equal(result.summary.incomplete, 3)
  assert.deepEqual(result.measurement!.trials.filter(t => t.state === 'missing').map(t => t.state === 'missing' ? t.reason : ''), ['not_collected', 'not_collected'])
  const paired = reportOf(result).pairedRelayVsNaive
  assert.equal(paired.state === 'descriptive' ? paired.includedTasks : -1, 0, 'a task with a cancelled or missing arm leaves both sides')
})

test('the trial deadline stops the relay and records a cancelled outcome, never a model failure', async () => {
  const r = rig({ pollsBeforeDone: 1000 })
  const result = await runSmoke(config({ timing: { pollMs: 1000, trialDeadlineMs: 5000 } }), r.deps())
  assert.equal(result.exitCode, 3)
  assert.equal(result.summary.trials[0]!.endedBy, 'deadline')
  assert.deepEqual(r.fake.stopped, [r.fake.started[0]!.input.key], 'the deadline stops the relay it gave up on')
  const trial = result.measurement!.trials[0]!
  assert.equal(trial.state === 'observed' ? trial.outcome : '', 'cancelled')
})

test('an endpoint that keeps failing: the relay is stopped, the trial is stored as aborted, and nothing is left running', async () => {
  let calls = 0
  const r = rig({}, fake => ({ ...fakeBind(fake), status: async () => { calls++; throw new SmokeSourceError('endpoint_unreachable') } }))
  const result = await runSmoke(config({ timing: { pollMs: 1000, trialDeadlineMs: 3_600_000, statusFailuresBeforeAbort: 3 } }), r.deps())
  assert.equal(calls, 3)
  assert.equal(result.summary.trials[0]!.endedBy, 'aborted')
  assert.deepEqual(r.fake.stopped, [r.fake.started[0]!.input.key], 'a stop is attempted before the trial is given up')
  assert.equal(result.summary.trials[0]!.status, 'canceled', 'the observation carries the stopped relay state, not the last poll')
  assert.equal(result.summary.halted, null)
})

test('when the relay cannot be stopped either, the trial is not stored, nothing starts after it, and a rerun re-attaches to the same key', async () => {
  let broken = true
  const r = rig({ failStop: () => broken }, fake => ({ ...fakeBind(fake), status: async (arm: string, key: string) => { if (broken) throw new SmokeSourceError('endpoint_unreachable'); return fake.status(arm, key) } }))
  const cfg = config({ tasks: ['ll-money-text', 'll-rules-fx'], timing: { pollMs: 1000, trialDeadlineMs: 3_600_000, statusFailuresBeforeAbort: 2 } })
  const first = await runSmoke(cfg, r.deps())
  assert.equal(first.exitCode, 3)
  assert.equal(first.summary.halted, 'relay_state_unknown')
  assert.equal(r.fake.started.length, 1, 'the next trial never starts while the first relay is unaccounted for')
  assert.equal(r.store.all.size, 0, 'an unsettled trial is not final')
  assert.deepEqual(first.measurement!.trials.map(t => t.state), ['missing', 'missing'])
  broken = false
  const second = await runSmoke(cfg, r.deps({ sleep: async () => {} }))
  assert.equal(r.fake.started.length, 2, 'the first key is re-attached (idempotent start), only the second task starts anew')
  assert.equal(second.exitCode, 0)
})

test('a start that outlives the client deadline is reconciled by key: the admitted relay is observed, never duplicated', async () => {
  const r = rig({ hangStart: () => true })
  const result = await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'] }), r.deps())
  assert.equal(result.exitCode, 0)
  assert.equal(r.fake.started.length, 2, 'one start per trial, none repeated')
  assert.deepEqual(r.fake.stopped, [])
  assert.deepEqual(result.measurement!.trials.map(t => t.state === 'observed' ? t.outcome : t.state), ['passed', 'passed'])
})

test('a start that timed out and cannot be reconciled is stopped by key; if that fails too, nothing else starts', async () => {
  const lost = rig({ hangStart: () => true }, fake => ({ ...fakeBind(fake), status: async () => { throw new SmokeSourceError('endpoint_unreachable') } }))
  const stopped = await runSmoke(config({ timing: { pollMs: 10, trialDeadlineMs: 3_600_000, statusFailuresBeforeAbort: 2 } }), lost.deps())
  assert.deepEqual(lost.fake.stopped, [lost.fake.started[0]!.input.key])
  assert.equal(stopped.summary.trials[0]!.status, 'canceled')
  assert.equal(stopped.summary.halted, null)
  const stuck = rig({ hangStart: () => true, failStop: () => true }, fake => ({ ...fakeBind(fake), status: async () => { throw new SmokeSourceError('timeout') } }))
  const halted = await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'], timing: { pollMs: 10, trialDeadlineMs: 3_600_000, statusFailuresBeforeAbort: 2 } }), stuck.deps())
  assert.equal(halted.summary.halted, 'relay_state_unknown')
  assert.equal(stuck.fake.started.length, 1)
  assert.equal(halted.exitCode, 3)
})

test('a start that timed out before the relay ever saw it is not running: the slot is missing and the next run retries', async () => {
  let drop = true
  const r = rig({ failStart: () => drop ? 'timeout' : null })
  const first = await runSmoke(config(), r.deps())
  assert.equal(first.exitCode, 3)
  assert.equal(first.summary.halted, null)
  assert.deepEqual(first.measurement!.trials.map(t => t.state), ['missing'])
  drop = false
  assert.equal((await runSmoke(config(), r.deps())).exitCode, 0)
})

test('a relay refusal is definitive: no reconciliation, no stop, the slot is missing', async () => {
  const r = rig({ failStart: () => 'runtime_meter_unavailable' })
  const result = await runSmoke(config(), r.deps())
  assert.deepEqual(r.fake.stopped, [])
  assert.equal(result.summary.trials[0]!.endedBy, 'start_failed')
  assert.equal(result.summary.halted, null)
})

test('two arms behind one endpoint cannot run in one pass; one arm per pass merges into one document', async () => {
  const r = rig()
  const cfg = config({ arms: SHARED })
  await assert.rejects(runSmoke(cfg, r.deps()), { message: 'smoke_config_arm_endpoint' })
  await assert.rejects(runSmoke(cfg, r.deps({ only: ['nope'] })), { message: 'smoke_config_arms' })
  assert.equal(r.fake.started.length, 0, 'refused before any relay starts')
  const first = await runSmoke(cfg, r.deps({ only: ['ledger-relay'] }))
  assert.equal(first.exitCode, 3, 'the other arm is still to do')
  assert.deepEqual(first.measurement!.trials.map(t => [t.arm, t.state]), [['ledger-relay', 'observed'], ['naive-compaction', 'missing']])
  const second = await runSmoke(cfg, r.deps({ only: ['naive-compaction'] }))
  assert.equal(second.exitCode, 0)
  assert.deepEqual(second.measurement!.trials.map(t => [t.arm, t.state]), [['ledger-relay', 'observed'], ['naive-compaction', 'observed']])
  assert.deepEqual(r.fake.started.map(s => s.arm), ['ledger-relay', 'naive-compaction'], 'the ledger trial was read from the store, not run again')
  assert.equal(second.report!.pairedRelayVsNaive.state, 'descriptive')
  assert.equal(second.summary.armIdentity, 'operator_asserted')
})

test('a stored observation is reused only under the same configuration fingerprint', async () => {
  const r = rig()
  await runSmoke(config(), r.deps())
  for (const patch of [{ start: { projectId: 'other', connectionId: 'connection-1', model: 'model-1' } }, { caps: { tokens: 5, moneyMicros: 0, wallMs: null } }, { horizon: 7 },
    { stratum: { provider: 'fake', model: 'fake-model', revision: 'r2', quantization: { kind: 'not_applicable' }, runtime: 'rt', adapter: 'ad', resourceProfile: 'rp', windowTokens: 32768, tokenCountConvention: 'conv' } },
    { endpoint: { url: 'http://127.0.0.1:4999' } }, { arms: [{ kind: 'ledger_relay', id: 'ledger-relay', harnessRevision: 'b'.repeat(40) }] }]) {
    await assert.rejects(runSmoke(config(patch), r.deps()), { message: 'smoke_config_observation_mismatch' }, JSON.stringify(Object.keys(patch)))
  }
  assert.equal(r.fake.started.length, 1)
  // timing and the task or seed selection are not part of what a trial measures
  assert.equal((await runSmoke(config({ timing: { pollMs: 7 }, tasks: ['ll-money-text', 'll-rules-fx'] }), r.deps())).exitCode, 0)
  assert.equal(r.fake.started.length, 2)
})

test('a transient read failure is not final: the next run reads the events and the database again, without starting anything', async () => {
  let fail = true
  const r = rig({}, fake => ({ ...fakeBind(fake), ledger: async (arm: string, runId: string) => { if (fail) throw new SmokeSourceError('home_database_unreadable'); return fake.ledger(arm, runId) } }))
  const first = await runSmoke(config(), r.deps())
  assert.equal(first.summary.trials[0]!.ledgerError, 'home_database_unreadable')
  fail = false
  const second = await runSmoke(config(), r.deps())
  assert.equal(r.fake.started.length, 1)
  assert.deepEqual([second.summary.trials[0]!.ledgerRead, second.summary.trials[0]!.ledgerError], [true, null])
  assert.equal(second.report!.arms[0]!.totals.items.groupsUnknown, 0)
})

const fakeBind = (f: FakeRelay): RelaySource => ({ kind: 'fake', start: (a, i) => f.start(a, i), status: (a, k) => f.status(a, k), stop: (a, k) => f.stop(a, k), events: (a, s, n) => f.events(a, s, n), ledger: (a, r) => f.ledger(a, r) })

test('a naive arm that the relay cannot run is declared unsupported and needs no trials', async () => {
  const r = rig()
  const result = await runSmoke(config(), r.deps())
  assert.equal(result.exitCode, 0)
  assert.equal(result.summary.expectedTrials, 1)
  assert.deepEqual(result.summary.arms.map(a => [a.kind, a.availability]), [['ledger_relay', 'planned'], ['naive_compaction', 'unsupported']])
  assert.equal(result.measurement!.evidence.filter(e => e.kind === 'arm_declaration').length, 1)
  const report = reportOf(result)
  assert.deepEqual(report.pairedRelayVsNaive, { state: 'unresolved', reason: 'arm_unsupported' })
  assert.ok(report.unresolved.includes('arm_unsupported:naive_compaction'))
  assert.deepEqual(r.fake.started.map(s => s.arm), ['ledger-relay'])
})

test('a run that reaches no ledger keeps working: the home database failure is recorded, groups are unknown', async () => {
  const r = rig({}, fake => ({ ...fakeBind(fake), ledger: async () => { throw new SmokeSourceError('home_database_unreadable') } }))
  const result = await runSmoke(config(), r.deps())
  assert.equal(result.exitCode, 0)
  assert.equal(result.summary.trials[0]!.ledgerRead, false)
  assert.equal(result.summary.trials[0]!.ledgerError, 'home_database_unreadable')
  assert.equal(reportOf(result).arms[0]!.totals.items.groupsUnknown, 5)
})

test('scenarios: truncation, escalation and a tampered handoff are all visible in the reduction', async () => {
  const scenario = (input: Parameters<typeof defaultScenario>[0], arm: string): FakeScenario => {
    const base = defaultScenario(input, arm)
    if (input.plan.revision === 'll-money-text') return { cycles: base.cycles.slice(0, 3).map((c, i) => i === 2 ? { ...c, truncated: true } : c), status: 'failed', error: 'truncation_protocol' }
    return { ...base, cycles: base.cycles.map((c, i) => i === 1 ? { ...c, tamper: true, deadEnd: 'repeat' } : c), status: 'input_required', error: 'probe_failed_twice' }
  }
  const r = rig({ scenario })
  const result = await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'] }), r.deps())
  assert.equal(result.exitCode, 0)
  const totals = reportOf(result).arms[0]!.totals
  assert.deepEqual([totals.context.truncationEvents, totals.integrity.reportedMismatch, totals.guards.guardedRepeats], [1, 1, 1])
  const outcomes = reportOf(result).arms[0]!.trials.outcomes
  assert.deepEqual([outcomes.failed, outcomes.escalated], [1, 1])
})

test('configuration is strict and loopback only', () => {
  const ok = JSON.parse(JSON.stringify({ version: 1, experimentId: 'e', harnessRevision: 'a'.repeat(40), endpoint: { url: 'http://127.0.0.1:4551' }, start: { projectId: 'p', connectionId: 'c', model: 'm' },
    stratum: { provider: 'x', model: 'm', revision: 'r', quantization: { kind: 'not_applicable' }, runtime: 'a', adapter: 'b', resourceProfile: 'c', windowTokens: 32768, tokenCountConvention: 't' }, caps: { tokens: null, moneyMicros: 0, wallMs: null } }))
  assert.doesNotThrow(() => parseSmokeConfig(JSON.stringify(ok)))
  const bad = (patch: Record<string, unknown>) => assert.throws(() => parseSmokeConfig(JSON.stringify({ ...ok, ...patch })), /smoke_config|endpoint_invalid/)
  bad({ endpoint: { url: 'http://192.168.1.5:4551' } })
  bad({ endpoint: { url: 'https://127.0.0.1:4551' } })
  bad({ endpoint: { url: 'http://127.0.0.1:4551/api' } })
  bad({ endpoint: { url: 'http://user:pw@127.0.0.1:4551' } })
  bad({ extra: true })
  bad({ tasks: ['ll-unknown'] })
  bad({ tasks: ['ll-money-text', 'll-money-text'] })
  bad({ seeds: [1, 1] })
  bad({ horizon: 3, etaSelectionCycle: 4 })
  bad({ arms: [{ kind: 'ledger_relay', id: 'a' }, { kind: 'ledger_relay', id: 'b' }] })
  bad({ arms: [{ kind: 'observation_masking', id: 'a' }] })
  bad({ harnessRevision: 'main' })
  assert.throws(() => parseSmokeConfig('not json'), /smoke_config_invalid/)
  const own = parseSmokeConfig(JSON.stringify({ ...ok, arms: [{ kind: 'ledger_relay', id: 'a' }, { kind: 'naive_compaction', id: 'b', enabled: true, url: 'http://127.0.0.1:4651' }] }))
  assert.deepEqual(resolveArms(own).map(a => [a.id, a.planned, a.url]), [['a', true, 'http://127.0.0.1:4551'], ['b', true, 'http://127.0.0.1:4651']])
  assert.deepEqual(resolveArms(own).map(a => [a.profile.ledgerHandoff, a.profile.deadEndGuard]), [[true, true], [false, false]])
})

test('the arm is confirmed from the run own events: a naive trial on a ledger node is a failure, never a relabel', async () => {
  const r = rig()
  r.fake.homeMode = 'ledger'
  const cfg = config({ tasks: ['ll-money-text', 'll-rules-fx'], arms: SHARED })
  const wrong = await runSmoke(cfg, r.deps({ only: ['naive-compaction'] }))
  assert.equal(wrong.exitCode, 1)
  assert.equal(wrong.summary.halted, 'arm_mode_mismatch')
  assert.equal(wrong.summary.trials.find(t => t.arm === 'naive-compaction')!.endedBy, 'arm_mode_mismatch')
  assert.equal(r.fake.started.length, 1, 'nothing starts after the first mismatch')
  assert.equal(r.store.all.size, 0, 'a mismatched run is not stored under the arm it was planned as')
  assert.ok(wrong.measurement!.trials.every(t => t.state === 'missing'), 'and it is not in the document')
  assert.deepEqual(wrong.summary.document, { valid: true, issues: [] })
})

test('the reverse mismatch: a ledger trial on a node left in naive mode is refused too', async () => {
  const r = rig()
  r.fake.homeMode = 'naive'
  const result = await runSmoke(config({ arms: SHARED }), r.deps({ only: ['ledger-relay'] }))
  assert.deepEqual([result.exitCode, result.summary.halted, r.store.all.size], [1, 'arm_mode_mismatch', 0])
})

test('events that cannot be read confirm nothing: the trial is unconfirmed, unstored, and the rerun re-attaches by key', async () => {
  let broken = true
  const r = rig({}, fake => ({ ...fakeBind(fake), events: async (arm: string, sessionId: string, after: number) => { if (broken) throw new SmokeSourceError('response_invalid'); return fake.events(arm, sessionId, after) } }))
  const first = await runSmoke(config(), r.deps())
  assert.deepEqual([first.exitCode, first.summary.halted, r.store.all.size], [1, 'arm_mode_unconfirmed', 0])
  broken = false
  const second = await runSmoke(config(), r.deps())
  assert.deepEqual([second.exitCode, r.fake.started.length], [0, 1])
})

test('two passes against one endpoint: ledger pass, restart the home in naive mode, naive pass, one merged measurement', async () => {
  const r = rig()
  const cfg = config({ tasks: ['ll-money-text', 'll-rules-fx'], arms: SHARED })
  r.fake.homeMode = 'ledger'
  const first = await runSmoke(cfg, r.deps({ only: ['ledger-relay'] }))
  assert.equal(first.exitCode, 3)
  r.fake.homeMode = 'naive'   // the operator restarted the home with the naive setting
  const second = await runSmoke(cfg, r.deps({ only: ['naive-compaction'] }))
  assert.equal(second.exitCode, 0)
  assert.deepEqual(second.measurement!.trials.map(t => [t.arm, t.state]), [['ledger-relay', 'observed'], ['naive-compaction', 'observed'], ['ledger-relay', 'observed'], ['naive-compaction', 'observed']])
  const [ledger, naive] = second.report!.arms
  assert.deepEqual([ledger!.totals.probes.wholeAnswer.expected, naive!.totals.probes.wholeAnswer.expected], [8, 0], 'probe accuracy exists only for the ledger arm')
  assert.deepEqual([naive!.totals.probes.groupsUnknown, naive!.totals.integrity.unknown], [8, 10])
  assert.deepEqual(second.report!.pairedRelayVsNaive.state, 'descriptive')
  assert.ok(second.summary.trials.filter(t => t.arm === 'naive-compaction').every(t => t.notes.includes('compaction_summaries:5')))
})

const cyclesOf = (n: number, per: (cycle: number) => Partial<FakeScenario['cycles'][number]> = () => ({})): FakeScenario['cycles'] =>
  Array.from({ length: n }, (_, i) => ({ items: [{ item: `I0${i + 1}`, ok: true }], probe: [true], calls: 3, inputTokens: 18_000, sealed: true, ...per(i + 1) }))

test('a run whose attempts disagree about the mode is refused with its own code, whichever way the node was restarted, and is never stored', async () => {
  type Mode = 'ledger' | 'naive'
  const attempts = (first: Mode, second: Mode) => (c: number) => ({ attempt: c <= 2 ? 1 : 2, mode: c <= 2 ? first : second })
  const mixed = async (planned: 'ledger-relay' | 'naive-compaction', home: Mode, perCycle: (cycle: number) => { attempt: number; mode: Mode }) => {
    const r = rig({ scenario: () => ({ status: 'completed', cycles: cyclesOf(4, perCycle) }) })
    r.fake.homeMode = home
    const result = await runSmoke(config({ tasks: ['ll-money-text'], arms: SHARED }), r.deps({ only: [planned] }))
    return { result, r }
  }
  const cases: Array<[string, 'ledger-relay' | 'naive-compaction', Mode, (cycle: number) => { attempt: number; mode: Mode }]> = [
    ['naive attempt, then a restart in ledger mode', 'naive-compaction', 'naive', attempts('naive', 'ledger')],
    ['ledger attempt, then a restart in naive mode', 'naive-compaction', 'naive', attempts('ledger', 'naive')],
    ['the same two restarts in a trial planned as ledger', 'ledger-relay', 'ledger', attempts('ledger', 'naive')],
  ]
  for (const [name, planned, home, perCycle] of cases) {
    const { result, r } = await mixed(planned, home, perCycle)
    assert.deepEqual([result.exitCode, result.summary.halted, r.store.all.size], [1, 'arm_mode_mixed', 0], name)
    assert.equal(result.summary.trials.find(t => t.arm === planned)!.endedBy, 'arm_mode_mixed', name)
    assert.ok(result.measurement!.trials.every(t => t.state === 'missing'), name + ': never in the document under either arm')
  }
  // a run of two attempts that are both naive is one consistent naive run
  const { result, r } = await mixed('naive-compaction', 'naive', attempts('naive', 'naive'))
  assert.deepEqual([result.exitCode, result.summary.halted, r.store.all.size], [3, null, 1], 'stored; exit 3 only because the ledger pass is still to do')
})

test('a naive trial whose seals cannot be read cannot be attributed: unconfirmed, unstored, and a rerun re-attaches', async () => {
  let readable = false
  const r = rig({}, fake => ({ ...fakeBind(fake), ledger: async (arm: string, runId: string) => { if (!readable) throw new SmokeSourceError('home_database_unreadable'); return fake.ledger(arm, runId) } }))
  r.fake.homeMode = 'naive'
  const first = await runSmoke(config({ arms: SHARED }), r.deps({ only: ['naive-compaction'] }))
  assert.deepEqual([first.exitCode, first.summary.halted, r.store.all.size], [1, 'arm_mode_unconfirmed', 0])
  readable = true
  const second = await runSmoke(config({ arms: SHARED }), r.deps({ only: ['naive-compaction'] }))
  assert.deepEqual([second.summary.halted, r.fake.started.length], [null, 1], 'the same relay is read again, not started again')
  assert.equal(r.store.all.size, 1)
})

test('the summary notes of a naive trial carry the degraded reasons and the limits the relay reported', async () => {
  const r = rig({ scenario: () => ({ status: 'completed', cycles: cyclesOf(4, c => c >= 2 ? { summaryDegraded: c === 3 ? 'narrative_output_limited' : 'model_failed' } : {}) }) })
  r.fake.homeMode = 'naive'
  const result = await runSmoke(config({ arms: SHARED }), r.deps({ only: ['naive-compaction'] }))
  const notes = result.summary.trials.find(t => t.arm === 'naive-compaction')!.notes
  assert.ok(notes.includes('compaction_summary_degraded:3') && notes.includes('compaction_summary_truncated:3'), notes.join('|'))
  assert.ok(notes.includes('compaction_summary_degraded_reasons:model_failed=2,narrative_output_limited=1'), notes.join('|'))
  assert.ok(notes.includes('compaction_summary_limit_bytes:min=4000,max=4000') && notes.includes('compaction_output_limit_tokens:min=1000,max=1000'), notes.join('|'))
})
