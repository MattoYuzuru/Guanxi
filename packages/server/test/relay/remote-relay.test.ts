import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RelayStartInput } from '@guanxi/contract'
import type { SignedDispatchGrant } from '@guanxi/contract/federation'
import { OwnedCheckoutAllocator } from '../../src/relay/checkout.ts'
import { REMOTE_RELAY_COUNTER_SOURCE, REMOTE_RELAY_PROPS_SOURCE } from '../../src/relay/remote-runtime.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { fakeRender, fakeTokens, type FakeLlamaState } from '../fixtures/fake-llama-server.ts'
import { caps, reserves } from './fixture.ts'
import { relayScript, remoteFixture, until, type RemoteOptions } from './remote-fixture.ts'

const exec = promisify(execFile), sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** The R2-op end-to-end shape, with the relay on the home node and every model call on the executor node. */
async function fixture(t: { after(fn: () => unknown): void }, options: RemoteOptions & { fake?: Partial<FakeLlamaState>; projectFails?: boolean; transientRetryMs?: number[] } = {}) {
  // Match the K4 fixtures: Colima shares the checkout, not macOS tmpdir().
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'remote-relay-')))
  const source = join(parent, 'project'), checkouts = join(parent, 'checkouts')
  await mkdir(join(source, 'src'), { recursive: true }); await writeFile(join(source, 'src', 'item.txt'), 'synthetic task content')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd: source })).stdout.trim()
  await git(['init', '-q', '-b', 'main']); await git(['add', '.']); await git(['commit', '-q', '-m', 'fixture'])
  const base = await git(['rev-parse', 'HEAD'])
  const f = await remoteFixture(t, { ...options, dir: parent, fake: { replies: [relayScript], ...options.fake } })
  const relayStore = new RelayStore(f.home.db, f.home.runs, f.home.scrubber, () => f.home.time)
  let allocations = 0
  const allocator = new OwnedCheckoutAllocator({ root: checkouts })
  // Transient-call retries wait in real time; these fixtures retry only when a test asks for it.
  const host = { runtime: f.source, reserves, clock: () => f.home.time, nodePorts: () => [4417, 5217], limits: { transientRetryMs: options.transientRetryMs ?? [] },
    project: async (id: string) => options.projectFails ? Promise.reject(new Error('project unavailable')) : ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: f.home.time }),
    allocate: (async (policy, signal) => { allocations++; return allocator.allocate(policy, signal) }) as NonNullable<ConstructorParameters<typeof RelayStarts>[6]['allocate']> }
  const starts = new RelayStarts(f.home.db, f.home.runs, f.home.log, f.h.connections, f.home.scrubber, relayStore, host)
  const input: RelayStartInput = { key: 'remote-key', projectId: 'project', connectionId: f.homeConnection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base, goal: 'Read the fixture and run acceptance.',
      items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['/usr/bin/true'], protectedPaths: [] }], protectedPaths: [] }, caps }
  t.after(async () => {
    await starts.close()
    await chmod(checkouts, 0o700).catch(() => undefined)
    let quarantined = false
    for (const name of await readdir(checkouts).catch(() => [] as string[])) {
      if ((await readdir(join(checkouts, name, 'runtime', 'native-cleanup')).catch(() => [] as string[])).length) quarantined = true
    }
    if (!quarantined) await rm(parent, { recursive: true, force: true })
  })
  return { ...f, relayStore, starts, input, allocations: () => allocations, holdings: () => readdir(checkouts).catch(() => [] as string[]),
    errors: (sessionId: string) => f.home.log.readAll(sessionId, 'person').filter(event => event.type === 'error').map(event => (event.data as { code: string }).code) }
}
const grantsOf = (f: Awaited<ReturnType<typeof fixture>>) => f.sent.filter(s => s.path === '/attempts/dispatch').map(s => (s.body as SignedDispatchGrant).grant)

