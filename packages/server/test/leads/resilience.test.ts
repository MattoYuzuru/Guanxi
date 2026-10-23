import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brief, leadFixture, HOUR } from './helpers.ts'
import { RunError } from '../../src/runs/types.ts'
import { LeadStore } from '../../src/leads/store.ts'
import { LeadToolServer } from '../../src/leads/tool-server.ts'

type Fixture = Awaited<ReturnType<typeof leadFixture>>
const resumedPrompts = async (f: Fixture, adapter: 'claude-code' | 'copilot' = 'claude-code') =>
  (await f.events(adapter)).filter(e => e.event === 'prompt' && String(e.text).includes('guanxi.wake/v1'))

test('a planted secret in the child report never reaches the stored packet or the resumed lead', async t => {
  const f = await leadFixture(t)
  const secret = `planted_${'s'.repeat(24)}`
  f.kernel.scrubber.register('secret://lead/planted', secret)
  const { runId, first } = f.start()
  await first
  const child = f.children.launches[0]!.childRunId
  f.children.reports.set(child, { items: [{ id: 't1', title: `Title ${secret}`, status: 'done' }],
    gates: [{ item: 't1', ok: true, head: 'abc', output: `output ${secret} tail` }], head: 'abc', diffstat: `1 file ${secret}`,
    handoff: { ref: `relay:${child}`, cycle: 3 }, narrative: `narrative ${secret}`, openQuestions: [`ask ${secret}`],
    metrics: { cycles: 3, tokens: 100, moneyMicros: 5 } })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  const stored = String(f.db.prepare('SELECT packet FROM lead_wakes WHERE run_id=?').get(runId)!.packet)
  assert.ok(!stored.includes(secret), 'the stored packet is scrubbed')
  assert.match(stored, /redacted|REDACTED|\[/i)
  const raw = JSON.stringify(f.db.prepare('SELECT * FROM lead_wakes').all()) + JSON.stringify(f.db.prepare('SELECT * FROM lead_sessions').all()) +
    JSON.stringify(f.db.prepare('SELECT * FROM lead_delegations').all())
  assert.ok(!raw.includes(secret))
  const prompt = String((await resumedPrompts(f))[0]!.text)
  assert.ok(!prompt.includes(secret))
  assert.match(prompt, /handoff: relay:/)
  assert.match(prompt, /items:\n- t1 \[done\]/)
  assert.match(prompt, /gates:\n- t1 ok=true @abc/)
})

test('a wake packet stays inside its token budget for a very large child report and says what was cut', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  const child = f.children.launches[0]!.childRunId
  const items = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, title: `Item ${i} ${'x'.repeat(300)}`, status: 'open' as const }))
  f.children.reports.set(child, { items, gates: items.map(item => ({ item: item.id, ok: false, head: 'abc', output: 'o'.repeat(2000) })),
    head: 'abc', diffstat: 'd'.repeat(10_000), handoff: { ref: `relay:${child}`, cycle: 9 }, narrative: 'n'.repeat(20_000),
    openQuestions: Array.from({ length: 50 }, (_, i) => `question ${i} ${'q'.repeat(500)}`), metrics: { cycles: 9, tokens: 1, moneyMicros: null } })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const stored = JSON.parse(String(f.db.prepare('SELECT packet FROM lead_wakes WHERE run_id=?').get(runId)!.packet))
  assert.ok(stored.truncated.length > 0)
  const prompt = String((await resumedPrompts(f))[0]!.text)
  assert.ok(Math.ceil(Buffer.byteLength(prompt) / 3) <= 4000, `packet is ${Buffer.byteLength(prompt)} bytes`)
  assert.match(prompt, /truncated: /)
  assert.match(prompt, /outcome: completed/)
})

