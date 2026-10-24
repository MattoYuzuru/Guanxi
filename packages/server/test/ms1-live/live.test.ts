/** MS1 live mode on the production boot: two real `ms1-live start` processes (separate data directories, loopback ports), the
 * executor in front of the fake llama-server in attach mode, a port-forward emulator between them. See
 * docs/plans/lanes/MS1-live.handoff.md for what this cannot prove: no real model, no SSH, no second machine. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { RELAY_RUNTIME_PROBE } from '@guanxi/contract/federation'
import { REMOTE_RELAY_COUNTER_SOURCE, REMOTE_RELAY_PROPS_SOURCE } from '../../src/relay/remote-runtime.ts'
import { fakeRender, fakeTokens } from '../fixtures/fake-llama-server.ts'
import { cli, createLiveWorld, freeWorldPorts, LiveNode, LiveWorld, StartupPortCollision, until, pinLifecycle } from './live-world.ts'

const num = (a: number, b: number) => a - b
const TERMINAL = ['completed', 'failed', 'interrupted', 'input_required', 'canceled']
async function ended(w: LiveWorld, key: string, ms = 180_000) {
  await until(async () => TERMINAL.includes((await w.relayStatus(key)).status), `relay ${key} to end`, ms)
  return w.relayStatus(key)
}
interface Preflight { ok: boolean; role: string; checks: Array<{ id: string; status: string; code?: string; summary: string; fix?: string; data?: Record<string, any> }>; observed: Record<string, any> | null }
async function preflight(w: LiveWorld, role: 'home' | 'executor', extra: string[] = []) {
  const result = await cli(['preflight', '--config', role === 'home' ? w.homeConfig : w.execConfig, '--json', ...extra], { HOME: w.dir })
  return { code: result.code, report: JSON.parse(result.out) as Preflight, text: result.out }
}
const check = (report: Preflight, id: string) => report.checks.find(c => c.id === id)

test('fixture port groups are distinct and only a typed failed startup is an allocation collision', async () => {
  assert.equal(new Set(await freeWorldPorts()).size, 4)
  const node = new LiveNode('fixture', '', '', 1, 2, {})
  node.events.push({ event: 'failed', code: 'port_in_use' })
  await assert.rejects(node.wait('started'), StartupPortCollision)
  await assert.rejects(node.wait('other'), error => !(error instanceof StartupPortCollision))
  node.events[0]!['code'] = 'start_failed'
  await assert.rejects(node.wait('started'), error => !(error instanceof StartupPortCollision))
})

test('fixture port allocation retries a transient collision only after removing the partial world', async t => {
  const dirs: string[] = []
  const cleanups: Array<() => unknown> = []
  const mocked = t.mock.method(LiveWorld.prototype, 'init', async function(this: LiveWorld) {
    dirs.push(this.dir)
    assert.equal(cleanups.length, dirs.length, 'cleanup ownership is registered before each initialization')
    if (dirs.length === 1) throw new StartupPortCollision('synthetic port collision')
  })
  try {
    const world = await createLiveWorld({ after(fn) { cleanups.push(fn); t.after(fn) } })
    assert.equal(dirs.length, 2)
    assert.notEqual(dirs[0], dirs[1])
    assert.equal(existsSync(dirs[0]!), false)
    assert.equal(existsSync(world.dir), true)
  } finally { mocked.mock.restore() }
})

test('fixture port allocation is bounded and never retries another failure or unconfirmed cleanup', async t => {
  let calls = 0
  let failure: Error = new StartupPortCollision('persistent collision')
  let latest: LiveWorld | undefined
  let stillAlive = false
  const mocked = t.mock.method(LiveWorld.prototype, 'init', async function(this: LiveWorld) {
    calls++; latest = this
    if (stillAlive) this.home = { alive: true } as LiveNode
    throw failure
  })
  try {
    await assert.rejects(createLiveWorld(t), StartupPortCollision)
    assert.equal(calls, 3)
    calls = 0; failure = new Error('unrelated startup error')
    await assert.rejects(createLiveWorld(t), error => error === failure)
    assert.equal(calls, 1)
    calls = 0; failure = new StartupPortCollision('collision with failed cleanup')
    const cleanup = t.mock.method(LiveWorld.prototype, 'close', async () => { throw new Error('fixture_cleanup_unconfirmed') })
    try {
      await assert.rejects(createLiveWorld(t), /fixture_cleanup_unconfirmed/)
      assert.equal(calls, 1); assert.equal(existsSync(latest!.dir), true)
    } finally { cleanup.mock.restore(); await latest?.close() }
    calls = 0; stillAlive = true
    try {
      await assert.rejects(createLiveWorld(t), /fixture_cleanup_unconfirmed/)
      assert.equal(calls, 1); assert.equal(existsSync(latest!.dir), true)
    } finally { latest!.home.alive = false; await latest?.close() }
  } finally { mocked.mock.restore() }
})

/** Nothing the nodes print, log or store holds the private key. */
function assertNoKey(w: LiveWorld) {
  for (const [dir, nodes] of [[w.homeDir, [w.home]], [w.execDir, [w.executor]]] as const) {
    const body = readFileSync(join(dir, 'node.key'), 'utf8').split('\n').filter(line => line && !line.startsWith('-----')).join('').slice(0, 32)
    for (const node of nodes) {
      assert.ok(!JSON.stringify(node.events).includes(body) && !node.stderr.join('').includes(body), `${node.name} output carries no key`)
      for (const file of readdirSync(node.dataDir).filter(name => /\.(db|sqlite)(-wal)?$/.test(name))) {
        assert.ok(!readFileSync(join(node.dataDir, file)).includes(body), `${node.name} ${file} holds no key`)
      }
    }
  }
}

