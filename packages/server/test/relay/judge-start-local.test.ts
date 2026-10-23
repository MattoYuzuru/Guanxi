/** R3-remote: the same public-start judge on a stock local (Ollama) relay, whose behaviour must be unchanged. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { RelayStartInput, RunningModel } from '@guanxi/contract'
import { runFixture, RUN_TIME } from '../fixtures/durable-runs.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { ledgerJudgeInput, relayJudgeModel, type RelayStartJudgeSource } from '../../src/relay/judge-start.ts'
import { Connections } from '../../src/connections/service.ts'
import { ConnectionStore } from '../../src/connections/store.ts'
import { Vault } from '../../src/vault/vault.ts'
import { BalanceProbes } from '../../src/probes/balances.ts'
import { OllamaClient } from '../../src/ollama/client.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { caps, reserves } from './fixture.ts'
import { JUDGE_PROMPT, judgeVerdict, signalPolicy, startBrief } from './judge-fixture.ts'

const exec = promisify(execFile)
async function until(predicate: () => boolean) {
  for (let n = 0; n < 2000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('fixture did not reach expected state')
}

async function fixture(t: { after(fn: () => unknown): void }, options: { judge?: RelayStartJudgeSource; judgeReply?: string } = {}) {
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const parent = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'judge-local-')))
  const source = join(parent, 'source'), root = join(parent, 'attempt'), runtimeBase = join(parent, 'runtime'), scratch = join(runtimeBase, 'scratch')
  for (const path of [source, root, runtimeBase, scratch]) await mkdir(path)
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src', 'item.txt'), 'synthetic task content')
  const git = async (args: string[]) => (await exec('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim()
  await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture'])
  const f = runFixture(':memory:')
  const relay = new RelayStore(f.db, f.store, f.scrubber, () => RUN_TIME), governor = new ResourceGovernor(), life = new AbortController()
  const connectionStore = new ConnectionStore(join(parent, 'connections.sqlite'), f.scrubber)
  const vault = new Vault(connectionStore, async () => { throw new Error('No fixture keychain') }, f.scrubber, { ownerDevice: true, nodeKeyOptIn: true })
  let work = 0, cleaned = false
  const requests: any[] = []
  const client = new OllamaClient({ host: 'http://127.0.0.1:11434', fetch: async (url, init) => {
    if (String(url).endsWith('/api/version')) return Response.json({ version: 'fixture-v1' })
    const request = JSON.parse(String(init?.body)); requests.push(request)
    const prompt = request.messages[0].content as string
    const content = prompt.startsWith(JUDGE_PROMPT) ? (options.judgeReply ?? judgeVerdict)
      : prompt.startsWith('Write a fresh') ? 'Completed fixture acceptance.' : JSON.stringify(++work === 1
        ? { action: 'tool', name: 'file_read', args: { path: 'src/item.txt' } } : work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' })
    return Response.json({ model: 'fixture', created_at: new Date(RUN_TIME).toISOString(), done: true, message: { role: 'assistant', content }, prompt_eval_count: Buffer.byteLength(prompt) + 5, eval_count: 100 })
  } })
  const connections = new Connections(connectionStore, vault, new BalanceProbes(connectionStore, vault), f.scrubber, life.signal, { client: () => client }, governor, () => 'http://127.0.0.1:11434')
  const connection = connections.create('local', { name: 'Fixture', kind: 'local_runtime', provider: 'ollama', auth: 'none', unattended: true })
  const rows: RunningModel[] = [{ name: 'fixture:latest', digest: 'fixture-digest', sizeBytes: 1, sizeVramBytes: null, gpuPercent: null,
    processorLabel: null, contextLength: 16000, expiresAt: null, source: 'ollama_api_ps', observedAt: new Date(RUN_TIME).toISOString() }]
  const models = { runtimeHost: 'http://127.0.0.1:11434', async ps() { return rows },
    async installedArtifacts() { return [{ name: 'fixture', digest: 'fixture-digest' }] }, async runtimeVersion() { return 'fixture-v1' } }
  const runtime = new RelayRuntimeSource(connections, () => models, { maximumAgeMs: 10000, counter: async fact => ({
    identity: { model: fact.model, digest: fact.digest, runtimeVersion: fact.runtimeVersion }, placement: 'installed_local',
    source: 'fixture exact renderer', observedAt: RUN_TIME, confidence: 'high', count: request => Buffer.byteLength(request.messages[0]!.content) + 5 }) }, () => RUN_TIME)
  const host = { runtime, reserves, clock: () => RUN_TIME, nodePorts: () => [4432, 5232],
    project: async (id: string) => ({ projectId: id, roots: [source], source: 'fixture project/workspace store', observedAt: RUN_TIME }),
    allocate: async () => ({ root, scratch, runtimeBase, async close() { cleaned = true } }), ...(options.judge ? { judge: options.judge } : {}) }
  const starts = new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, relay, host)
  const input: RelayStartInput = { key: 'local-judge-key', projectId: 'project', connectionId: connection.id, model: 'fixture', consent: 'full-access', domains: [],
    plan: { revision: 'r1', base: await git(['rev-parse', 'HEAD']), goal: 'Read the fixture and run acceptance.',
      items: [{ id: 'one', title: 'fixture', dependsOn: [], acceptance: ['/usr/bin/true'], protectedPaths: [] }], protectedPaths: [] }, caps }
  t.after(async () => { life.abort(); await starts.close(); await connections.close(); vault.close(); connectionStore.close(); await governor.close(); f.close()
    const quarantined = await readdir(join(runtimeBase, 'native-cleanup')).catch(() => [])
    if (!quarantined.length) await rm(parent, { recursive: true, force: true })
  })
  const notes = (sessionId: string) => (f.db.prepare("SELECT payload FROM session_events WHERE session_id=? AND type='agent.note' ORDER BY seq").all(sessionId) as Array<{ payload: string }>)
    .map(row => { try { return JSON.parse((JSON.parse(row.payload) as { text: string }).text) as Record<string, any> } catch { return {} as Record<string, any> } })
    .filter(note => typeof note['relay'] === 'string')
  return { ...f, relay, starts, input, connections, requests, governor, notes, cleaned: () => cleaned,
    finish: async () => { await until(() => cleaned); await until(() => starts.status(input.key).status !== 'running'); return starts.status(input.key) } }
}
const stockJudge = (cascade: boolean): RelayStartJudgeSource => context => ({
  signals: ledgerJudgeInput(signalPolicy, context.clock),
  ...(cascade ? { cascade: { brief: startBrief(context.input), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } } : {}),
})
const judgeRequests = (f: Awaited<ReturnType<typeof fixture>>) => f.requests.filter(r => (r.messages[0].content as string).startsWith(JUDGE_PROMPT))

test('a local relay with the judge on is the same relay plus judge events: its own calls are unchanged and the judge goes through the stock Ollama path', async t => {
  const plain = await fixture(t), judged = await fixture(t, { judge: stockJudge(true) })
  const [a, b] = await Promise.all([plain.starts.start(plain.input), judged.starts.start(judged.input)])
  assert.equal((await plain.finish()).status, 'completed'); assert.equal((await judged.finish()).status, 'completed')
  // The relay's own requests are byte for byte the ones of a relay without a judge.
  const own = (f: typeof plain) => f.requests.filter(r => !(r.messages[0].content as string).startsWith(JUDGE_PROMPT))
  assert.equal(own(judged).length, own(plain).length)
  assert.deepEqual(own(judged).map(r => r.messages[0].content), own(plain).map(r => r.messages[0].content))
  assert.deepEqual(plain.notes(a.sessionId!).filter(n => String(n['relay']).startsWith('judge')), [])
  // The judge: two samples at the two boundaries of the one cycle, on Ollama, with no transport-only fields.
  assert.equal(judgeRequests(judged).length, 4)
  for (const request of judgeRequests(judged)) {
    assert.equal(request.think, undefined, 'the stock judge request is the one it always was'); assert.equal(request.options.num_predict, 1000); assert.equal(request.options.num_ctx, 16000)
    assert.equal(Object.hasOwn(request, 'tools'), false)
  }
  const rows = judged.db.prepare('SELECT layer,state FROM relay_judge_requests WHERE run_id=?').all(b.runId!) as Array<{ layer: string; state: string }>
  assert.deepEqual(rows.map(r => [r.layer, r.state]), [['J2', 'completed'], ['J2', 'completed']])
  assert.equal(judged.notes(b.sessionId!).filter(n => n['relay'] === 'judge_signals').length, 2)
  // K3 recorded the judge's usage like any other local call; the relay's own R1 rows are exactly the plain relay's.
  assert.equal(judged.connections.snapshot('local').costs.length, own(judged).length + 4)
  const rowsOf = (f: typeof plain, runId: string) => f.store.costs(runId).map(row => [row.inputTokens, row.outputTokens])
  assert.deepEqual(rowsOf(judged, b.runId!), rowsOf(plain, a.runId!), 'judge calls add no row to the relay run\'s R1 ledger')
  assert.equal(judged.governor.snapshot().activeLease, null)
})

test('signals alone on a local relay: observations published, no model call by the judge', async t => {
  const f = await fixture(t, { judge: stockJudge(false) })
  const receipt = await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  assert.equal(f.notes(receipt.sessionId!).filter(n => n['relay'] === 'judge_signals').length, 2)
  assert.equal(judgeRequests(f).length, 0)
})

test('a local judge that answers in prose is invalid, not a verdict, and the run completes', async t => {
  const f = await fixture(t, { judge: stockJudge(true), judgeReply: 'looks fine' })
  const receipt = await f.starts.start(f.input); assert.equal((await f.finish()).status, 'completed')
  assert.equal(f.relay.read(receipt.runId!).items.one, 'done')
  const rows = f.db.prepare('SELECT state FROM relay_judge_requests WHERE run_id=?').all(receipt.runId!) as Array<{ state: string }>
  assert.deepEqual(rows.map(r => r.state), ['invalid', 'invalid'])
})

test('a local start whose judge cannot be admitted is refused with nothing created, and its checkout is released', async t => {
  const f = await fixture(t, { judge: context => ({ cascade: { brief: startBrief({ ...context.input, caps: { ...context.input.caps, cycles: 3 } }), model: relayJudgeModel(context, { accountId: 'local', maxAgeMs: 10_000 }) } }) })
  await assert.rejects(f.starts.start(f.input), /judge_config_invalid/)
  for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, table)
  assert.equal(f.requests.length, 0); assert.equal(f.cleaned(), true)
})