test('an unavailable lead keeps the wake and packet, notifies, backs off and is acknowledged once when it returns', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  await f.scenario({ mcpHttp: false })
  const childId = f.children.launches[0]!.childRunId
  const report = (narrative: string) => ({ items: [], gates: [], head: null, diffstat: '', handoff: null, narrative, openQuestions: [], metrics: { cycles: null, tokens: null, moneyMicros: null } })
  f.children.reports.set(childId, report('FIRST-REPORT'))
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  f.children.reports.set(childId, report('SECOND-REPORT'))
  const run = f.runs()
  assert.equal(run.get(runId).state, 'submitted', 'the lead waits for a retry, it is not failed')
  assert.equal(run.wakes(runId)[0]!.acknowledged_at, null)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_wakes').get()!.n, 1, 'the packet is kept')
  assert.deepEqual(f.notices.map(n => [n.kind, 'code' in n ? n.code : null]), [['lead_unavailable', 'mcp_http_unsupported']])
  assert.equal(f.lead().sessions()[0]!.failures, 1)
  // The back-off holds: an immediate pump claims nothing.
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.wakes(runId)[0]!.deliveries, 1)
  const packetBefore = f.db.prepare('SELECT packet, packet_hash FROM lead_wakes').get()
  await f.scenario({ mcpHttp: true })
  f.advance(1_001)
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).length, 1)
  assert.equal(run.wakes(runId)[0]!.deliveries, 2)
  assert.ok(run.wakes(runId)[0]!.acknowledged_at !== null)
  assert.equal((await resumedPrompts(f)).length, 1, 'exactly one resumed turn reached the lead')
  const resumed = String((await resumedPrompts(f))[0]!.text)
  assert.match(resumed, /FIRST-REPORT/)
  assert.ok(!resumed.includes('SECOND-REPORT'), 'a redelivery never rebuilds the packet from newer facts')
  assert.equal(f.lead().sessions()[0]!.failures, 0)
  assert.deepEqual(f.db.prepare('SELECT packet, packet_hash FROM lead_wakes').get(), packetBefore, 'the redelivery used the packet built for the first delivery')
})

test('the run policy fallback lead is used only when named, with a seeded session', async t => {
  const f = await leadFixture(t, { fallback: true })
  await f.scenario({ mcpHttp: false }, 'claude-code')
  const { runId, first } = f.start('Plan the work')
  const turn = await first
  assert.equal(turn.outcome, 'hibernated', 'the fallback lead delegated after the primary was unavailable')
  assert.equal((await f.events('claude-code')).filter(e => e.event === 'prompt').length, 0)
  assert.equal((await f.events('copilot')).filter(e => e.event === 'tool_call').length, 1)
  assert.equal(f.lead().sessions()[0]!.fallbackUsed, true)
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  assert.equal((await resumedPrompts(f, 'copilot')).length, 1)
  assert.equal((await resumedPrompts(f, 'claude-code')).length, 0)
})

test('without a named fallback an unavailable first turn fails the run instead of spending elsewhere', async t => {
  const f = await leadFixture(t, { fallback: true })
  await f.scenario({ mcpHttp: false }, 'claude-code')
  const { runId, first } = await f.lead().startLead({ ownerAccountId: f.owner, actorAccountId: f.owner, projectId: 'p', prompt: 'x' })
    .first.then(turn => ({ runId: turn.runId, first: Promise.resolve(turn) }))
  const turn = await first
  assert.equal(turn.outcome, 'failed')
  assert.equal(f.runs().get(runId).state, 'failed')
  assert.equal((await f.events('copilot')).length, 0)
})

test('a lead failure after the wake was acknowledged needs a person and is never replayed automatically', async t => {
  const f = await leadFixture(t, { lead: { crashOnResume: true } })
  const { runId, first } = f.start()
  await first
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'input_required')
  assert.deepEqual(f.notices.map(n => n.kind), ['lead_failed'])
  assert.equal(run.wakes(runId)[0]!.acknowledged_at !== null, true)
  f.lead().pump()
  await f.lead().idle()
  assert.equal((await resumedPrompts(f)).length, 1, 'the acknowledged wake is not resumed again')
  await f.scenario({ crashOnResume: false })
  const decided = await f.lead().resume(runId, 'Please continue the work')
  assert.equal(decided.outcome, 'completed')
  assert.equal(run.get(runId).state, 'completed')
})

