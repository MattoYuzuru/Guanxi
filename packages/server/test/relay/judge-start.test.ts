/** R3-remote: the judge of a public relay start, on a relay whose inference runs on another node and on a stock local one. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RelayStartInput } from '@guanxi/contract'
import type { SignedDispatchGrant } from '@guanxi/contract/federation'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import { relayPlugin } from '../../src/relay/plugin.ts'
import { ledgerJudgeInput, relayJudgeModel, startHostWithJudge, type RelayStartJudgeContext, type RelayStartJudgeSource } from '../../src/relay/judge-start.ts'
import { judgeUnknownFacts } from '../../src/relay/judge-host.ts'
import { evaluateJudgeSignals } from '../../src/relay/judge-signals.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { fakeTokens, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'
import { caps, reserves } from './fixture.ts'
import { JUDGE_PROMPT, judgeRole, relayAndGarbledJudgeScript, relayAndJudgeScript, signalPolicy, startBrief } from './judge-fixture.ts'
import { remoteFixture, until, type RemoteOptions } from './remote-fixture.ts'

const exec = promisify(execFile), sha = (text: string) => createHash('sha256').update(text).digest('hex')
const judgePrompt = (prompt: string) => prompt.startsWith(`<|user|>\n${JUDGE_PROMPT}`)

/** The remote relay of `remote-relay.test.ts`, with a judge source on the start host. */
async function fixture(t: { after(fn: () => unknown): void }, options: RemoteOptions & { hostClockSkew?: number; fake?: Partial<FakeLlamaState>; judge?: () => RelayStartJudgeSource | undefined } = {}) {
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'judge-start-')))
  const source = join(parent, 'project'), checkouts = join(parent, 'checkouts')
  await mkdir(join(source, 'src'), { recursive: true }); await writeFile(join(source, 'src', 'item.txt'), 'synthetic task content')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: source })).stdout.trim()
  await git(['init', '-q', '-b', 'main']); await git(['add', '.']); await git(['commit', '-q', '-m', 'fixture'])
  const base = await git(['rev-parse', 'HEAD'])
  const f = await remoteFixture(t, { ...options, dir: parent, fake: { replies: [relayAndJudgeScript], ...options.fake } })
  const relayStore = new RelayStore(f.home.db, f.home.runs, f.home.scrubber, () => f.home.time)
  let allocations = 0
  const allocator = new OwnedCheckoutAllocator({ root: checkouts })
  const input: RelayStartInput = { key: 'remote-judge-key', projectId: 'project', connectionId: f.homeConnection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base, goal: 'Read the fixture and run acceptance.',
      items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['/usr/bin/true'], protectedPaths: [] }], protectedPaths: [] }, caps }
  const host = { runtime: f.source, reserves, clock: () => f.home.time + (options.hostClockSkew ?? 0), nodePorts: () => [4432, 5232],
    project: async (id: string) => ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: f.home.time }),
    allocate: (async (policy, signal) => { allocations++; return allocator.allocate(policy, signal) }) as NonNullable<ConstructorParameters<typeof RelayStarts>[6]['allocate']>,
    ...(options.judge ? { judge: options.judge() } : {}) }
  const starts = new RelayStarts(f.home.db, f.home.runs, f.home.log, f.h.connections, f.home.scrubber, relayStore, host)
  t.after(async () => {
    await starts.close()
    await chmod(checkouts, 0o700).catch(() => undefined)
    let quarantined = false
    for (const name of await readdir(checkouts).catch(() => [] as string[])) {
      if ((await readdir(join(checkouts, name, 'runtime', 'native-cleanup')).catch(() => [] as string[])).length) quarantined = true
    }
    if (!quarantined) await rm(parent, { recursive: true, force: true })
  })
  const notes = (sessionId: string) => (f.home.db.prepare("SELECT payload FROM session_events WHERE session_id=? AND type='agent.note' ORDER BY seq").all(sessionId) as Array<{ payload: string }>)
    .map(row => { try { return JSON.parse((JSON.parse(row.payload) as { text: string }).text) as Record<string, any> } catch { return {} as Record<string, any> } })
    .filter(note => typeof note['relay'] === 'string')
  const finish = async () => { await until(() => !['running', 'preparing'].includes(starts.status(input.key).status)); return starts.status(input.key) }
  return { ...f, host, relayStore, starts, input, notes, finish, allocations: () => allocations, holdings: () => readdir(checkouts).catch(() => [] as string[]),
    errors: (sessionId: string) => f.home.log.readAll(sessionId, 'person').filter(event => event.type === 'error').map(event => (event.data as { code: string }).code),
    grants: () => f.sent.filter(s => s.path === '/attempts/dispatch').map(s => (s.body as SignedDispatchGrant).grant) }
}
/** The host's judge for the remote relay: the signals layer, and J2 on the relay's own runtime through its own meter. */
const remoteJudge = (overrides: { signals?: boolean; cascade?: boolean; samples?: 2 | 3 } = {}): RelayStartJudgeSource => context => ({
  ...(overrides.signals === false ? {} : { signals: ledgerJudgeInput(signalPolicy, context.clock) }),
  ...(overrides.cascade === false ? {} : { cascade: { brief: startBrief(context.input, { executorNodeId: 'target', samples: overrides.samples }),
    model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } }),
})

