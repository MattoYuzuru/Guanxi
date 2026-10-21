import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './fixture.ts'
import { emptyUsage } from '../../src/native-agent/model.ts'
import { piModels, piTransport } from '../../src/connections/pi.ts'

for (const cap of ['maxTokens','maxCostMicrounits'] as const) test(`nonzero ${cap} consumes actual K3 usage in R1 before stopping`, async t => {
  const usage = { ...emptyUsage(), input: 10, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 22, cost: { input: 0.1, output: 0.025, cacheRead: 0, cacheWrite: 0, total: 0.125 } }
  const f = await fixture(t, undefined, undefined, undefined, undefined, { usage })
  const { sessionId } = await f.agents().create({ ...f.input, budget: { [cap]: cap === 'maxTokens' ? 22 : 125000 } })
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'cancelled'); assert.equal(result.error, 'budget_exhausted')
  assert.equal(f.requests.length, 1)
  const runId = String(f.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').get(sessionId)!.id)
  assert.deepEqual(f.runs.costs(runId), [{ currency: 'USD', inputTokens: 15, outputTokens: 7, costMicrounits: 125000 }])
})

for (const reporting of [false,true]) test(`${reporting ? 'report' : 'run'} duration cap aborts a pending provider through R1`, { timeout: 5000 }, async t => {
  let now = Date.now(), aborted = false
  const f = await fixture(t, async (_call, _context, signal) => {
    signal!.addEventListener('abort', () => { aborted = true }, { once: true })
    return await new Promise(() => {})
  }, undefined, undefined, undefined, { clock: () => now })
  const { sessionId } = await f.agents().create({ ...f.input, budget: reporting ? { reportMaxDurationMs: 10 } : { maxDurationMs: 10 } })
  while (f.requests.length === 0) await new Promise(r => setImmediate(r))
  const runId = String(f.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').get(sessionId)!.id)
  if (reporting) { const attempt = f.runs.attempts(runId)[0]!; f.runs.wrappingUp(attempt); f.runs.checkExecution(attempt) }
  now += 11
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.error, reporting ? 'report_budget_exhausted' : 'budget_exhausted')
  assert.equal(aborted, true); assert.equal(f.requests.length, 1)
})

test('Session leave finishes current work, blocks queued turns and starts recovery grace only when idle', async t => {
  let release!: () => void
  const block = new Promise<void>(r => { release = r })
  const f = await fixture(t, async () => { await block; return [{ type: 'text', text: 'done' }] })
  const { sessionId } = await f.agents().create({ ...f.input, retention: 'session' })
  f.agents().queue(sessionId, 'must not start after leave')
  f.agents().leaveSession(sessionId)
  const late = new Date(Date.now() + 8 * 3600000)
  await f.agents().sessions.maintain(new Set([sessionId]), late)
  assert.equal(f.agents().sessions.retention(sessionId).recoveryDeadline, null)
  release(); await f.agents().wait(sessionId)
  assert.equal(f.requests.length, 1)
  await f.agents().sessions.maintain(new Set(), late)
  const deadline = f.agents().sessions.retention(sessionId).recoveryDeadline!
  assert.equal(Date.parse(deadline), late.getTime() + 24 * 3600000)
  await f.agents().sessions.maintain(new Set(), new Date(Date.parse(deadline) - 1))
  assert.notEqual(f.log.session(sessionId), null)
})

test('partial cleanup persists intent, blocks continuation and retries all resources after restart', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const dirs = f.agents().sessions.paths(sessionId)
  await writeFile(join(f.data, 'native-output'), 'blocks the output parent directory')
  await assert.rejects(f.agents().deleteSession(sessionId), /deletion_failed/)
  await assert.rejects(readdir(dirs[0]!), { code: 'ENOENT' })
  assert.equal(f.agents().sessions.retention(sessionId).state, 'deleting')
  assert.throws(() => f.agents().prompt(sessionId, 'must not resume'), /session_expired/)
  assert.notEqual(f.log.session(sessionId), null)
  await rm(join(f.data, 'native-output'))
  await f.restart()
  // Exercise the actual startup owner; close waits for its maintenance promise.
  await f.agents().close()
  assert.equal(f.log.session(sessionId), null)
  for (const dir of dirs) await assert.rejects(readdir(dir), { code: 'ENOENT' })
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM native_sessions WHERE session_id=?').get(sessionId)!.n, 0)
})