test('restarting the lead service while the lead sleeps still yields exactly one resumed turn', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  await f.restartLead()
  f.advance(3 * HOUR)
  f.children.complete()
  await f.restartLead()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  assert.equal((await resumedPrompts(f)).length, 1)
  assert.equal(f.runs().wakes(runId).filter(w => w.acknowledged_at !== null).length, 1)
})

test('a child executor that fails without finishing resolves the promise as failed and wakes the lead once', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  f.children.fail()
  await new Promise(resolve => setTimeout(resolve, 20))
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.promises(runId)[0]!.outcome, 'failed')
  assert.equal(run.wakes(runId).length, 1)
  assert.match(String((await resumedPrompts(f))[0]!.text), /outcome: failed/)
  assert.deepEqual(f.notices.map(n => n.kind), ['child_start_failed'])
})

test('a child that cannot start still resolves its promise and the lead hears about it once', async t => {
  const f = await leadFixture(t)
  f.children.failStart = true
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.promises(runId)[0]!.outcome, 'failed')
  assert.equal(run.wakes(runId).length, 1)
  assert.equal((await resumedPrompts(f)).length, 1)
  assert.equal(run.get(runId).state, 'completed')
})

test('a second delegation in the same turn is refused while the first is held', async t => {
  const f = await leadFixture(t, { lead: { doubleCall: true } })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  const second = (await f.events()).find(e => e.event === 'tool_second')!
  assert.deepEqual([second.isError, second.text], [true, 'delegation_already_requested'])
  assert.equal(f.runs().promises(runId).length, 1)
  assert.equal(f.children.launches.length, 1)
})

test('a refused executor, a secret in the brief or a host that is not always-on answers the lead and never hibernates it', async t => {
  const secret = `brief_${'k'.repeat(24)}`
  for (const [name, options, expected] of [
    ['executor', { plugin: { validateExecutor: () => { throw Object.assign(new Error('no'), { code: 'executor_not_allowed' }) } } }, 'executor_not_allowed'],
    ['always-on', { alwaysOn: false }, 'no_always_on_home'],
    ['secret', { lead: { briefs: [{ ...(await import('./brief.ts')).brief(), objective: `Use ${secret}` }] } }, 'content_withheld'],
  ] as const) {
    const f = await leadFixture(t, options as never)
    f.kernel.scrubber.register('secret://lead/brief', secret)
    const { runId, first } = f.start()
    const turn = await first
    assert.equal(turn.outcome, 'completed', name)
    const answer = (await f.events()).find(e => e.event === 'tool_answer')!
    assert.deepEqual([answer.isError, answer.text], [true, expected], name)
    assert.equal(f.runs().promises(runId).length, 0, name)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_delegations').get()!.n, 0, `${name}: no intent is persisted`)
    assert.equal(f.children.launches.length, 0, name)
  }
})

test('a wake whose packet cannot be built is deferred with a notice and the lead is never prompted with anything else', async t => {
  const f = await leadFixture(t, { plugin: { packetTokens: 5 } })
  const { runId, first } = f.start()
  await first
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.deepEqual(f.notices.map(n => [n.kind, 'code' in n ? n.code : null]), [['lead_unavailable', 'wake_packet_too_large']])
  assert.equal(run.get(runId).state, 'submitted')
  assert.equal(run.wakes(runId)[0]!.acknowledged_at, null)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_wakes').get()!.n, 0, 'no half-built packet is stored')
  assert.equal((await resumedPrompts(f)).length, 0)
  assert.equal(run.attempts(runId).filter(a => ['delivered', 'started'].includes(a.state)).length, 0, 'the claimed attempt was released')
})

