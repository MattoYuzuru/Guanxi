/** B3-c: the default-off naive-compaction arm. The ledger relay is the default and must not change; the arm replaces what the model is shown at a
 * cycle boundary (the strip, notes and ledger queries) by a model-written summary and records that it did. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { thresholds } from '../../src/relay/budget.ts'
import { canonical, validateHandoff } from '../../src/relay/handoff.ts'
import { NAIVE_DEGRADED_SUMMARY, NAIVE_UNAVAILABLE_SUMMARY, workPrompt } from '../../src/relay/response-schemas.ts'
import { RelayError } from '../../src/relay/types.ts'
import { fixture, plan, reserves, window } from './fixture.ts'

const item = (id: string, dependsOn: string[]) => ({ id, title: 'item ' + id, dependsOn, acceptance: ['true'], protectedPaths: ['tests'] })
const pair = { ...plan, items: [item('b', ['a']), item('a', [])] }
const SUMMARY = 'SUMMARY-ONE: item a is verified; item b is next.'
const isSummary = (prompt: string) => prompt.startsWith('Summarize')
/** Cycle 1 verifies a and hands off, cycle 2 verifies b and hands off (the plan is then done). `summaries` answers every summary call. */
function script(summaries: (n: number, prompt: string) => string | Promise<string> = () => SUMMARY, extra: Array<Record<string, unknown>> = []) {
  let work = 0, summary = 0
  return async (prompt: string): Promise<string> => {
    if (isSummary(prompt)) return summaries(++summary, prompt)
    const step = work++
    if (step < extra.length) return canonical(extra[step])
    const rest = step - extra.length
    return canonical(rest === 0 ? { action: 'verify', item: 'a' } : rest === 2 ? { action: 'verify', item: 'b' } : { action: 'handoff' })
  }
}
const events = (f: ReturnType<typeof fixture>) => f.log.readAll(f.run.session_id, 'person')
const notes = (f: ReturnType<typeof fixture>) => events(f).filter(e => e.type === 'agent.note').map(e => String(e.data.text))
const relayNotes = (f: ReturnType<typeof fixture>, name: string) => notes(f).filter(text => text.includes(`"relay":"${name}"`)).map(text => JSON.parse(text) as Record<string, unknown>)
/** The work prompts of the cycle after the first summary or narrative: what the second cycle was shown. */
const secondCycle = (prompts: string[]) => prompts.slice(prompts.findIndex(p => isSummary(p) || p.startsWith('Write a fresh')) + 1)
const work = (prompts: string[]) => prompts.filter(p => p.startsWith('Execute'))

test('default: the second cycle is shown the ledger strip and the narrative, the ledger tools are offered, and nothing of the arm is recorded', async () => {
  const f = fixture({ plan: pair, actions: script() })
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.relay.read(f.run.id).cycle, 2); assert.equal(f.store.get(f.run.id).state, 'completed')
    assert.deepEqual(f.executor.tools.slice(0, 2).map(t => t.name), ['work.query', 'notes.search'])
    const later = work(secondCycle(f.prompts)); assert.ok(later.length >= 2)
    assert.ok(later[0]!.includes('"current":"b","currentStatus":"open"') && later[0]!.includes('"query":"work.query"'), 'the live ledger strip is in the context')
    assert.ok(later.at(-1)!.includes('"current":null,"currentStatus":null'), 'and it follows the ledger within the cycle')
    for (const prompt of later) {
      assert.ok(prompt.includes('Continue the plan using its evidence.'), 'the ledger arm\'s narrative is in the context')
      assert.ok(prompt.startsWith(workPrompt(f.executor.tools)) && prompt.includes('notes.search(query, offset?)'))
    }
    assert.equal(f.prompts.filter(isSummary).length, 0, 'no summary is ever requested')
    assert.equal(f.prompts.filter(p => p.startsWith('Write a fresh')).length, 2, 'one narrative per boundary, as before')
    assert.equal(notes(f).some(text => text.includes('compaction')), false, 'no compaction marker, summary or probe field in the default path')
    assert.deepEqual(relayNotes(f, 'probe'), [{ relay: 'probe', retry: 0, correct: true, damaged: false }])
  } finally { f.close() }
})

