import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOUR, brief, leadFixture } from './helpers.ts'

type Fixture = Awaited<ReturnType<typeof leadFixture>>
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const lifecycle = (f: Fixture, runId: string) => f.kernel.sessionLog!.readAll(runId, 'person').filter(e => e.type === 'run.lifecycle').map(e => e.data as { runId: string; action: string; state: string; wakeSeq: number | null })
const ledger = (f: Fixture, runId: string) => ({ totals: f.runs().costs(runId), rows: Number(f.db.prepare('SELECT COUNT(*) AS n FROM run_costs WHERE run_id=?').get(runId)!.n) })
const resumedPrompts = async (f: Fixture) => (await f.events()).filter(e => e.event === 'prompt' && String(e.text).includes('guanxi.wake/v1'))

test('delegate, hibernate and wake: one wake, one resumed turn by session/load, ledger unchanged while asleep', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  const turn = await first
  assert.equal(turn.outcome, 'hibernated')
  const run = f.runs()
  assert.equal(run.get(runId).state, 'waiting_children')
  assert.equal(f.children.launches.length, 1)
  assert.equal(run.promises(runId).length, 1)

  // Hibernating means no process, no admission holder, no tool grant and no execution lease.
  const pids = [...new Set((await f.events()).map(e => Number(e.pid)))]
  assert.ok(pids.length >= 1)
  for (const pid of pids) assert.equal(alive(pid), false, `lead agent process ${pid} must be gone`)
  const connectionId = f.binding.connectionId
  assert.deepEqual(f.service().limits(f.owner, connectionId).durableLocalOccupancy, { held: 0, cleanupUnconfirmed: 0, total: 0 })
  assert.equal(f.service().limits(f.owner, connectionId).activeOnThisNode, 0)
  assert.equal(f.tools.activeGrants(), 0)
  assert.equal(f.db.prepare('SELECT released FROM leases WHERE key=?').get(`run:${runId}/exec`)!.released, 1)
  // The lead's retained scratch resource still holds a lease.
  assert.equal(f.db.prepare('SELECT released FROM leases WHERE key=?').get(`resource:lead-scratch:${runId}`)!.released, 0)

  const afterDelegate = ledger(f, runId)
  assert.equal(afterDelegate.rows, 1)
  assert.deepEqual(afterDelegate.totals, [{ currency: 'USD', inputTokens: 1000, outputTokens: 200, costMicrounits: 500_000 }])
  const attemptsAsleep = run.attempts(runId).length
  const leadEventsAsleep = (await f.events()).length

  // Eight simulated hours pass: nothing is spent, nothing starts, retained resources survive.
  f.advance(8 * HOUR - 1_000)
  f.lead().pump()
  await f.lead().idle()
  assert.deepEqual(run.reapResources(), [])
  assert.equal(run.attempts(runId).length, attemptsAsleep)
  assert.equal((await f.events()).length, leadEventsAsleep, 'a sleeping lead is never prompted')
  f.children.complete()
  const beforeWake = ledger(f, runId)
  assert.deepEqual(beforeWake, afterDelegate, 'lead cost ledger is identical between delegate and wake')

  f.lead().pump()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).length, 1)
  assert.ok(run.wakes(runId)[0]!.acknowledged_at !== null)
  assert.equal(run.wakes(runId)[0]!.deliveries, 1)
  assert.equal(run.promises(runId).filter(p => p.outcome === 'completed').length, 1)
  const events = await f.events()
  assert.equal(events.filter(e => e.event === 'session_new').length, 1)
  assert.equal(events.filter(e => e.event === 'session_load').length, 1)
  assert.equal((await resumedPrompts(f)).length, 1)
  assert.equal(events.filter(e => e.event === 'turn_end' && e.stopReason === 'end_turn').length, 1)
  const actions = lifecycle(f, runId).filter(a => a.runId === runId).map(a => a.action)
  assert.equal(actions.filter(a => a === 'delegated').length, 1)
  assert.equal(actions.filter(a => a === 'resolved').length, 1)
  assert.equal(actions.filter(a => a === 'wake').length, 1)
  assert.equal(actions.filter(a => a === 'acknowledged').length, 1)
  // The resumed turn is billed after the wake, on the new attempt.
  assert.equal(ledger(f, runId).rows, 2)
  assert.deepEqual(ledger(f, runId).totals, [{ currency: 'USD', inputTokens: 2000, outputTokens: 400, costMicrounits: 1_000_000 }])
  // Replayed history during session/load never becomes output of the resumed turn.
  for (const session of f.kernel.sessionLog!.list().sessions) {
    for (const event of f.kernel.sessionLog!.readAll(session.sessionId, 'person')) assert.ok(!JSON.stringify(event.data).includes('HISTORY-REPLAY'), event.type)
  }
  assert.deepEqual(f.notices, [])
})