test('a wake that arrives while the lead is mid-turn waits: turns never overlap and each wake is acknowledged once', async t => {
  const f = await leadFixture(t, { lead: { resumeDelayMs: 300 } })
  const { runId, first } = f.start()
  await first
  const run = f.runs()
  run.signal(f.children.attempt(), 'first-flag')
  f.lead().pump()
  // The resumed turn is running (delayed inside the agent); a second signal and pumps must not start another.
  for (let i = 0; i < 200 && (await resumedPrompts(f)).length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await resumedPrompts(f)).length, 1)
  run.signal(f.children.attempt(), 'second-flag')
  f.lead().pump()
  f.lead().pump()
  assert.equal((await resumedPrompts(f)).length, 1, 'no concurrent resumed turn')
  assert.equal(run.wakes(runId)[1]!.acknowledged_at, null)
  await f.lead().idle()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.wakes(runId).length, 2)
  assert.deepEqual(run.wakes(runId).map(w => w.acknowledged_at !== null), [true, true])
  const sequence = (await f.events()).filter(e => (e.event === 'prompt' && String(e.text).includes('guanxi.wake/v1')) || (e.event === 'turn_end' && e.resumed === true)).map(e => e.event)
  assert.deepEqual(sequence, ['prompt', 'turn_end', 'prompt', 'turn_end'])
})

test('shutting the lead service down mid-turn mutates nothing: no fallback, no failure, no notice', async t => {
  const f = await leadFixture(t, { fallback: true, lead: { hang: true } })
  const { runId, first } = f.start()
  for (let i = 0; i < 400 && (await f.events()).filter(e => e.event === 'prompt').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await f.events()).filter(e => e.event === 'prompt').length, 1)
  await f.restartLead()
  assert.equal((await first).code, 'lead_closed')
  assert.equal(f.notices.length, 0)
  assert.equal((await f.events('copilot')).length, 0, 'the fallback lead was never started by a shutdown')
  assert.equal(f.db.prepare('SELECT fallback_used FROM lead_sessions WHERE run_id=?').get(runId)!.fallback_used, 0)
})

test('an absurd cost from the agent is recorded as unknown and never strands the run', async t => {
  const f = await leadFixture(t, { lead: { usagePerTurn: { inputTokens: 10, outputTokens: 5, amount: 1e300 } } })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.costs(runId), [{ currency: 'unknown', inputTokens: 20, outputTokens: 10, costMicrounits: null }])
})

test('a registered value that straddles the stored task cut never survives as a prefix', async t => {
  const f = await leadFixture(t)
  const secret = `task_secret_${'z'.repeat(30)}`
  f.kernel.scrubber.register('secret://lead/task', secret)
  const { runId, first } = f.lead().startLead({ ownerAccountId: f.owner, actorAccountId: f.owner, projectId: 'p', prompt: `${'x'.repeat(3_990)}${secret}` })
  await first
  const task = String(f.db.prepare('SELECT task FROM lead_sessions WHERE run_id=?').get(runId)!.task)
  assert.ok(!task.includes('task_'), 'neither the value nor any prefix of it')
  assert.ok(Array.from(task).length <= 4_000)
})

test('a changed lead binding is never asked to load the old agent session, on a wake or on an explicit resume', async t => {
  const f = await leadFixture(t, { fallback: true })
  const { runId, first } = f.start()
  await first
  assert.equal((await f.events('copilot')).length, 0)
  // The project now names the other agent as lead: its session cannot be loaded from the first agent's id.
  f.service().setProjectRoles(f.owner, f.owner, 'p', { lead: f.fallback! })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  const copilot = await f.events('copilot')
  assert.equal(copilot.filter(e => e.event === 'session_load_requested').length, 0)
  assert.equal(copilot.filter(e => e.event === 'session_new').length, 1)
  assert.equal(f.db.prepare('SELECT resume_mode FROM lead_wakes WHERE run_id=?').get(runId)!.resume_mode, 'seeded')
  assert.match(String((await resumedPrompts(f, 'copilot'))[0]!.text), /Lead handoff:/)
})