test('default and an explicit ledger setting are the same relay: identical prompts and identical events', async () => {
  const run = async (limits?: { compaction: 'ledger' }) => {
    const f = fixture({ plan: pair, actions: script(), ...(limits ? { limits } : {}) })
    try {
      await f.executor.run(f.attempt)
      // Evidence ids are random, so every hash that covers them differs between two runs; shapes, order and text must not.
      const same = (text: string) => text.replaceAll(f.run.id, 'RUN').replaceAll(f.attempt.id, 'ATTEMPT').replace(/[0-9a-f]{64}/g, 'H').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
      return { prompts: f.prompts.map(same), notes: notes(f).map(same), ledger: same(canonical(f.relay.read(f.run.id))) }
    } finally { f.close() }
  }
  assert.deepEqual(await run({ compaction: 'ledger' }), await run())
})

test('naive: the second cycle is shown the goal and the summary and nothing of the ledger: no strip, no notes, no ledger tools', async () => {
  const f = fixture({ plan: pair, actions: script(), limits: { compaction: 'naive' } })
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.relay.read(f.run.id).cycle, 2); assert.equal(f.store.get(f.run.id).state, 'completed')
    const firstCycle = work(f.prompts).slice(0, work(f.prompts).length - work(secondCycle(f.prompts)).length), later = work(secondCycle(f.prompts))
    assert.ok(firstCycle.length >= 2, 'the first cycle has a prompt before and one after its verify')
    for (const prompt of firstCycle) {
      assert.ok(prompt.includes('"initial":true') && prompt.includes('"current":"a"') && prompt.includes('Implement the fixture task.'), 'the first cycle is shown the task statement, labelled initial')
      assert.equal(prompt.includes('"current":"b"'), false, 'and it does not follow the ledger after item a passes its gate')
      for (const live of ['currentStatus', 'verification_requested']) assert.equal(prompt.includes(live), false, live)
    }
    assert.ok(firstCycle[1]!.includes('"action":"verify"'), 'the second prompt is the one after the verify turn')
    assert.ok(later.length >= 2)
    for (const prompt of later) {
      assert.ok(prompt.includes(SUMMARY) && prompt.includes('Implement the fixture task.'), 'the summary and the plan goal')
      for (const gone of ['currentStatus', '"queued"', '"blocked"', 'Continue the plan using its evidence.']) assert.equal(prompt.includes(gone), false, gone + ' must not reach the next cycle')
      assert.equal(prompt.includes('work.query') || prompt.includes('notes.search'), false, 'the ledger tools are not offered')
    }
    assert.deepEqual(f.executor.tools.map(t => t.name).filter(n => n === 'work.query' || n === 'notes.search'), [])
    // One summary per boundary, written over what the cycle was shown: the first over the strip and the turns, the second over the first summary.
    const summaries = f.prompts.filter(isSummary)
    assert.equal(summaries.length, 2); assert.equal(f.prompts.filter(p => p.startsWith('Write a fresh')).length, 0)
    assert.ok(summaries[0]!.includes('"initial":true') && summaries[0]!.includes('"action":"verify"') && !summaries[0]!.includes('currentStatus'))
    // The refused tool is named nowhere the naive model reads, in any cycle: a hint to it would be charged to the arm as an error.
    for (const prompt of f.prompts) assert.equal(prompt.includes('work.query') || prompt.includes('notes.search'), false, prompt.slice(0, 40))
    assert.equal(f.relay.read(f.run.id).errors, 0)
    assert.ok(summaries[1]!.includes(SUMMARY) && summaries[1]!.includes('Implement the fixture task.') && !summaries[1]!.includes('currentStatus'))
    // The five probes are ledger facts the arm is never shown: they are not asked at all.
    assert.equal(f.prompts.filter(p => p.startsWith('Answer these five')).length, 0)
  } finally { f.close() }
})

