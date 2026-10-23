/** Misconfiguration and outages fail loudly and never fall back to inference on the home: a refused relay start creates no run,
 * the executor's llama-server generates nothing, and a local Ollama (a tripwire on OLLAMA_HOST) is never asked. */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { cli, createLiveWorld, until, type LiveWorld } from './live-world.ts'

async function preflight(w: LiveWorld, role: 'home' | 'executor', extra: string[] = []) {
  const result = await cli(['preflight', '--config', role === 'home' ? w.homeConfig : w.execConfig, '--json', ...extra], { HOME: w.dir })
  return { code: result.code, report: JSON.parse(result.out) as { ok: boolean; checks: Array<{ id: string; status: string; code?: string; summary: string; fix?: string }>; observed: unknown } }
}
const find = (r: { report: { checks: Array<{ id: string; status: string; code?: string; summary: string; fix?: string }> } }, id: string) => r.report.checks.find(c => c.id === id)
/** The relay start was refused as a whole: nothing durable exists, nothing was generated anywhere. */
async function assertRefusedWithoutInference(w: LiveWorld, response: { status: number; body: any }, code: string, completions = 0) {
  assert.deepEqual([response.status, response.body], [503, { code }])
  assert.equal(w.home.count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='relay_public_starts'") === 0 || w.home.count('SELECT COUNT(*) AS n FROM relay_public_starts') === 0, true, 'no start row')
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM durable_runs'), 0, 'no run of any kind')
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM sessions'), 0, 'no session')
  assert.deepEqual(existsSync(w.checkouts) ? readdirSync(w.checkouts) : [], [], 'no checkout was allocated')
  assert.equal((await w.fake.requests('/completion')).length, completions, 'the llama-server generated nothing')
  assert.deepEqual(w.tripwire.requests, [], 'a local Ollama was not asked either')
}

test('a peer file holding the executor\'s id with another public key: the executor\'s answers do not verify, preflight names it and no relay starts', async t => {
  const w = await createLiveWorld(t, { wrongPeer: 'key' })
  await w.registerProject()
  const pre = await preflight(w, 'home')
  assert.equal(pre.code, 1)
  assert.equal(find(pre, 'peer_url')?.status, 'ok'); assert.equal(find(pre, 'handshake')?.status, 'ok', 'the executor accepts the home: the fault is on the home\'s side of the pairing')
  assert.equal(find(pre, 'observe')?.code, 'peer_key_mismatch'); assert.match(find(pre, 'observe')!.fix!, /peer file/)
  assert.equal(pre.report.observed, null); assert.equal(find(pre, 'count')?.status, 'skip')
  await assertRefusedWithoutInference(w, await w.startRelay('wrong-key'), 'runtime_identity_unknown')
  // Nothing was pinned, offered or dispatched: the refusal came before any run existed.
  assert.deepEqual(w.toExecutor.requests.filter(r => /offers|dispatch|pin/.test(r.path)), [])
  assert.equal((await w.fake.requests('/tokenize')).length, 0, 'not even a count was made')
})

test('a peer file holding another node: the executor rejects the home\'s signature, both from the home\'s side and from the executor\'s', async t => {
  for (const options of [{ wrongPeer: 'stranger' as const }, { wrongHome: true }]) {
    const w = await createLiveWorld(t, options)
    await w.registerProject()
    const pre = await preflight(w, 'home')
    assert.equal(pre.code, 1)
    assert.equal(find(pre, 'peer_url')?.status, 'ok', 'a Guanxi federation answers')
    assert.equal(find(pre, 'handshake')?.code, 'peer_rejected_key', JSON.stringify(options)); assert.match(find(pre, 'handshake')!.fix!, /peer-offer\.json/)
    assert.equal(find(pre, 'observe')?.status, 'skip')
    await assertRefusedWithoutInference(w, await w.startRelay('stranger'), 'runtime_meter_unavailable')
    assert.equal((await w.fake.requests('/tokenize')).length, 0)
  }
})

test('an executor that is not there: the start is refused, preflight says what to start, and the same node works as soon as the link is back', async t => {
  const w = await createLiveWorld(t, { start: false })
  w.home.spawn(); await w.home.wait('started')
  await w.registerProject()
  const pre = await preflight(w, 'home')
  assert.equal(pre.code, 1); assert.equal(find(pre, 'peer_url')?.code, 'peer_unreachable'); assert.match(find(pre, 'peer_url')!.fix!, /ssh forward/)
  assert.equal(find(pre, 'handshake')?.status, 'skip')
  await assertRefusedWithoutInference(w, await w.startRelay('no-executor'), 'runtime_meter_unavailable')
  w.executor.spawn(); await w.executor.wait('started')
  const ok = await w.startRelay('after-start', 1)
  assert.equal(ok.status, 202, JSON.stringify(ok.body))
  assert.equal((await until(async () => (await w.relayStatus('after-start')).status === 'completed', 'the relay to complete', 120_000), 'completed'), 'completed')
})

test('a dropped forward (the ssh link dies) refuses new starts at once and a restored forward needs no restart', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  await w.toExecutor.cut()
  const pre = await preflight(w, 'home')
  assert.equal(find(pre, 'peer_url')?.code, 'peer_unreachable')
  await assertRefusedWithoutInference(w, await w.startRelay('cut'), 'runtime_meter_unavailable')
  await w.toExecutor.restore()
  assert.equal((await preflight(w, 'home')).code, 0)
  assert.equal((await w.startRelay('restored', 1)).status, 202)
  await until(async () => (await w.relayStatus('restored')).status === 'completed', 'the relay to complete', 120_000)
})

