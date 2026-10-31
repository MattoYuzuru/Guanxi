// B3 integration: behavioural pin of the notes the runner reads against the relay executor that writes them.
//
// The real RelayExecutor is driven with the server's own test fixture (the fake model of server/test/relay/naive-compaction.test.ts),
// in ledger mode and in naive mode, over a file database. What it emitted is then read back the way the runner reads a live node:
// the session events through HttpRelaySource.events (the contract's sessionEventsResponse parse) and the seals through
// SqliteLedgerReader (the real relay_seals columns), then projected, arm-confirmed and built. A renamed, retyped or dropped note
// field, or a changed marker attempt id, fails here and not in a real run.
//
// This file imports the server on purpose, like relay-smoke-drift.test.ts, so the mutation tool (which copies the bench package
// alone) does not run it. Each guard below was checked to fail when its line in the runner is removed or the server changes.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonical } from '../../server/src/relay/handoff.ts'
import { fixture, reserves } from '../../server/test/relay/fixture.ts'
import { RelayExecutor } from '../../server/src/relay/executor.ts'
import { DEFAULT_RELAY_LIMITS, type Plan } from '../../server/src/relay/types.ts'
import { armModeOf, projectEvents, type SmokeFact } from '../src/relay-smoke-facts.ts'
import { HttpRelaySource } from '../src/relay-smoke-source.ts'
import type { ArmProfile } from '../src/relay-smoke-build.ts'
import { LEDGER_ARM, config, documentOf, observation } from './relay-smoke-helpers.ts'

const item = (id: string, dependsOn: string[]) => ({ id, title: 'item ' + id, dependsOn, acceptance: ['true'], protectedPaths: ['tests'] })
const pair: Plan = { revision: 'r1', base: 'a'.repeat(40), goal: 'Implement the fixture task.', items: [item('I02', ['I01']), item('I01', [])], protectedPaths: ['.github'] }
const SUMMARY = 'SUMMARY-ONE: item I01 is verified; item I02 is next.'
const isSummary = (prompt: string) => prompt.startsWith('Summarize')
const NAIVE_ARM: ArmProfile = { id: 'naive-compaction', kind: 'naive_compaction', ledgerHandoff: false, deadEndGuard: false }
const NAIVE_CONFIG = () => config({ arms: [{ kind: 'ledger_relay', id: 'ledger-relay', enabled: false }, { kind: 'naive_compaction', id: 'naive-compaction', enabled: true }] })

/** Cycle 1 verifies I01 and hands off, cycle 2 verifies I02 and hands off (the plan is then done). */
function script(summaries: (n: number) => string = () => SUMMARY) {
  let work = 0, summary = 0
  return async (prompt: string): Promise<string> => {
    if (isSummary(prompt)) return summaries(++summary)
    const step = work++
    return canonical(step === 0 ? { action: 'verify', item: 'I01' } : step === 2 ? { action: 'verify', item: 'I02' } : { action: 'handoff' })
  }
}

type Fixture = ReturnType<typeof fixture>
/** Reads a finished fixture run exactly as the runner reads a node: events over the owner API parse, seals from the database file. */
async function observe(f: Fixture, homeDb: string) {
  const events = f.log.readAll(f.run.session_id, 'person')
  const transport: typeof fetch = async input => {
    const after = Number(new URL(String(input)).searchParams.get('after'))
    const page = events.filter(e => e.seq > after)
    return Response.json({ sessionId: f.run.session_id, events: page, nextAfter: page.at(-1)?.seq ?? after, lastSeq: events.at(-1)?.seq ?? 0, hasMore: false })
  }
  const source = new HttpRelaySource({ node: { url: 'http://127.0.0.1:1', homeDb } }, { transport })
  const page = await source.events('node', f.run.session_id, 0)
  assert.equal(page.events.length, events.length, 'every event of the session survives the owner API parse')
  const facts = projectEvents(page.events, f.run.id)
  const ledger = await source.ledger('node', f.run.id)
  assert.ok(ledger, 'the home database is readable while the node runs')
  const mode = armModeOf(facts, ledger.seals.map(s => ({ attemptId: s.attemptId, epoch: s.epoch })))
  return { facts, ledger, mode, runId: f.run.id }
}
/** The fixture clock is 2027; the document's own clock must follow the events it describes. */
function build(seen: Awaited<ReturnType<typeof observe>>, arm: ArmProfile, cfg = config()) {
  const times = seen.facts.map(f => f.atMs), first = Math.min(...times), last = Math.max(...times)
  return documentOf(observation({ arm: arm.id, runId: seen.runId, facts: seen.facts, ledger: seen.ledger, startedAtMs: first, finishedAtMs: last }), arm, cfg, last + 1_000)
}
const ofKind = <K extends SmokeFact['kind']>(facts: readonly SmokeFact[], kind: K) => facts.filter((f): f is Extract<SmokeFact, { kind: K }> => f.kind === kind)