test('naive: a note the model writes is stored but never selected into the seal or shown to the next cycle; the default arm shows it', async () => {
  const note = [{ action: 'note', kind: 'decision', text: 'NOTE-TEXT-X', items: ['a'], expiresAt: null }]
  const run = async (limits: object) => {
    const f = fixture({ plan: pair, actions: script(() => SUMMARY, note), limits })
    try {
      await f.executor.run(f.attempt)
      assert.equal(f.relay.notes(f.run.id).length, 1, 'the note is in the ledger store either way')
      return { sealed: f.relay.sealed(f.attempt)!.handoff.notes.length, nextCycle: work(secondCycle(f.prompts)).some(p => p.includes('NOTE-TEXT-X')) || secondCycle(f.prompts).some(p => p.startsWith('Answer these five') && p.includes('NOTE-TEXT-X')) }
    } finally { f.close() }
  }
  assert.deepEqual(await run({ compaction: 'naive' }), { sealed: 0, nextCycle: false })
  assert.deepEqual(await run({}), { sealed: 1, nextCycle: true })
})

test('naive: the executor refuses the ledger tools it no longer lists, and still serves them in the default arm', async () => {
  const query = [{ action: 'tool', name: 'work.query', args: {} }, { action: 'tool', name: 'notes.search', args: { query: 'x' } }]
  const results = async (limits: object) => {
    const f = fixture({ plan: pair, actions: script(() => SUMMARY, query), limits })
    try {
      await f.executor.run(f.attempt)
      return events(f).filter(e => e.type === 'tool.result').slice(0, 2).map(e => [e.data.status, e.data.error] as const)
    } finally { f.close() }
  }
  assert.deepEqual(await results({ compaction: 'naive' }), [['error', 'tool_denied'], ['error', 'tool_denied']])
  assert.deepEqual((await results({})).map(([status]) => status), ['ok', 'ok'])
})

test('naive: the mode is recorded once per attempt, per sealed cycle and per skipped probe, and the seal is the ordinary valid one', async () => {
  const f = fixture({ plan: pair, actions: script(), limits: { compaction: 'naive' } })
  try {
    await f.executor.run(f.attempt)
    assert.deepEqual(relayNotes(f, 'compaction'), [{ relay: 'compaction', mode: 'naive', attempt: f.attempt.id, epoch: f.attempt.epoch }])
    const marker = notes(f).findIndex(text => text.includes('"relay":"compaction"')), firstModelCall = events(f).findIndex(e => e.type === 'assistant.started')
    assert.ok(marker >= 0 && firstModelCall >= 0 && events(f).findIndex(e => e.type === 'agent.note' && String(e.data.text).includes('"relay":"compaction"')) < firstModelCall, 'written before the first model call')
    const summaries = relayNotes(f, 'compaction_summary')
    assert.deepEqual(summaries.map(s => [s.cycle, s.mode, s.truncated, s.degraded, s.inputDropped, s.inputCut]), [[1, 'naive', false, false, 0, 0], [2, 'naive', false, false, 0, 0]])
    assert.equal(summaries[0]!.summaryBytes, Buffer.byteLength(SUMMARY)); assert.equal(summaries[0]!.attempt, f.attempt.id)
    assert.equal(summaries[0]!.outputLimitTokens, reserves.turn); assert.equal(summaries[0]!.degradedReason, null)
    assert.ok(Number(summaries[0]!.summaryLimitBytes) > 0 && Number(summaries[0]!.summaryLimitBytes) < thresholds(window, reserves).handoff, 'the summary room is the handoff bound minus its framing')
    assert.deepEqual(relayNotes(f, 'probe_not_applicable'), [{ relay: 'probe_not_applicable', mode: 'naive', cycle: 2, reason: 'ledger_facts_not_shown', damaged: false }])
    assert.deepEqual(relayNotes(f, 'probe'), [], 'a skipped probe is never a pass or a fail')
    const sealed = f.relay.sealed(f.attempt)!
    validateHandoff(sealed.handoff, sealed.ledger, sealed.bundle, thresholds(window, reserves).handoff)
    assert.equal(sealed.handoff.narrative, SUMMARY); assert.deepEqual(sealed.handoff.notes, [])
    assert.ok(sealed.handoff.ledger.strip.includes('"current"'), 'the durable seal still carries the ledger strip for fencing and integrity; the model never sees it')
  } finally { f.close() }
})

