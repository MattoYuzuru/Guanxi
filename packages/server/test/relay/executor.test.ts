import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, plan, window, reserves } from './fixture.ts'
import { canonical, hash, render, selectNotes, validateHandoff, probes } from '../../src/relay/handoff.ts'
import { thresholds } from '../../src/relay/budget.ts'

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
    assert.ok(s.handoff.degraded); assert.equal(s.ledger.items.one, 'done'); assert.equal(s.ledger.evidence.length, 1)
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
test('normative cycle/token/money/wall/J3 caps wrap up before another model call', async () => {
  for (const kind of ['cycles','tokens','money','wall','j3']) {
    const f = fixture({ caps: { cycles: kind === 'cycles' ? 1 : null, tokens: kind === 'tokens' ? 1 : null,
      moneyMicros: kind === 'money' ? 0 : null, wallMs: kind === 'wall' ? 1 : null, j3: kind === 'j3' ? 0 : null }, actions: () => canonical({ action: 'handoff' }) })
    try {
      if (kind === 'wall') f.relay.change(f.attempt, 'fixture_time', l => { l.startedAt -= 2 })
      if (kind === 'j3') f.relay.change(f.attempt, 'fixture_judge', l => { l.j3 = 1 })
      await f.executor.run(f.attempt)
      assert.equal(f.store.get(f.run.id).state, 'wrapping_up', kind)
      assert.equal(f.prompts.filter(p => p.startsWith('Execute')).length, kind === 'cycles' ? 1 : 0, kind)
    } finally { f.close() }
  }
})
test('stopping an in-flight model preserves the ledger and never replays it on recovery', async () => {
  const f=fixture()
  try {
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    f.model.call=async(_p,o)=>{started();return new Promise((_resolve,reject)=>o.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}
    const pending=f.executor.run(f.attempt); await ready; f.executor.stop(); await pending
    assert.equal(f.store.get(f.run.id).state,'input_required')
    assert.equal(f.relay.read(f.run.id).items.one,'open')
    assert.ok(f.relay.read(f.run.id).tokens>0)
    assert.equal(f.relay.read(f.run.id).pendingCall,null)
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