test('preflight proves the link both ways and prints what the executor\'s llama-server is, with where and when it was observed', async t => {
  const w = await createLiveWorld(t, { fake: { replies: ['pong'] } })
  const home = await preflight(w, 'home')
  assert.equal(home.code, 0, home.text); assert.equal(home.report.ok, true)
  assert.deepEqual(home.report.checks.map(c => [c.id, c.status]), [['credentials', 'ok'], ['peer_url', 'ok'], ['handshake', 'ok'], ['observe', 'ok'], ['count', 'ok'], ['reserves', 'ok']])
  const o = home.report.observed!
  assert.equal(o['model'], 'fixture:latest'); assert.match(o['digest'], /^sha256:[0-9a-f]{64}$/); assert.equal(o['contextTokens'], 16000); assert.equal(o['runtimeVersion'], 'llama-server/b0-fixture')
  assert.equal(o['propsSource'], REMOTE_RELAY_PROPS_SOURCE); assert.equal(o['counterSource'], REMOTE_RELAY_COUNTER_SOURCE)
  assert.ok(Math.abs(Date.parse(o['observedAt']) - Date.now()) < 60_000, 'a fresh observation time')
  const rendered = fakeRender(RELAY_RUNTIME_PROBE, { template: 'chat' }, false)
  assert.equal(o['probe'].tokens, fakeTokens(rendered, true), 'the executor\'s exact count of the rendered probe')
  assert.match(check(home.report, 'handshake')!.summary, /offers the relay runtime/)
  // The executor did the work: its llama-server rendered and tokenized the probe; the home has no llama-server at all.
  assert.ok((await w.fake.requests('/apply-template')).length >= 1 && (await w.fake.requests('/tokenize')).length >= 1)
  assert.equal((await w.fake.requests('/completion')).length, 0, 'a preflight generates nothing')
  assert.deepEqual(w.toExecutor.paths('/attempts/runtime').map(r => r.path), ['/attempts/runtime/observe', '/attempts/runtime/count'])
  const text = await cli(['preflight', '--config', w.homeConfig], { HOME: w.dir })
  assert.equal(text.code, 0); assert.match(text.out, /window +16000 tokens \(federation:llama_server_props\)/); assert.match(text.out, /build +llama-server\/b0-fixture/); assert.match(text.out, /counter +federation:llama-server:\/apply-template\+\/tokenize \(probe: \d+ tokens\)/)

  // A real generation shares the single slot with the relay: it is refused while this node's federation port answers.
  const running = await preflight(w, 'executor', ['--completion'])
  assert.equal(running.code, 1); assert.equal(check(running.report, 'completion')?.code, 'completion_while_running'); assert.match(check(running.report, 'completion')!.fix!, /never during a run/)
  assert.equal((await w.fake.requests('/completion')).length, 0, 'and nothing was generated')
  await w.executor.stop()
  const exec = await preflight(w, 'executor', ['--completion'])
  assert.equal(exec.code, 0, exec.text)
  assert.deepEqual(exec.report.checks.map(c => [c.id, c.status]), [['credentials', 'ok'], ['llama_server', 'ok'], ['template', 'ok'], ['slots', 'ok'], ['completion', 'ok'], ['schemas', 'ok'], ['home_link', 'ok'], ['home_handshake', 'ok']])
  assert.equal(exec.report.observed!['digest'], o['digest'], 'both sides name the same model file')
  assert.equal(exec.report.observed!['probe'].tokens, o['probe'].tokens)
  assert.equal(check(exec.report, 'completion')!.data!['evaluatedTokens'], o['probe'].tokens, 'a one-token generation evaluated exactly the counted prompt')
  assert.equal((await w.fake.requests('/completion')).length, 4, 'the completion check and one generation per schema')
  assert.ok((await w.fake.requests('/completion')).every(post => post.body.n_predict === 1))
  assert.deepEqual(w.tripwire.requests, [], 'no preflight asks a local Ollama anything')
  assertNoKey(w)
})