test('naive: a summary longer than the handoff bound is cut visibly and reported; the cut text is what the next cycle sees', async () => {
  const long = 'L'.repeat(thresholds(window, reserves).handoff * 2)
  const f = fixture({ plan: pair, actions: script(n => n === 1 ? long : SUMMARY), limits: { compaction: 'naive' } })
  try {
    await f.executor.run(f.attempt)
    const [cut, whole] = relayNotes(f, 'compaction_summary')
    assert.equal(cut!.truncated, true); assert.equal(whole!.truncated, false)
    assert.ok(Number(cut!.summaryBytes) <= Number(cut!.summaryLimitBytes), 'inside the room the same 15% handoff bound leaves')
    assert.ok(Number(cut!.summaryLimitBytes) - Number(cut!.summaryBytes) < 20, 'and it uses that room: the cut text is as long as the bound allows')
    const seen = work(secondCycle(f.prompts))[0]!
    assert.ok(seen.includes('[use paging]') && seen.includes('LLLL') && !seen.includes(long), 'the next cycle sees the cut text, marked as cut')
  } finally { f.close() }
})

test('naive: turns that do not fit the summary request are dropped oldest first and the loss is reported with the summary', async () => {
  const read = (c: string) => ({ action: 'tool', name: 'file_read', args: { output: c.repeat(2500) } })
  // The summary request is metered 6000 tokens heavier than the work requests (a model whose summary prompt costs more than the cycle did),
  // so it cannot hold every turn the work context held.
  const f = fixture({ plan: pair, actions: script(() => SUMMARY, [read('A'), read('B'), read('C')]), limits: { compaction: 'naive' },
    exact: true, count: text => Buffer.byteLength(text) + window.framingTokens + (text.startsWith('Summarize') ? 6000 : 0) })
  try {
    await f.executor.run(f.attempt)
    const [first] = relayNotes(f, 'compaction_summary')
    assert.ok(Number(first!.inputDropped) >= 1, JSON.stringify(first))
    const asked = f.prompts.find(isSummary)!
    assert.equal(asked.includes('AAAA'), false, 'the oldest turn went first'); assert.ok(asked.includes('CCCC'), 'the newest turn stayed')
    assert.ok(relayNotes(f, 'context_dropped').some(n => n.cycle === 1 && n.dropped === first!.inputDropped), 'the existing drop note is emitted with the same count')
  } finally { f.close() }
})

test('naive: a summary that cannot be written seals degraded with a fixed text and the run goes on', async () => {
  const f = fixture({ plan: pair, actions: script(n => { if (n === 1) throw new Error('fixture unavailable'); return SUMMARY }), limits: { compaction: 'naive' } })
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.store.get(f.run.id).state, 'completed')
    const [failed] = relayNotes(f, 'compaction_summary'); assert.equal(failed!.degraded, true)
    assert.ok(work(secondCycle(f.prompts))[0]!.includes(NAIVE_DEGRADED_SUMMARY))
    assert.equal(NAIVE_DEGRADED_SUMMARY.includes('work.query'), false)
  } finally { f.close() }
})

test('naive: no probe is asked, so a model that would fail it cannot escalate the run; the default arm still escalates on the same model', async () => {
  const naive = fixture({ plan: pair, actions: script(), probeFails: true, limits: { compaction: 'naive' } })
  try {
    await naive.executor.run(naive.attempt)
    assert.equal(naive.store.get(naive.run.id).state, 'completed')
    assert.equal(naive.prompts.filter(p => p.startsWith('Answer these five')).length, 0)
    assert.equal(notes(naive).some(text => text.includes('judge_requested') || text.includes('probe_degraded') || text.includes('"relay":"probe"')), false)
  } finally { naive.close() }
  const ledger = fixture({ plan: pair, actions: script(), probeFails: true })
  try {
    await ledger.executor.run(ledger.attempt)
    assert.equal(ledger.store.get(ledger.run.id).state, 'input_required', 'probe_failed_twice is the ledger arm\'s gate')
  } finally { ledger.close() }
})

test('naive: a damaged stored seal is not repaired from the ledger; the next cycle is told the summary is unavailable and the note records the damage', async () => {
  const f = fixture({ plan: pair, actions: script(), limits: { compaction: 'naive' } })
  try {
    const sealed = f.relay.sealed.bind(f.relay)
    f.relay.sealed = a => { const s = sealed(a); return s && { ...s, artifactHash: 'f'.repeat(64) } }
    await f.executor.run(f.attempt)
    assert.ok(work(secondCycle(f.prompts))[0]!.includes(NAIVE_UNAVAILABLE_SUMMARY) && !work(secondCycle(f.prompts))[0]!.includes(SUMMARY))
    assert.deepEqual(relayNotes(f, 'probe_not_applicable').map(p => p.damaged), [true])
    assert.equal(notes(f).some(text => text.includes('probe_degraded')), false)
  } finally { f.close() }
})