test('the ledger follows the agent\'s cumulative counter through a reset and a currency change without over-billing', async t => {
  const f = await leadFixture(t, { lead: { briefs: [brief(), brief({ objective: 'two' }), brief({ objective: 'three' })], redelegate: true,
    usageByTurn: [{ inputTokens: 1000, outputTokens: 300, amount: 0.5 }, { inputTokens: 300, outputTokens: 100, amount: 0.2 },
      { inputTokens: 600, outputTokens: 200, amount: 0.4, currency: 'EUR' }, { inputTokens: 900, outputTokens: 250, amount: 0.9, currency: 'EUR' }] } })
  const { runId, first } = f.start()
  await first
  for (let i = 0; i < 3; i++) {
    f.children.complete(i)
    f.lead().pump()
    await f.lead().idle()
  }
  const run = f.runs()
  assert.equal(run.get(runId).state, 'completed')
  // 1000 | reset to 300 (the counter restarted, so 300 is new) | 600 (+300) | 900 (+300) = 2200 in, 650 out... per turn deltas below.
  assert.deepEqual(run.costEntries(runId).map(e => [e.inputTokens, e.outputTokens, e.currency, e.costMicrounits]), [
    [1000, 300, 'USD', 500_000], [300, 100, 'USD', 200_000], [300, 100, 'EUR', 400_000], [300, 50, 'EUR', 500_000]])
  assert.deepEqual(run.costs(runId).sort((a, b) => a.currency.localeCompare(b.currency)), [
    { currency: 'EUR', inputTokens: 600, outputTokens: 150, costMicrounits: 900_000 }, { currency: 'USD', inputTokens: 1300, outputTokens: 400, costMicrounits: 700_000 }])
})

test('a failing cost record is noted and never blocks the turn; the next turn catches the usage up', async t => {
  const f = await leadFixture(t)
  const run = f.runs()
  const original = run.recordCost.bind(run)
  let failing = true
  t.mock.method(run, 'recordCost', (...args: Parameters<typeof original>) => { if (failing) throw new RunError('invalid_input'); return original(...args) })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'hibernated')
  assert.deepEqual(run.costEntries(runId), [])
  const notes = () => f.kernel.sessionLog!.readAll(runId, 'person').filter(e => e.type === 'agent.note').map(e => String((e.data as { text: string }).text))
  assert.ok(notes().some(text => text.includes('usage_failed')))
  failing = false
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.costs(runId), [{ currency: 'USD', inputTokens: 2000, outputTokens: 400, costMicrounits: 1_000_000 }], 'nothing was lost, nothing billed twice')
})

test('an unexpected failure while settling a turn asks a person instead of stranding a live attempt', async t => {
  const f = await leadFixture(t, { lead: { briefs: [] } })
  const run = f.runs()
  t.mock.method(run, 'complete', () => { throw Object.assign(new Error('storage'), { code: 'storage_error' }) }, { times: 1 })
  const { runId, first } = f.start()
  const turn = await first
  assert.equal(turn.outcome, 'failed')
  assert.equal(run.get(runId).state, 'input_required')
  assert.equal(run.attempts(runId).filter(a => ['delivered', 'started'].includes(a.state)).length, 0)
  assert.deepEqual(f.notices.map(n => [n.kind, 'code' in n ? n.code : null]), [['lead_failed', 'storage_error']])
})

test('a delegation that fails before it commits is abandoned, never completed later behind the lead\'s back', async t => {
  const f = await leadFixture(t)
  const run = f.runs()
  t.mock.method(run, 'delegate', () => { throw Object.assign(new Error('storage'), { code: 'storage_error' }) }, { times: 1 })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'failed')
  assert.equal(run.get(runId).state, 'input_required')
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'abandoned')
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.promises(runId).length, 0)
  assert.equal(f.children.launches.length, 0)
  await f.scenario({ briefs: [] })
  assert.equal((await f.lead().resume(runId, 'Try again without delegating')).outcome, 'completed')
  assert.equal(run.promises(runId).length, 0, 'the abandoned brief was not resurrected')
})

