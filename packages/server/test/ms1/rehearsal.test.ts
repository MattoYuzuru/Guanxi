/** MS1 local rehearsal: the shape of the north-star gate on loopback fixtures.
 *
 * A fixture ACP lead delegates a six-item plan, sleeps, and is woken once while the plan runs on the home node with
 * every model call executed and counted by a second node. It proves the COMPOSITION of LW, R1, R2, F2-d and F2-c.
 * It cannot prove real models, a real Claude Code, two real hosts, six real hours, R3/B3 quality or TLS: see
 * docs/plans/lanes/MS1-rehearsal.handoff.md for the list. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { REDACTION_MARKER_OPEN } from '../../src/egress/types.ts'
import { REMOTE_RELAY_COUNTER_SOURCE, REMOTE_RELAY_PROPS_SOURCE } from '../../src/relay/remote-runtime.ts'
import { fakeTokens } from '../fixtures/fake-llama-server.ts'
import { ConnectionJudgeModel } from '../../src/relay/judge-model.ts'
import { integrity, legalState } from './invariants.ts'
import { createWorld, HOUR, MINUTE, START, until, World, type Gap } from './world.ts'

const exec = promisify(execFile)
const num = (a: number, b: number) => a - b
const sum = (rows: Array<{ input_tokens: number }>) => rows.reduce((n, r) => n + r.input_tokens, 0)

interface GapCheck {
  cycle: number; relay: string; step: number; leadState: string; mirrorState: string; relayState: string; wakes: number; leadLedgerUnchanged: boolean
  agents: number; pins: string[]; liveLeadAttempts: number; pendingTimers: number
  /** Nothing is in flight: no pending model call in the relay ledger and no remote call that has not ended. */
  pendingCall: unknown; openRemoteCalls: number
  /** The work files in the owned checkout: i1..i<cycle>. */
  owned: string[]; relayLeaseValid: boolean; mirrorLeaseValid: boolean; legal: string | null
}