test('compaction accepts only the two named modes', () => {
  assert.throws(() => fixture({ limits: { compaction: 'summary' as never } }), (error: unknown) => error instanceof RelayError && error.code === 'relay_compaction_invalid')
})

test('naive: the summary request states the output ceiling and the storage room, and the note reports the same numbers', async () => {
  const f = fixture({ plan: pair, actions: script(), limits: { compaction: 'naive' } })
  try {
    await f.executor.run(f.attempt)
    const reported = relayNotes(f, 'compaction_summary'), asked = f.prompts.filter(isSummary)
    assert.equal(asked.length, 2); assert.equal(reported.length, 2)
    asked.forEach((prompt, i) => assert.ok(prompt.includes(`Your reply is cut at ${reserves.turn} tokens, and the stored summary at ${reported[i]!.summaryLimitBytes} bytes`), prompt.slice(0, 600)))
  } finally { f.close() }
})

test('naive: a degraded summary says why, with the relay\'s fixed code', async () => {
  const reasons = async (mutate: (f: ReturnType<typeof fixture>) => void, actions = script()) => {
    const f = fixture({ plan: pair, actions, limits: { compaction: 'naive' } })
    try {
      mutate(f)
      await f.executor.run(f.attempt)
      return relayNotes(f, 'compaction_summary').map(n => [n.degraded, n.degradedReason])
    } finally { f.close() }
  }
  const limited = (f: ReturnType<typeof fixture>) => {
    const original = f.model.call.bind(f.model)
    f.model.call = async (prompt, options) => { const reply = await original(prompt, options); return isSummary(prompt) ? { ...reply, outputLimited: true } : reply }
  }
  assert.deepEqual((await reasons(() => {}, script(n => { if (n === 1) throw new Error('fixture unavailable'); return SUMMARY }))).at(0), [true, 'model_failed'])
  assert.deepEqual((await reasons(limited)).at(0), [true, 'narrative_output_limited'], 'a reply the output reserve cut is not a summary')
  assert.deepEqual((await reasons(() => {})).at(0), [false, null])
})

test('naive: a summary replaced by the harness fallback is reported as lost, not as intact', async () => {
  const { RelayError } = await import('../../src/relay/types.ts')
  const f = fixture({ plan: pair, actions: script(), limits: { compaction: 'naive' } })
  try {
    const seal = f.relay.seal.bind(f.relay)
    let refused = 0
    f.relay.seal = (...args: Parameters<typeof seal>) => { if (refused++ < 2) throw new RelayError('handoff_size'); return seal(...args) }
    await f.executor.run(f.attempt)
    const [lost] = relayNotes(f, 'compaction_summary')
    assert.deepEqual([lost!.truncated, lost!.degraded, lost!.degradedReason, lost!.summaryBytes], [true, true, 'handoff_fallback', 0])
    assert.ok(work(secondCycle(f.prompts))[0]!.includes(NAIVE_UNAVAILABLE_SUMMARY), 'the next cycle is told the summary is unavailable')
  } finally { f.close() }
})

/** A second attempt on the same run, as after a stop or a restart: a new executor, a recovered ledger. */
async function resume(f: ReturnType<typeof fixture>, limits: object) {
  const next = f.store.decide(f.run.id)
  f.relay.recover(next)
  const { RelayExecutor } = await import('../../src/relay/executor.ts')
  const { DEFAULT_RELAY_LIMITS } = await import('../../src/relay/types.ts')
  const executor = new RelayExecutor(f.relay, f.model, f.workspace, f.executor.reserves, f.scrubber, { ...DEFAULT_RELAY_LIMITS, ...limits })
  return { next, executor }
}