test('an agent without loadSession gets a new session seeded with the lead handoff and the wake packet', async t => {
  const f = await leadFixture(t, { lead: { loadSession: false } })
  const { runId, first } = f.start('Fix the failing tests carefully')
  assert.equal((await first).outcome, 'hibernated')
  f.advance(2 * HOUR)
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  const events = await f.events()
  assert.equal(events.filter(e => e.event === 'session_new').length, 2)
  assert.equal(events.filter(e => e.event === 'session_load').length, 0)
  const resumed = await resumedPrompts(f)
  assert.equal(resumed.length, 1)
  assert.match(String(resumed[0]!.text), /Lead handoff:\nTask: Fix the failing tests carefully/)
  assert.match(String(resumed[0]!.text), /Delegated objective: Make the fixture tests pass/)
  assert.match(String(resumed[0]!.text), /Your last words before hibernating:\nplanning delegation/)
  assert.match(String(resumed[0]!.text), /guanxi\.wake\/v1 wake=1 kind=resolution/)
  assert.notEqual(resumed[0]!.sessionId, events.find(e => e.event === 'session_new')!.sessionId)
  assert.equal(f.db.prepare('SELECT resume_mode FROM lead_wakes WHERE run_id=?').get(runId)!.resume_mode, 'seeded')
  assert.equal(f.runs().wakes(runId).filter(w => w.acknowledged_at !== null).length, 1)
})

test('an advertised loadSession that the agent refuses falls back to a seeded session in the same turn', async t => {
  const f = await leadFixture(t, { lead: { loadSession: true } })
  const { runId, first } = f.start()
  await first
  await f.scenario({ loadFails: true })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  const events = await f.events()
  assert.equal(events.filter(e => e.event === 'session_load').length, 0, 'the refusal is not a successful load')
  assert.equal((await resumedPrompts(f)).length, 1)
  assert.equal(f.db.prepare('SELECT resume_mode FROM lead_wakes WHERE run_id=?').get(runId)!.resume_mode, 'seeded')
  assert.equal(f.runs().wakes(runId).filter(w => w.acknowledged_at !== null).length, 1)
})

test('an agent that no longer advertises loadSession is never asked to load the saved session', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  assert.equal(f.lead().sessions()[0]!.loadSession, true, 'the first run advertised it')
  await f.scenario({ loadSession: false })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  const events = await f.events()
  assert.equal(events.filter(e => e.event === 'session_load_requested').length, 0)
  assert.equal(events.filter(e => e.event === 'session_new').length, 2)
  assert.equal(f.db.prepare('SELECT resume_mode FROM lead_wakes WHERE run_id=?').get(runId)!.resume_mode, 'seeded')
})

test('an escalation wakes the lead without resolving the promise, and the completion wakes it again', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  const run = f.runs()
  run.signal(f.children.attempt(), 'judge-flag')
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.promises(runId)[0]!.outcome, null, 'an escalation never resolves the promise')
  assert.equal(run.get(runId).state, 'waiting_children', 'the lead yields again because its child is still pending')
  assert.equal((await resumedPrompts(f)).length, 1)
  assert.match(String((await resumedPrompts(f))[0]!.text), /kind=escalation[\s\S]*outcome: pending/)
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).length, 2)
  assert.deepEqual(run.wakes(runId).map(w => [w.kind, w.acknowledged_at !== null]), [['escalation', true], ['resolution', true]])
  assert.equal(run.promises(runId).filter(p => p.outcome === 'completed').length, 1)
  assert.equal((await resumedPrompts(f)).length, 2)
  assert.equal(lifecycle(f, runId).filter(a => a.runId === runId && a.action === 'resolved').length, 1)
})