async function withDb<T>(body: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'b3-shapes-'))
  try { return await body(join(dir, 'guanxi.db')) } finally { rmSync(dir, { recursive: true, force: true }) }
}
async function runOnce(path: string, options: { naive: boolean; summaries?: (n: number) => string }) {
  const f = fixture({ path, plan: pair, actions: script(options.summaries), ...(options.naive ? { limits: { compaction: 'naive' } } : {}) })
  await f.executor.run(f.attempt)
  assert.equal(f.store.get(f.run.id).state, 'completed')
  return f
}

test('a real naive run: the marker names the attempt that sealed, the summary notes carry the reported limits, and the probe is a non-result', async () => {
  await withDb(async path => {
    const f = await runOnce(path, { naive: true })
    try {
      const seen = await observe(f, path)
      assert.equal(seen.mode, 'naive')
      const [marker] = ofKind(seen.facts, 'compaction')
      assert.deepEqual([ofKind(seen.facts, 'compaction').length, marker!.mode, marker!.attempt, marker!.epoch], [1, 'naive', f.attempt.id, f.attempt.epoch])
      assert.deepEqual(seen.ledger.seals.map(s => s.attemptId), [f.attempt.id, f.attempt.id], 'the marker attempt id is the relay_seals.attempt_id the runner reads')
      const summaries = ofKind(seen.facts, 'compaction_summary')
      assert.deepEqual(summaries.map(s => [s.cycle, s.attempt, s.summaryBytes, s.outputLimitTokens, s.truncated, s.degraded, s.degradedReason, s.inputDropped, s.inputCut]),
        [[1, f.attempt.id, Buffer.byteLength(SUMMARY), reserves.turn, false, false, null, 0, 0], [2, f.attempt.id, Buffer.byteLength(SUMMARY), reserves.turn, false, false, null, 0, 0]])
      assert.ok(summaries.every(s => s.summaryLimitBytes !== null && s.summaryLimitBytes > Buffer.byteLength(SUMMARY)), 'the room the handoff bound leaves is read')
      assert.deepEqual(ofKind(seen.facts, 'probe_not_applicable').map(p => [p.cycle, p.damaged]), [[2, false]])
      assert.deepEqual([...ofKind(seen.facts, 'probe'), ...ofKind(seen.facts, 'probe_degraded')], [], 'a skipped probe is never a pass or a fail')
      const begins = ofKind(seen.facts, 'cycle_begin').map(c => c.cycle)
      assert.ok(ofKind(seen.facts, 'probe_not_applicable').every(p => begins.includes(p.cycle)), 'it is stamped with a cycle the run began')

      const doc = build(seen, NAIVE_ARM, NAIVE_CONFIG())
      assert.ok(doc.checked.ok, JSON.stringify(doc.checked.ok ? '' : doc.checked.issues))
      const rooms = summaries.map(x => x.summaryLimitBytes!)
      assert.deepEqual(doc.built.notes.filter(n => n.startsWith('compaction')), ['compaction_summaries:2', `compaction_summary_limit_bytes:min=${Math.min(...rooms)},max=${Math.max(...rooms)}`, `compaction_output_limit_tokens:min=${reserves.turn},max=${reserves.turn}`])
      const cycles = (doc.raw.trials[0] as { cycles: Array<{ state: string; probes?: { state: string; reason?: string } }> }).cycles
      assert.deepEqual(cycles.slice(0, 2).map(c => c.probes?.state === 'unknown' ? c.probes.reason : c.probes?.state), ['observed', 'unsupported'])
    } finally { f.close() }
  })
})

test('a real ledger run writes none of the naive notes, and its probe is a result the runner counts', async () => {
  await withDb(async path => {
    const f = await runOnce(path, { naive: false })
    try {
      const seen = await observe(f, path)
      assert.equal(seen.mode, 'ledger')
      for (const kind of ['compaction', 'compaction_summary', 'probe_not_applicable'] as const) assert.deepEqual(ofKind(seen.facts, kind), [], kind)
      assert.deepEqual(ofKind(seen.facts, 'probe').map(p => [p.cycle, p.retry, p.correct, p.damaged]), [[2, 0, true, false]])
      const doc = build(seen, LEDGER_ARM)
      assert.ok(doc.checked.ok, JSON.stringify(doc.checked.ok ? '' : doc.checked.issues))
      assert.deepEqual(doc.built.notes.filter(n => n.startsWith('compaction')), [])
      assert.deepEqual([doc.report!.arms[0]!.totals.probes.wholeAnswer.expected, doc.report!.arms[0]!.totals.probes.wholeAnswer.firstCorrect], [1, 1])
    } finally { f.close() }
  })
})