test('an explicit resume abandons a delegation intent the lead had only begun to request', async t => {
  const f = await leadFixture(t, { lead: { briefs: [] } })
  const run = f.runs()
  // A lead that was interrupted right after its tool call: the intent is durable, the delegation never committed.
  run.create({ id: 'lead-x' })
  f.db.prepare('INSERT INTO lead_sessions (run_id,owner_account_id,actor_account_id,project_id,session_roles,binding_digest,task) VALUES (?,?,?,?,?,?,?)')
    .run('lead-x', f.owner, f.owner, 'p', '{}', 'd', 't')
  f.db.prepare("INSERT INTO lead_delegations (lead_run_id,key,brief,deadline,on_deadline,on_cancel,state) VALUES ('lead-x','k','{}',1,'wrap_up','cancel','intent')").run()
  f.db.prepare("UPDATE durable_runs SET state='interrupted' WHERE id='lead-x'").run()
  await f.lead().resume('lead-x', 'decide afresh')
  assert.equal(f.db.prepare("SELECT state FROM lead_delegations WHERE lead_run_id='lead-x'").get()!.state, 'abandoned')
  assert.equal(run.promises('lead-x').length, 0)
})

test('a failed acknowledgement is retried: the wake is not skipped and the lead is not acknowledged by luck', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  const run = f.runs()
  const original = run.modelStarted.bind(run)
  t.mock.method(run, 'modelStarted', (...args: Parameters<typeof original>) => { throw new RunError('writer_busy') }, { times: 1 })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.wakes(runId)[0]!.acknowledged_at, null, 'a failed acknowledgement leaves the wake pending')
  assert.notEqual(run.get(runId).state, 'completed')
  f.advance(1_001)
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).filter(w => w.acknowledged_at !== null).length, 1)
})

test('a delegation R1 already committed is finished by recovery, not abandoned, when the bookkeeping after it fails', async t => {
  const f = await leadFixture(t)
  t.mock.method(LeadStore.prototype, 'setHandoff', () => { throw Object.assign(new Error('storage'), { code: 'storage_error' }) }, { times: 1 })
  const { runId, first } = f.start()
  await first
  const run = f.runs()
  assert.equal(run.promises(runId).length, 1, 'the delegation committed')
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'intent', 'not marked, but not abandoned either')
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'child_started')
  assert.equal(f.children.launches.length, 1, 'the child started exactly once')
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
})

test('the cost baseline survives a turn that reported no cost and a different currency starts afresh', async t => {
  const f = await leadFixture(t, { lead: { briefs: [brief(), brief({ objective: 'two' }), brief({ objective: 'three' })], redelegate: true,
    usageByTurn: [{ inputTokens: 100, outputTokens: 10, amount: 5 }, { inputTokens: 200, outputTokens: 20 },
      { inputTokens: 300, outputTokens: 30, amount: 8 }, { inputTokens: 400, outputTokens: 40, amount: 9 }] } })
  const { runId, first } = f.start()
  await first
  for (let i = 0; i < 3; i++) { f.children.complete(i); f.lead().pump(); await f.lead().idle() }
  const run = f.runs()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.costEntries(runId).map(e => [e.inputTokens, e.currency, e.costMicrounits]), [[100, 'USD', 5_000_000], [100, 'unknown', null], [100, 'USD', 3_000_000], [100, 'USD', 1_000_000]])
  assert.deepEqual(run.costs(runId).sort((a, b) => (a.currency < b.currency ? -1 : 1)), [
    { currency: 'USD', inputTokens: 300, outputTokens: 30, costMicrounits: 9_000_000 }, { currency: 'unknown', inputTokens: 100, outputTokens: 10, costMicrounits: null }])
})

