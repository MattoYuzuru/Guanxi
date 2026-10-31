// Drift guards against the server this runner reads. These import the server's own source on purpose; they are the
// only B3-b tests that do, so the mutation tool (which copies the bench package alone) does not run them.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { canonical, hash } from '../../server/src/relay/handoff.ts'
import { RELAY_MIGRATION } from '../../server/src/relay/store.ts'
import { DURABLE_RUNS_MIGRATION } from '../../server/src/runs/schema.ts'
import { canonicalText, outcomeOf, sha256Hex } from '../src/relay-smoke-facts.ts'
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
