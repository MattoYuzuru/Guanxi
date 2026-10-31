import assert from 'node:assert/strict'
import test from 'node:test'
import { armModeOf, canonicalText, outcomeOf, projectEvents, type EventLike, type SmokeFact } from '../src/relay-smoke-facts.ts'
import { T0, failure } from './relay-smoke-helpers.ts'

const RUN = 'run-1'
let seq = 0
const at = (n: number) => new Date(T0 + n * 1000).toISOString()
const ev = (type: string, data: unknown, jobId: string | null = RUN, n = ++seq): EventLike => ({ seq: n, type, createdAt: at(n), jobId, data })
const store = (relay: string, data: Record<string, unknown>) => ev('agent.note', { text: canonicalText({ relay, data }) })
const flat = (relay: string, data: Record<string, unknown>) => ev('agent.note', { text: canonicalText({ relay, ...data }) })

test('store notes and executor notes both parse, stamped with the cycle in force', () => {
  const facts = projectEvents([
    store('cycle_begin', { cycle: 1, state: 'orient', hash: 'x' }),
    store('cycle_begin', { cycle: 2, state: 'orient', hash: 'x' }),
    flat('probe', { retry: 0, correct: false, damaged: false }),
    flat('probe', { retry: 1, correct: true, damaged: true }),
    store('sealed', { cycle: 2, ledgerHash: 'h', bundleHash: 'b' }),
    flat('context_dropped', { dropped: 2, cut: 1, cycle: 2 }),
    flat('call_retry', { purpose: 'work', reason: 'runtime_meter_unavailable', retry: 1, waitMs: 5000 }),
    flat('judge_signals', { phase: 'cycle_start', cycle: 2, signals: [{ code: 'repeated_dead_end', layer: 'J1' }], unknownFacts: ['heartbeat'] }),
    ev('assistant.started', { messageId: 'm-1', model: 'relay:probe', step: 2 }),
    ev('assistant.message', { messageId: 'm-1', step: 2, text: 'hidden' }),
    ev('error', { code: 'probe_failed_twice', message: 'hidden' }),
  ], RUN)
  assert.deepEqual(facts.map(f => f.kind), ['cycle_begin', 'cycle_begin', 'probe', 'probe', 'sealed', 'context_dropped', 'call_retry', 'judge_signals', 'call_started', 'call_done', 'error'])
  const probes = facts.filter((f): f is Extract<SmokeFact, { kind: 'probe' }> => f.kind === 'probe')
  assert.deepEqual(probes.map(p => [p.cycle, p.retry, p.correct, p.damaged]), [[2, 0, false, false], [2, 1, true, true]])
  const judged = facts.find(f => f.kind === 'judge_signals') as Extract<SmokeFact, { kind: 'judge_signals' }>
  assert.deepEqual(judged.signals, ['repeated_dead_end'])
  assert.equal((facts.find(f => f.kind === 'call_started') as Extract<SmokeFact, { kind: 'call_started' }>).purpose, 'probe')
})

test('no event text, tool argument or unknown note survives projection', () => {
  const marker = 'SECRET-WORKSPACE-CONTENT'
  const facts = projectEvents([
    store('cycle_begin', { cycle: 1 }),
    ev('assistant.message', { messageId: 'm-1', step: 1, text: marker }),
    ev('tool.call', { toolCallId: 't', name: 'file_read', arguments: { path: marker } }),
    ev('tool.result', { toolCallId: 't', status: 'ok', result: marker }),
    store('note', { kind: 'decision', items: [marker] }),
    ev('agent.note', { text: `{"relay":"cap","reason":"${marker}"}` }),
    ev('error', { code: marker, message: marker }),
  ], RUN)
  assert.ok(!JSON.stringify(facts).includes(marker))
  assert.deepEqual(facts.map(f => f.kind), ['cycle_begin', 'call_done', 'cap'])
  assert.equal((facts[2] as Extract<SmokeFact, { kind: 'cap' }>).reason, 'unknown', 'a free-text reason is replaced, not echoed; an error with a free-text code is dropped')
})

test('foreign jobs, malformed notes and unreadable timestamps are ignored', () => {
  const facts = projectEvents([
    store('cycle_begin', { cycle: 1 }),
    ev('agent.note', { text: canonicalText({ relay: 'cycle_begin', data: { cycle: 9 } }) }, 'rc-child'),
    ev('agent.note', { text: '{not json' }),
    ev('agent.note', { text: 'null' }),
    ev('agent.note', { text: JSON.stringify({ relay: 'Not A Code', cycle: 3 }) }),
    store('cycle_begin', { cycle: -4 }),
    { seq: 99, type: 'agent.note', createdAt: 'not a date', jobId: RUN, data: { text: canonicalText({ relay: 'cycle_begin', data: { cycle: 3 } }) } },
  ], RUN)
  assert.deepEqual(facts.map(f => f.kind), ['cycle_begin'])
})