test('the judge option reaches the executor through the public start: signals on every cycle boundary and J2 verdicts evaluated by the executor node', async t => {
  const f = await fixture(t, { judge: () => remoteJudge() })
  const receipt = await f.starts.start(f.input), status = await f.finish()
  assert.equal(status.status, 'completed', JSON.stringify({ errors: f.errors(receipt.sessionId!), error: status.error }))
  assert.equal(f.relayStore.read(receipt.runId!).items.one, 'done')
  const notes = f.notes(receipt.sessionId!), cycles = f.relayStore.read(receipt.runId!).cycle
  // Signals: one observation at cycle_start and one at pre_seal of every cycle, none of them a health claim (heartbeat, lease, disk are unknown).
  const signals = notes.filter(note => note['relay'] === 'judge_signals')
  assert.deepEqual(signals.map(note => [note['cycle'], note['phase']]), Array.from({ length: cycles }, (_, i) => [i + 1, 'cycle_start']).flatMap(([cycle, phase], i) => [[cycle, phase], [i + 1, 'pre_seal']]))
  assert.ok(signals.every(note => note['unknownFacts'].includes('heartbeat') && note['unknownFacts'].includes('lease') && note['unknownFacts'].includes('disk')))
  assert.ok(signals.every(note => ['failureStreak', 'editRevert', 'deadEnds', 'pathEdits', 'crash', 'itemTokens'].every(name => note['unknownFacts'].includes(name))),
    'what the ledger has no fact for is published as unknown, not as zero')
  // Verdicts: two samples per phase, each a real call on the executor, each counted by the executor first.
  const posts = await f.completions(), judgePosts = posts.filter(post => judgePrompt(post.body.prompt))
  assert.equal(judgePosts.length, 2 * 2 * cycles, 'two samples at each of the two boundaries of every cycle')
  const grants = f.grants()
  assert.equal(grants.length, posts.length, 'one grant per completion, judge or relay')
  assert.ok(posts.filter(post => !judgePrompt(post.body.prompt)).every(post => post.body.n_predict === reserves.turn), 'while the relay\'s own calls keep the relay turn')
  for (const post of judgePosts) {
    const text = post.body.prompt as string
    assert.match(text, /"watchdog":\{"ref":"signals:[0-9a-f]+","state":"observed","summary":/, 'the judge is shown the signals summary')
    assert.ok(text.includes('"unknownFacts":["heartbeat","lease","disk","tokenBudget","failureStreak","editRevert","deadEnds","pathEdits","crash","itemTokens"]'), 'and told what was not observed')
  }
  for (const post of judgePosts) {
    const grant = grants.find(g => g.job.counted!.renderedSha256 === sha(post.body.prompt))
    assert.ok(grant, 'the judge prompt that was evaluated is exactly a rendering the executor counted and was granted')
    assert.equal(grant.job.counted!.tokens, fakeTokens(post.body.prompt, true), 'the executor\'s count is the evaluated count')
    assert.equal(post.body.n_predict, 700, 'the judge\'s own output ceiling, not the relay turn')
  }
  const results = f.home.db.prepare('SELECT layer,state FROM relay_judge_requests WHERE run_id=?').all(receipt.runId!) as Array<{ layer: string; state: string }>
  t.diagnostic(`cycles=${cycles} posts=${posts.length} judgePosts=${judgePosts.length}`)
  assert.equal(results.length, 2 * cycles); assert.ok(results.every(row => row.layer === 'J2' && row.state === 'completed'))
  assert.deepEqual(f.errors(receipt.sessionId!), [])
})

test('judge cost lands in the R1 ledger the way remote relay calls do (the executor-reported tokens on the call\'s child run) and is never added to the relay run\'s own rows', async t => {
  const f = await fixture(t, { judge: () => remoteJudge() })
  const receipt = await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  const posts = await f.completions(), grants = f.grants()
  let judgeChildTokens = 0, relayChildTokens = 0
  for (const grant of grants) {
    const rows = f.costs(grant.offer.runId), post = posts.find(p => sha(p.body.prompt) === grant.job.counted!.renderedSha256)!
    assert.equal(rows.length, 1, 'exactly one cost row per remote call, judge or relay'); assert.equal(rows[0]!.entry_key, `remote-dispatch:${grant.offer.id}`)
    assert.equal(rows[0]!.input_tokens, grant.job.counted!.tokens)
    if (judgePrompt(post.body.prompt)) judgeChildTokens += rows[0]!.input_tokens; else relayChildTokens += rows[0]!.input_tokens
  }
  assert.ok(judgeChildTokens > 0 && relayChildTokens > 0)
  const relayRows = f.costs(receipt.runId!)
  assert.ok(relayRows.every(row => !row.entry_key.startsWith('remote-dispatch:')))
  assert.equal(relayRows.reduce((n, row) => n + row.input_tokens, 0), relayChildTokens, 'the relay run\'s own rows hold only its own calls: the judge is not double counted against its caps')
  // The relay caps see the judge only as the cascade's pre-debit: tokenReserve per sample, no settlement to actuals.
  const ledger = f.relayStore.read(receipt.runId!), samples = 2 * 2 * ledger.cycle
  assert.equal(ledger.tokens, relayRows.reduce((n, row) => n + row.input_tokens + row.output_tokens, 0) + samples * 13000)
  const totals = f.home.federation.attemptDispatch!.sessionCosts(receipt.sessionId!)
  assert.equal(totals.own.reduce((n, c) => n + c.inputTokens, 0), relayChildTokens, 'the relay\'s own accounting, without its children')
  assert.equal(totals.relayChildren.reduce((n, c) => n + c.inputTokens, 0), relayChildTokens + judgeChildTokens, 'children are kept apart and hold the judge\'s too')
})

test('signals alone work on a remote relay with no judge model: observations are published and no extra call is made', async t => {
  const f = await fixture(t, { judge: () => remoteJudge({ cascade: false }) })
  const receipt = await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  const notes = f.notes(receipt.sessionId!)
  assert.ok(notes.filter(note => note['relay'] === 'judge_signals').length >= 2)
  assert.equal(notes.filter(note => /^judge_(prepared|dispatched|result)$/.test(note['relay'])).length, 0, 'no model layer')
  assert.equal((await f.completions()).filter(post => judgePrompt(post.body.prompt)).length, 0)
  assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'relay_judge%'").get()!.n, 0, 'the additive judge ledger is not even opened')
})

test('no judge source: a remote relay publishes no judge event and makes no judge call, exactly as before', async t => {
  const f = await fixture(t)
  const receipt = await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  assert.equal(f.notes(receipt.sessionId!).filter(note => String(note['relay']).startsWith('judge')).length, 0)
  assert.equal((await f.completions()).filter(post => judgePrompt(post.body.prompt)).length, 0)
  assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'relay_judge%'").get()!.n, 0)
})

test('a concurrent and a later replay of the same start dispatch no second judge call', async t => {
  const f = await fixture(t, { judge: () => remoteJudge() })
  const [receipt, again] = await Promise.all([f.starts.start(f.input), f.starts.start(f.input)])
  assert.equal(again.runId, receipt.runId); assert.equal((await f.finish()).status, 'completed')
  const judged = async () => (await f.completions()).filter(post => judgePrompt(post.body.prompt)).length
  assert.equal(await judged(), 4, 'two samples at each of the two boundaries of the one cycle, once')
  assert.equal(f.home.db.prepare('SELECT COUNT(*) n FROM relay_judge_requests').get()!.n, 2)
  const posts = (await f.completions()).length, replay = await f.starts.start(f.input)
  assert.equal(replay.runId, receipt.runId); assert.equal((await f.completions()).length, posts)
})

test('the plugin-level default reaches the public start, and a start host\'s own source wins over it', async t => {
  const f = await fixture(t), calls = { own: 0, fallback: 0 }
  const provided = new Map<string, any>()
  const services: Record<string, unknown> = { 'runs.durable': { store: f.home.runs }, 'connections.registry': f.h.connections, 'session.log': f.home.log, 'egress.scrubber': f.home.scrubber }
  const apply = (config: Parameters<typeof relayPlugin.apply>[1]) => {
    relayPlugin.apply({ service: (name: string) => services[name], provide: (name: string, service: unknown) => { provided.set(name, service) }, effect: () => undefined } as never, config)
    return provided.get('agent.relay') as { publicStarts: RelayStarts }
  }
  const fallback: RelayStartJudgeSource = () => { calls.fallback++; throw new Error('default judge') }
  const own: RelayStartJudgeSource = () => { calls.own++; throw new Error('own judge') }
  await assert.rejects(apply({ db: f.home.db, startHost: f.host, judge: fallback }).publicStarts.start(f.input), /judge_config_invalid/)
  assert.deepEqual(calls, { own: 0, fallback: 1 }, 'the default was consulted')
  await assert.rejects(apply({ db: f.home.db, startHost: { ...f.host, judge: own }, judge: fallback }).publicStarts.start({ ...f.input, key: 'second' }), /judge_config_invalid/)
  assert.deepEqual(calls, { own: 1, fallback: 1 }, 'the host\'s own source replaced it')
})

// ---- fail closed: nothing exists when the judge cannot be admitted ------------------------------------------------------

const refusals: Array<[string, (context: RelayStartJudgeContext) => ReturnType<RelayStartJudgeSource>]> = [
  ['the source throws', () => { throw new Error('judge host exploded with a path /Users/x') }],
  ['the brief was written for another plan', context => ({ cascade: { brief: startBrief({ ...context.input, plan: { ...context.input.plan, revision: 'other' } }), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the brief asks for other caps than the start', context => ({ cascade: { brief: startBrief({ ...context.input, caps: { ...context.input.caps, cycles: 3 } }), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the brief is malformed', context => ({ cascade: { brief: { ...startBrief(context.input), version: 2 } as never, model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the judge model cannot sample', context => ({ cascade: { brief: startBrief(context.input), model: { admit: async () => true } as never } })],
  ['the signals policy is invalid', () => ({ signals: { policy: { ...signalPolicy, tokenBlowupRatio: 1 }, collect: async () => { throw new Error('unreachable') } } })],
  ['the signals collector is missing', () => ({ signals: { policy: signalPolicy } as never })],
  ['the source returns something that is not a judge', () => 'judge' as never],
  ['the source is asynchronous (a promise is not a judge)', context => Promise.resolve({ cascade: { brief: startBrief(context.input), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } }) as never],
  ['the brief names a judge role on another model than the runtime that counts', context => ({ cascade: { brief: startBrief(context.input, { j2: judgeRole(context.input.connectionId, 'another-model') }), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the brief names a judge role on another connection than the runtime that counts', context => ({ cascade: { brief: startBrief(context.input, { j2: judgeRole('another-connection', context.input.model) }), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the meter is counted by one runtime and would be dispatched on another (async counter, no transport)', context => ({ cascade: { brief: startBrief(context.input),
    model: relayJudgeModel({ ...context, meter: { ...context.meter, transport: undefined } }, { accountId: 'local', maxAgeMs: 10_000 }) } })],
  ['the meter is not exact', context => ({ cascade: { brief: startBrief(context.input), model: relayJudgeModel({ ...context, meter: { ...context.meter, countIsExact: false } }, { accountId: 'local', maxAgeMs: 10_000 }) } })],
]
for (const [name, source] of refusals) {
  test(`fail closed before anything exists: ${name}`, async t => {
    const f = await fixture(t, { judge: () => source })
    await assert.rejects(f.starts.start(f.input), (error: Error) => error.message === 'judge_config_invalid')
    for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.home.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
    assert.equal(f.sent.filter(s => s.path === '/attempts/runtime/pin').length, 0, 'the executor was never asked to pin a run that cannot exist')
    assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'relay_judge%'").get()!.n, 0, 'the judge ledger was not even opened')
    assert.deepEqual(f.target.db.prepare('SELECT id FROM federation_streams').all(), [])
    assert.equal((await f.completions()).length, 0)
    await until(async () => (await f.holdings()).length === 0)
    assert.throws(() => f.starts.status(f.input.key), /relay_not_found/, 'the failed start leaves no entry that a retry would replay')
  })
}

// ---- degrade: a judge that fails never blocks or corrupts the run ------------------------------------------------------------

test('a judge that answers in prose is recorded as invalid and the run still completes on its own gates', async t => {
  const f = await fixture(t, { fake: { replies: [relayAndGarbledJudgeScript] }, judge: () => remoteJudge() })
  const receipt = await f.starts.start(f.input), status = await f.finish()
  assert.equal(status.status, 'completed', JSON.stringify(f.errors(receipt.sessionId!)))
  const ledger = f.relayStore.read(receipt.runId!)
  assert.equal(ledger.items.one, 'done'); assert.ok(ledger.evidence.some(e => e.item === 'one' && e.ok && e.head === ledger.head), 'done because its own gate passed at the final head')
  const rows = f.home.db.prepare('SELECT state,payload FROM relay_judge_requests WHERE run_id=?').all(receipt.runId!) as Array<{ state: string; payload: string }>
  assert.ok(rows.length >= 2 && rows.every(row => row.state === 'invalid' && JSON.parse(row.payload).code === 'judge_invalid_output'))
  assert.deepEqual(f.errors(receipt.sessionId!), [])
})

test('a judge that cannot fit its evidence in its input ceiling is unavailable before any judge call, and the run completes', async t => {
  const f = await fixture(t, { judge: () => context => ({ cascade: { brief: startBrief(context.input, { executorNodeId: 'target', j2: { connectionId: context.input.connectionId, model: 'fixture', windowTokens: 16000, maxInputTokens: 20, maxOutputTokens: 1000, temperature: 0, tokenReserve: 1020, moneyReserveMicros: 0 } }),
    model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } }) })
  const receipt = await f.starts.start(f.input), status = await f.finish()
  assert.equal(status.status, 'completed'); assert.equal(f.relayStore.read(receipt.runId!).items.one, 'done')
  assert.equal((await f.completions()).filter(post => judgePrompt(post.body.prompt)).length, 0, 'the oversized judge prompt was never evaluated')
  const rows = f.home.db.prepare('SELECT state,payload FROM relay_judge_requests WHERE run_id=?').all(receipt.runId!) as Array<{ state: string; payload: string }>
  assert.ok(rows.length >= 2 && rows.every(row => row.state === 'unavailable' && JSON.parse(row.payload).code === 'judge_context_ceiling'))
})

test('an executor that evaluates another token count than it counted gives the judge no verdict: the call fails closed like the relay\'s', async t => {
  const f = await fixture(t, { fake: { evaluatedSkew: 1 }, judge: () => remoteJudge() })
  const receipt = await f.starts.start(f.input); await f.finish()
  const rows = f.home.db.prepare('SELECT state FROM relay_judge_requests WHERE run_id=? ORDER BY created_at').all(receipt.runId!) as Array<{ state: string }>
  assert.ok(rows.length >= 1 && rows.every(row => row.state !== 'completed'), 'a judge whose count and evaluation disagree has no verdict')
  assert.notEqual(f.relayStore.read(receipt.runId!).items.one, 'done', 'and the relay itself fails closed on the same disagreement')
})

test('stop during a remote judge call waits for the executor to acknowledge the cancel and leaves nothing running there', async t => {
  const f = await fixture(t, { fake: { completionDelayMs: 4000 }, judge: () => remoteJudge() })
  const order: string[] = []
  f.afters.push(path => { if (path === '/attempts/dispatch-cancel') order.push('ack') })
  const receipt = await f.starts.start(f.input)
  await until(async () => (await f.fake.count('/completion')) === 1)
  assert.ok(judgePrompt((await f.completions())[0]!.body.prompt), 'the first call of a judged cycle is the judge\'s, at cycle_start')
  const stopped = await f.starts.stop(f.input.key); order.push('stopped')
  assert.equal(stopped.status, 'canceled'); assert.deepEqual(order, ['ack', 'stopped'])
  const [grant] = f.grants()
  await f.target.federation.attemptDispatch!.settled(grant!.id)
  assert.equal(f.tg.snapshot().activeLease, null); assert.equal((await f.completions()).length, 1)
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled'); assert.equal(f.home.runs.get(receipt.runId!).state, 'canceled')
  const rows = f.home.db.prepare('SELECT state FROM relay_judge_requests WHERE run_id=?').all(receipt.runId!) as Array<{ state: string }>
  // The cancel revokes the fence, so the cascade cannot append an outcome: the row stays as dispatched (R3 recovery abandons it later), never a verdict.
  assert.deepEqual(rows.map(row => row.state), ['dispatched'])
  await until(async () => (await f.holdings()).length === 0)
})

test('a signals collector that fails keeps its existing fail-closed rule: a fixed code, the ledger retained, no pin left', async t => {
  const f = await fixture(t, { judge: () => context => ({ signals: { policy: signalPolicy, collect: async () => { throw new Error('collector failed at /Users/x/secret') } }, ...remoteJudge({ signals: false })(context) }) })
  const receipt = await f.starts.start(f.input), status = await f.finish()
  assert.equal(status.status, 'input_required'); assert.deepEqual(f.errors(receipt.sessionId!), ['judge_observation_unavailable'])
  assert.notEqual(f.home.runs.get(receipt.runId!).state, 'completed'); assert.equal(f.relayStore.read(receipt.runId!).cycle, 1, 'the ledger is retained')
  assert.deepEqual(f.target.db.prepare('SELECT id FROM federation_streams').all(), [])
  assert.equal(JSON.stringify(f.home.log.readAll(receipt.sessionId!, 'person')).includes('secret'), false)
})

test('the plugin-level default is used only when the start host has no judge of its own', () => {
  const own: RelayStartJudgeSource = () => undefined, fallback: RelayStartJudgeSource = () => undefined
  const host = { project: async () => { throw new Error('unused') }, nodePorts: () => [] }
  assert.equal(startHostWithJudge(host, undefined), host, 'nothing to add: the same host')
  assert.equal(startHostWithJudge(host, fallback).judge, fallback)
  assert.equal(startHostWithJudge({ ...host, judge: own }, fallback).judge, own, 'a start host\'s own source wins')
  assert.equal(startHostWithJudge({ ...host, judge: own }, undefined).judge, own)
})

test('the default collector reports what the ledger holds, leaves the rest unknown, and raises no_progress and deadline from it', async () => {
  const ledger = { cycle: 4, noProgress: 3, startedAt: 1_000, caps: { wallMs: 5_000 } } as never
  const input = ledgerJudgeInput(signalPolicy, () => 6_500)
  const observation = await input.collect({ attempt: { id: 'a', runId: 'r', epoch: 1, token: 1 }, ledger, signal: new AbortController().signal })
  assert.deepEqual([observation.cycle, observation.noProgressCycles, observation.deadlineAt, observation.observedAt], [4, 3, 6_000, 6_500])
  assert.deepEqual([observation.heartbeatAt, observation.lease, observation.disk, observation.tokenBudgetForItem], [null, null, null, null], 'unknown, not healthy')
  assert.deepEqual(input.unobserved, ['failureStreak', 'editRevert', 'deadEnds', 'pathEdits', 'crash', 'itemTokens'], 'the zeros the shape requires are declared unobserved')
  assert.deepEqual(evaluateJudgeSignals(observation, signalPolicy).map(signal => signal.code), ['deadline', 'no_progress'])
  assert.deepEqual(judgeUnknownFacts(observation, input.unobserved), ['heartbeat', 'lease', 'disk', 'tokenBudget', 'failureStreak', 'editRevert', 'deadEnds', 'pathEdits', 'crash', 'itemTokens'])
  const open = await ledgerJudgeInput(signalPolicy, () => 6_500).collect({ attempt: { id: 'a', runId: 'r', epoch: 1, token: 1 },
    ledger: { cycle: 1, noProgress: 0, startedAt: 1_000, caps: { wallMs: null } } as never, signal: new AbortController().signal })
  assert.equal(open.deadlineAt, null); assert.deepEqual(evaluateJudgeSignals(open, signalPolicy), [])
})

test('an asynchronous judge source that rejects is refused and its rejection is handled: the host process stays alive and prints nothing', async () => {
  const child = await exec(process.execPath, [new URL('./judge-start-reject-child.ts', import.meta.url).pathname])
  assert.equal(child.stdout, 'refused: judge_config_invalid\nalive\n')
  assert.equal(child.stderr, '', 'no unhandled-rejection report, and none of the source\'s own text')
})

test('the judge context carries the relay store\'s clock, the one the ledger and the signals deadline are in', async t => {
  const seen: number[] = []
  const f = await fixture(t, { hostClockSkew: 7, judge: () => context => { seen.push(context.clock()); return undefined } })
  await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  assert.deepEqual(seen, [f.relayStore.clock()], 'not the start host\'s own clock, which may be kept apart from the store\'s')
})