test('MS1 gate shape: a lead delegates six items, sleeps six simulated hours at zero cost, and wakes exactly once to a green clean checkout', async t => {
  const began = Date.now()
  const checks: GapCheck[] = []
  let lead = '', snapshot = '', previous = START
  const w = await createWorld(t, { items: 6, gapMs: 75 * MINUTE, leadDeadlineMs: 8 * HOUR, onGap: async (gap: Gap, world: World) => {
    const mirror = world.rows<{ child_id: string }>('SELECT child_id FROM promises WHERE parent_id=?', lead)[0]!.child_id
    // The lead hibernated before the relay's first cycle ended, so the ledger it has now is the one it went to sleep with.
    if (!snapshot) snapshot = JSON.stringify(world.costs(lead))
    const leaseValid = (id: string) => Number(world.one('SELECT expires_at FROM leases WHERE key=? AND released=0', `run:${id}/exec`)?.['expires_at'] ?? 0) > gap.now
    let legal: string | null = null
    try { world.db(legalState) } catch (error) { legal = String(error) }
    checks.push({ pendingCall: world.ledger(gap.run).pendingCall, owned: await world.ownedFiles(), legal, relayLeaseValid: leaseValid(gap.run), mirrorLeaseValid: leaseValid(mirror),
      openRemoteCalls: world.count("SELECT COUNT(*) AS n FROM durable_runs WHERE id LIKE 'rc-%' AND state NOT IN ('completed','failed','canceled')"), cycle: gap.cycle, relay: gap.run, step: gap.now - previous, leadState: world.state(lead), mirrorState: world.state(mirror), relayState: world.state(gap.run),
      wakes: world.wakes(lead).length, leadLedgerUnchanged: JSON.stringify(world.costs(lead)) === snapshot, agents: (await world.agentProcesses()).length,
      pins: world.target.db.prepare('SELECT id FROM federation_streams').all().map(row => String(row['id'])),
      liveLeadAttempts: world.count("SELECT COUNT(*) AS n FROM run_attempts WHERE run_id=? AND state IN ('delivered','started')", lead),
      pendingTimers: world.count("SELECT COUNT(*) AS n FROM timers t JOIN promises p ON p.id=t.promise_id WHERE p.parent_id=? AND t.state='pending'", lead) })
    previous = gap.now
  } })
  const home = await w.boot()

  // 1. The lead delegates a plan of six items, each with an acceptance command, within the owner's limits.
  const started = await w.startLead(home)
  lead = started.runId
  const first = (await started.first)['result']
  assert.equal(first.outcome, 'hibernated', 'the delegating turn ends in hibernation, not in an answer')
  const tool = w.agentEvents().filter(e => e.event === 'tool_call')
  assert.equal(tool.length, 1, 'one guanxi_delegate call')
  assert.ok(w.agentEvents().some(e => e.event === 'tool_list' && e['tools'].includes('guanxi_delegate')))
  assert.equal(w.agentEvents().find(e => e.event === 'session_new')!['authorized'], true, 'the tool endpoint was reached with a per-turn bearer capability')
  const delegation = w.one('SELECT * FROM lead_delegations WHERE lead_run_id=?', lead)!
  const brief = JSON.parse(delegation['brief'])
  assert.equal(brief.plan.items.length, 6)
  assert.ok(brief.plan.items.every((item: { acceptance: string[] }) => item.acceptance.length > 0), 'every item carries an acceptance command')
  assert.ok(Object.values(brief.caps).every(cap => typeof cap === 'number'), 'the lead asked for a cap on every axis')

  // 2. The lead hibernates: nothing of it is alive, and its cost totals are fixed.
  assert.equal(w.state(lead), 'waiting_children')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE run_id=? AND state IN ('delivered','started')", lead), 0, 'no live attempt')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM leases WHERE key=? AND released=0", `run:${lead}/exec`), 0, 'no execution lease')
  assert.deepEqual(await w.agentProcesses(), [], 'no lead process')
  const delegating = [...new Set(w.agentEvents().map(e => e['pid'] as number))]
  assert.equal(delegating.length, 1, 'the delegating turn ran in one agent process')
  assert.ok(!World.alive(delegating[0]!), 'and that process is gone')
  const leadRows = w.costs(lead)
  assert.equal(leadRows.length, 1, 'the delegating turn was billed once')
  snapshot ||= JSON.stringify(leadRows)
  assert.equal(snapshot, JSON.stringify(leadRows))

  // 3-6. The plan runs, the clock advances across the cycles, and the lead wakes once with its ledger untouched.
  await until(() => w.wakePrompts().length === 1, 'the lead to be woken', 300_000)
  // Positive control for every "no lead process" above: while the resumed turn runs, the same check finds it.
  assert.ok((await w.agentProcesses()).length >= 1, 'the process check can see a live lead agent')
  assert.equal(JSON.stringify(w.costs(lead)), snapshot, 'MS1 cost ledger: the lead\'s totals at the wake are exactly the totals at the delegate')
  await until(() => w.state(lead) === 'completed', 'the resumed lead to finish', 120_000)
  await until(() => [...new Set(w.agentEvents().map(e => e['pid'] as number))].every(pid => !World.alive(pid)), 'every lead agent process to be gone', 30_000)

  assert.equal(w.relayStarts().length, 1, 'one relay start for one delegation')
  const { run_id: relay, status } = w.relayStarts()[0]!
  assert.equal(status, 'completed')
  const ledger = w.ledger(relay)

  // 4. Every item is green, in the relay's own gates and again in a clean checkout.
  assert.deepEqual(Object.entries(ledger.items).sort(), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map(id => [id, 'done']))
  for (const item of ledger.plan.items) {
    assert.ok(ledger.evidence.some((e: { item: string; ok: boolean; head: string }) => e.item === item.id && e.ok && e.head === ledger.head), `${item.id} passed its gate at the final head`)
  }
  const clean = await w.cleanCheckout(relay)
  assert.equal(clean.head, clean.ledgerHead, 'the clean checkout is at the head the relay finished at')
  assert.deepEqual(clean.results.map(r => r.code), [0, 0, 0, 0, 0, 0], 'every acceptance command is green in a clean checkout')
  assert.ok(clean.control.every(r => r.code !== 0), 'the same commands fail without the work, so the check above is not vacuous')
  assert.deepEqual(readdirSync(w.checkouts), [], 'the owned checkout is gone')
  assert.deepEqual(await w.projectUntouched(), { status: '', head: w.base }, 'the project was only read: the model\'s work never touched it')

  // 3. Inference ran on the second node through F2-d: signed pin, observe, count, dispatch.
  const pins = w.requests.filter(r => r.startsWith('/attempts/runtime/pin'))
  assert.deepEqual(pins, ['/attempts/runtime/pin:pin', '/attempts/runtime/pin:unpin'], 'the relay run was pinned by a signed message and unpinned at the end')
  assert.deepEqual(w.target.db.prepare('SELECT id FROM federation_streams').all(), [], 'no pin is left on the executor')
  const posts = await w.fake.requests('/completion')
  assert.ok(posts.length >= 30, `a six-item plan makes many model calls (${posts.length})`)
  assert.equal(w.requests.filter(r => r === '/attempts/dispatch').length, posts.length, 'one grant per completion')
  assert.ok(w.requests.filter(r => r === '/attempts/runtime/observe').length > posts.length, 'every call and every cycle observes the loaded window')
  assert.ok(w.requests.filter(r => r === '/attempts/runtime/count').length >= posts.length, 'every dispatched string was counted by the executor first')
  assert.equal((await w.fake.requests('/props')).length > 0 && (await w.fake.requests('/tokenize')).length >= posts.length, true)
  const start = w.one('SELECT runtime,policy FROM relay_public_starts WHERE run_id=?', relay)!
  const admitted = JSON.parse(start['runtime'])
  assert.equal(admitted.runtime.source, REMOTE_RELAY_PROPS_SOURCE, 'the loaded window came from the executor')
  assert.equal(admitted.runtime.contextTokens, 16000)
  assert.equal(admitted.meter.source, REMOTE_RELAY_COUNTER_SOURCE); assert.equal(admitted.meter.measurement, 'exact_rendered_request')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE run_id=? AND state IN ('delivered','started')", relay), 0)

  // 3. Remote token usage is in the child ledgers (F2-c), exactly the tokens the executor evaluated.
  const children = w.rows<{ id: string; state: string }>("SELECT id,state FROM durable_runs WHERE id LIKE 'rc-%'")
  assert.equal(children.length, posts.length, 'one child run per remote call')
  assert.ok(children.every(child => child.state === 'completed'))
  const childRows = children.flatMap(child => w.costs(child.id)) as Array<{ entry_key: string; input_tokens: number }>
  assert.equal(childRows.length, children.length, 'exactly one cost row per remote call')
  assert.ok(childRows.every(row => row.entry_key.startsWith('remote-dispatch:')))
  assert.deepEqual(childRows.map(row => row.input_tokens).sort(num), posts.map(post => fakeTokens(post.body.prompt, true)).sort(num), 'the ledgers hold the evaluated counts, call for call')
  const relayRows = w.costs(relay) as Array<{ entry_key: string; input_tokens: number }>
  assert.ok(relayRows.every(row => !row.entry_key.startsWith('remote-dispatch:')))
  assert.equal(sum(relayRows), sum(childRows), 'the relay run\'s cap accounting and the executor reports agree (and are never summed together)')

  // 5. Six simulated hours passed in cycles; hardly any real time did.
  assert.equal(checks.length, 5, 'a gap before each of cycles 2 to 6')
  assert.deepEqual(checks.map(check => check.cycle), [1, 2, 3, 4, 5])
  assert.ok(checks.every(check => check.step === 75 * MINUTE), 'the injected clock moved by exactly one gap each time')
  assert.ok(w.now - START >= 6 * HOUR, `simulated ${(w.now - START) / HOUR} h`)
  const real = Date.now() - began
  t.diagnostic(`simulated ${(w.now - START) / HOUR} h in ${(real / 1000).toFixed(1)} s of real time, ${posts.length} model calls`)
  assert.ok(real < 30 * 60_000, 'the rehearsal did not wait for hours in real time')
  for (const check of checks) {
    assert.equal(check.leadState, 'waiting_children', `cycle ${check.cycle}: the lead sleeps`)
    assert.equal(check.wakes, 0, `cycle ${check.cycle}: nobody woke it`)
    assert.equal(check.leadLedgerUnchanged, true, `cycle ${check.cycle}: its ledger did not move`)
    assert.equal(check.agents, 0, `cycle ${check.cycle}: no lead process`)
    assert.equal(check.liveLeadAttempts, 0)
    assert.equal(check.pendingTimers, 1, `cycle ${check.cycle}: the 8 h deadline is still pending, not fired`)
    assert.equal(check.mirrorState, 'working'); assert.equal(check.relayState, 'working')
    assert.equal(check.pendingCall, null, `cycle ${check.cycle}: the clock moved with no model call in flight`)
    assert.equal(check.openRemoteCalls, 0)
    assert.deepEqual(check.owned, Array.from({ length: check.cycle }, (_, i) => `ms1-i${i + 1}.txt`), `cycle ${check.cycle}: the model's files are in the owned checkout`)
    assert.ok(check.relayLeaseValid && check.mirrorLeaseValid, `cycle ${check.cycle}: both leases outlive the jump`)
    assert.equal(check.legal, null, `cycle ${check.cycle}: the cross-table invariants hold`)
    assert.deepEqual(check.pins, [`relay:${check.relay}`], 'exactly the relay run is pinned on the executor while it works')
  }

  // 6. Exactly one wake, a scrubbed bounded packet, and the lead billed only for its own turns.
  assert.deepEqual(w.wakes(lead).map(wake => [wake.kind, wake.acknowledged_at !== null, wake.suppressed_at]), [['resolution', true, null]])
  assert.equal(w.count('SELECT COUNT(*) AS n FROM lead_wakes WHERE run_id=?', lead), 1)
  assert.equal(w.count("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND type='agent.note' AND payload LIKE '%wake_packet%'", lead), 1, 'the packet was built once')
  assert.equal(w.wakePrompts().length, 1, 'the agent was prompted with the wake once')
  assert.equal(w.agentEvents().filter(e => e.event === 'turn_end').length, 2, 'the delegating turn and the resumed turn, nothing else')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND type='run.lifecycle' AND payload LIKE '%\"action\":\"resolved\"%'", lead), 1)
  const after = w.costs(lead)
  assert.equal(after.length, 2, 'the lead\'s ledger gained exactly its resumed turn')
  assert.deepEqual(after.slice(0, 1), JSON.parse(snapshot))
  assert.ok(after.every(row => String(row['entry_key']).startsWith('lead-turn:')), 'no relay or remote tokens reached the lead')
  assert.equal(after.reduce((n, row) => n + Number(row['input_tokens']), 0), 2000)
  assert.equal(w.one('SELECT outcome FROM promises WHERE parent_id=?', lead)!['outcome'], 'completed', 'resolved by the plan finishing, not by the lead\'s 8 h deadline')
  const packetRow = w.one('SELECT packet FROM lead_wakes WHERE run_id=?', lead)!['packet'] as string
  const packet = JSON.parse(packetRow)
  assert.equal(packet.format, 'guanxi.wake/v1'); assert.equal(packet.kind, 'resolution'); assert.equal(packet.outcome, 'completed')
  assert.deepEqual(packet.items, ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'].map(id => ({ id, title: `artifact ${id}`, status: 'done' })), 'each item appears once, done')
  assert.deepEqual(packet.gates.map((gate: { item: string }) => gate.item).sort(), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'])
  assert.ok(packet.gates.every((gate: { ok: boolean; head: string }) => gate.ok && ledger.head.startsWith(gate.head.replace(/…$/, ''))), 'every gate is for the final head (the packet shortens it)')
  assert.ok(ledger.head.startsWith(String(packet.head).replace(/…$/, ''))); assert.equal(packet.handoff.ref, `relay:${relay}`)
  assert.ok(Math.ceil(Buffer.byteLength(packetRow) / 3) <= 4000, 'the packet fits its token budget')
  assert.deepEqual(packet.metrics, { cycles: 6, tokens: relayRows.reduce((n, row) => n + row.input_tokens + (row as unknown as { output_tokens: number }).output_tokens, 0), moneyMicros: 0 }, 'the packet reports the relay run\'s own accounting')
  assert.deepEqual(packet.child.costs, [], 'the lead\'s promise child is a mirror and holds no tokens')
  for (const forbidden of [w.dir, w.project, 'Bearer ', 'PRIVATE_REASONING_FIXTURE', 'model.gguf', 'sandbox-worker'])
    assert.ok(!packetRow.includes(forbidden), `the packet carries no ${forbidden}`)
  const text = String(w.wakePrompts()[0]!['text'])
  for (const id of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']) assert.equal(text.split(`- ${id} [done]`).length - 1, 1, `${id} is listed once in the prompt the lead read`)

  // The registered canary was printed by a gate (the redaction marker is the proof it flowed) and appears nowhere at rest or on any wire we can see.
  assert.match(JSON.stringify(ledger.evidence.filter((e: { item: string }) => e.item === 'i1')), new RegExp(REDACTION_MARKER_OPEN.replace(/[[\]\\^$.*+?()|{}]/g, '\\$&')), 'the gate printed the canary and the scrubber redacted it')
  assert.ok(!packetRow.includes(w.canary) && !text.includes(w.canary), 'the canary is in neither the packet nor the prompt')
  assert.ok(!JSON.stringify(posts).includes(w.canary), 'nor in any prompt the executor evaluated')
  await assert.rejects(exec('/usr/bin/grep', ['-rlF', w.canary, w.homeDir]), (error: { code?: number }) => error.code === 1, 'nor in any file of the home node (database, WAL, agent logs)')

  // Recorded blocker, asserted so that it cannot close silently: no judge looked at this remote relay (see the judge test below).
  const relaySession = String(w.one('SELECT session_id FROM durable_runs WHERE id=?', relay)!['session_id'])
  assert.equal(w.count("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND payload LIKE '%judge%'", relaySession), 0, 'no judge signal or verdict exists for the remote relay')

  // The end state: every run closed, nothing alive anywhere.
  for (const id of [lead, relay, w.rows<{ child_id: string }>('SELECT child_id FROM promises WHERE parent_id=?', lead)[0]!.child_id]) assert.equal(w.state(id), 'completed', id)
  assert.deepEqual(await w.agentProcesses(), [])
  assert.equal(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE state IN ('delivered','started')"), 0, 'no attempt anywhere is still live')
  assert.deepEqual(home.all('notice'), [], 'nothing needed a person')
  w.db(legalState); w.db(integrity)
  // Everything that was composed closes cleanly.
  home.send({ cmd: 'shutdown' })
  assert.equal((await Promise.race([home.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the home did not shut down')), 30_000).unref())])).code, 0)
})

// ---- Time and the owner end a delegation ---------------------------------------------------------------------------------

test('the lead\'s deadline passes in simulated hours while the relay works: it is stopped, nothing keeps running, and the lead is woken once with "deadline"', async t => {
  let lead = ''
  const w = await createWorld(t, { items: 6, gapMs: 75 * MINUTE, leadDeadlineMs: 3 * HOUR })
  const home = await w.boot()
  const started = await w.startLead(home); lead = started.runId
  await started.first
  await until(() => w.state(lead) === 'completed', 'the woken lead to finish', 240_000)
  const promise = w.one('SELECT * FROM promises WHERE parent_id=?', lead)!
  assert.equal(promise['outcome'], 'deadline', 'resolved by the 3 h deadline, which the injected clock passed between two cycles')
  assert.deepEqual(w.wakes(lead).map(wake => [wake.kind, wake.acknowledged_at !== null]), [['resolution', true]])
  assert.equal(w.wakePrompts().length, 1)
  const [relay] = w.relayStarts()
  assert.equal(w.state(relay!.run_id), 'canceled', 'the relay run was told to stop (cancel after wrap-up)')
  const ledger = w.ledger(relay!.run_id)
  assert.ok(Object.values(ledger.items).some(status => status === 'done') && Object.values(ledger.items).some(status => status === 'open'), 'it stopped part-way')
  const packet = JSON.parse(w.one('SELECT packet FROM lead_wakes WHERE run_id=?', lead)!['packet'] as string)
  assert.equal(packet.outcome, 'deadline')
  assert.deepEqual(packet.items.map((item: { id: string; status: string }) => [item.id, item.status]), Object.entries(ledger.items).sort(), 'every item once, as the ledger says')
  assert.ok(w.gaps.length >= 3 && w.gaps.length < 5, `the clock stopped moving when the relay did (${w.gaps.length} gaps)`)
  const calls = await w.fake.count('/completion')
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(await w.fake.count('/completion'), calls, 'no model call after the stop')
  assert.deepEqual(w.target.db.prepare('SELECT id FROM federation_streams').all(), [], 'the executor holds no pin for the stopped run')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE state IN ('delivered','started')"), 0)
  assert.deepEqual(readdirSync(w.checkouts), [], 'the owned checkout is gone')
  assert.deepEqual(await w.agentProcesses(), [])
  w.db(legalState); w.db(integrity)
})

test('the owner cancels the lead between two relay cycles: the relay run and its pin are gone, nobody is woken, nothing keeps running', async t => {
  let lead = '', home!: Awaited<ReturnType<World['boot']>>
  const w = await createWorld(t, { items: 6, gapMs: 75 * MINUTE, onGap: gap => { if (gap.cycle === 2) home.send({ cmd: 'cancel', runId: lead }) } })
  home = await w.boot()
  const started = await w.startLead(home); lead = started.runId
  await started.first
  await home.wait('the cancel to be answered', () => home.find('canceled'), 120_000)
  await until(() => w.relayStarts()[0]?.status !== 'running', 'the relay start to settle', 60_000)
  const mirror = w.rows<{ child_id: string }>('SELECT child_id FROM promises WHERE parent_id=?', lead)[0]!.child_id
  for (const id of [lead, mirror, w.relayStarts()[0]!.run_id]) assert.equal(w.state(id), 'canceled', id)
  assert.equal(w.relayStarts()[0]!.status, 'canceled')
  assert.equal(w.wakes(lead).length, 0, 'a canceled lead is not woken')
  assert.equal(w.wakePrompts().length, 0)
  assert.deepEqual(home.all('notice'), [])
  assert.equal(w.count('SELECT COUNT(*) AS n FROM relay_seals WHERE run_id=?', w.relayStarts()[0]!.run_id), 2, 'the third cycle never sealed: the cancel landed at the second gap')
  const calls = await w.fake.count('/completion')
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(await w.fake.count('/completion'), calls, 'no model call after the cancel')
  assert.deepEqual(w.target.db.prepare('SELECT id FROM federation_streams').all(), [], 'the executor holds no pin')
  assert.equal(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE state IN ('delivered','started')"), 0)
  assert.deepEqual(readdirSync(w.checkouts), [])
  assert.deepEqual(await w.agentProcesses(), [])
  assert.equal(w.costs(lead).length, 1, 'the lead was billed only for the turn that delegated')
  w.db(legalState); w.db(integrity)
})

// ---- The owner's limits bind the lead inside the composition ------------------------------------------------------------

test('the owner\'s limits and executor allow-list bind the lead in the composed node: a refused brief hibernates nothing and starts no relay', async t => {
  const w = await createWorld(t, { items: 2 })
  const cases: Array<[string, (w: World) => ReturnType<World['brief']>, RegExp]> = [
    ['a larger money cap than the owner allows', w => w.brief({ caps: { ...w.brief().caps, moneyMicros: 5_000_000 } }), /delegation_exceeds_policy: (caps\.)?moneyMicros/],
    ['no wall cap at all', w => w.brief({ caps: { ...w.brief().caps, wallMs: null } }), /delegation_exceeds_policy: (caps\.)?wallMs/],
    ['a deadline beyond the owner\'s', w => w.brief({ deadlineMs: 100 * HOUR }), /delegation_exceeds_policy: deadlineMs/],
    ['detaching from the run', w => w.brief({ onCancel: 'detach' }), /delegation_exceeds_policy: onCancel/],
    ['an executor the owner never allowed', w => w.brief({ executor: { connectionId: w.executorConnection, model: 'some-other-model' } }), /executor_not_allowed/],
  ]
  const home = await w.boot({ briefs: world => cases.map(([, make]) => make(world)) })
  for (const [index, [what, , expected]] of cases.entries()) {
    const { runId, first } = await w.startLead(home, `refused delegation ${index}`)
    // Each lead's first turn ends by itself: the tool answered with an error and nothing was stopped.
    await until(() => w.state(runId) === 'completed', `lead ${index} to finish`, 60_000)
    const answer = w.agentEvents().filter(e => e.event === 'tool_answer')[index]!
    assert.equal(answer['isError'], true, what)
    assert.match(String(answer['text']), expected, what)
    assert.equal(w.count('SELECT COUNT(*) AS n FROM promises WHERE parent_id=?', runId), 0, `${what}: nothing was delegated`)
    void first.catch(() => undefined)
  }
  assert.deepEqual(w.relayStarts(), [], 'no relay start')
  assert.equal(await w.fake.count('/completion'), 0, 'no inference')
  assert.deepEqual(w.requests, [], 'the executor was never contacted')
  assert.equal(w.count('SELECT COUNT(*) AS n FROM lead_delegations'), 0)
})

// ---- The recorded MS1 blocker: the R3 judge cannot observe a remote relay ------------------------------------------------

test('recorded MS1 blocker: the R3 judge model refuses the meter of a remote or llama-server relay, and the public relay start has no judge seam', () => {
  // This is the shape of the executor's meter in every test above: it carries the transport that counted, and an async count.
  const remoteMeter = { countIsExact: true, localOnly: true, transport: { id: 'llama-server', host: 'federation://ms1-executor' }, countAsync: async () => 1,
    count: () => 1, observe: async () => ({}) }
  assert.throws(() => new ConnectionJudgeModel({} as never, 'local', remoteMeter as never, {} as never, async () => null, 1000), /judge_config_invalid/,
    'if this stops throwing, the judge can observe a remote relay: wire it into RelayStarts, run the rehearsal with it, and remove this blocker from the MS1 hand-off')
  const local = { countIsExact: true, localOnly: true, count: () => 1, observe: async () => ({}) }
  assert.doesNotThrow(() => new ConnectionJudgeModel({} as never, 'local', local as never, {} as never, async () => null, 1000), 'a local Ollama meter is accepted, so the refusal above is about the remote seam')
})

// ---- 7. A SIGKILL at 15 named home-side boundaries, then recovery from disk ------------------------------------------------

interface Crash {
  name: string
  /** The named durable boundary of the home process; `nth` counts occurrences. */
  label: string
  nth: number
  /** `completes`: recovery re-runs the whole plan to green. `fails`: the relay run was lost with the process (it never resumes
   * inference), so the lead is woken once with a failed outcome and the ledger as it stood. */
  recovery: 'completes' | 'fails'
  /** Items done in the relay ledger when the plan could not finish. */
  done?: string[]
  /** `resume`: the wake was acknowledged before the kill, so the node never replays the turn and a person continues it once. */
  resume?: boolean
  /** The lead's wake turn is allowed to START twice (killed before its acknowledgement) but completes once. */
  restarted?: boolean
  /** The executor pinned a relay run that died with the home (F2-d residual 3). Since F2-reap the restarted home releases it by a
   * signed, fenced unpin: the expectation after recovery is zero pins and an empty journal, and the live run's pin is never confused. */
  stalePin?: boolean
  /** What the disk says at the instant of the kill: proof that the process died on the boundary the name claims. */
  atKill(w: World, lead: string): void | Promise<void>
}
const pinsOf = (w: World) => w.target.db.prepare('SELECT id FROM federation_streams').all().map(row => String(row['id']))
const remoteChildren = (w: World) => w.rows<{ id: string; state: string }>("SELECT id,state FROM durable_runs WHERE id LIKE 'rc-%' ORDER BY created_at, id")
const relayOf = (w: World) => w.relayStarts()[0]
const ITEMS = ['i1', 'i2', 'i3']
const crashes: Crash[] = [
  { name: 'delegate, before the promise commits', label: 'hibernate:before_commit', nth: 1, recovery: 'completes',
    atKill(w, lead) {
      assert.equal(w.count('SELECT COUNT(*) AS n FROM promises WHERE parent_id=?', lead), 0, 'no promise yet')
      assert.equal(w.one('SELECT state FROM lead_delegations WHERE lead_run_id=?', lead)?.['state'], 'intent', 'the lead\'s decision is durable')
    } },
  { name: 'delegate, promise committed', label: 'lead:delegate:committed', nth: 1, recovery: 'completes',
    atKill(w, lead) {
      assert.equal(w.count('SELECT COUNT(*) AS n FROM promises WHERE parent_id=?', lead), 1)
      assert.equal(w.one('SELECT state FROM lead_delegations WHERE lead_run_id=?', lead)?.['state'], 'intent', 'committed but not yet marked, and no child started')
      assert.equal(relayOf(w), undefined)
    } },
  { name: 'relay start, before the run exists', label: 'create_started:before_commit', nth: 2, recovery: 'completes', stalePin: true,
    atKill(w) { assert.equal(relayOf(w), undefined, 'no relay run'); assert.equal(pinsOf(w).length, 1, 'but the executor already pinned it') } },
  { name: 'relay start, run committed', label: 'create_started:committed', nth: 2, recovery: 'fails', done: [], stalePin: true,
    async atKill(w) {
      assert.equal(relayOf(w)?.status, 'running'); assert.equal(await w.fake.count('/completion'), 0, 'no inference yet')
      assert.deepEqual(Object.values(w.ledger(relayOf(w)!.run_id).items), ['open', 'open', 'open'])
    } },
  { name: 'remote pin acknowledged', label: 'net:pin:acked', nth: 1, recovery: 'completes', stalePin: true,
    atKill(w) { assert.equal(relayOf(w), undefined, 'the home has no run'); assert.equal(pinsOf(w).length, 1, 'the executor acknowledged the pin') } },
  { name: 'between relay cycles', label: 'gap:2', nth: 1, recovery: 'fails', done: ['i1', 'i2'], stalePin: true,
    async atKill(w) {
      const relay = relayOf(w)!
      assert.equal(w.count('SELECT COUNT(*) AS n FROM relay_seals WHERE run_id=?', relay.run_id), 2, 'two cycles sealed')
      assert.equal(w.ledger(relay.run_id).pendingCall, null, 'no call in flight'); assert.equal(w.state(relay.run_id), 'working')
      assert.ok(remoteChildren(w).every(child => child.state === 'completed'))
    } },
  { name: 'terminal ingest, before it commits', label: 'net:terminal:before_ingest', nth: 7, recovery: 'fails', done: ['i1'], stalePin: true,
    atKill(w) {
      const children = remoteChildren(w)
      assert.equal(children.length, 7); assert.equal(children.filter(child => child.state === 'completed').length, 6)
      const open = children.find(child => child.state !== 'completed')!
      assert.equal(w.costs(open.id).length, 0, 'the answer the executor evaluated is not on the home\'s books')
    } },
  { name: 'terminal ingest, committed but unanswered', label: 'net:terminal:after_ingest', nth: 7, recovery: 'fails', done: ['i1'], stalePin: true,
    atKill(w) {
      const children = remoteChildren(w)
      assert.equal(children.length, 7); assert.ok(children.every(child => child.state === 'completed'))
      assert.equal(children.flatMap(child => w.costs(child.id)).length, 7, 'the child ledgers have all seven')
      // The answer reached the relay run too (it was waiting in the same process), but through a different ledger and a different transaction.
      assert.ok([6, 7].includes(w.costs(relayOf(w)!.run_id).length), 'the relay run keeps its own accounting')
    } },
  // Inside the one transaction that records the receipt, the usage and the completion of a remote call (F2-c). Before the first lead,
  // mirror or relay run ends, the only R1 `complete` operations are those of the per-call child runs, so #7 is the seventh remote call.
  { name: 'terminal ingest, inside the transaction', label: 'complete:before_commit', nth: 7, recovery: 'fails', done: ['i1'], stalePin: true,
    atKill(w) {
      const children = remoteChildren(w)
      assert.equal(children.length, 7); assert.equal(children.filter(child => child.state === 'completed').length, 6, 'the seventh completion rolled back')
      assert.equal(children.flatMap(child => w.costs(child.id)).length, 6, 'and took its usage row with it')
    } },
  { name: 'terminal ingest, just after the transaction', label: 'complete:committed', nth: 7, recovery: 'fails', done: ['i1'], stalePin: true,
    atKill(w) {
      const children = remoteChildren(w)
      assert.equal(children.length, 7); assert.ok(children.every(child => child.state === 'completed'))
      assert.equal(children.flatMap(child => w.costs(child.id)).length, 7, 'completion and usage landed together')
      assert.equal(w.costs(relayOf(w)!.run_id).length, 6, 'the relay run had not yet heard of it: the two ledgers are separate views and are never summed')
    } },
  { name: 'relay finished, mirror not yet ended', label: 'mirror:complete:completed:before', nth: 1, recovery: 'completes',
    atKill(w, lead) {
      assert.equal(relayOf(w)?.status, 'completed')
      assert.equal(w.state(w.rows<{ child_id: string }>('SELECT child_id FROM promises WHERE parent_id=?', lead)[0]!.child_id), 'working', 'the lead\'s promise is still open')
      assert.equal(w.wakes(lead).length, 0)
    } },
  { name: 'wake delivery, claimed', label: 'lead:wake:claimed', nth: 1, recovery: 'completes',
    atKill(w, lead) { assert.equal(w.wakes(lead).length, 1); assert.equal(w.wakes(lead)[0]!.acknowledged_at, null); assert.equal(w.count('SELECT COUNT(*) AS n FROM lead_wakes WHERE run_id=?', lead), 0, 'no packet yet') } },
  { name: 'wake delivery, packet stored', label: 'lead:wake:packet_built', nth: 1, recovery: 'completes',
    atKill(w, lead) { assert.equal(w.count('SELECT COUNT(*) AS n FROM lead_wakes WHERE run_id=?', lead), 1); assert.equal(w.wakes(lead)[0]!.acknowledged_at, null); assert.equal(w.wakePrompts().length, 0, 'the lead has not been told') } },
  { name: 'ack, agent running before it', label: 'lead:turn:before_ack', nth: 2, recovery: 'completes', restarted: true,
    atKill(w, lead) {
      assert.equal(w.wakes(lead)[0]!.acknowledged_at, null); assert.equal(w.wakePrompts().length, 1, 'the lead was prompted')
      assert.equal(w.one('SELECT first_model_at FROM run_attempts WHERE id=?', String(w.wakes(lead)[0]!.attempt_id))?.['first_model_at'], null, 'no model start observed yet')
    } },
  { name: 'ack, committed and agent running', label: 'lead:turn:acked', nth: 2, recovery: 'completes', resume: true,
    atKill(w, lead) { assert.notEqual(w.wakes(lead)[0]!.acknowledged_at, null); assert.equal(w.wakePrompts().length, 1) } },
]

for (const crash of crashes) {
  test(`crash at ${crash.name} (${crash.label}): SIGKILL, restart on the same data, exactly one wake and every item outcome once`, async t => {
    const w = await createWorld(t, { items: ITEMS.length, gapMs: 75 * MINUTE })
    const dying = await w.boot({ crash: { label: crash.label, nth: crash.nth } })
    const started = await w.startLead(dying).catch(() => ({ runId: '', first: Promise.resolve({}) }))
    void started.first.catch(() => undefined)
    const killed = await Promise.race([dying.exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the home never reached ${crash.label} #${crash.nth}\n${dying.stderr.join('').slice(-1500)}`)), 300_000).unref())])
    assert.equal(killed.signal, 'SIGKILL', `the process died at ${crash.label}`)
    const lead = w.one("SELECT run_id FROM lead_sessions")?.['run_id'] as string | undefined ?? started.runId
    assert.ok(lead, 'the lead run was committed before the kill')
    const before = { wakeRows: w.rows('SELECT packet,packet_hash FROM lead_wakes WHERE run_id=?', lead), leadCosts: JSON.stringify(w.costs(lead)) }
    w.db(legalState)
    await crash.atKill(w, lead)
    const pinsAtKill = pinsOf(w).length

    const home = await w.boot({ restart: true })
    if (crash.resume) {
      await until(() => w.state(lead) === 'interrupted', 'the lead to be reported interrupted', 300_000)
      assert.equal(w.wakePrompts().length, 1, 'an acknowledged wake is never delivered again by the node')
      await new Promise(resolve => setTimeout(resolve, 1500))
      assert.equal(w.wakePrompts().length, 1)
      home.send({ cmd: 'resume', runId: lead, prompt: 'continue the lead' })
      await home.wait('the explicit resume', () => home.find('resumed'))
    }
    await until(() => w.state(lead) === 'completed', 'the lead to finish after recovery', 300_000)
    assert.equal(home.find('fatal'), undefined)

    // Exactly one wake, acknowledged once, built once and never changed.
    const wakes = w.wakes(lead)
    assert.deepEqual(wakes.map(wake => [wake.kind, wake.acknowledged_at !== null]), [['resolution', true]], 'exactly one wake, acknowledged')
    const stored = w.rows('SELECT packet,packet_hash FROM lead_wakes WHERE run_id=?', lead)
    assert.equal(stored.length, 1)
    if (before.wakeRows.length) assert.deepEqual(stored, before.wakeRows, 'a packet stored before the kill is delivered unchanged')
    assert.equal(w.count("SELECT COUNT(*) AS n FROM session_events WHERE session_id=? AND type='agent.note' AND payload LIKE '%wake_packet%'", lead), 1, 'the packet was built once')
    assert.equal(w.count('SELECT COUNT(*) AS n FROM promises WHERE parent_id=?', lead), 1, 'one delegation')
    assert.equal(w.count('SELECT COUNT(*) AS n FROM durable_runs WHERE parent_id=?', lead), 1, 'one mirror child')
    const prompts = w.wakePrompts().length
    assert.ok(prompts >= 1 && prompts <= (crash.restarted ? 2 : 1), `${prompts} wake prompts`)
    assert.equal(new Set(w.wakePrompts().map(e => String(e['text']))).size, 1, 'a redelivered wake carries the same packet')
    const wakeEnds = w.agentEvents().filter(e => e.event === 'turn_end' && e['resumed'] === true).length
    assert.ok(wakeEnds <= 1, 'the wake turn completed at most once')

    // Every item outcome once, and the same as the relay ledger says.
    const packet = JSON.parse(stored[0]!['packet'] as string)
    assert.deepEqual(packet.items.map((item: { id: string }) => item.id), ITEMS, 'every plan item exactly once')
    const starts = w.relayStarts()
    assert.ok(starts.length <= 1, 'one relay start per delegation')
    const relay = starts[0]
    const statusOf = (id: string) => crash.recovery === 'completes' ? 'done' : (crash.done ?? []).includes(id) ? 'done' : 'open'
    assert.deepEqual(packet.items.map((item: { status: string }) => item.status), ITEMS.map(statusOf), 'item outcomes')
    if (relay) assert.deepEqual(packet.items.map((item: { id: string; status: string }) => [item.id, item.status]), Object.entries(w.ledger(relay.run_id).items).sort(), 'the packet says what the ledger says')
    assert.equal(packet.outcome, crash.recovery === 'completes' ? 'completed' : 'failed')
    assert.equal(new Set(packet.gates.map((gate: { item: string }) => gate.item)).size, packet.gates.length, 'one gate result per item')
    if (crash.recovery === 'completes') {
      assert.equal(relay?.status, 'completed')
      assert.ok(packet.gates.length === ITEMS.length && packet.gates.every((gate: { ok: boolean }) => gate.ok))
      const clean = await w.cleanCheckout(relay!.run_id)
      assert.deepEqual(clean.results.map(r => r.code), ITEMS.map(() => 0), 'green in a clean checkout after recovery')
      assert.equal(clean.head, clean.ledgerHead)
    } else {
      assert.equal(w.state(relay!.run_id), 'interrupted', 'a relay run lost with its process is interrupted, never completed')
      assert.ok(w.count("SELECT COUNT(*) AS n FROM run_attempts WHERE state IN ('delivered','started')") === 0)
    }

    // Costs: the lead pays for its own turns only, once each; remote calls are billed to their child exactly once.
    const leadRows = w.costs(lead)
    assert.ok(leadRows.every(row => String(row['entry_key']).startsWith('lead-turn:')), 'no relay or remote tokens reached the lead')
    assert.ok(JSON.stringify(leadRows).startsWith(before.leadCosts.slice(0, -1)), 'what the lead had been billed before the kill is unchanged')
    // Executor (F2-reap): the pin of a run that died with the home was released by the restarted home's reconciliation, whether or not a
    // relay run row existed. Had the live (re-started) run's pin been confused with it, that run could not have finished above.
    if (crash.stalePin) assert.equal(pinsAtKill, 1, 'the kill left exactly one stale pin on the executor')
    await until(() => w.target.db.prepare('SELECT id FROM federation_streams').all().length === 0, 'the restarted home to release every pin it journaled', 60_000)
    const pins = w.target.db.prepare('SELECT id FROM federation_streams').all().map(row => String(row['id']))
    assert.deepEqual(pins, [], `no stale pin after restart and reconciliation: ${pins}`)
    assert.equal(w.count('SELECT COUNT(*) AS n FROM federation_relay_pin_journal'), 0, 'and the home\'s journal is empty')
    assert.equal(w.target.db.prepare('SELECT COUNT(*) n FROM federation_relay_pin_leases').get()!['n'], 0, 'with no orphan lease row')

    assert.deepEqual(await w.agentProcesses(), [], 'no agent process survives recovery')
    w.db(legalState); w.db(integrity)
    t.diagnostic(`outcome=${packet.outcome} items=${packet.items.map((item: { status: string }) => item.status).join(',')} relay=${relay?.status ?? 'none'} wakePrompts=${prompts} pins=${pins.length} atKill=${pinsAtKill} sim=${(w.now - START) / HOUR}h`)
  })
}