test('a relay started through the public route runs every model call on the executor through F2-d, and the ledgers agree', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  const response = await w.startRelay('live-happy', 2)
  assert.equal(response.status, 202, JSON.stringify(response.body))
  const status = await ended(w, 'live-happy')
  assert.equal(status.status, 'completed', JSON.stringify(status))
  const relay = status.runId as string
  assert.equal(status.runtime.source, REMOTE_RELAY_PROPS_SOURCE, 'the loaded window came from the executor'); assert.equal(status.runtime.contextTokens, 16000)
  assert.equal(status.meter.source, REMOTE_RELAY_COUNTER_SOURCE); assert.equal(status.meter.measurement, 'exact_rendered_request')

  const ledger = w.ledger(relay)
  assert.deepEqual(ledger.items, { i1: 'done', i2: 'done' })
  for (const item of ledger.plan.items) assert.ok(ledger.evidence.some((e: { item: string; ok: boolean; head: string }) => e.item === item.id && e.ok && e.head === ledger.head), `${item.id} passed its gate at the final head`)

  // Inference ran on the second node: signed pin, observe, count, offer, dispatch, one per call.
  const posts = await w.fake.requests('/completion')
  assert.ok(posts.length >= 4, `many model calls (${posts.length})`)
  assert.equal(pinLifecycle(w.toExecutor.requests.filter(r => r.path === '/attempts/runtime/pin').map(r => r.action)).ok, true, 'pinned by a signed message first, unpinned last, only re-pins between')
  assert.equal(w.toExecutor.paths('/attempts/dispatch').filter(r => r.path === '/attempts/dispatch').length, posts.length, 'one dispatch grant per completion')
  assert.equal(w.toExecutor.requests.filter(r => r.path === '/attempts/offers').length, posts.length, 'one offer per call')
  assert.ok(w.toExecutor.requests.filter(r => r.path === '/attempts/runtime/count').length >= posts.length, 'every dispatched string was counted by the executor first')
  assert.ok(w.toExecutor.requests.filter(r => r.path === '/attempts/runtime/observe').length > posts.length)
  assert.ok(w.toHome.requests.some(r => r.path === '/attempts/events'), 'the executor reported its results to the home over the reverse forward')
  assert.deepEqual(w.executor.rows('SELECT id FROM federation_streams'), [], 'no pin is left on the executor')
  assert.deepEqual(w.executor.rows('SELECT DISTINCT status FROM remote_dispatch_holders'), [{ status: 'completed' }])
  assert.equal(w.executor.count('SELECT COUNT(*) AS n FROM remote_dispatch_holders'), posts.length)

  // F2-c: each call is a child run with exactly one remote-dispatch cost row holding the tokens the executor evaluated.
  const children = w.home.rows<{ id: string; state: string }>("SELECT id,state FROM durable_runs WHERE id LIKE 'rc-%'")
  assert.equal(children.length, posts.length); assert.ok(children.every(child => child.state === 'completed'))
  const rows = children.flatMap(child => w.home.rows<{ entry_key: string; input_tokens: number }>('SELECT entry_key,input_tokens FROM run_costs WHERE run_id=?', child.id))
  assert.equal(rows.length, children.length); assert.ok(rows.every(row => row.entry_key.startsWith('remote-dispatch:')))
  assert.deepEqual(rows.map(row => row.input_tokens).sort(num), posts.map(post => fakeTokens(post.body.prompt, true)).sort(num), 'the ledgers hold the evaluated counts, call for call')
  assert.ok(w.home.rows<{ entry_key: string }>('SELECT entry_key FROM run_costs WHERE run_id=?', relay).every(row => !row.entry_key.startsWith('remote-dispatch:')), 'the relay run keeps its own accounting, never merged')

  // No local inference of any kind: the home never even consulted Ollama; the owned checkout is gone; the project was only read.
  assert.deepEqual(w.tripwire.requests, [], 'nobody asked a local Ollama anything, at boot or during the run')
  assert.deepEqual(readdirSync(w.checkouts), [], 'the owned checkout is gone')
  const git = async (...args: string[]) => (await import('node:util')).promisify((await import('node:child_process')).execFile)('/usr/bin/git', args, { cwd: w.project }).then(r => r.stdout.trim())
  assert.equal(await git('status', '--porcelain', '--untracked-files=all'), ''); assert.equal(await git('rev-parse', 'HEAD'), w.base)
  assertNoKey(w)
})

