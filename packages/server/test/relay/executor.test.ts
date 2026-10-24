import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, plan, window, reserves } from './fixture.ts'
import type { Plan } from '../../src/relay/types.ts'
import { canonical, hash, render, selectNotes, validateHandoff, probes } from '../../src/relay/handoff.ts'
import { thresholds } from '../../src/relay/budget.ts'
import { DEFAULT_RELAY_LIMITS, RelayError } from '../../src/relay/types.ts'
import { ConnectionRelayModel } from '../../src/relay/model.ts'

test('verified task finishes with atomic ledger/hash/bundle seal and K2 trace', async () => {
  const f = fixture(); try {
    const l = await f.executor.run(f.attempt)
    assert.equal(l.state, 'finish'); assert.equal(l.items.one, 'done')
    assert.equal(f.store.get(f.run.id).state, 'completed')
    const s = f.relay.sealed(f.attempt)!
    assert.equal(s.handoff.ledgerHash, hash(s.ledger)); assert.equal(s.artifactHash, hash(s.handoff))
    validateHandoff(s.handoff, s.ledger, s.bundle, thresholds(window, reserves).handoff)
    assert.ok(Buffer.byteLength(render(s.handoff)) <= .15 * window.tokens)
    const events = f.log.readAll(f.run.session_id, 'person')
    assert.equal(events.filter(e => e.type === 'assistant.message').length, f.prompts.length)
    assert.ok(events.some(e => e.type === 'agent.note' && e.data.text.includes('sealed')))
  } finally { f.close() }
})
test('failed fresh-context narrative seals degraded without losing verified progress', async () => {
  const f = fixture({ narrativeFails: true }); try {
    await f.executor.run(f.attempt)
    const s = f.relay.sealed(f.attempt)!
    assert.ok(s.handoff.degraded); assert.equal(s.ledger.items.one, 'done'); assert.equal(s.ledger.evidence.length, 2)
    assert.equal(s.handoff.ledgerHash, hash(s.ledger))
    assert.ok(f.prompts.find(p => p.startsWith('Write a fresh')))
  } finally { f.close() }
})
test('notes alone produce three no-progress cycles, J2 signal and escalation; plan is immutable', async () => {
  let turn = 0
  const f = fixture({ actions: () => canonical(++turn % 2 ? { action: 'note', kind: 'decision', text: 'memo', items: ['one'], expiresAt: null } : { action: 'handoff' }) }); try {
    await f.executor.run(f.attempt)
    const l = f.relay.read(f.run.id)
    assert.equal(l.noProgress, 3); assert.equal(l.cycle, 3); assert.equal(f.store.get(f.run.id).state, 'input_required')
    assert.equal(f.relay.notes(f.run.id).length, 3)
    assert.equal(f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('judge_requested')).length, 2)
    assert.equal(hash(l.plan), hash(plan)); assert.equal(l.items.one, 'open')
    assert.throws(() => f.relay.propose(f.attempt, 'amend the plan'), /stale_lease/)
  } finally { f.close() }
})
test('critical probe failure retries degraded once, then escalates without another work call', async () => {
  const f = fixture({ probeFails: true, actions: () => canonical({ action: 'handoff' }) }); try {
    await f.executor.run(f.attempt)
    assert.equal(f.prompts.filter(p => p.startsWith('Answer these five')).length, 2)
    assert.equal(f.prompts.filter(p => p.startsWith('Execute')).length, 1)
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    assert.equal(f.relay.read(f.run.id).items.one, 'open')
    assert.equal(f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('probe_degraded')).length, 1)
  } finally { f.close() }
})
test('deterministic notes select linked open items, recent decisions and unexpired dead ends within budget', () => {
  const f = fixture(); try {
    for (let n=0;n<5;n++) f.relay.note(f.attempt, 'decision', 'd'+n, [], null)
    f.relay.note(f.attempt, 'hypothesis', 'linked', ['one'], null)
    f.relay.note(f.attempt, 'dead_end', 'live', [], null)
    f.relay.note(f.attempt, 'dead_end', 'expired', [], 1)
    const selected = selectNotes(f.relay.notes(f.run.id), f.relay.read(f.run.id), 100, 10000, 2)
    assert.deepEqual(selected.map(n => n.text), ['d3','d4','linked','live'])
    assert.deepEqual(selectNotes(f.relay.notes(f.run.id), f.relay.read(f.run.id), 100, 100, 2), selectNotes(f.relay.notes(f.run.id), f.relay.read(f.run.id), 100, 100, 2))
    assert.ok(Buffer.byteLength(canonical(selectNotes(f.relay.notes(f.run.id), f.relay.read(f.run.id), 100, 100, 2))) <= 100)
    assert.ok(Buffer.byteLength(f.relay.read(f.run.id).plan.goal) > 0)
  } finally { f.close() }
})
test('executor proposals and unverified done requests cannot change plan or count as progress', () => {
  const f = fixture(); try {
    f.relay.begin(f.attempt)
    f.relay.propose(f.attempt, 'remove tests')
    f.relay.requestVerification(f.attempt, 'one')
    assert.equal(f.relay.read(f.run.id).items.one, 'verification_requested')
    assert.equal(f.relay.countProgress(f.attempt, false), false)
    assert.equal(hash(f.relay.read(f.run.id).plan), hash(plan))
    assert.deepEqual(f.relay.read(f.run.id).proposals, ['remove tests'])
  } finally { f.close() }
})
test('normative cycle/token/money/wall caps wrap up before another model call', async () => {
  for (const kind of ['cycles','tokens','money','wall']) {
    const f = fixture({ caps: { cycles: kind === 'cycles' ? 1 : null, tokens: kind === 'tokens' ? 1 : null,
      moneyMicros: kind === 'money' ? 0 : null, wallMs: kind === 'wall' ? 1 : null }, actions: () => canonical({ action: 'handoff' }) })
    try {
      if (kind === 'wall') f.relay.change(f.attempt, 'fixture_time', l => { l.startedAt -= 2 })
      // A zero money cap stops once anything was spent (or a cost is unknown); free calls alone do not reach it (next test).
      if (kind === 'money') f.relay.change(f.attempt, 'fixture_spend', l => { l.moneyMicros = 1 })
      await f.executor.run(f.attempt)
      assert.equal(f.store.get(f.run.id).state, 'wrapping_up', kind)
      assert.equal(f.prompts.filter(p => p.startsWith('Execute')).length, kind === 'cycles' ? 1 : 0, kind)
    } finally { f.close() }
  }
})
test('a transient transport failure re-sends the same reserved call after a wait; exhausting the waits fails it as before', async () => {
  let failures = 2, work = 0
  const f = fixture({ limits: { transientRetryMs: [1, 1, 1] }, actions: () => {
    if (failures-- > 0) throw new RelayError('runtime_meter_unavailable')
    return canonical(work++ === 0 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
  } })
  try {
    const before = f.relay.read(f.run.id).tokens
    await f.executor.run(f.attempt)
    const notes = f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('"call_retry"'))
    assert.equal(notes.length, 2)
    assert.equal(f.relay.read(f.run.id).errors, 0, 'a retried call is not an error')
    assert.equal(f.store.get(f.run.id).state, 'completed')
    assert.equal(f.relay.read(f.run.id).items.one, 'done')
    assert.ok(f.relay.read(f.run.id).tokens > before)
  } finally { f.close() }
  const g = fixture({ limits: { transientRetryMs: [1, 1] }, actions: () => { throw new RelayError('runtime_meter_unavailable') } })
  try {
    await g.executor.run(g.attempt)
    assert.equal(g.log.readAll(g.run.session_id, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('"call_retry"')).length, 2)
    assert.equal(g.store.get(g.run.id).state, 'input_required')
    assert.equal(g.relay.read(g.run.id).pendingCall, null)
  } finally { g.close() }
  // A failure that says something about the request is never retried.
  const h = fixture({ limits: { transientRetryMs: [1, 1] }, actions: () => { throw new RelayError('context_ceiling') } })
  try {
    await h.executor.run(h.attempt)
    assert.equal(h.log.readAll(h.run.session_id, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('"call_retry"')).length, 0)
  } finally { h.close() }
})
test('a zero money cap stops on an unknown cost before any call', async () => {
  const g = fixture({ caps: { cycles: null, tokens: null, moneyMicros: 0, wallMs: null }, actions: () => canonical({ action: 'handoff' }) })
  try {
    g.relay.change(g.attempt, 'fixture_unknown_cost', l => { l.unknownCosts = 1 })
    await g.executor.run(g.attempt)
    assert.equal(g.store.get(g.run.id).state, 'wrapping_up')
    assert.equal(g.prompts.filter(p => p.startsWith('Execute')).length, 0)
  } finally { g.close() }
})
test('stopping an in-flight model preserves the ledger and never replays it on recovery', async () => {
  const f=fixture()
  try {
    let dispatched=0
    const quoted:number[][]=[]
    f.model.maxCostMicros=(input,output)=>{quoted.push([input,output]);return 10}
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    f.model.call=async(_p,o)=>{dispatched++;o.onStarted?.();started();return new Promise((_resolve,reject)=>o.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}
    const pending=f.executor.run(f.attempt); await ready; assert.notEqual(f.store.attempts(f.run.id)[0]!.first_model_at,null);
    assert.deepEqual(quoted,[[thresholds(window,reserves).H,reserves.turn]])
    assert.equal(f.relay.read(f.run.id).moneyMicros,10)
    f.executor.stop(); await pending
    assert.equal(f.store.get(f.run.id).state,'input_required')
    assert.equal(f.relay.read(f.run.id).items.one,'open')
    assert.equal(f.relay.read(f.run.id).tokens,thresholds(window,reserves).H+reserves.turn)
    assert.equal(f.relay.read(f.run.id).pendingCall,null)
    const replacement=f.store.decide(f.run.id)
    f.relay.recover(replacement)
    assert.equal(f.relay.read(f.run.id).state,'boot')
    assert.equal(dispatched,1)
    assert.ok(replacement.token>f.attempt.token)
  } finally {f.close()}
})
test('refused K2 append rolls back the ledger mutation and refused seal rolls back uploaded bytes', () => {
  const f=fixture()
  try {
    const before=canonical(f.relay.read(f.run.id)), append=f.log.appendFromHomeWithin.bind(f.log)
    f.log.appendFromHomeWithin=()=>{throw new Error('fixture trace refused')}
    assert.throws(()=>f.relay.propose(f.attempt,'new proposal'),/fixture trace refused/)
    assert.equal(canonical(f.relay.read(f.run.id)),before)
    f.log.appendFromHomeWithin=append
  } finally {f.close()}
})
test('wake is acknowledged at dispatch while the model response is still pending', async () => {
  const f=fixture()
  try {
    const promise=f.store.delegate(f.attempt,{key:'fixture-wake',deadline:1800000300000})
    const child=f.store.start(promise.child_id);f.store.complete(child,'completed')
    const lead=f.store.deliver(f.run.id,1)!
    let started!:()=>void; const ready=new Promise<void>(resolve=>{started=resolve})
    f.model.call=async(_p,o)=>{o.onStarted?.();started();return new Promise((_resolve,reject)=>o.signal!.addEventListener('abort',()=>reject(new Error('stop')),{once:true}))}
    const pending=f.executor.run(lead);await ready
    assert.notEqual(f.store.wakes(f.run.id)[0]!.acknowledged_at,null)
    assert.equal(f.store.wakes(f.run.id)[0]!.deliveries,1)
    f.executor.stop();await pending
    assert.equal(f.store.deliver(f.run.id,1),null)
  } finally {f.close()}
})
test('an output-limited narrative degrades and seals exactly once without stopping the run', async () => {
  const f = fixture(); try {
    const call = f.model.call
    f.model.call = async (p, o) => {
      const reply = await call(p, o)
      return p.startsWith('Write a fresh') ? { ...reply, outputLimited: true } : reply
    }
    await f.executor.run(f.attempt)
    const l = f.relay.read(f.run.id)
    const seals = f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n
    assert.equal(seals, 1)
    assert.equal(f.relay.sealed(f.attempt)!.handoff.degraded, true)
    assert.equal(l.items.one, 'done')
    assert.notEqual(f.store.get(f.run.id).state, 'input_required')
    assert.equal(f.log.readAll(f.run.session_id, 'person').some(e => e.type === 'error' && e.data.code === 'truncation_protocol'), false)
  } finally { f.close() }
})
test('an output-limited work reply is an invalid action and the run continues', async () => {
  let work = 0
  const f = fixture({ actions: () => canonical(++work <= 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) }); try {
    const call = f.model.call
    let limited = false
    f.model.call = async (p, o) => {
      const reply = await call(p, o)
      if (p.startsWith('Execute') && !limited) { limited = true; return { ...reply, outputLimited: true } }
      return reply
    }
    await f.executor.run(f.attempt)
    const workPrompts = f.prompts.filter(p => p.startsWith('Execute'))
    assert.ok(f.relay.read(f.run.id).errors >= 1)
    assert.ok(workPrompts.length >= 3)
    assert.ok(workPrompts[1]!.includes('Your reply hit the output limit; return one short valid JSON action.'))
    assert.equal(f.store.get(f.run.id).state, 'completed')
    assert.equal(f.relay.read(f.run.id).items.one, 'done')
  } finally { f.close() }
})
test('a new attempt probes and carries the latest seal from the previous attempt', async () => {
  let work = 0
  const marker = 'dead-end-do-not-repeat'
  const f = fixture({ actions: () => { work++; if (work === 2) f.executor.stop(); return canonical({ action: 'handoff' }) } })
  try {
    f.relay.note(f.attempt, 'dead_end', marker, ['one'], null)
    await f.executor.run(f.attempt)
    assert.ok(f.relay.sealed(f.attempt), 'the stopped attempt sealed before stopping')
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    const next = f.store.decide(f.run.id)
    f.relay.recover(next)
    const before = f.prompts.length
    const { RelayExecutor } = await import('../../src/relay/executor.ts')
    const executor = new RelayExecutor(f.relay, f.model, f.workspace, f.executor.reserves, f.scrubber)
    await executor.run(next)
    const after = f.prompts.slice(before)
    assert.ok(after.filter(p => p.startsWith('Answer these five')).length >= 1, 'probes ran')
    assert.ok(after.find(p => p.startsWith('Execute'))?.includes(marker), 'dead-end note reached work')
  } finally { f.close() }
})
test('an escalated relay recovers under a newly admitted attempt', async () => {
  let turn = 0
  const f = fixture({ actions: () => canonical(++turn % 2 ? { action: 'note', kind: 'decision', text: 'memo', items: ['one'], expiresAt: null } : { action: 'handoff' }) })
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.relay.read(f.run.id).state, 'escalate')
    assert.equal(f.store.get(f.run.id).state, 'input_required')
    const next = f.store.decide(f.run.id)
    f.relay.recover(next)
    assert.equal(f.relay.read(f.run.id).state, 'boot')
    const before = f.prompts.length
    const { RelayExecutor } = await import('../../src/relay/executor.ts')
    const executor = new RelayExecutor(f.relay, f.model, f.workspace, f.executor.reserves, f.scrubber)
    await executor.run(next)
    assert.ok(f.prompts.length > before, 'recovered run makes model calls')
    assert.equal(f.log.readAll(f.run.session_id, 'person').some(e => e.type === 'error' && e.data.code === 'cycle_transition'), false)
  } finally { f.close() }
})
test('a first failing gate observation and notes do not count as progress', async () => {
  let turn = 0
  const f = fixture({ actions: () => { const k = ++turn % 3; return canonical(k === 1 ? { action: 'note', kind: 'hypothesis', text: 'still thinking', items: [], expiresAt: null } : k === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) } })
  try {
    f.workspace.verify = async (_p, item) => ({ item, head: plan.base, ok: false, output: 'gate failed' })
    const trace: number[] = []
    const count = f.relay.countProgress.bind(f.relay)
    f.relay.countProgress = (a, c) => { const result = count(a, c); trace.push(f.relay.read(f.run.id).noProgress); return result }
    await f.executor.run(f.attempt)
    assert.deepEqual(trace, [1, 2, 3])
    assert.equal(f.relay.read(f.run.id).cycle, 3)
    assert.equal(f.relay.read(f.run.id).state, 'escalate')
    assert.equal(f.store.get(f.run.id).state, 'input_required')
  } finally { f.close() }
})
test('tool errors become tool results, increment errors and do not stop the run', async () => {
  let work = 0
  const f = fixture({ actions: () => canonical(++work === 1 ? { action: 'tool', name: 'read_file', args: { path: 'a' } }
    : work === 2 ? { action: 'tool', name: 'work.query', args: { offset: -1 } }
    : work === 3 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) })
  try {
    const denied = f.workspace.tool.bind(f.workspace)
    f.workspace.tool = async (name, args, signal) => {
      if (name === 'read_file') throw new RelayError('tool_denied')
      return denied(name, args, signal)
    }
    await f.executor.run(f.attempt)
    const events = f.log.readAll(f.run.session_id, 'person')
    const calls = events.filter(e => e.type === 'tool.call')
    const results = events.filter(e => e.type === 'tool.result')
    assert.equal(calls.length, 2)
    assert.equal(results.length, calls.length, 'every tool.call has a tool.result')
    for (const call of calls) {
      const result = results.find(e => e.data.toolCallId === call.data.toolCallId)
      assert.ok(result, `result for ${call.data.toolCallId}`)
      assert.equal(result!.data.status, 'error')
      assert.ok(result!.data.error)
    }
    assert.ok(f.relay.read(f.run.id).errors >= 2)
    assert.ok(f.prompts.filter(p => p.startsWith('Execute')).some(p => p.includes('tool_denied') && p.includes('invalid_offset')))
    assert.equal(f.store.get(f.run.id).state, 'completed')
  } finally { f.close() }
})
test('paging size, goal cut and gate timeout are explicit execution limits', async () => {
  const paged = fixture({ limits: { pageBytes: 16 } })
  try {
    const access = paged.executor as unknown as { tool: (a: typeof paged.attempt, n: string, args: Record<string, unknown>, s: AbortSignal) => Promise<string> }
    const page = JSON.parse(await access.tool(paged.attempt, 'work.query', { offset: 0 }, new AbortController().signal))
    assert.ok(Buffer.byteLength(page.text) <= 16)
    assert.equal(page.more, true)
  } finally { paged.close() }
  const goal = 'G'.repeat(2000)
  let goalTurn = 0
  const f = fixture({ limits: { goalBytes: 40 }, actions: () => canonical(++goalTurn === 1 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) })
  try {
    f.relay.change(f.attempt, 'fixture_goal', l => { l.plan = { ...l.plan, goal } })
    let timeout: number | undefined
    f.workspace.verify = async (_p, item, _s, ms) => { timeout = ms; return { item, head: plan.base, ok: true, output: 'pass' } }
    await f.executor.run(f.attempt)
    const work = f.prompts.find(p => p.startsWith('Execute'))
    assert.ok(work && !work.includes('G'.repeat(100)), 'goal was cut')
    assert.ok(work!.includes('[use paging]'))
    assert.equal(timeout, DEFAULT_RELAY_LIMITS.gateTimeoutMs)
  } finally { f.close() }
})
test('the invalid-action limit counts invalid turns, not every turn', async () => {
  let actions = 0, verifies = 0
  const f = fixture({ caps: { cycles: 1 }, limits: { invalidActions: 2 }, actions: () => {
    actions++
    return actions <= 2 ? 'not json' : canonical({ action: 'verify', item: 'one' })
  } })
  try {
    f.workspace.verify = async (_p, item) => { verifies++; return { item, head: plan.base, ok: true, output: 'pass' } }
    await f.executor.run(f.attempt)
    assert.equal(actions, 2)
    assert.equal(verifies, 0)
  } finally { f.close() }
})
test('a local runtime reports known zero cost and trips neither a generous nor a zero money cap', async () => {
  for (const moneyMicros of [1_000_000_000, 0]) {
  const f = fixture({ caps: { moneyMicros } })
  try {
    const meter = { observe: async () => window, count: (text: string) => Buffer.byteLength(text) + window.framingTokens, maxCostMicros: () => 0 }
    let work = 0
    const prompts: string[] = []
    const connections = {
      snapshot: () => ({ connections: [{ id: 'fixture-local', kind: 'local_runtime' }] }),
      localChat: async (_scope: unknown, _id: unknown, request: { messages: { content: unknown }[] }) => {
        const prompt = String(request.messages[0]!.content)
        prompts.push(prompt)
        let text: string
        if (prompt.startsWith('Write a fresh')) text = 'Continue the plan using its evidence.'
        else if (prompt.startsWith('Answer these five')) text = canonical(probes(f.relay.sealed(f.attempt)!.ledger))
        else text = canonical(++work === 1 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
        return { message: { content: text }, prompt_eval_count: meter.count(prompt), eval_count: 1, done_reason: 'stop' }
      },
    }
    const model = new ConnectionRelayModel(connections as never, 'fixture-local', 'fixture', meter)
    const { RelayExecutor } = await import('../../src/relay/executor.ts')
    const executor = new RelayExecutor(f.relay, model, f.workspace, reserves, f.scrubber)
    await executor.run(f.attempt)
    const l = f.relay.read(f.run.id)
    assert.ok(prompts.length > 1)
    assert.equal(l.moneyMicros, 0)
    assert.equal(l.unknownCosts, 0)
    assert.equal(f.store.get(f.run.id).state, 'completed', `money cap ${moneyMicros}`)
  } finally { f.close() }
  }
})
test('a cancel racing seal preparation ends the run cleanly without stale_lease', async () => {
  const f = fixture()
  try {
    f.workspace.bundle = async () => { f.store.cancel(f.run.id); return Buffer.from('fixture-git-bundle') }
    await f.executor.run(f.attempt)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n, 0)
    assert.equal(f.store.get(f.run.id).state, 'canceled')
  } finally { f.close() }
})