test('maintenance rechecks policy after an earlier cleanup await', async t => {
  const f = await fixture(t)
  const a = await f.agents().create(f.input); await f.agents().wait(a.sessionId)
  const b = await f.agents().create(f.input); await f.agents().wait(b.sessionId)
  f.db.prepare('UPDATE native_sessions SET deletion_requested=1 WHERE session_id=?').run(a.sessionId)
  f.db.prepare('UPDATE threads SET last_user_activity_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), b.sessionId)
  let release!: () => void, entered!: () => void
  const block = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { entered = r })
  const sessions = f.agents().sessions, remove = sessions.remove.bind(sessions)
  sessions.remove = async id => { if (id === a.sessionId) { entered(); await block } return remove(id) }
  const pending = sessions.maintain(new Set())
  await ready
  f.agents().setRetention(b.sessionId, 'keep')
  release(); await pending
  assert.equal(sessions.retention(b.sessionId).mode, 'keep')
  assert.equal(sessions.retention(b.sessionId).state, 'active')
})

for (const quota of [false,true]) test(`actual Google pi transport ${quota ? 'quota' : 'start'} observation reaches native R1`, async t => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return quota ? new Response(JSON.stringify({ error: { code: 429, message: 'fixture quota', status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'content-type': 'application/json' } })
      : new Response('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }) + '\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  t.after(() => { globalThis.fetch = original })
  const f = await fixture(t)
  const connection = f.connections.create('local', { name: 'Google fixture', provider: 'google', auth: 'api_key', kind: 'model_api' })
  f.connections.saveSecret('local', connection.id, f.secret)
  Reflect.set(f.connections, 'pi', piTransport)
  const { sessionId } = await f.agents().create({ ...f.input, connectionId: connection.id, model: piModels('google')[0]!.id })
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, quota ? 'cancelled' : 'completed')
  assert.equal(result.error, quota ? 'quota_exhausted' : null)
  assert.equal(calls, 1)
  const runId = String(f.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').get(sessionId)!.id)
  const attempt = f.runs.attempts(runId)[0]!
  assert.equal(attempt.first_model_at !== null, !quota)
})

test('clean home handover reconciles a native attempt before its execution lease expires', async t => {
  const { RunStore } = await import('../../src/runs/store.ts')
  const f = await fixture(t, async () => await new Promise(() => {}))
  const { sessionId } = await f.agents().create(f.input)
  while (f.requests.length === 0) await new Promise(r => setImmediate(r))
  const runId = String(f.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').get(sessionId)!.id)
  const attempt = f.runs.attempts(runId)[0]!
  f.runs.close()
  const successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
  try {
  successor.heartbeat(); successor.reconcile()
  assert.equal(successor.attempts(runId)[0]!.state, 'lost')
  assert.equal(successor.get(runId).state, 'input_required')
  assert.throws(() => successor.complete(attempt, 'completed'), /stale_lease/)
  assert.equal(f.requests.length, 1)
  } finally { successor.close() }
})

test('a deposed native home cannot delete a settled session or its resources', async t => {
  const { RunStore } = await import('../../src/runs/store.ts')
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  f.runs.close()
  const successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
  try {
    successor.heartbeat(); successor.reconcile()
    await assert.rejects(f.agents().deleteSession(sessionId), /closed/)
    assert.notEqual(f.log.session(sessionId), null)
    await readdir(f.agents().sessions.paths(sessionId)[0]!)
    assert.equal(f.db.prepare('SELECT deletion_requested FROM native_sessions WHERE session_id=?').get(sessionId)!.deletion_requested, 0)
  } finally { successor.close() }
})


test('synchronous API cancellation cannot acknowledge dispatch or leak a pending rejection', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  let started = 0
  Reflect.set(f.connections, 'pi', { complete: async () => {
    controller.abort()
    throw new Error('fixture dispatch canceled')
  } })
  await assert.rejects(f.connections.complete('local', f.input.connectionId, { messages: [] }, {
    model: f.input.model, runId: 'fixture', requestId: 'fixture-cancel', signal: controller.signal,
    onStarted: () => { started++ },
  }))
  assert.equal(started, 0, 'cancellation wins before dispatch acknowledgment')
  await new Promise(r => setImmediate(r))
})
