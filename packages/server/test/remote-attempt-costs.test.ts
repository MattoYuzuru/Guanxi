import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DispatchEvent, LocalInferenceJob, SignedDispatchEvent } from '@guanxi/contract/federation'
import type { DispatchPolicy } from '../src/remote-attempts/dispatch.ts'
import { FederationChannel } from '../src/federation/channel.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { hash, signValue } from '../src/federation/crypto.ts'
import { identity, SimNode } from './federation/harness.ts'

const ZERO = '0'.repeat(64)
const keys = (id: string) => identity(id, { scopes: ['config', 'replicas', 'commands', 'telemetry', 'attempts'] })

/** Home/target fixture for the home-side ingest path only; no model or connection is used. */
async function fixture(t: { after(fn: () => unknown): void }) {
  const clock = { mono: 1_000_000 }, hg = new ResourceGovernor(), tg = new ResourceGovernor()
  let home!: SimNode, target!: SimNode
  const channel = (from: SimNode, to: SimNode) => new FederationChannel({ local: from.keys.identity, privateKey: from.keys.privateKey,
    peer: to.keys.identity, clock: () => from.time, transport: async request => to.app.request(request) })
  const hp: DispatchPolicy = { ttlMs: 3000, safetyMs: 100, maxModelAgeMs: 5000, leaseClock: () => clock.mono, channel: () => channel(home, target) }
  const tp: DispatchPolicy = { ...hp, channel: () => channel(target, home) }
  home = new SimNode(keys('home'), ':memory:', { attempts: { governor: hg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: hp })
  target = new SimNode(keys('target'), ':memory:', { attempts: { governor: tg, maxReservationMs: 5000, leaseClock: () => clock.mono }, dispatch: tp })
  home.trust(target); target.trust(home)

  const parent = home.runs.create({ id: 'parent', sessionId: 'session' })
  const lead = home.runs.start(parent.id); home.runs.modelStarted(lead)
  home.runs.recordCost(lead, { key: 'lead-observation', inputTokens: 2, outputTokens: 1, costMicrounits: null, currency: 'unknown' })
  const promise = home.runs.delegate(lead, { key: 'child', deadline: home.time + 90_000 })
  const runId = promise.child_id
  target.federation.replicas.bind({ streamId: runId, kind: 'run', sessionId: parent.session_id, ownerAccountId: 'owner',
    homeNodeId: 'home', homeEpoch: 1 })
  const job: LocalInferenceJob = { kind: 'local_inference', model: 'fixture-model', context: 32768, outputTokens: 512,
    deadline: home.time + 30_000, messages: [{ role: 'user', content: 'fixture prompt' }] }
  const offer = home.federation.prepareDispatch(runId, 'target', job, 4000)
  const grant = home.federation.grantDispatch(offer.id, await channel(home, target).offer(offer))
  assert.equal(grant.grant.dispatchAuthorized, true)
  const ref = { id: offer.id, homeNodeId: 'home', executorNodeId: 'target' }
  const targetContext = { identity: target.keys.identity, readOnly: false, version: { major: 1, minor: 3 } }
  const sign = (seq: number, previousHash: string, event: DispatchEvent['event']): SignedDispatchEvent => {
    const entry: DispatchEvent = { ref, seq, previousHash, observedAt: home.time, event }
    return { entry, hash: hash(entry), signature: signValue(target.keys.privateKey, entry) }
  }
  const deliver = (signed: SignedDispatchEvent) => home.federation.receiveDispatchEvent(targetContext, signed)
  t.after(async () => { home.close(); target.close(); await hg.close(); await tg.close() })
  return { home, parent, runId, attempt: home.runs.attempts(runId).at(-1)!, offer, sign, deliver }
}

const usage = (inputTokens: number, outputTokens: number) => ({ kind: 'terminal' as const, outcome: 'completed' as const,
  content: 'fixture result', inputTokens, outputTokens, source: 'ollama:/api/chat' as const })
function costRows(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  return f.home.db.prepare('SELECT * FROM run_costs WHERE run_id=?').all(runId) as unknown as
    { run_id: string; entry_key: string; attempt_id: string; input_tokens: number; output_tokens: number;
      cost_microunits: number | null; currency: string }[]
}

test('completed terminal records one fenced cost row and leaves parent totals unchanged', async t => {
  const f = await fixture(t)
  const parentBefore = f.home.runs.costs(f.parent.id)
  assert.deepEqual(parentBefore, [{ currency: 'unknown', inputTokens: 2, outputTokens: 1, costMicrounits: null }])
  assert.deepEqual(f.home.runs.costs(f.runId), [])
  const started = f.sign(1, ZERO, { kind: 'started' })
  f.deliver(started)
  f.deliver(f.sign(2, started.hash, usage(7, 3)))
  assert.equal(f.home.runs.get(f.runId).state, 'completed')
  assert.deepEqual(f.home.runs.costs(f.runId), [{ currency: 'unknown', inputTokens: 7, outputTokens: 3, costMicrounits: null }])
  const rows = costRows(f, f.runId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.entry_key, `remote-dispatch:${f.offer.id}`)
  assert.equal(rows[0]!.attempt_id, f.attempt.id)
  assert.equal(rows[0]!.input_tokens, 7)
  assert.equal(rows[0]!.output_tokens, 3)
  assert.equal(rows[0]!.cost_microunits, null)
  assert.equal(rows[0]!.currency, 'unknown')
  assert.deepEqual(f.home.runs.costs(f.parent.id), parentBefore)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) AS n FROM remote_dispatch_receipts WHERE id=?').get(f.offer.id)!.n, 2)
})

