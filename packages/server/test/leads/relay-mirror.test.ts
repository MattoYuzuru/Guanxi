import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RelayStartStatus } from '@guanxi/contract'
import { relayStartsChildReporter, relayStartsChildStarter } from '../../src/leads/children.ts'
import type { ChildLaunch } from '../../src/leads/types.ts'
import { HOUR, brief, leadFixture } from './helpers.ts'

type RelayState = RelayStartStatus['status']
/** The public relay start, idempotent by key like the real one, with a state the test moves. */
class FakeRelayStarts {
  state: RelayState = 'preparing'
  readonly inputs: { key: string }[] = []
  readonly stops: string[] = []
  readonly runs = new Map<string, string>()
  private status0(key: string): RelayStartStatus {
    return { key, runId: this.runs.get(key) ?? null, sessionId: null, status: this.state, error: null, source: 'run-home', observedAt: new Date(0).toISOString(),
      confidence: 'observed', runtime: null, runtimeAgeMs: null, meter: null, reserves: null }
  }
  async start(raw: { key: string }) {
    this.inputs.push(raw)
    if (!this.runs.has(raw.key)) this.runs.set(raw.key, `relay-run-${this.runs.size + 1}`)
    return this.status0(raw.key)
  }
  status(key: string) {
    if (!this.runs.has(key)) throw Object.assign(new Error('relay_not_found'), { code: 'relay_not_found' })
    return this.status0(key)
  }
  async stop(key: string) { this.stops.push(key); return this.status0(key) }
}
const ledger = { plan: { items: [{ id: 't1', title: 'Fix it' }] }, items: { t1: 'done' }, head: 'abc123', evidence: [{ item: 't1', head: 'abc123', ok: true, output: 'npm test green' }],
  diffstat: '1 file changed', proposals: [], cycle: 2, tokens: 500, moneyMicros: 0, unknownCosts: 0 }

async function mirrorFixture(t: Parameters<typeof leadFixture>[0], lead: Record<string, unknown> = {}) {
  const relay = new FakeRelayStarts()
  const ticks: (() => void)[] = []
  let ref: Awaited<ReturnType<typeof leadFixture>> | null = null
  const sleep = () => new Promise<void>(resolve => ticks.push(resolve))
  let inner: ReturnType<typeof relayStartsChildStarter> | null = null
  const starter = {
    start: (launch: ChildLaunch) => (inner ??= relayStartsChildStarter(relay as never, { consent: 'full-access', domains: [], runs: ref!.runs(), pollMs: 1, sleep })).start(launch),
    stop: (id: string) => (inner ??= relayStartsChildStarter(relay as never, { consent: 'full-access', domains: [], runs: ref!.runs(), pollMs: 1, sleep })).stop(id),
  }
  const reporter = relayStartsChildReporter(relay as never, { read: () => ledger as never })
  const f = await leadFixture(t, { lead, plugin: { child: starter, reporter } })
  ref = f
  const step = async () => { for (const tick of ticks.splice(0)) tick(); await new Promise(resolve => setTimeout(resolve, 15)) }
  return { f, relay, step, ticks }
}
const resumed = async (f: Awaited<ReturnType<typeof leadFixture>>) => (await f.events()).filter(e => e.event === 'prompt' && String(e.text).includes('guanxi.wake/v1'))

test('a lead delegates through the public relay start: escalation, completion, two wakes and the relay ledger in the packet', async t => {
  const { f, relay, step } = await mirrorFixture(t)
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  const run = f.runs()
  const child = run.promises(runId)[0]!.child_id
  await step()
  assert.deepEqual(relay.inputs.map(i => i.key), [child], 'the relay start is keyed by the R1 child id')
  assert.equal(run.attempts(child)[0]!.first_model_at, null, 'preparing is not work')
  relay.state = 'running'
  await step()
  assert.notEqual(run.attempts(child)[0]!.first_model_at, null, 'the mirror records that work began')
  relay.state = 'input_required'
  await step()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.wakes(runId).length, 1)
  assert.equal(run.wakes(runId)[0]!.kind, 'escalation')
  assert.equal(run.get(runId).state, 'waiting_children', 'the lead yielded; the promise is still pending')
  relay.state = 'completed'
  await step()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.wakes(runId).map(w => [w.kind, w.acknowledged_at !== null]), [['escalation', true], ['resolution', true]])
  assert.equal(run.promises(runId)[0]!.outcome, 'completed')
  const prompts = await resumed(f)
  assert.equal(prompts.length, 2)
  assert.match(String(prompts[1]!.text), /items:\n- t1 \[done\] Fix it/)
  assert.match(String(prompts[1]!.text), /gates:\n- t1 ok=true @abc123 npm test green/)
  assert.match(String(prompts[1]!.text), /handoff: relay:relay-run-1 cycle=2/)
})

test('a failed relay run resolves the promise as failed and a restart-interrupted one is reported failed, never resumed', async t => {
  for (const state of ['failed', 'interrupted'] as const) {
    const { f, relay, step } = await mirrorFixture(t)
    const { runId, first } = f.start()
    await first
    relay.state = state
    await step()
    f.lead().pump()
    await f.lead().idle()
    assert.equal(f.runs().promises(runId)[0]!.outcome, 'failed', state)
    assert.match(String((await resumed(f))[0]!.text), /outcome: failed/)
  }
})

test('canceling the lead stops the relay run once and the mirror ends without a wake or a notice', async t => {
  const { f, relay, step } = await mirrorFixture(t)
  const { runId, first } = f.start()
  await first
  const child = f.runs().promises(runId)[0]!.child_id
  relay.state = 'running'
  await step()
  await f.lead().cancel(runId)
  await f.lead().cancel(runId)
  await step()
  assert.deepEqual(relay.stops, [child], 'the relay run is stopped exactly once')
  assert.equal(f.runs().wakes(runId).length, 0)
  assert.deepEqual(f.notices, [])
  assert.equal(f.runs().get(child).state, 'canceled')
})

test('after a lost mirror the child is attached to the SAME relay run again, never a second one', async t => {
  const { f, relay, step } = await mirrorFixture(t, { briefs: [brief({ deadlineMs: 72 * HOUR })] })
  const { runId, first } = f.start()
  await first
  const child = f.runs().promises(runId)[0]!.child_id
  await step()
  assert.equal(relay.runs.size, 1)
  // The node was away longer than the mirror's lease, before the relay run did any work.
  f.advance(25 * HOUR)
  f.runs().tick()
  assert.equal(f.runs().get(child).state, 'interrupted')
  await step()
  f.lead().pump()
  await f.lead().idle()
  await step()
  assert.deepEqual(relay.inputs.map(i => i.key), [child, child], 'started twice with the same key')
  assert.equal(relay.runs.size, 1, 'the relay deduplicated by key: one run')
  assert.equal(f.runs().get(child).state, 'working')
  relay.state = 'completed'
  await step()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  assert.equal(f.runs().wakes(runId).length, 1)
})
