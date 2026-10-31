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
    const [first] = work(f.prompts)!, later = work(secondCycle(f.prompts))
    assert.ok(first!.includes('"currentStatus":"open"') && first!.includes('"current":"a"'), 'the first cycle is shown the task statement: the strip at cycle start')
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
    assert.ok(summaries[0]!.includes('"currentStatus":"open"') && summaries[0]!.includes('"action":"verify"'))
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
    assert.deepEqual(relayNotes(f, 'compaction'), [{ relay: 'compaction', mode: 'naive' }])
    const marker = notes(f).findIndex(text => text.includes('"relay":"compaction"')), firstModelCall = events(f).findIndex(e => e.type === 'assistant.started')
    assert.ok(marker >= 0 && firstModelCall >= 0 && events(f).findIndex(e => e.type === 'agent.note' && String(e.data.text).includes('"relay":"compaction"')) < firstModelCall, 'written before the first model call')
    const summaries = relayNotes(f, 'compaction_summary')
    assert.deepEqual(summaries.map(s => [s.cycle, s.mode, s.truncated, s.degraded, s.inputDropped, s.inputCut]), [[1, 'naive', false, false, 0, 0], [2, 'naive', false, false, 0, 0]])
    assert.equal(summaries[0]!.summaryBytes, Buffer.byteLength(SUMMARY)); assert.equal(summaries[0]!.handoffLimitBytes, thresholds(window, reserves).handoff)
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
    assert.ok(Number(cut!.summaryBytes) <= Number(cut!.handoffLimitBytes), 'inside the same 15% handoff bound the ledger handoff uses')
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