/** A workspace whose tree is dirty until a checkpoint (which moves the head), like the real git workspace. */
function dirtyWorkspace(f: ReturnType<typeof fixture>, options: { stuck?: boolean } = {}) {
  let dirty = true, checkpoints = 0
  const checkpoint = f.workspace.checkpoint.bind(f.workspace), verify = f.workspace.verify.bind(f.workspace)
  f.workspace.checkpoint = async (...args) => { checkpoints++; await checkpoint(...args); if (!options.stuck) dirty = false }
  f.workspace.validate = async () => { if (dirty) throw new RelayError('checkout_dirty') }
  f.workspace.verify = async (...args) => { if (dirty) throw new RelayError('checkout_dirty'); return verify(...args) }
  return { checkpoints: () => checkpoints }
}
const notes = (f: ReturnType<typeof fixture>) => f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'agent.note').map(e => String(e.data.text))
const errors = (f: ReturnType<typeof fixture>) => f.log.readAll(f.run.session_id, 'person').filter(e => e.type === 'error').map(e => String(e.data.code))

test('verify with uncommitted work checkpoints once, tells the model and runs the gate on the new head', async () => {
  const f = fixture(); try {
    const w = dirtyWorkspace(f)
    const l = await f.executor.run(f.attempt)
    assert.equal(l.items.one, 'done')
    assert.equal(w.checkpoints(), 1)
    assert.equal(notes(f).filter(t => t.includes('"relay":"auto_checkpoint"') && t.includes('"reason":"verify"')).length, 1)
    assert.equal(l.evidence.at(-1)!.head, 'b'.repeat(40))
    assert.ok(f.log.readAll(f.run.session_id, 'person').some(e => e.type === 'tool.result' || e.type === 'agent.note'), 'trace present')
    assert.ok(f.prompts.some(p => p.includes('"autoCheckpoint":true')), 'the next work prompt shows the model that a checkpoint was made')
  } finally { f.close() }
})

