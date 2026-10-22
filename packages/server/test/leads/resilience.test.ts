import assert from 'node:assert/strict'
import { test } from 'node:test'
import { leadFixture, HOUR } from './helpers.ts'

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
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
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
  await f.scenario({ mcpHttp: true })
  f.advance(1_001)
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal(run.wakes(runId).length, 1)
  assert.equal(run.wakes(runId)[0]!.deliveries, 2)
  assert.ok(run.wakes(runId)[0]!.acknowledged_at !== null)
  assert.equal((await resumedPrompts(f)).length, 1, 'exactly one resumed turn reached the lead')
  assert.equal(f.lead().sessions()[0]!.failures, 0)
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