test('terminal with null usage completes without inventing a cost', async t => {
  for (const [inputTokens, outputTokens] of [[null, null], [7, null], [null, 3]] as const) {
    const f = await fixture(t)
    const started = f.sign(1, ZERO, { kind: 'started' })
    f.deliver(started)
    f.deliver(f.sign(2, started.hash, { kind: 'terminal', outcome: 'completed', content: '',
      inputTokens, outputTokens, source: 'ollama:/api/chat' }))
    assert.equal(f.home.runs.get(f.runId).state, 'completed')
    assert.deepEqual(f.home.runs.costs(f.runId), [])
    assert.equal(f.home.db.prepare('SELECT COUNT(*) AS n FROM run_costs WHERE run_id=?').get(f.runId)!.n, 0)
  }
})

test('replayed identical terminal still records exactly one cost row', async t => {
  const f = await fixture(t)
  const started = f.sign(1, ZERO, { kind: 'started' })
  f.deliver(started)
  const terminal = f.sign(2, started.hash, usage(7, 3))
  f.deliver(terminal); f.deliver(terminal)
  assert.equal(f.home.runs.get(f.runId).state, 'completed')
  assert.equal(costRows(f, f.runId).length, 1)
  assert.deepEqual(f.home.runs.costs(f.runId), [{ currency: 'unknown', inputTokens: 7, outputTokens: 3, costMicrounits: null }])
  const costEvents = f.home.log.read('session', { audience: 'person' }).events
    .filter(event => event.type === 'run.lifecycle' && event.data.action === 'cost' && event.data.runId === f.runId)
  assert.equal(costEvents.length, 1)
  assert.equal(f.home.db.prepare('SELECT COUNT(*) AS n FROM remote_dispatch_receipts WHERE id=?').get(f.offer.id)!.n, 2)
})

test('a failing cost insert rolls back the terminal receipt, cost and completion together', async t => {
  const f = await fixture(t)
  const started = f.sign(1, ZERO, { kind: 'started' })
  f.deliver(started)
  const terminal = f.sign(2, started.hash, usage(7, 3))
  f.home.db.exec("CREATE TRIGGER fail_remote_cost BEFORE INSERT ON run_costs BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
  assert.throws(() => f.deliver(terminal), /fixture rollback/)
  assert.equal(f.home.runs.get(f.runId).state, 'working')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) AS n FROM remote_dispatch_receipts WHERE id=? AND seq=2').get(f.offer.id)!.n, 0)
  assert.equal(costRows(f, f.runId).length, 0)
  f.home.db.exec('DROP TRIGGER fail_remote_cost')
  f.deliver(terminal)
  assert.equal(f.home.runs.get(f.runId).state, 'completed')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) AS n FROM remote_dispatch_receipts WHERE id=?').get(f.offer.id)!.n, 2)
  assert.equal(costRows(f, f.runId).length, 1)
})

test('canceled and failed terminals with usage follow the same cost rule', async t => {
  for (const outcome of ['canceled', 'failed'] as const) {
    const f = await fixture(t)
    const started = f.sign(1, ZERO, { kind: 'started' })
    f.deliver(started)
    f.deliver(f.sign(2, started.hash, { ...usage(4, 2), outcome }))
    assert.equal(f.home.runs.get(f.runId).state, outcome)
    assert.deepEqual(f.home.runs.costs(f.runId), [{ currency: 'unknown', inputTokens: 4, outputTokens: 2, costMicrounits: null }])
    assert.equal(costRows(f, f.runId).length, 1)
  }
})