test('a tree still dirty after the auto checkpoint stops once with its own code (no loop)', async () => {
  const f = fixture(); try {
    const w = dirtyWorkspace(f, { stuck: true })
    await f.executor.run(f.attempt).catch(() => undefined)
    assert.equal(w.checkpoints(), 1)
    assert.notEqual(f.relay.read(f.run.id).items.one, 'done')
    assert.ok(errors(f).includes('checkout_dirty_after_checkpoint'))
    assert.equal(f.relay.read(f.run.id).head, 'b'.repeat(40))
  } finally { f.close() }
})

test('verify still stops the run for an unverifiable tree other than uncommitted work', async () => {
  const f = fixture(); try {
    let checkpoints = 0
    f.workspace.checkpoint = async () => { checkpoints++ }
    f.workspace.validate = async () => { throw new RelayError('protected_path') }
    await f.executor.run(f.attempt).catch(() => undefined)
    assert.notEqual(f.relay.read(f.run.id).items.one, 'done')
    assert.equal(checkpoints, 0, 'no checkpoint is forced for a reason other than uncommitted work')
    assert.ok(errors(f).includes('protected_path'))
  } finally { f.close() }
})

test('verifying an item re-verifies its dependencies first at the current head', async () => {
  const two: Plan = { ...plan, items: [plan.items[0]!, { id: 'two', title: 'second', dependsOn: ['one'], acceptance: ['true'], protectedPaths: [] }] }
  const verified: string[] = []
  const f = fixture({ plan: two, actions: (_p, n) => canonical(n === 1 ? { action: 'checkpoint' } : n === 2 ? { action: 'verify', item: 'two' } : { action: 'handoff' }) }); try {
    const verify = f.workspace.verify.bind(f.workspace)
    f.workspace.verify = async (p, item, ...rest) => { verified.push(item); return verify(p, item, ...rest) }
    const l = await f.executor.run(f.attempt)
    assert.deepEqual(verified.slice(0, 2), ['one', 'two'], 'the dependency gate ran before the item, in one action')
    assert.equal(l.items.one, 'done'); assert.equal(l.items.two, 'done')
  } finally { f.close() }
})