test('a relay run on the home node completes with every model call executed and counted on the executor', async t => {
  const f = await fixture(t)
  const lead = f.home.runs.create({ id: 'lead', sessionId: 'lead-session' }), leadAttempt = f.home.runs.start(lead.id)
  f.home.runs.recordCost(leadAttempt, { key: 'lead-prior', inputTokens: 5, outputTokens: 7, costMicrounits: null, currency: 'unknown' })
  const leadBefore = JSON.stringify([f.home.runs.costs('lead'), f.costs('lead'), f.home.runs.get('lead')])
  const receipt = await f.starts.start(f.input)
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  const status = f.starts.status(f.input.key)
  assert.equal(status.status, 'completed', JSON.stringify({ errors: f.errors(receipt.sessionId!), error: status.error }))
  assert.equal(f.relayStore.read(receipt.runId!).items.one, 'done')
  // Admission facts come from the executor, with their own sources and the executor's loaded window.
  assert.equal(status.runtime?.source, REMOTE_RELAY_PROPS_SOURCE); assert.equal(status.runtime?.contextTokens, 16000)
  assert.match(status.runtime!.digest, /^sha256:[0-9a-f]{64}$/); assert.equal(status.runtime?.runtimeVersion, 'llama-server/b0-fixture')
  assert.equal(status.meter?.source, REMOTE_RELAY_COUNTER_SOURCE); assert.equal(status.meter?.measurement, 'exact_rendered_request')
  // One grant per call, one completion per grant, and the evaluated string is the counted string.
  const posts = await f.completions(), grants = grantsOf(f)
  assert.ok(posts.length >= 4, 'work steps plus the fresh narrative were dispatched')
  assert.equal(grants.length, posts.length)
  const H = 16000 - reserves.turn - reserves.safety
  for (const post of posts) {
    const tokens = fakeTokens(post.body.prompt, true), grant = grants.find(g => g.job.counted!.renderedSha256 === sha(post.body.prompt))
    assert.ok(grant, 'every evaluated prompt is exactly a rendering that was counted and granted')
    assert.equal(grant.job.counted!.tokens, tokens); assert.ok(tokens <= H, `request of ${tokens} tokens exceeds the hard ceiling ${H}`)
    assert.equal(post.body.n_predict, reserves.turn)
    assert.equal(sha(fakeRender(grant.job.messages[0]!.content, { template: 'chat' }, false)), grant.job.counted!.renderedSha256)
  }
  assert.deepEqual(f.errors(receipt.sessionId!), [], 'no protocol error: every evaluated count equalled the executor\'s exact count')
  // Remote tokens: the child ledgers hold them, the relay run keeps its own cap accounting, the lead is untouched.
  let remoteIn = 0
  for (const grant of grants) {
    const rows = f.costs(grant.offer.runId)
    assert.equal(rows.length, 1); assert.equal(rows[0]!.entry_key, `remote-dispatch:${grant.offer.id}`)
    assert.equal(rows[0]!.input_tokens, grant.job.counted!.tokens); assert.equal(f.home.runs.get(grant.offer.runId).state, 'completed')
    remoteIn += rows[0]!.input_tokens
  }
  const relayRows = f.costs(receipt.runId!)
  assert.ok(relayRows.length >= 4); assert.ok(relayRows.every(row => !row.entry_key.startsWith('remote-dispatch:')))
  assert.equal(relayRows.reduce((sum, row) => sum + row.input_tokens, 0), remoteIn, 'the relay and the executor agree on the tokens that were evaluated')
  assert.equal(JSON.stringify([f.home.runs.costs('lead'), f.costs('lead'), f.home.runs.get('lead')]), leadBefore, 'the lead run is unchanged')
  // The sanctioned session total never mixes the two views of the same tokens: children are reported separately.
  const totals = f.home.federation.attemptDispatch!.sessionCosts(receipt.sessionId!)
  assert.equal(totals.own.reduce((n, c) => n + c.inputTokens, 0), remoteIn, 'the relay run\'s own accounting, without its children')
  assert.equal(totals.relayChildren.reduce((n, c) => n + c.inputTokens, 0), remoteIn, 'the executor\'s reports, kept apart')
  assert.equal(totals.relayChildren.length, 1); assert.equal(totals.own.length, 1)
  // Nothing ran on the home: its governor was never used and the executor released its own.
  assert.equal(f.hg.snapshot().activeLease, null); assert.equal(f.tg.snapshot().activeLease, null)
  await until(async () => (await f.holdings()).length === 0)
  assert.equal(f.allocations(), 1)
  const replay = await f.starts.start(f.input); assert.equal(replay.runId, receipt.runId)
  assert.equal((await f.completions()).length, posts.length, 'an identical retry dispatches nothing')
})