test('a real naive run reports why a summary was degraded, with the relay fixed code, and the runner keeps it per trial', async () => {
  await withDb(async path => {
    const f = await runOnce(path, { naive: true, summaries: n => { if (n === 1) throw new Error('fixture unavailable'); return SUMMARY } })
    try {
      const seen = await observe(f, path)
      assert.equal(seen.mode, 'naive')
      const [first, second] = ofKind(seen.facts, 'compaction_summary')
      assert.deepEqual([first!.degraded, first!.degradedReason, second!.degraded, second!.degradedReason], [true, 'model_failed', false, null])
      const doc = build(seen, NAIVE_ARM, NAIVE_CONFIG())
      assert.ok(doc.built.notes.includes('compaction_summary_degraded:1') && doc.built.notes.includes('compaction_summary_degraded_reasons:model_failed=1'), doc.built.notes.join('|'))
    } finally { f.close() }
  })
})

/** Attempt 1 handles one cycle and is stopped; attempt 2 resumes the same run on a node whose mode may have changed. */
async function twoAttempts(path: string, first: 'naive' | 'ledger', second: 'naive' | 'ledger', options: { secondStopsBeforeSealing?: boolean } = {}) {
  let n = 0
  const holder: { executor: { stop(): void } } = { executor: { stop() {} } }
  const later: { executor: { stop(): void } } = { executor: { stop() {} } }
  const f = fixture({ path, plan: pair, limits: first === 'naive' ? { compaction: 'naive' } : {}, actions: async prompt => {
    if (isSummary(prompt)) return SUMMARY
    ++n
    if (n === 2) holder.executor.stop()
    // The second attempt's first work call: it has oriented (a ledger attempt has probed) and is stopped before it can seal.
    if (n === 3 && options.secondStopsBeforeSealing) { later.executor.stop(); return canonical({ action: 'tool', name: 'file_read', args: { output: 'x' } }) }
    return canonical({ action: 'handoff' })
  } })
  holder.executor = f.executor
  await f.executor.run(f.attempt)
  assert.equal(f.store.get(f.run.id).state, 'input_required')
  const next = f.store.decide(f.run.id)
  f.relay.recover(next)
  const executor = new RelayExecutor(f.relay, f.model, f.workspace, f.executor.reserves, f.scrubber, { ...DEFAULT_RELAY_LIMITS, ...(second === 'naive' ? { compaction: 'naive' } : {}) })
  later.executor = executor
  await executor.run(next)
  return { f, next }
}

test('real attempts of both modes in one run are mixed, whichever order the node restart put them in; two naive attempts are one naive run', async () => {
  for (const [first, second, expected] of [['naive', 'ledger', 'mixed'], ['ledger', 'naive', 'mixed'], ['naive', 'naive', 'naive']] as const) {
    await withDb(async path => {
      const { f, next } = await twoAttempts(path, first, second)
      try {
        const seen = await observe(f, path)
        const sealers = new Set(seen.ledger.seals.map(s => s.attemptId))
        assert.ok(sealers.has(f.attempt.id) && sealers.has(next.id), `${first} then ${second}: both attempts sealed a cycle`)
        assert.equal(seen.mode, expected, `${first} then ${second}`)
        assert.deepEqual(ofKind(seen.facts, 'compaction').map(m => m.attempt), [first === 'naive' ? f.attempt.id : null, second === 'naive' ? next.id : null].filter(Boolean))
      } finally { f.close() }
    })
  }
})

test('a ledger attempt that probed and was stopped before it sealed leaves no marker and no seal, but its probe still shows the run is mixed', async () => {
  await withDb(async path => {
    const { f, next } = await twoAttempts(path, 'naive', 'ledger', { secondStopsBeforeSealing: true })
    try {
      const seen = await observe(f, path)
      assert.deepEqual([...new Set(seen.ledger.seals.map(s => s.attemptId))], [f.attempt.id], 'the ledger attempt sealed nothing')
      assert.deepEqual(ofKind(seen.facts, 'compaction').map(m => m.attempt), [f.attempt.id], 'and wrote no marker')
      assert.deepEqual(ofKind(seen.facts, 'probe').map(p => p.cycle), [Math.max(...seen.ledger.seals.map(x => x.cycle)) + 1], 'but, in the cycle after the last seal, it asked the ledger probe, which a naive attempt never does')
      assert.ok(next.id !== f.attempt.id)
      assert.equal(seen.mode, 'mixed')
    } finally { f.close() }
  })
})