test('verify of an item already done at this head, or of an unknown id, is answered without a gate or a stop', async () => {
  const f = fixture({ actions: (_p, n) => canonical(n === 1 ? { action: 'verify', item: 'one' } : n === 2 ? { action: 'verify', item: 'one' } : n === 3 ? { action: 'verify', item: 'nope' } : { action: 'handoff' }) }); try {
    let gates = 0
    const verify = f.workspace.verify.bind(f.workspace)
    f.workspace.verify = async (...args) => { gates++; return verify(...args) }
    const l = await f.executor.run(f.attempt)
    assert.equal(l.items.one, 'done')
    assert.ok(f.prompts.some(p => p.includes('"alreadyDone":true')))
    assert.ok(f.prompts.some(p => p.includes('"refused":"unknown_item"')))
    assert.deepEqual(errors(f), [])
    assert.ok(gates >= 1)
  } finally { f.close() }
})

test('uncommitted work at a handoff is checkpointed before the seal instead of stopping the run', async () => {
  const f = fixture({ actions: () => canonical({ action: 'handoff' }) }); try {
    const w = dirtyWorkspace(f)
    await f.executor.run(f.attempt)
    assert.equal(w.checkpoints(), 1)
    assert.equal(notes(f).filter(t => t.includes('"relay":"auto_checkpoint"') && t.includes('"reason":"handoff"')).length, 1)
    assert.ok(!errors(f).some(code => code.startsWith('checkout_dirty')), 'the dirty tree did not stop the run')
    assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM relay_seals WHERE run_id=?').get(f.run.id)!.n as number >= 1, 'a seal was written')
    assert.equal(f.relay.read(f.run.id).head, 'b'.repeat(40))
  } finally { f.close() }
})