test('stop during a remote call waits for the executor to acknowledge the cancel and leaves nothing running there', async t => {
  const f = await fixture(t, { fake: { completionDelayMs: 4000 } })
  const order: string[] = []
  f.afters.push(path => { if (path === '/attempts/dispatch-cancel') order.push('ack') })
  const receipt = await f.starts.start(f.input)
  await until(async () => (await f.fake.count('/completion')) === 1)
  const stopped = await f.starts.stop(f.input.key); order.push('stopped')
  assert.equal(stopped.status, 'canceled'); assert.deepEqual(order, ['ack', 'stopped'])
  const [grant] = grantsOf(f)
  assert.equal(f.target.federation.attemptDispatch!.state(grant!.id).status, 'canceled')
  await f.target.federation.attemptDispatch!.settled(grant!.id)
  assert.equal(f.tg.snapshot().activeLease, null); assert.equal((await f.completions()).length, 1)
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'canceled'); assert.equal(f.home.runs.get(receipt.runId!).state, 'canceled')
  await until(async () => (await f.holdings()).length === 0)
})

test('an executor that evaluates another token count fails the whole run closed after one dispatch', async t => {
  const f = await fixture(t, { fake: { evaluatedSkew: 1 } }), receipt = await f.starts.start(f.input)
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
  assert.deepEqual(f.errors(receipt.sessionId!), ['model_failed'])
  assert.equal((await f.completions()).length, 1, 'no fallback estimate and no second attempt')
  assert.notEqual(f.relayStore.read(receipt.runId!).items.one, 'done'); assert.notEqual(f.home.runs.get(receipt.runId!).state, 'completed')
  await until(async () => (await f.holdings()).length === 0)
})

test('an executor that stops answering leaves the relay interrupted for the owner, never completed', async t => {
  const f = await fixture(t, { fake: { completionDelayMs: 400 }, ttlMs: 300, safetyMs: 50, transientRetryMs: [1, 1] }), receipt = await f.starts.start(f.input)
  await until(async () => (await f.fake.count('/completion')) === 1)
  f.rules.push(() => { throw new Error('fixture partition') })
  f.home.time += 5_000                       // the child's holder lease lapses; the relay's own lease is still valid
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
  assert.notEqual(f.home.runs.get(receipt.runId!).state, 'completed')
  const [grant] = grantsOf(f)
  assert.equal(f.home.runs.get(grant!.offer.runId).state, 'interrupted'); assert.equal(f.costs(grant!.offer.runId).length, 0)
  assert.equal((await f.completions()).length, 1)
  // A partition that outlasts every retry wait still ends the relay: each retry was announced and none reached the executor.
  assert.equal(f.home.log.readAll(receipt.sessionId!, 'person').filter(e => e.type === 'agent.note' && e.data.text.includes('"call_retry"')).length, 2)
})