test('a refused acknowledgement at the delegate call is answered to the lead, which keeps working', async t => {
  const f = await leadFixture(t, { lead: { silentTool: true, usagePerTurn: { inputTokens: 10, outputTokens: 5 } } })
  const run = f.runs()
  t.mock.method(run, 'modelStarted', () => { throw new RunError('writer_busy') }, { times: 1 })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'completed')
  const answer = (await f.events()).find(e => e.event === 'tool_answer')!
  assert.deepEqual([answer.isError, answer.text], [true, 'writer_busy'])
  assert.equal(run.promises(runId).length, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_delegations').get()!.n, 0)
})

test('a resumed turn that emits no update at all is acknowledged when it ends, so the wake is not looped', async t => {
  const f = await leadFixture(t, { lead: { noUpdates: true, usagePerTurn: { inputTokens: 10, outputTokens: 5 } } })
  const { runId, first } = f.start()
  await first
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.wakes(runId).map(w => [w.acknowledged_at !== null, w.deliveries]), [[true, 1]])
  assert.equal((await resumedPrompts(f)).length, 1)
})

test('when abandoning fails the run still asks a person; an explicit resume then abandons and a failed start abandons nothing', async t => {
  const f = await leadFixture(t)
  const run = f.runs()
  t.mock.method(run, 'delegate', () => { throw Object.assign(new Error('storage'), { code: 'storage_error' }) }, { times: 1 })
  t.mock.method(LeadStore.prototype, 'delegations', () => { throw Object.assign(new Error('storage'), { code: 'storage_error' }) }, { times: 1 })
  const { runId, first } = f.start()
  assert.equal((await first).outcome, 'failed')
  assert.equal(run.get(runId).state, 'input_required', 'the safety net did not depend on the abandon succeeding')
  assert.deepEqual(f.notices.map(n => n.kind), ['lead_failed'])
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'intent')
  // A resume whose attempt cannot be created abandons nothing.
  const start = t.mock.method(run, 'decide', () => { throw new RunError('writer_busy') }, { times: 1 })
  assert.throws(() => f.lead().resume(runId, 'again'), { code: 'writer_busy' })
  assert.equal(start.mock.callCount(), 1)
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'intent')
  await f.scenario({ briefs: [] })
  assert.equal((await f.lead().resume(runId, 'decide afresh')).outcome, 'completed')
  assert.equal(f.db.prepare('SELECT state FROM lead_delegations').get()!.state, 'abandoned')
})

test('a late error event on the tool listener does not take the node down', async t => {
  const server = new LeadToolServer()
  t.after(() => server.close())
  await server.url()
  const inner = (server as unknown as { server: { emit(event: string, error: Error): boolean } }).server
  assert.doesNotThrow(() => inner.emit('error', new Error('accept failure')))
})

test('an agent that echoes its MCP configuration never leaves the per-turn bearer token in the session log or the database', async t => {
  const f = await leadFixture(t, { lead: { echoConfig: true } })
  const { runId, first } = f.start()
  await first
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  assert.equal(f.runs().get(runId).state, 'completed')
  assert.equal(f.tokens.length, 2)
  let echoed = 0
  for (const session of f.kernel.sessionLog!.list().sessions) {
    for (const event of f.kernel.sessionLog!.readAll(session.sessionId, 'person')) {
      const text = JSON.stringify(event.data)
      for (const token of f.tokens) assert.ok(!text.includes(token), `${event.type} must not carry a bearer token`)
      if (event.type === 'assistant.message' && text.includes('config ')) echoed++
    }
  }
  assert.ok(echoed >= 1, 'the fixture really did echo its configuration')
  const dump = (f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(table => { try { return JSON.stringify(f.db.prepare(`SELECT * FROM "${table.name}"`).all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v)) } catch { return '' } }).join('\n')
  for (const token of f.tokens) assert.ok(!dump.includes(token))
})