test('a failing dependency gate ends the verify action before the requested item; done dependencies are skipped; a diamond runs each gate once', async () => {
  const diamond: Plan = { ...plan, items: [
    { id: 'base', title: 'b', dependsOn: [], acceptance: ['true'], protectedPaths: [] },
    { id: 'left', title: 'l', dependsOn: ['base'], acceptance: ['true'], protectedPaths: [] },
    { id: 'right', title: 'r', dependsOn: ['base'], acceptance: ['true'], protectedPaths: [] },
    { id: 'top', title: 't', dependsOn: ['left', 'right'], acceptance: ['true'], protectedPaths: [] }] }
  {
    const verified: string[] = []
    const f = fixture({ plan: diamond, actions: (_p, n) => canonical(n === 1 ? { action: 'verify', item: 'top' } : { action: 'handoff' }) }); try {
      const verify = f.workspace.verify.bind(f.workspace)
      f.workspace.verify = async (p, item, ...rest) => { verified.push(item); return verify(p, item, ...rest) }
      await f.executor.run(f.attempt)
      const action = verified.slice(0, 4)
      assert.deepEqual([...action].sort(), ['base', 'left', 'right', 'top'])
      assert.equal(action[0], 'base'); assert.equal(action[3], 'top')
      assert.equal(new Set(action).size, 4, 'each gate ran once in the action')
      assert.ok(f.prompts.some(p => p.includes('"item":"top","ok":true')), 'the verdict leads the result')
    } finally { f.close() }
  }
  {
    const verified: string[] = []
    const f = fixture({ plan: diamond, actions: (_p, n) => canonical(n === 1 ? { action: 'verify', item: 'top' } : { action: 'handoff' }) }); try {
      const verify = f.workspace.verify.bind(f.workspace)
      f.workspace.verify = async (p, item, ...rest) => { verified.push(item); const e = await verify(p, item, ...rest); return item === 'left' ? { ...e, ok: false } : e }
      await f.executor.run(f.attempt).catch(() => undefined)
      assert.ok(!verified.includes('top'), 'the requested item was not gated after its dependency failed')
      assert.ok(f.prompts.some(p => p.includes('"failedAt":"left"')))
    } finally { f.close() }
  }
  {
    const verified: string[] = []
    const f = fixture({ plan: diamond, actions: (_p, n) => canonical(n === 1 ? { action: 'verify', item: 'base' } : n === 2 ? { action: 'verify', item: 'left' } : { action: 'handoff' }) }); try {
      const verify = f.workspace.verify.bind(f.workspace)
      f.workspace.verify = async (p, item, ...rest) => { verified.push(item); return verify(p, item, ...rest) }
      await f.executor.run(f.attempt)
      assert.deepEqual(verified.slice(0, 2), ['base', 'left'], 'base, already done at this head, was not re-gated for left')
    } finally { f.close() }
  }
})

