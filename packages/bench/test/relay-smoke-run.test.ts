import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeClock, FakeRelay, defaultScenario, type FakeScenario } from '../src/relay-smoke-fake.ts'
import type { RelaySource } from '../src/relay-smoke-source.ts'
import { SmokeSourceError } from '../src/relay-smoke-source.ts'
import { memoryStore, parseSmokeConfig, resolveArms, runSmoke, trialKey, type RunDeps } from '../src/relay-smoke-run.ts'
import { config, T0 } from './relay-smoke-helpers.ts'

const BOTH = [{ kind: 'ledger_relay', id: 'ledger-relay' }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true }]
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
  await runSmoke(config({ tasks: ['ll-money-text', 'll-rules-fx'], seeds: [0, 1], arms: BOTH, horizon: 7 }), r.deps())
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
  const trial = result.measurement!.trials[0]!
  assert.equal(trial.state === 'observed' ? trial.outcome : '', 'cancelled')
})

test('an endpoint that keeps failing ends the trial as aborted after the configured number of failures', async () => {
  let calls = 0
  const r = rig({}, fake => ({ ...fakeBind(fake), status: async () => { calls++; throw new SmokeSourceError('endpoint_unreachable') } }))
  const result = await runSmoke(config({ timing: { pollMs: 1000, trialDeadlineMs: 3_600_000, statusFailuresBeforeAbort: 3 } }), r.deps())
  assert.equal(calls, 3)
  assert.equal(result.summary.trials[0]!.endedBy, 'aborted')
  assert.equal(result.summary.trials[0]!.status, 'running')
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
