// Drift guards against the server this runner reads. These import the server's own source on purpose; they are the
// only B3-b tests that do, so the mutation tool (which copies the bench package alone) does not run them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { serve } from '@hono/node-server'
import { relayStartInputSchema } from '@guanxi/contract'
import { Hono } from 'hono'
import { canonical, hash } from '../../server/src/relay/handoff.ts'
import { relayStartRoutes } from '../../server/src/relay/routes.ts'
import { RELAY_MIGRATION } from '../../server/src/relay/store.ts'
import { DURABLE_RUNS_MIGRATION } from '../../server/src/runs/schema.ts'
import { canonicalText, outcomeOf, sha256Hex } from '../src/relay-smoke-facts.ts'
import { HttpRelaySource, SmokeSourceError } from '../src/relay-smoke-source.ts'
import { RELAY_TABLES_DDL, RUN_COSTS_DDL } from './relay-smoke-db-fixture.ts'

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

test('the fixture tables are the server tables', () => {
  for (const statement of RELAY_TABLES_DDL.split(';').map(squash).filter(Boolean)) assert.ok(squash(RELAY_MIGRATION).includes(statement), statement.slice(0, 40))
  const server = /CREATE TABLE run_costs \([\s\S]*?\n  \);/.exec(DURABLE_RUNS_MIGRATION)
  assert.ok(server, 'the R1 cost table moved')
  assert.equal(squash(RUN_COSTS_DDL), squash(server[0]))
})

test('the canonical form and hash used to re-verify seals are the relay own', () => {
  for (const sample of [{ b: [1, { z: 'é', A: null }], a: true, Z: 'x', n: -0.5, s: 'quote"\n' }, [], 'plain', { 'ß': 1, ss: 2, B: 3, a: 4 }]) {
    assert.equal(canonicalText(sample), canonical(sample))
    assert.equal(sha256Hex(canonicalText(sample)), hash(sample))
  }
})

test('the stop codes the outcome table classifies are codes the relay can actually produce', () => {
  const executor = readFileSync(new URL('../../server/src/relay/executor.ts', import.meta.url), 'utf8')
  for (const code of ['probe_failed_twice', 'no_progress', 'truncation_protocol', 'relay_stopped']) assert.ok(executor.includes(`'${code}'`), code)
  assert.equal(outcomeOf('input_required', null, [], 'terminal'), 'failed')
})

const read = (relative: string) => readFileSync(new URL(`../../server/src/${relative}`, import.meta.url), 'utf8')

test('the JSON shapes the reader and the fact projection depend on are the ones the relay writes', () => {
  const types = read('relay/types.ts')
  assert.ok(types.includes('export interface Evidence { id: string; item: string; head: string; ok: boolean; output: string }'), 'ledger evidence rows')
  assert.ok(types.includes('items: Record<string, \'open\' | \'verification_requested\' | \'done\'>'), 'ledger item statuses')
  assert.match(types, /head: string; files: string\[\]; diffstat: string; evidence: Evidence\[\]/, 'ledger head and evidence')
  assert.match(types, /ledgerHash: string; ledger: \{ ref: string; strip: string; head: string; revision: string \}; notes: Note\[\]; narrative: string; degraded: boolean; bundleHash: string/, 'handoff hashes')
  const executor = read('relay/executor.ts')
  assert.ok(executor.includes("canonical({ relay: 'probe', retry, correct, damaged })"), 'probe note')
  assert.ok(executor.includes("canonical({ relay: 'context_dropped', dropped, cut, cycle })"), 'context_dropped note')
  assert.ok(executor.includes("canonical({ relay: 'call_failed_reason', runId: a.run_id, purpose, reason })"), 'call_failed_reason note')
  assert.ok(executor.includes("relay: 'judge_signals', phase, cycle, signals, unknownFacts: summary.unknownFacts"), 'judge_signals note')
  assert.ok(executor.includes("{ type: 'assistant.started', data: { messageId: id, model: 'relay:' + purpose, step: l.cycle } }"), 'call start event')
  assert.ok(executor.includes("{ type: 'assistant.message', data: { messageId: id, step: l.cycle, text: reply.text } }"), 'call message event')
  assert.ok(executor.includes("this.store.runs.recordCost(a, { key: id,"), 'the cost key is the message id')
  const store = read('relay/store.ts')
  assert.ok(store.includes("emit({ type: 'agent.note', jobId: runId, data: { text: canonical({ relay: action, data }) } })"), 'store note envelope')
  assert.ok(store.includes("this.event(emit, a.run_id, action, { cycle: l.cycle, state: l.state, hash: hash(l) })"), 'cycle_begin data carries the cycle')
  assert.ok(store.includes("this.event(emit, a.run_id, 'sealed', { cycle: l.cycle, ledgerHash: h.ledgerHash, bundleHash: byteHash(bundle) })"), 'sealed data')
  assert.ok(store.includes("l.cycle++; l.state = 'orient'"), 'the cycle counter increments in the cycle_begin change')
})

test('the real relay routes accept the requests the HTTP source sends, over a real loopback socket', async () => {
  const calls: string[] = []
  const status = (key: string, state = 'running') => ({ key, runId: 'run-1', sessionId: 'ses-1', status: state, error: null, source: 'start-owner', observedAt: '2026-11-01T00:00:00.000Z', confidence: 'observed', runtime: null, runtimeAgeMs: null, meter: null, reserves: null })
  const service = {
    start: async (input: { key: string }) => { calls.push('start'); return status(input.key) },
    status: (key: string) => { calls.push('status'); if (key === 'missing') throw Object.assign(new Error('relay_not_found'), { code: 'relay_not_found' }); return status(key) },
    stop: async (key: string) => { calls.push('stop'); return status(key, 'canceled') },
    keyForRun: (run: string) => run,
  }
  const app = new Hono().route('/api/relay', relayStartRoutes(() => service as never))
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  try {
    const { port } = server.address() as { port: number }
    const source = new HttpRelaySource({ a: { url: `http://127.0.0.1:${port}` } })
    const input = relayStartInputSchema.parse({ key: 'k1', projectId: 'p', connectionId: 'c', model: 'm', consent: 'full-access', domains: [], caps: { cycles: 3, tokens: null, moneyMicros: 0, wallMs: null },
      plan: { revision: 'r', base: 'a'.repeat(40), goal: 'g', protectedPaths: [], items: [{ id: 'I01', title: 't', dependsOn: [], acceptance: ['node', '--test', 'test/x.test.mjs'], protectedPaths: [] }] } })
    assert.equal((await source.start('a', input)).status, 'running', 'a strict JSON start body is accepted (content type, schema)')
    assert.equal((await source.status('a', 'k1')).key, 'k1')
    assert.equal((await source.stop('a', 'k1')).status, 'canceled', 'the stop body is the strict empty object')
    await assert.rejects(source.status('a', 'missing'), (error: unknown) => error instanceof SmokeSourceError && error.code === 'relay_not_found')
    assert.deepEqual(calls, ['start', 'status', 'stop', 'status'])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