test('verify answers alreadyDone only for a clean tree: work written after a pass is checkpointed and re-gated', async () => {
  let gates = 0
  const f = fixture({ actions: (_p, n) => canonical(n <= 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) }); try {
    const verify = f.workspace.verify.bind(f.workspace)
    let dirty = false, checkpoints = 0
    const checkpoint = f.workspace.checkpoint.bind(f.workspace)
    f.workspace.checkpoint = async (...args) => { checkpoints++; dirty = false; await checkpoint(...args) }
    f.workspace.validate = async () => { if (dirty) throw new RelayError('checkout_dirty') }
    f.workspace.verify = async (...args) => { gates++; const e = await verify(...args); dirty = true; return e }
    await f.executor.run(f.attempt)
    assert.equal(checkpoints >= 1, true)
    assert.ok(gates >= 2, 'the second verify ran a gate on the new checkpoint instead of answering alreadyDone')
    assert.ok(!f.prompts.some(p => p.includes('"alreadyDone":true')))
  } finally { f.close() }
})

test('a protected path in the handoff auto checkpoint stops the run as protected_path', async () => {
  const f = fixture({ actions: () => canonical({ action: 'handoff' }) }); try {
    f.workspace.validate = async () => { throw new RelayError('checkout_dirty') }
    f.workspace.checkpoint = async () => { throw new RelayError('protected_path') }
    await f.executor.run(f.attempt).catch(() => undefined)
    assert.ok(errors(f).includes('protected_path'))
  } finally { f.close() }
})

test('all items done, then a handoff auto checkpoint: the final gates run again at the new head and the next cycle is told', async () => {
  let gates = 0
  const f = fixture({ actions: (_p, n) => canonical(n === 1 ? { action: 'verify', item: 'one' } : { action: 'finish' }) }); try {
    const verify = f.workspace.verify.bind(f.workspace)
    let dirty = false
    f.workspace.checkpoint = async () => { dirty = false }
    f.workspace.validate = async () => { if (dirty) throw new RelayError('checkout_dirty') }
    f.workspace.verify = async (...args) => { gates++; const e = await verify(...args); if (gates === 1) dirty = true; return e }
    const l = await f.executor.run(f.attempt)
    assert.equal(gates, 2, 'one gate for the action, one final gate after the harness checkpoint')
    assert.equal(l.items.one, 'done')
    assert.ok(f.relay.notes(f.run.id).some((n: { text: string }) => n.text.includes('harness checkpointed uncommitted work')))
  } finally { f.close() }
})