test('a deadline wakes the lead although the child never finishes, with the wrap-up report requested', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  f.advance(8 * HOUR + 1)
  f.runs().tick()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.promises(runId)[0]!.outcome, 'deadline')
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).length, 1)
  assert.match(String((await resumedPrompts(f))[0]!.text), /outcome: deadline[\s\S]*state=wrapping_up/)
  // The lead chose to finish; R1 then cancels its unfinished child along the chain, once.
  const child = run.get(f.children.launches[0]!.childRunId)
  assert.equal(child.state, 'canceled')
  assert.equal(child.cancel_count, 1)
})

test('a lead that delegates again after its wake sleeps twice and each wake is acknowledged once', async t => {
  const f = await leadFixture(t, { lead: { briefs: [brief(), brief({ objective: 'Second pass' })], redelegate: true } })
  const { runId, first } = f.start()
  await first
  f.children.complete(0)
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'waiting_children')
  assert.equal(run.promises(runId).length, 2)
  assert.equal(f.children.launches.length, 2)
  f.advance(HOUR)
  f.children.complete(1)
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.wakes(runId).map(w => w.acknowledged_at !== null), [true, true])
  assert.equal(run.promises(runId).filter(p => p.outcome === 'completed').length, 2)
  assert.equal((await f.events()).filter(e => e.event === 'tool_call').length, 2)
  assert.equal((await resumedPrompts(f)).length, 2)
})

test('an invalid brief is answered as a tool error and the lead keeps working without hibernating', async t => {
  const f = await leadFixture(t, { lead: { briefs: [{ objective: '' }] } })
  const { runId, first } = f.start()
  const turn = await first
  assert.equal(turn.outcome, 'completed')
  assert.equal(f.runs().promises(runId).length, 0)
  assert.equal(f.children.launches.length, 0)
  const answer = (await f.events()).find(e => e.event === 'tool_answer')!
  assert.equal(answer.isError, true)
  assert.match(String(answer.text), /^invalid_brief: /)
})

test('canceling a hibernating lead cancels the child chain once and stops its executor once', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  const childId = f.children.launches[0]!.childRunId
  await f.lead().cancel(runId)
  await f.lead().cancel(runId)
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'canceled')
  assert.equal(run.get(childId).state, 'canceled')
  assert.equal(run.get(runId).cancel_count, 1)
  assert.equal(run.get(childId).cancel_count, 1)
  assert.deepEqual(f.children.stops, [childId], 'the executor is stopped exactly once')
  const canceled = lifecycle(f, runId).filter(a => a.action === 'canceled')
  assert.equal(canceled.filter(a => a.runId === childId).length + canceled.filter(a => a.runId === runId).length, 2)
  assert.equal(run.wakes(runId).length, 0, 'a cancellation wakes nobody')
  assert.equal(f.db.prepare("SELECT state FROM lead_delegations WHERE lead_run_id=?").get(runId)!.state, 'child_stop_requested')
  assert.equal((await resumedPrompts(f)).length, 0)
  // A late completion from the canceled executor is fenced out and wakes nobody.
  assert.throws(() => f.children.complete(), { code: 'stale_lease' })
  assert.equal(run.wakes(runId).length, 0)
})

test('canceling a running lead turn stops its process and cancels the run', async t => {
  const f = await leadFixture(t, { lead: { hang: true } })
  const { runId, first } = f.start()
  const events = async () => (await f.events()).filter(e => e.event === 'prompt')
  for (let i = 0; i < 400 && (await events()).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await events()).length, 1)
  await f.lead().cancel(runId)
  assert.equal((await first).outcome, 'canceled')
  assert.equal(f.runs().get(runId).state, 'canceled')
  const pids = [...new Set((await f.events()).map(e => Number(e.pid)))]
  for (const pid of pids) assert.equal(alive(pid), false)
  assert.deepEqual(f.service().limits(f.owner, f.binding.connectionId).durableLocalOccupancy, { held: 0, cleanupUnconfirmed: 0, total: 0 })
  assert.equal(f.tools.activeGrants(), 0)
})