test('events are ordered by seq whatever the page order, and a call without a step takes the current cycle', () => {
  const late = ev('assistant.message', { messageId: 'm-2', step: null, text: '' }, RUN, 3)
  const begin = store('cycle_begin', { cycle: 4 }); begin.seq = 2; begin.createdAt = at(2)
  const facts = projectEvents([late, begin], RUN)
  assert.deepEqual(facts.map(f => [f.kind, f.cycle]), [['cycle_begin', 4], ['call_done', 4]])
})

test('the canonical form matches the relay byte for byte for sorted and unicode keys', () => {
  assert.equal(canonicalText({ b: 1, a: [{ z: null, y: 'é' }], 'Z': true }), '{"a":[{"y":"é","z":null}],"b":1,"Z":true}')
})

test('the outcome table', () => {
  const none: SmokeFact[] = []
  assert.equal(outcomeOf('completed', null, none, 'terminal'), 'passed')
  assert.equal(outcomeOf('canceled', null, none, 'terminal'), 'cancelled')
  assert.equal(outcomeOf('interrupted', null, none, 'terminal'), 'infra_error')
  assert.equal(outcomeOf('input_required', null, [failure(2, T0, 'probe_failed_twice')], 'terminal'), 'escalated')
  assert.equal(outcomeOf('input_required', null, [failure(2, T0, 'no_progress')], 'terminal'), 'escalated')
  assert.equal(outcomeOf('failed', 'runtime_meter_unavailable', none, 'terminal'), 'infra_error')
  assert.equal(outcomeOf('input_required', null, [failure(2, T0, 'relay_stopped')], 'terminal'), 'cancelled')
  assert.equal(outcomeOf('input_required', null, [failure(2, T0, 'truncation_protocol')], 'terminal'), 'failed', 'a truncated request is a harness failure, never infrastructure')
  assert.equal(outcomeOf('failed', 'cap_reached', none, 'terminal'), 'failed')
  assert.equal(outcomeOf('running', null, none, 'terminal'), 'unknown')
  assert.equal(outcomeOf('running', null, none, 'deadline'), 'cancelled', 'a deadline is the runner stopping the trial, not a model failure')
  assert.equal(outcomeOf('completed', null, none, 'aborted'), 'cancelled')
})

test('the naive-compaction notes parse into facts: the arm statement, per-cycle probe non-results and summary losses', () => {
  const facts = projectEvents([
    store('initialized', { revision: 'r', hash: 'h' }),
    flat('compaction', { mode: 'naive', attempt: ATT1, epoch: 1 }),
    store('cycle_begin', { cycle: 1 }),
    store('cycle_begin', { cycle: 2 }),
    flat('probe_not_applicable', { mode: 'naive', cycle: 2, reason: 'ledger_facts_not_shown', damaged: false }),
    flat('compaction_summary', { mode: 'naive', attempt: ATT1, cycle: 2, summaryBytes: 900, summaryLimitBytes: 4000, outputLimitTokens: 1000, truncated: true, degraded: true, degradedReason: 'narrative_output_limited', inputDropped: 3, inputCut: 1 }),
  ], RUN)
  assert.deepEqual(facts.map(f => f.kind), ['initialized', 'compaction', 'cycle_begin', 'cycle_begin', 'probe_not_applicable', 'compaction_summary'])
  assert.deepEqual(facts.filter(f => f.kind === 'probe'), [], 'a non-applicable probe is never a probe result')
  const marker = facts.find(f => f.kind === 'compaction') as Extract<SmokeFact, { kind: 'compaction' }>
  assert.deepEqual([marker.mode, marker.attempt, marker.epoch], ['naive', ATT1, 1])
  const summary = facts.find(f => f.kind === 'compaction_summary') as Extract<SmokeFact, { kind: 'compaction_summary' }>
  assert.deepEqual([summary.cycle, summary.attempt, summary.truncated, summary.degraded, summary.degradedReason, summary.inputDropped, summary.inputCut], [2, ATT1, true, true, 'narrative_output_limited', 3, 1])
  assert.deepEqual([summary.summaryBytes, summary.summaryLimitBytes, summary.outputLimitTokens], [900, 4000, 1000])
  assert.equal(armModeOf(facts, [{ attemptId: ATT1, epoch: 1 }]), 'naive')
})

test('a note field of the wrong type or shape is dropped, never coerced into a fact value', () => {
  const [marker, summary] = projectEvents([
    flat('compaction', { mode: 'naive', attempt: 'not an id!', epoch: -1 }),
    flat('compaction_summary', { mode: 'naive', attempt: 7, cycle: 1, summaryBytes: '900', summaryLimitBytes: -1, outputLimitTokens: 1.5, degraded: 'yes', degradedReason: 'Has Spaces' }),
  ], RUN) as [Extract<SmokeFact, { kind: 'compaction' }>, Extract<SmokeFact, { kind: 'compaction_summary' }>]
  assert.deepEqual([marker.attempt, marker.epoch], [null, null])
  assert.deepEqual([summary.attempt, summary.summaryBytes, summary.summaryLimitBytes, summary.outputLimitTokens, summary.degraded, summary.degradedReason], [null, null, null, null, false, null])
})

