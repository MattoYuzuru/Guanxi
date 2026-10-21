import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, htmlReport } from '../src/report.ts'
import { selectCorpus } from '../src/corpus.ts'
import { schedule, validatePlan, validateRecordedPlan, validateResults } from '../src/protocol.ts'
import { decodeAgentExec, fixtureExecutor, remoteCommand, harborExecutor } from '../src/runner.ts'
import { plan } from './helpers.ts'

test('infra errors and tainted trials are excluded from BOTH paired arms, counted separately from failures', async () => {
  const p = plan({ seeds: [0, 1, 2] })
  const trials = await fixtureExecutor({ 'task-0:candidate:1': 'infra_error', 'task-1:control:2': 'infra_tainted', 'task-2:candidate:0': 'failed' }).run(p)
  const result = analyze(p, trials)
  assert.equal(result.summaries[1]!.failed, 1)
  assert.equal(result.summaries[1]!.infraErrors, 1)
  assert.equal(result.summaries[0]!.infraTainted, 1)
  assert.equal(result.comparisons[0]!.pairs, 8)
  assert.deepEqual(result.comparisons[0]!.excluded, ['task-0', 'task-1'])
  assert.equal(result.comparisons[0]!.stats!.ci.clusters, 8)
  assert.deepEqual(result.comparisons[0]!.stats!.flips, [{ task: 'task-2', control: 1, candidate: 2 / 3 }])
  assert.equal(result.infraWarning, true)
})
test('strict pairing refuses missing, duplicated, foreign, invalid and unaccounted-for results', async () => {
  const p = plan(); const rows = await fixtureExecutor().run(p) as any[]
  assert.throws(() => validateResults(p, rows.slice(1)), /missing_trials/)
  assert.throws(() => validateResults(p, [...rows, rows[0]]), /duplicate_trial/)
  assert.throws(() => validateResults(p, [{ ...rows[0], seed: 500 }, ...rows.slice(1)]), /unexpected/)
  assert.throws(() => validateResults(p, [{ ...rows[0], costMicrousd: null }, ...rows.slice(1)]), /unknown_billing/)
  assert.throws(() => validateResults(p, [{ ...rows[0], secret: 'hidden' }, ...rows.slice(1)]))
  assert.throws(() => validateResults(p, [{ ...rows[0], costMicrousd: -1 }, ...rows.slice(1)]))
})
test('task/seed/model pairing is deterministic and arm order is counterbalanced', () => {
  const p = plan()
  const trials = schedule(p)
  assert.deepEqual(trials.slice(0, 4).map(t => t.arm.id), ['control', 'candidate', 'candidate', 'control'])
  assert.equal(trials.length, 20)
  assert.throws(() => validatePlan({ ...p, seeds: [0, 0] }), /duplicate_protocol_key/)
  assert.throws(() => validatePlan({ ...p, mode: 'noise-floor' }), /five_seeds/)
  assert.throws(() => validatePlan({ ...p, mode: 'ab' }), /50_fresh/)
  assert.throws(() => validatePlan({ ...p, apiKey: 'forbidden' }))
})
test('selects exactly 50 fresh SWE-rebench and 30 Verified metadata records with a reproducible digest', () => {
  const now = new Date('2026-10-21T00:00:00Z')
  const select = (raw: unknown[], window: { from: string; through: string }) => selectCorpus(raw, window, now)
  const candidates = Array.from({ length: 90 }, (_, i) => ({ ...plan().tasks[0]!, id: `task-${String(i).padStart(3, '0')}`, suite: i < 60 ? 'swe-rebench' : 'verified' }))
  const window = { from: '2026-10-01', through: '2026-10-21' }
  const corpus = select(candidates, window)
  assert.equal(corpus.tasks.filter(t => t.suite === 'swe-rebench').length, 50)
  assert.equal(corpus.tasks.filter(t => t.suite === 'verified').length, 30)
  assert.equal(select([...candidates].reverse(), window).sha256, corpus.sha256)
  const oldPlan = { ...plan(), mode: 'ab', tasks: corpus.tasks.map(t => ({ ...t, published: '2020-01-01' })) }
  assert.equal(validateRecordedPlan(oldPlan).tasks.length, 80)
  assert.throws(() => select(candidates, { from: '2026-02-30', through: '2026-10-21' }), /invalid_fresh_window/)
  const boundary = candidates.map(t => ({ ...t, published: '2026-09-20' }))
  assert.equal(select(boundary, { from: '2026-09-01', through: '2026-09-20' }).tasks.length, 80)
  assert.throws(() => select(boundary, { from: '2026-09-01', through: '2026-09-19' }), /too_wide/)
  assert.throws(() => select(candidates.slice(11), window), /50_fresh/)
  assert.throws(() => select(candidates.map(t => ({ ...t, published: '2020-01-01' })), window), /50_fresh/)
  assert.throws(() => select(candidates, { from: '2020-01-01', through: '2026-10-21' }), /too_wide/)
  assert.throws(() => select(candidates, { from: '2020-01-01', through: '2020-01-21' }), /too_wide/)
  assert.throws(() => validatePlan({ ...plan(), mode: 'ab', tasks: corpus.tasks.map(t => ({ ...t, published: '2020-01-01' })) }, now), /stale_ab_corpus/)
})
test('standalone report contains separate infra columns, task flips and no scripts/network; public mode has no task IDs', async () => {
  const p = plan(); const rows = validateResults(p, await fixtureExecutor({ 'task-0:candidate:0': 'failed' }).run(p))
  const html = htmlReport(p, rows)
  assert.match(html, /Infra errors/); assert.match(html, /task-0/)
  assert.match(html, /default-src 'none'/); assert.doesNotMatch(html, /<script|https?:\/\//)
  assert.doesNotMatch(htmlReport(p, rows, true), /task-0|\/tasks\//)
  assert.match(html, /holdout and guardrails/)
})
test('transport always changes to dedicated user, clears inherited environment and rejects command/path injection', () => {
  const command = remoteCommand({ ssh: 'bench-test', root: '/home/guanxi-bench/b1' }).join(' ')
  assert.match(command, /sudo -n -u guanxi-bench env -i/)
  assert.match(command, /cd \/tmp/); assert.match(command, /XDG_RUNTIME_DIR=\/run\/user\/1001/)
  assert.match(command, /\.venv\/bin\/python/)
  assert.doesNotMatch(command, /fedora|8080|workstation-|--privileged|--gpus/)
  for (const ssh of ['-oProxyCommand=bad', 'fedora;bad', 'host user']) assert.throws(() => remoteCommand({ ssh, root: '/home/guanxi-bench/b1' }))
  for (const root of ['/tmp/bench', '/home/yuzuru/b1', '/home/guanxi-bench/../bad']) assert.throws(() => remoteCommand({ ssh: 'host', root }))
})
test('Guanxi exec adapter validates the exact K4 stdout schema without treating completion as hidden-test success', () => {
  assert.deepEqual(decodeAgentExec({ version: 1, sessionId: 's', status: 'completed', text: 'private text', error: null }), { completed: true, status: 'completed' })
  assert.throws(() => decodeAgentExec({ version: 2, status: 'completed' }))
  assert.throws(() => decodeAgentExec({ version: 1, sessionId: 's', status: 'completed', text: '', error: null, key: 'forbidden' }))
})

test('stock host executor refuses unsupported experiments before spawning SSH', async () => {
  await assert.rejects(harborExecutor({ ssh: 'must-not-be-contacted', root: '/home/guanxi-bench/b1' }).run(plan()), /host_fixture_envelope_required/)
})
