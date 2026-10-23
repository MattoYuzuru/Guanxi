/** The owner's Claude Code stands in as the ACP fixture agent (the one the K5 and LW suites use): the production boot wires K5 and LW
 * from the home's `lead` section, the lead delegates through `guanxi_delegate`, and the plan runs on the executor. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeTokens } from '../fixtures/fake-llama-server.ts'
import { createLiveWorld, until, type LiveWorld, pinLifecycle } from './live-world.ts'

const HOUR = 3_600_000
function brief(w: LiveWorld, overrides: Record<string, unknown> = {}) {
  const connectionId = w.home.find('started')!['connectionId']
  return { objective: 'Produce one green artifact per item', definitionOfDone: ['every item gate is green in a clean checkout'],
    plan: { revision: 'r1', base: w.base, goal: 'Write ms1-<item>.txt for each item and prove it.', protectedPaths: [],
      items: ['i1', 'i2'].map((id, i) => ({ id, title: `artifact ${id}`, dependsOn: i ? ['i1'] : [], acceptance: ['grep', '-q', `ms1-green-${id}`, `ms1-${id}.txt`], protectedPaths: [] })) },
    caps: { cycles: 40, tokens: 2_000_000, moneyMicros: 500_000, wallMs: 12 * HOUR }, executor: { connectionId, model: 'fixture' },
    deadlineMs: 8 * HOUR, onDeadline: 'wrap_up', onCancel: 'cancel', ...overrides }
}

test('the lead delegates through the production boot, sleeps, and the plan runs on the executor until one wake', async t => {
  const w = await createLiveWorld(t, { lead: true })
  await w.registerProject()
  assert.ok(w.leadConnection, 'the home reports its lead connection')
  const started = await w.restartHomeWithLead(brief(w))
  const login = w.home.find('lead-login')!
  assert.match(login['executable'], /fixture-agent\.mjs$/); assert.deepEqual(login['args'], ['auth', 'login']); assert.ok(login['environment']['CLAUDE_CONFIG_DIR'], 'the vendor sign-in runs in the private config directory K5 uses')
  const lead = started['runId'] as string

  assert.equal((await w.home.wait('lead-first', 90_000))['outcome'], 'hibernated', 'the delegating turn ends in hibernation, not in an answer')
  assert.ok(w.agentEvents().some(e => e.event === 'tool_list' && e['tools'].includes('guanxi_delegate')))
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM lead_delegations WHERE lead_run_id=?', lead), 1)
  await until(() => w.agentEvents().filter(e => e.event === 'prompt' && String(e['text']).includes('guanxi.wake/v1')).length === 1, 'the lead to be woken', 240_000)
  await until(() => w.home.one<{ state: string }>('SELECT state FROM durable_runs WHERE id=?', lead)?.state === 'completed', 'the resumed lead to finish', 120_000)

  const wakes = w.home.rows('SELECT wake_seq,acknowledged_at FROM outbox WHERE run_id=?', lead)
  assert.equal(wakes.length, 1, 'exactly one wake'); assert.ok(wakes[0]!['acknowledged_at'])
  const relayRow = w.home.rows<{ run_id: string; status: string }>('SELECT run_id,status FROM relay_public_starts')
  assert.equal(relayRow.length, 1); assert.equal(relayRow[0]!.status, 'completed')
  assert.deepEqual(w.ledger(relayRow[0]!.run_id).items, { i1: 'done', i2: 'done' })
  const posts = await w.fake.requests('/completion')
  assert.ok(posts.length >= 4)
  assert.equal(w.home.count("SELECT COUNT(*) AS n FROM durable_runs WHERE id LIKE 'rc-%' AND state='completed'"), posts.length, 'one remote child per call, all on the executor')
  assert.deepEqual(w.home.rows<{ input_tokens: number }>("SELECT input_tokens FROM run_costs WHERE entry_key LIKE 'remote-dispatch:%'").map(r => r.input_tokens).sort((a, b) => a - b),
    posts.map(post => fakeTokens(post.body.prompt, true)).sort((a, b) => a - b))
  assert.equal(pinLifecycle(w.toExecutor.requests.filter(r => r.path === '/attempts/runtime/pin').map(r => r.action)).ok, true)
  assert.deepEqual(w.executor.rows('SELECT id FROM federation_streams'), [])
  assert.deepEqual(w.tripwire.requests, [])
  // The lead is billed for its own turns only (delegating turn and resumed turn); the executor's tokens are never the lead's.
  assert.ok(w.home.rows<{ entry_key: string }>('SELECT entry_key FROM run_costs WHERE run_id=?', lead).every(row => row.entry_key.startsWith('lead-turn:')))
})

test('a restart that is asked to start the lead again does not start a second one', async t => {
  const w = await createLiveWorld(t, { lead: true })
  await w.registerProject()
  await w.restartHomeWithLead(brief(w, { executor: { connectionId: w.home.find('started')!['connectionId'], model: 'some-other-model' } }))
  await w.home.wait('lead-first', 90_000)
  await until(() => w.home.count("SELECT COUNT(*) AS n FROM durable_runs WHERE state='completed'") >= 1, 'the refused lead to finish', 90_000)
  const before = w.home.count('SELECT COUNT(*) AS n FROM lead_sessions')
  assert.equal(before, 1)
  await w.home.stop()
  w.home.spawn(['--lead-prompt-file', `${w.dir}/lead-prompt.txt`, '--project', w.projectId])
  await w.home.wait('started'); await w.home.wait('lead-exists')
  assert.equal(w.home.find('lead-started'), undefined, 'no second lead was started')
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM lead_sessions'), before)
})

test('the owner\'s configuration binds the lead: an executor or caps beyond the configuration are refused, nothing hibernates and no relay starts', async t => {
  const cases: Array<[string, (w: LiveWorld) => Record<string, unknown>, RegExp]> = [
    ['an executor model the owner never allowed', w => brief(w, { executor: { connectionId: w.home.find('started')!['connectionId'], model: 'some-other-model' } }), /executor_not_allowed/],
    ['a money cap above the configured ceiling', w => brief(w, { caps: { ...brief(w).caps, moneyMicros: 5_000_000 } }), /delegation_exceeds_policy: (caps\.)?moneyMicros/],
    ['detaching from the run', w => brief(w, { onCancel: 'detach' }), /delegation_exceeds_policy: onCancel/],
  ]
  for (const [what, make, expected] of cases) {
    const w = await createLiveWorld(t, { lead: true })
    await w.registerProject()
    const started = await w.restartHomeWithLead(make(w))
    await w.home.wait('lead-first', 90_000)
    await until(() => w.home.one<{ state: string }>('SELECT state FROM durable_runs WHERE id=?', started['runId'])?.state === 'completed', 'the lead to finish', 60_000)
    const answer = w.agentEvents().filter(e => e.event === 'tool_answer')[0]!
    assert.equal(answer['isError'], true, what); assert.match(String(answer['text']), expected, what)
    assert.equal(w.home.count('SELECT COUNT(*) AS n FROM lead_delegations'), 0, `${what}: nothing was delegated`)
    assert.equal(w.home.count('SELECT COUNT(*) AS n FROM promises WHERE parent_id=?', started['runId']), 0)
    assert.equal(w.home.count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='relay_public_starts'") === 0 || w.home.count('SELECT COUNT(*) AS n FROM relay_public_starts') === 0, true)
    assert.equal((await w.fake.requests('/completion')).length, 0); assert.deepEqual(w.toExecutor.requests.filter(r => /offers|dispatch|pin/.test(r.path)), [])
    await w.close()
  }
})

test('a lead that cannot be set up fails the start and leaves nothing running', async t => {
  const w = await createLiveWorld(t, { lead: true, start: false })
  w.patchHome(config => { config.home.lead.claudeExecutable = join(w.dir, 'absent-claude') })
  w.executor.spawn(); await w.executor.wait('started')
  w.home.spawn()
  const failed = await w.home.wait('failed')
  assert.ok(failed['code'], 'a code names what failed')
  assert.equal((await w.home.exit).code, 1, 'the node exited non-zero')
  assert.equal(w.home.alive, false, 'and it is not left running half-configured')
  await assert.rejects(fetch(w.home.url + '/api/health'), 'its listeners are closed')
})