const ATT1 = 'f0000000-0000-4000-8000-000000000001', ATT2 = 'f0000000-0000-4000-8000-000000000002'
const marker = (attempt: string | null, epoch: number | null) => flat('compaction', { mode: 'naive', ...(attempt ? { attempt } : {}), ...(epoch !== null ? { epoch } : {}) })
const sealing = (...attempts: Array<[string, number]>) => attempts.map(([attemptId, epoch]) => ({ attemptId, epoch }))

test('the arm of a run is read from its own events and from nothing else', () => {
  const run = (seals: Array<{ attemptId: string; epoch: number }> | null, ...events: EventLike[]) => armModeOf(projectEvents(events, RUN), seals)
  assert.equal(run([], store('initialized', { revision: 'r' }), store('cycle_begin', { cycle: 1 })), 'ledger', 'no naive marker is a ledger run')
  assert.equal(run(sealing([ATT1, 1]), store('initialized', {}), marker(ATT1, 1)), 'naive')
  assert.equal(run([], store('initialized', {}), marker(ATT1, 1)), 'naive', 'a naive run that sealed nothing yet is still naive')
  assert.equal(run([]), 'unconfirmed', 'no readable events confirm nothing')
  assert.equal(run([], ev('agent.note', { text: canonicalText({ relay: 'compaction', mode: 'something_else', attempt: ATT1, epoch: 1 }) }), store('cycle_begin', { cycle: 1 })), 'unconfirmed', 'an unknown mode is not a ledger run')
  assert.equal(run([], store('cycle_begin', { cycle: 2 }), flat('probe_not_applicable', { mode: 'naive', cycle: 2 })), 'unconfirmed', 'naive markers without the arm statement')
  assert.equal(run([], store('cycle_begin', { cycle: 2 }), flat('compaction_summary', { mode: 'naive', attempt: ATT1, cycle: 2 })), 'unconfirmed')
})

test('a naive run must carry the marker on every attempt that sealed a cycle: a sealing attempt without one is a mixed run, never relabelled', () => {
  const run = (seals: Array<{ attemptId: string; epoch: number }> | null, ...events: EventLike[]) => armModeOf(projectEvents(events, RUN), seals)
  const begin = store('cycle_begin', { cycle: 1 })
  // naive attempt 1, then a restart in ledger mode: attempt 2 sealed and wrote no marker
  assert.equal(run(sealing([ATT1, 1], [ATT2, 2]), marker(ATT1, 1), begin), 'mixed')
  // ledger attempt 1 sealed, then a restart in naive mode: attempt 1 has no marker
  assert.equal(run(sealing([ATT1, 1], [ATT2, 2]), begin, marker(ATT2, 2)), 'mixed')
  // both attempts marked is a consistent naive run
  assert.equal(run(sealing([ATT1, 1], [ATT2, 2]), marker(ATT1, 1), begin, marker(ATT2, 2)), 'naive')
  // a ledger attempt writes `probe` notes, which a naive attempt never does
  assert.equal(run(sealing([ATT1, 1]), marker(ATT1, 1), begin, flat('probe', { retry: 0, correct: true, damaged: false })), 'mixed')
  assert.equal(run(sealing([ATT1, 1]), marker(ATT1, 1), begin, flat('probe_degraded', { cycle: 1 })), 'mixed')
  // a summary that names an attempt nobody marked, or none
  assert.equal(run(sealing([ATT1, 1]), marker(ATT1, 1), flat('compaction_summary', { mode: 'naive', attempt: ATT2, cycle: 1 })), 'unconfirmed')
  assert.equal(run(sealing([ATT1, 1]), marker(ATT1, 1), flat('compaction_summary', { mode: 'naive', cycle: 1 })), 'unconfirmed')
  // a marker that cannot be tied to an attempt, or that disagrees with the seal about the epoch
  assert.equal(run(sealing([ATT1, 1]), marker(null, 1)), 'unconfirmed')
  assert.equal(run(sealing([ATT1, 1]), marker(ATT1, null)), 'unconfirmed')
  assert.equal(run(sealing([ATT1, 2]), marker(ATT1, 1)), 'unconfirmed')
  assert.equal(run(sealing([ATT1, 2]), marker(ATT1, 1), marker(ATT1, 2)), 'unconfirmed', 'one attempt states itself once, and a later statement does not overwrite the first')
  // the seals could not be read: a naive run cannot be attributed
  assert.equal(run(null, marker(ATT1, 1), begin), 'unconfirmed')
  // a ledger run has nothing to check against: its seals are irrelevant, and a null database does not make it naive
  assert.equal(run(null, begin), 'ledger')
})
