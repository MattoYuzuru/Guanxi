/** The judge on the production boot: `home.judge` gives every relay this home starts its R3 judge, through the pairing. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fakeTokens } from '../fixtures/fake-llama-server.ts'
import { cli, createLiveWorld, JUDGE_PROMPT, until, type LiveWorld } from './live-world.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
async function completed(w: LiveWorld, key: string) {
  await until(async () => ['completed', 'failed', 'interrupted', 'input_required'].includes((await w.relayStatus(key)).status), `relay ${key} to end`, 180_000)
  return w.relayStatus(key)
}
const isJudge = (post: { body: { prompt: string } }) => post.body.prompt.startsWith(JUDGE_PROMPT)

test('without home.judge a live relay has no judge: no signal event, no judge sample, no judge ledger', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  assert.equal((await w.startRelay('no-judge', 1)).status, 202)
  const status = await completed(w, 'no-judge'); assert.equal(status.status, 'completed')
  assert.deepEqual(w.notes(status.sessionId).filter(note => String(note['relay']).startsWith('judge')), [])
  assert.ok((await w.fake.requests('/completion')).every(post => !isJudge(post)))
})

test('home.judge with signals only: every cycle boundary of a live relay emits a judge signal event, and nothing the ledger cannot see is called healthy', async t => {
  const w = await createLiveWorld(t, { judge: 'signals' })
  await w.registerProject()
  assert.equal((await w.startRelay('signals', 2)).status, 202)
  const status = await completed(w, 'signals'); assert.equal(status.status, 'completed', JSON.stringify(status))
  const cycles = w.ledger(status.runId).cycle
  const signals = w.notes(status.sessionId).filter(note => note['relay'] === 'judge_signals')
  assert.equal(signals.length, 2 * cycles, 'one observation at the start and one before the seal of every cycle')
  assert.deepEqual(signals.map(note => note['phase']).slice(0, 2), ['cycle_start', 'pre_seal'])
  assert.ok(signals.every(note => ['heartbeat', 'lease', 'disk', 'failureStreak', 'crash'].every(name => note['unknownFacts'].includes(name))), 'unknown stays unknown')
  assert.ok((await w.fake.requests('/completion')).every(post => !post.body.prompt.startsWith(JUDGE_PROMPT)), 'signals take no model call')
})

test('home.judge with a cascade: J2 samples run on the executor through the pairing, each counted and granted like a relay call, with the configured ceiling', async t => {
  const w = await createLiveWorld(t, { judge: 'cascade' })
  await w.registerProject()
  assert.equal((await w.startRelay('cascade', 2)).status, 202)
  const status = await completed(w, 'cascade'); assert.equal(status.status, 'completed', JSON.stringify(status))
  const relay = status.runId as string, cycles = w.ledger(relay).cycle
  const posts = await w.fake.requests('/completion'), judgePosts = posts.filter(isJudge)
  assert.equal(judgePosts.length, 2 * 2 * cycles, 'two samples at each of the two boundaries of every cycle')
  assert.ok(judgePosts.every(post => post.body.n_predict === 700), 'the judge\'s own output ceiling')
  assert.ok(posts.filter(post => !isJudge(post)).every(post => post.body.n_predict === 1000), 'and the relay keeps its turn')
  // One executor grant per completion, judge or relay; the evaluated prompt is the one the executor counted.
  const grants = w.executor.rows<{ grant: string }>('SELECT grant FROM remote_dispatch_holders').map(row => JSON.parse(row.grant).grant)
  assert.equal(grants.length, posts.length)
  for (const post of judgePosts) {
    const grant = grants.find(g => g.job.counted.renderedSha256 === sha(post.body.prompt))
    assert.ok(grant, 'the evaluated judge prompt is a counted rendering'); assert.equal(grant.job.counted.tokens, fakeTokens(post.body.prompt, true))
  }
  const rows = w.home.rows<{ layer: string; state: string }>('SELECT layer,state FROM relay_judge_requests WHERE run_id=?', relay)
  assert.equal(rows.length, 2 * cycles); assert.ok(rows.every(row => row.layer === 'J2' && row.state === 'completed'))
  assert.deepEqual(w.tripwire.requests, [])
  // Both layers ran: the signals layer is not replaced by the cascade.
  assert.equal(w.notes(status.sessionId).filter(note => note['relay'] === 'judge_signals').length, 2 * cycles)
})

test('a judge sample that cannot fit the observed window refuses the start before anything exists, and preflight says so first', async t => {
  const w = await createLiveWorld(t, { judge: { cascade: { maxInputTokens: 15000, maxOutputTokens: 2000 } } })
  await w.registerProject()
  const pre = await cli(['preflight', '--config', w.homeConfig, '--json'], { HOME: w.dir })
  const check = (JSON.parse(pre.out) as { checks: Array<{ id: string; code?: string; fix?: string }> }).checks.find(c => c.id === 'judge')
  assert.equal(pre.code, 1); assert.equal(check?.code, 'judge_exceeds_window'); assert.match(check!.fix!, /maxInputTokens/)
  const response = await w.startRelay('too-big', 1)
  assert.deepEqual([response.status, response.body], [503, { code: 'judge_config_invalid' }])
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM durable_runs'), 0, 'no run'); assert.equal((await w.fake.requests('/completion')).length, 0)
  assert.deepEqual(w.executor.rows('SELECT id FROM federation_streams'), [], 'and no pin')
})