test('an unreachable llama-server: the executor says so, the home\'s start is refused, and nothing generates', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  await w.fake.close()
  const exec = await preflight(w, 'executor')
  assert.equal(exec.code, 1); assert.equal(find(exec, 'llama_server')?.code, 'llama_server_unavailable'); assert.match(find(exec, 'llama_server')!.fix!, /--alias <model> --jinja/)
  assert.equal(find(exec, 'template')?.status, 'skip')
  const home = await preflight(w, 'home')
  assert.equal(home.code, 1); assert.equal(find(home, 'handshake')?.status, 'ok'); assert.equal(find(home, 'observe')?.code, 'peer_unavailable'); assert.match(find(home, 'observe')!.fix!, /llama-server is unreachable/)
  const response = await w.startRelay('no-llama')
  assert.deepEqual([response.status, response.body], [503, { code: 'runtime_meter_unavailable' }])
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM durable_runs'), 0); assert.deepEqual(w.tripwire.requests, [])
})

test('a model the pairing does not serve is refused before any message is sent', async t => {
  const w = await createLiveWorld(t)
  await w.registerProject()
  const before = w.toExecutor.requests.length
  const response = await w.startRelay('other-model', 1, { model: 'some-other-model' })
  assert.deepEqual([response.status, response.body], [503, { code: 'runtime_identity_unknown' }])
  assert.equal(w.toExecutor.requests.length, before, 'the executor was not even contacted')
  assert.equal(w.home.count('SELECT COUNT(*) AS n FROM durable_runs'), 0)
})

test('preflight sends the probe, work and judge schemas to the executor\'s llama-server and names a grammar it rejects', async t => {
  const ok = await createLiveWorld(t, { fake: { replies: ['pong'] } })
  await ok.executor.stop()
  const good = await preflight(ok, 'executor', ['--completion'])
  assert.equal(good.code, 0); assert.equal(find(good, 'schemas')?.status, 'ok')
  const posts = (await ok.fake.requests('/completion')).filter(post => post.body.json_schema)
  assert.equal(posts.length, 3, 'one one-token generation per schema'); assert.ok(posts.every(post => post.body.n_predict === 1))
  assert.deepEqual(posts.map(post => Object.keys(post.body.json_schema.properties ?? {}).length > 0 || Array.isArray(post.body.json_schema.anyOf)), [true, true, true])
  const w = await createLiveWorld(t, { fake: { rejectSchema: true, replies: ['pong'] } })
  await w.executor.stop()
  const exec = await preflight(w, 'executor', ['--completion'])
  assert.equal(exec.code, 1); assert.equal(find(exec, 'completion')?.status, 'ok'); assert.equal(find(exec, 'schemas')?.code, 'response_schema_rejected')
  assert.match(find(exec, 'schemas')!.summary, /probe response schema/); assert.match(find(exec, 'schemas')!.fix!, /home\.structuredOutput/)
  assert.ok(!JSON.stringify(exec).includes('SERVER-GRAMMAR-TEXT'), 'the server\'s text is not echoed')
})

test('a meter mismatch (the server evaluates other tokens than it counted): the first call is refused as truncation_protocol, nothing is accepted and nothing local runs', async t => {
  const w = await createLiveWorld(t, { fake: { evaluatedSkew: 1, replies: ['pong'] } })
  await w.registerProject()
  await w.executor.stop()
  const exec = await preflight(w, 'executor', ['--completion'])
  assert.equal(exec.code, 1); assert.equal(find(exec, 'completion')?.code, 'truncation_protocol'); assert.match(find(exec, 'completion')!.fix!, /cachePrompt/)
  assert.equal(find(exec, 'template')?.status, 'ok', 'the count itself is consistent: it is the evaluation that disagrees')

  w.executor.spawn(); await w.executor.wait('started')
  const response = await w.startRelay('skew', 2)
  assert.equal(response.status, 202, 'admission passes: observation and the probe count are fine')
  const status = await (async () => { await until(async () => (await w.relayStatus('skew')).status !== 'running', 'the relay to stop', 90_000); return w.relayStatus('skew') })()
  assert.notEqual(status.status, 'completed', JSON.stringify(status))
  const relay = status.runId as string
  assert.deepEqual(w.ledger(relay).items, { i1: 'open', i2: 'open' }, 'no work was accepted')
  const terminals = w.home.rows<{ payload: string }>('SELECT payload FROM remote_dispatch_receipts').map(r => JSON.parse(r.payload).entry.event).filter(event => event.kind === 'terminal')
  assert.ok(terminals.length >= 1 && terminals.every(event => event.outcome === 'failed'), 'every call the executor ended, it ended as failed')
  assert.ok(terminals.every(event => event.reason === 'truncation_protocol'), 'with the fixed reason')
  assert.equal(w.home.count("SELECT COUNT(*) AS n FROM run_costs WHERE entry_key LIKE 'remote-dispatch:%'"), 0, 'no tokens were billed for a refused reply')
  await until(() => w.executor.count('SELECT COUNT(*) AS n FROM federation_streams') === 0, 'the pin to be released', 30_000)
  assert.deepEqual(w.tripwire.requests, [])
  const calls = (await w.fake.requests('/completion')).length
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal((await w.fake.requests('/completion')).length, calls, 'it does not retry into success')
})