test('naive: every attempt writes its own marker before that attempt\'s first model call, and a run whose attempts disagree is detectable', async () => {
  const sealers = (f: ReturnType<typeof fixture>) => (f.db.prepare('SELECT DISTINCT attempt_id FROM relay_seals WHERE run_id=?').all(f.run.id) as Array<{ attempt_id: string }>).map(r => r.attempt_id)
  /** The rule a bench runner applies: every attempt that sealed a cycle has a marker, and every summary note names a marked attempt. */
  const consistent = (f: ReturnType<typeof fixture>) => {
    const marked = new Set(relayNotes(f, 'compaction').map(n => n.attempt))
    return sealers(f).every(id => marked.has(id)) && relayNotes(f, 'compaction_summary').every(n => marked.has(n.attempt))
  }
  const stopAtSecondWork = (f: { executor: { stop(): void } }) => { let n = 0; return async (prompt: string) => { if (isSummary(prompt)) return SUMMARY; if (++n === 2) f.executor.stop(); return canonical({ action: 'handoff' }) } }
  const first = async (limits: object) => {
    const holder: { executor: { stop(): void } } = { executor: { stop() {} } }
    const f = fixture({ plan: pair, actions: stopAtSecondWork(holder), limits: { compaction: 'naive' } })
    holder.executor = f.executor
    await f.executor.run(f.attempt)
    assert.equal(f.store.get(f.run.id).state, 'input_required'); assert.ok(f.relay.sealed(f.attempt))
    const before = f.prompts.length
    const { next, executor } = await resume(f, limits)
    await executor.run(next)
    return { f, next, before }
  }
  const pure = await first({ compaction: 'naive' })
  try {
    const markers = relayNotes(pure.f, 'compaction')
    assert.deepEqual(markers.map(m => m.attempt), [pure.f.attempt.id, pure.next.id])
    assert.deepEqual(markers.map(m => m.epoch), [pure.f.attempt.epoch, pure.next.epoch])
    const log = events(pure.f), second = log.findIndex((e, i) => i > 0 && e.type === 'agent.note' && String(e.data.text).includes('"relay":"compaction"') && String(e.data.text).includes(pure.next.id))
    assert.ok(second > 0)
    assert.equal(log.slice(0, second).filter(e => e.type === 'assistant.started').length, pure.before, 'the second marker precedes every model call of the second attempt')
    assert.ok(log.slice(second).some(e => e.type === 'assistant.started'), 'and the second attempt did call the model')
    assert.equal(consistent(pure.f), true)
  } finally { pure.f.close() }
  const mixed = await first({})
  try {
    assert.equal(relayNotes(mixed.f, 'compaction').length, 1, 'a ledger attempt writes no marker')
    assert.ok(sealers(mixed.f).includes(mixed.next.id), 'the ledger attempt sealed a cycle')
    assert.equal(consistent(mixed.f), false, 'naive then ledger is detectable: a sealing attempt has no marker')
  } finally { mixed.f.close() }
})

test('naive: a resumed attempt with no seal is shown the task statement, not the progress the ledger has recorded', async () => {
  let n = 0
  const holder: { executor: { stop(): void } } = { executor: { stop() {} } }
  const f = fixture({ plan: pair, limits: { compaction: 'naive' }, actions: async prompt => {
    if (isSummary(prompt)) return SUMMARY
    n++
    if (n === 2) holder.executor.stop()
    return canonical(n === 1 ? { action: 'verify', item: 'a' } : n === 2 ? { action: 'tool', name: 'file_read', args: { output: 'x' } } : { action: 'handoff' })
  } })
  holder.executor = f.executor
  try {
    await f.executor.run(f.attempt)
    assert.equal(f.relay.sealed(f.attempt), null, 'stopped inside the first cycle: nothing sealed')
    assert.equal(f.relay.read(f.run.id).items.a, 'done', 'the ledger has recorded the progress')
    const before = f.prompts.length
    const { next, executor } = await resume(f, { compaction: 'naive' })
    n = 100
    await executor.run(next)
    const firstResumed = f.prompts.slice(before).find(p => p.startsWith('Execute'))!
    assert.ok(firstResumed.includes('"initial":true') && firstResumed.includes('"current":"a"'), firstResumed.slice(-400))
    for (const live of ['"current":"b"', 'currentStatus', 'work.query']) assert.equal(firstResumed.includes(live), false, live)
  } finally { f.close() }
})