test('a dropped link during the first offer is retried and the run completes', async t => {
  const f = await fixture(t, { transientRetryMs: [1, 1, 1] })
  let offers = 0
  f.rules.push(path => { if (path === '/attempts/offers' && ++offers === 1) throw new Error('fixture partition') })
  const receipt = await f.starts.start(f.input)
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  const status = f.starts.status(f.input.key)
  assert.equal(status.status, 'completed', JSON.stringify({ errors: f.errors(receipt.sessionId!), error: status.error }))
  assert.ok(offers >= 2, 'the transport failure was retried')
  const notes = f.home.log.readAll(receipt.sessionId!, 'person').filter(e => e.type === 'agent.note').map(e => (e.data as { text: string }).text)
  const retries = notes.filter(text => text.includes('"call_retry"'))
  assert.ok(retries.some(text => text.includes('"reason":"runtime_meter_unavailable"')), JSON.stringify(retries))
})

test('an executor that does not serve the relay runtime refuses admission before any run, session or allocation exists', async t => {
  const f = await fixture(t, { noRelayRuntime: true })
  await assert.rejects(f.starts.start(f.input), /runtime_meter_unavailable/)
  assert.equal(f.allocations(), 0); assert.equal((await f.completions()).length, 0)
  for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.home.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
})

test('a relay run the executor has not pinned gets no evidence: it stops before any dispatch', async t => {
  const f = await fixture(t)
  f.forgePinAck()
  const receipt = await f.starts.start(f.input)
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  assert.equal(f.starts.status(f.input.key).status, 'input_required')
  assert.deepEqual(f.errors(receipt.sessionId!), ['runtime_identity_unknown'])
  assert.equal(f.seen.includes('/attempts/offers'), false); assert.equal((await f.completions()).length, 0)
  assert.equal(f.home.db.prepare("SELECT COUNT(*) n FROM durable_runs WHERE id LIKE 'rc-%'").get()!.n, 0, 'no child run was created')
})

test('a refused run pin rolls the whole start back, and a start that fails after admission releases its remote session', async t => {
  const refused = await fixture(t)
  refused.refusePin()
  await assert.rejects(refused.starts.start(refused.input), /runtime_meter_unavailable/)
  for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(refused.home.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
  assert.equal(refused.seen.includes('/attempts/offers'), false); assert.equal((await refused.completions()).length, 0)
  await until(async () => (await refused.holdings()).length === 0)
  const sessions: Array<{ observe(reference: string, signal: AbortSignal): Promise<unknown> }> = []
  const failing = await fixture(t, { projectFails: true }), open = failing.remote.open.bind(failing.remote)
  failing.remote.open = () => { const session = open(); sessions.push(session); return session }
  await assert.rejects(failing.starts.start(failing.input))
  assert.equal(sessions.length, 1)
  await assert.rejects(sessions[0]!.observe(failing.remote.model, new AbortController().signal), /relay_stopped/)
  for (const table of ['durable_runs', 'sessions']) assert.equal(failing.home.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
})

test('a start whose run creation fails after the pin unpins the executor and creates no run', async t => {
  const f = await fixture(t), open = f.remote.open.bind(f.remote)
  f.remote.open = () => { const session = open(); session.bind = () => { throw new Error('bind refused after the pin') }; return session }
  await assert.rejects(f.starts.start(f.input))
  const messages = f.sent.filter(s => s.path === '/attempts/runtime/pin').map(s => (s.body as { action: string }).action)
  assert.deepEqual(messages, ['pin', 'unpin'])
  assert.deepEqual(f.target.db.prepare('SELECT id FROM federation_streams').all(), [])
  for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.home.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
  await until(async () => (await f.holdings()).length === 0)
})

test('a completed relay run leaves no pin on the executor', async t => {
  const f = await fixture(t), receipt = await f.starts.start(f.input)
  await until(() => !['running', 'preparing'].includes(f.starts.status(f.input.key).status))
  assert.equal(f.starts.status(f.input.key).status, 'completed')
  assert.deepEqual(f.target.db.prepare('SELECT id FROM federation_streams').all(), [], receipt.runId!)
})