test('a plan run twice with the same key attaches to the first run and dispatches nothing more; the public stop cancels, unpins and leaves nothing held', async t => {
  const w = await createLiveWorld(t, { fake: { completionDelayMs: 400 } })
  await w.registerProject()
  const first = await w.startRelay('live-stop', 3); assert.equal(first.status, 202)
  const again = await w.startRelay('live-stop', 3); assert.equal(again.body.runId, first.body.runId, 'idempotent by key')
  await until(async () => (await w.fake.requests('/completion')).length >= 1, 'a first model call', 60_000)
  const stopped = await w.home.api('POST', '/api/relay/starts/live-stop/stop', {})
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
  const status = await ended(w, 'live-stop', 60_000)
  assert.notEqual(status.status, 'completed')
  await until(() => w.executor.count('SELECT COUNT(*) AS n FROM federation_streams') === 0, 'the executor pin to be released', 30_000)
  assert.equal(pinLifecycle(w.toExecutor.requests.filter(r => r.path === '/attempts/runtime/pin').map(r => r.action)).ok, true)
  const calls = (await w.fake.requests('/completion')).length
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal((await w.fake.requests('/completion')).length, calls, 'no model call follows a stop')
  assert.equal(w.executor.count("SELECT COUNT(*) AS n FROM remote_dispatch_holders WHERE status IN ('accepted','running')"), 0, 'no holder is still computing on the executor')
  assert.deepEqual(w.tripwire.requests, [])
})

test('what crosses the forward is the federation API and only that: the owner API of either node is not reachable through it, and the forward is the topology a real ssh -L makes', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  for (const forward of [w.toExecutor, w.toHome]) {
    for (const [method, path] of [['GET', '/api/workspaces'], ['GET', '/api/projects'], ['POST', '/api/relay'], ['GET', '/api/connections'], ['GET', '/api/health']] as const) {
      const response = await fetch(forward.url + path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })
      assert.deepEqual([response.status, await response.json()], [404, { code: 'not_found' }], `${method} ${path} through the forward`)
    }
    const handshake = await fetch(`${forward.url}/api/federation/handshake`)
    assert.deepEqual([handshake.status, await handshake.json()], [401, { code: 'unauthenticated' }], 'the federation API answers, and refuses an unsigned caller')
  }
  // The forward listens on ::1 and connects to 127.0.0.1 with the same port number: nothing was rewritten on the way.
  assert.equal(new URL(w.toExecutor.url).hostname, '[::1]'); assert.equal(w.toExecutor.port, w.executor.federationPort)
  assert.notEqual(w.executor.port, w.executor.federationPort, 'the owner API has its own port, which is never forwarded')
  assert.equal((await w.executor.api('GET', '/api/workspaces')).status, 200, 'and it works where it belongs')
})
