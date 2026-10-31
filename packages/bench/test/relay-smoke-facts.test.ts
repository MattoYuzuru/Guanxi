import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalText, outcomeOf, projectEvents, type EventLike, type SmokeFact } from '../src/relay-smoke-facts.ts'
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
