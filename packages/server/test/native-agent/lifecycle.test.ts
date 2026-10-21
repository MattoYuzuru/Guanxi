import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture } from './fixture.ts'
import { nativeAgentRoutes } from '../../src/native-agent/routes.ts'
import { NativeOutputs } from '../../src/native-agent/outputs.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { RunStore } from '../../src/runs/store.ts'
import type { Attempt } from '../../src/runs/types.ts'
import { deleteNativeSessionResponseSchema, nativeRunBudgetSchema } from '@guanxi/contract'

const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const held = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release: () => release() } }
function latest(f: Awaited<ReturnType<typeof fixture>>, id: string): Attempt {
  const run = f.db.prepare('SELECT id FROM durable_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string }
  return f.runs.attempts(run.id).at(-1)!
}

test('every native turn owns one R1 attempt; stale trace/completion and home writes are fenced', async t => {
  const block = held()
  const f = await fixture(t, async () => { await block.promise; return [{ type: 'text', text: 'done' }] })
  t.after(block.release)
  const { sessionId } = await f.agents().create(f.input)
  const attempt = latest(f, sessionId)
  assert.equal(f.runs.get(attempt.run_id).state, 'working')
  assert.equal(f.runs.attempts(attempt.run_id).length, 1)
  const head = f.log.session(sessionId)!.lastSeq
  const stale = { ...attempt, token: attempt.token + 1 }
  assert.throws(() => f.runs.append(stale, { type: 'agent.note', data: { text: 'stale' } }, { expectedSeq: head + 1 }), /stale_lease/)
  assert.throws(() => f.runs.complete(stale, 'completed'), /stale_lease/)
  assert.equal(f.log.session(sessionId)!.lastSeq, head)
  assert.equal(f.runs.get(attempt.run_id).state, 'working')
  block.release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.throws(() => f.runs.append(attempt, { type: 'agent.note', data: { text: 'late' } }, { expectedSeq: f.log.session(sessionId)!.lastSeq + 1 }), /stale_lease/)
  f.agents().prompt(sessionId, 'second explicit turn')
  await f.agents().wait(sessionId)
  const runs = f.db.prepare('SELECT id FROM durable_runs WHERE session_id=?').all(sessionId) as { id: string }[]
  assert.equal(runs.length, 2)
  for (const run of runs) assert.equal(f.runs.attempts(run.id).length, 1)
  const contender = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
  t.after(() => contender.close())
  assert.throws(() => contender.heartbeat(), /writer_busy/)
})

test('native expectedSeq includes interleaved R1 model/cost/resource lifecycle events', async t => {
  const f = await fixture(t, async call => call === 1 ? [{ type: 'toolCall', id: 'note', name: 'note_add', arguments: { text: 'note' } }] : [{ type: 'text', text: 'done' }])
  const append = f.runs.append.bind(f.runs)
  const seen: number[] = []
  f.runs.append = (attempt, event, options) => {
    const id = f.runs.get(attempt.run_id).session_id
    assert.equal(options.expectedSeq, f.log.session(id)!.lastSeq + 1)
    seen.push(options.expectedSeq)
    return append(attempt, event, options)
  }
  const { sessionId } = await f.agents().create(f.input)
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.ok(seen.length >= 8)
  assert.ok(seen.some((seq, i) => i > 0 && seq > seen[i - 1]! + 1), 'lifecycle events advanced the native sequence')
  const events = f.log.readAll(sessionId, 'person')
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1))
  assert.equal(events.filter(e => e.type === 'agent.note').length, 1)
  assert.equal(f.runs.costs(latest(f, sessionId).run_id).length, 1)
})

for (const [name, budget, calls] of [
  ['before dispatch', { maxModelCalls: 0 }, 0],
  ['between calls', { maxModelCalls: 1 }, 1],
  ['observed tokens', { maxTokens: 0 }, 0],
  ['observed money', { maxCostMicrounits: 0 }, 0],
] as const) test(`R1 budget stops native execution ${name} with a durable terminal reason`, async t => {
  const f = await fixture(t, async () => [{ type: 'toolCall', id: 'note', name: 'note_add', arguments: { text: 'fixture' } }])
  const { sessionId } = await f.agents().create({ ...f.input, budget })
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.error, 'budget_exhausted')
  const attempt = latest(f, sessionId)
  assert.equal(f.runs.get(attempt.run_id).state, 'canceled')
  assert.equal(f.runs.executionReason(attempt.run_id), 'budget_exhausted')
  assert.equal(f.requests.length, calls)
  assert.equal(f.log.readAll(sessionId, 'person').filter(e => e.type === 'run.lifecycle' && e.data.reason === 'budget_exhausted' && e.data.state === 'canceled').length, 1)
})

test('an observed K3 quota refusal stops the native R1 run without another call', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('synthetic quota'), { status: 429 }) })
  const { sessionId } = await f.agents().create(f.input)
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'cancelled'); assert.equal(result.error, 'quota_exhausted')
  assert.equal(f.requests.length, 1)
  assert.equal(f.runs.get(latest(f, sessionId).run_id).state, 'canceled')
  assert.equal(f.runs.costs(latest(f, sessionId).run_id).length, 0, 'no invented cost for a refused call')
})

test('R1 wrapping_up blocks tool effects and bounds report calls', async t => {
  const block = held(); let effects = 0
  const f = await fixture(t, async call => {
    if (call === 1) await block.promise
    return [{ type: 'toolCall', id: `shell-${call}`, name: 'shell', arguments: { command: 'printf forbidden' } }]
  }, undefined, undefined, async () => { effects++; return { code: 0, stdout: '', stderr: '', truncated: false } })
  t.after(block.release)
  const { sessionId } = await f.agents().create({ ...f.input, budget: { reportMaxCalls: 1, reportMaxDurationMs: 10000 } })
  while (f.requests.length === 0) await new Promise(r => setImmediate(r))
  f.runs.wrappingUp(latest(f, sessionId)); block.release()
  const result = await f.agents().wait(sessionId)
  assert.equal(effects, 0)
  assert.equal(f.requests.length, 2, 'one working call and one report call')
  assert.equal(result.status, 'cancelled'); assert.equal(result.error, 'report_budget_exhausted')
})

test('native deletion removes Thread/session/log/FTS and every private resource; REST uses the contract', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input)
  await f.agents().wait(sessionId)
  const dirs = f.agents().sessions.paths(sessionId)
  for (const dir of dirs) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'fixture'), 'private fixture') }
  assert.equal(f.log.session(sessionId)!.threadId, sessionId)
  assert.throws(() => f.db.prepare('DELETE FROM threads WHERE id=?').run(sessionId), /coordinated deletion/)
  const app = nativeAgentRoutes(() => f.agents() as never)
  assert.equal((await app.request(`/${sessionId}`, { method: 'DELETE', headers: { origin: 'https://evil.invalid' } }, peer)).status, 403)
  const deleted = await app.request(`/${sessionId}`, { method: 'DELETE' }, peer)
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleteNativeSessionResponseSchema.parse(await deleted.json()), { sessionId, deleted: true })
  for (const dir of dirs) await assert.rejects(readdir(dir), { code: 'ENOENT' })
  for (const [table, key] of [['threads','id'], ['sessions','id'], ['session_writers','session_id'], ['session_events','session_id'], ['native_sessions','session_id'], ['durable_runs','session_id']] as const) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key}=?`).get(sessionId)!.n, 0, table)
  }
  for (const table of ['run_costs','run_attempts','run_execution','run_resources']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table)
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  f.db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES('integrity-check')")
  assert.equal((await app.request(`/${sessionId}`, { method: 'DELETE' }, peer)).status, 404)
})

test('deletion refuses a running turn and a separate K2 writer, preserving all resources', async t => {
  const block = held()
  const f = await fixture(t, async () => { await block.promise; return [{ type: 'text', text: 'done' }] })
  t.after(block.release)
  const { sessionId } = await f.agents().create(f.input)
  const app = nativeAgentRoutes(() => f.agents() as never)
  assert.equal((await app.request(`/${sessionId}`, { method: 'DELETE' }, peer)).status, 409)
  block.release(); await f.agents().wait(sessionId)
  const other = new SessionLog({ db: f.db, scrubber: f.scrubber })
  t.after(() => other.close())
  const writer = other.open(sessionId, { kind: 'agent' }); t.after(() => writer.close())
  assert.equal((await app.request(`/${sessionId}`, { method: 'DELETE' }, peer)).status, 409)
  assert.notEqual(f.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId), undefined)
  assert.notEqual(f.db.prepare('SELECT 1 FROM native_sessions WHERE session_id=? AND deletion_requested=0').get(sessionId), undefined)
  await readdir(f.agents().sessions.paths(sessionId)[0]!)
})

test('quarantine and its session record survive deletion, maintenance and restart', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const dir = join(f.data, 'native-cleanup'); await mkdir(dir)
  const record = join(dir, 'fixture.json'), bytes = JSON.stringify([f.agents().sessions.paths(sessionId)[0]])
  await writeFile(record, bytes)
  await assert.rejects(f.agents().deleteSession(sessionId), /cleanup_unconfirmed/)
  await f.agents().sessions.maintain(new Set(), new Date(Date.now() + 8 * 86400000))
  await f.restart()
  assert.equal(await readFile(record, 'utf8'), bytes)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM native_sessions WHERE session_id=?').get(sessionId)!.n, 1)
  assert.equal(f.agents().progress(sessionId).error, 'cleanup_unconfirmed')
})

test('canonical seven-day retention uses only user activity, keeps Trash recoverable, and restores explicitly', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const now = new Date()
  f.db.prepare('UPDATE threads SET last_user_activity_at=? WHERE id=?').run(new Date(now.getTime() - 8 * 86400000).toISOString(), sessionId)
  await f.agents().sessions.maintain(new Set([sessionId]), now)
  assert.equal(f.agents().sessions.retention(sessionId).state, 'active', 'a live native owner blocks expiry')
  await f.agents().sessions.maintain(new Set(), now)
  assert.equal(f.agents().sessions.retention(sessionId).state, 'trash')
  assert.throws(() => f.agents().prompt(sessionId, 'unsafe resume'), /session_expired/)
  await readdir(f.agents().sessions.paths(sessionId)[0]!)
  const app = nativeAgentRoutes(() => f.agents() as never)
  const restored = await app.request(`/${sessionId}/retention`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'keep' }) }, peer)
  assert.equal(restored.status, 200)
  assert.equal((await restored.json() as { state: string }).state, 'active')
  await f.agents().sessions.maintain(new Set(), new Date(now.getTime() + 100 * 86400000))
  assert.equal(f.agents().sessions.retention(sessionId).state, 'active')
})

test('reasoning exists only in K2 reasoning rows, never other ledgers, artifacts, exports or provider context', async t => {
  const marker = 'synthetic-reasoning-' + 'z'.repeat(40)
  const f = await fixture(t, async call => call === 1 ? [{ type: 'thinking', thinking: marker }, { type: 'toolCall', id: 'reasoning-note', name: 'note_add', arguments: { text: 'safe note' } }] : [{ type: 'text', text: 'public answer' }])
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const rows = f.db.prepare('SELECT type,payload,expires_at FROM session_events WHERE session_id=?').all(sessionId)
  assert.equal(rows.filter(row => String(row.payload).includes(marker)).length, 1)
  const reasoning = rows.find(row => row.type === 'reasoning')!
  assert.ok(reasoning, 'native thinking must use the K2 reasoning class')
  assert.ok(Date.parse(String(reasoning.expires_at)) <= Date.parse(f.agents().sessions.expiry(sessionId)!))
  assert.equal(JSON.stringify(f.log.readAll(sessionId, 'remote_agent')).includes(marker), false)
  const { sessionLogRoutes } = await import('../../src/session-log/routes.ts')
  const exported = await sessionLogRoutes(() => f.log).request(`/${sessionId}/export`, undefined, peer)
  assert.equal(exported.status, 200)
  assert.equal((await exported.text()).includes(marker), false)
  assert.equal(JSON.stringify(f.agents().progress(sessionId)).includes(marker), false)
  assert.equal(JSON.stringify(f.requests).includes(marker), false)
  for (const table of ['run_costs','run_execution','durable_runs','threads']) assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()).includes(marker), false, table)
  for (const dir of f.agents().sessions.paths(sessionId)) {
    let names: string[] = []; try { names = await readdir(dir) } catch { /* output directory may not exist */ }
    for (const name of names) assert.equal((await readFile(join(dir, name), 'utf8')).includes(marker), false)
  }
  const outputs = new NativeOutputs(f.data, sessionId, f.scrubber)
  await outputs.bound('safe-output'.repeat(10000))
  await f.agents().deleteSession(sessionId)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get()!.n, 0)
})

 test('Session retention waits 24 hours after explicit leave, restores before grace and cleans bytes after grace', async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create({ ...f.input, retention: 'session' }); await f.agents().wait(sessionId)
  f.agents().leaveSession(sessionId)
  await f.agents().sessions.maintain(new Set())
  assert.equal(f.agents().sessions.retention(sessionId).state, 'trash')
  const deadline = f.agents().sessions.retention(sessionId).recoveryDeadline!
  await f.agents().sessions.maintain(new Set(), new Date(Date.parse(deadline) - 1))
  assert.notEqual(f.log.session(sessionId), null)
  f.agents().setRetention(sessionId, 'keep')
  assert.equal(f.agents().sessions.retention(sessionId).state, 'active')
  f.agents().setRetention(sessionId, 'session'); f.agents().leaveSession(sessionId)
  await f.agents().sessions.maintain(new Set())
  const finalDeadline = f.agents().sessions.retention(sessionId).recoveryDeadline!
  await f.agents().sessions.maintain(new Set(), new Date(finalDeadline))
  assert.equal(f.log.session(sessionId), null)
  for (const dir of f.agents().sessions.paths(sessionId)) await assert.rejects(readdir(dir), { code: 'ENOENT' })
})

test('private native Thread owners cannot enter legacy lists, APIs or Chat Job admission, including native Trash', async t => {
  const { ThreadStore } = await import('../../src/store/threads.ts')
  const { JobStore } = await import('../../src/store/jobs.ts')
  const { threadsRoutes } = await import('../../src/http/threads-routes.ts')
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input); await f.agents().wait(sessionId)
  const threads = new ThreadStore(f.db), jobs = new JobStore(f.db)
  const app = threadsRoutes({ db: f.db, threads } as never)
  for (const trash of [false, true]) {
    if (trash) f.db.prepare('UPDATE native_sessions SET trashed_at=? WHERE session_id=?').run(new Date().toISOString(), sessionId)
    assert.equal(threads.list().some(row => row.id === sessionId), false)
    assert.equal(threads.listProjectless().some(row => row.id === sessionId), false)
    assert.equal(threads.get(sessionId), null)
    assert.equal(threads.getWithOwnership(sessionId), null)
    assert.equal(threads.update(sessionId, { model: 'legacy-override' }), null)
    assert.equal((await app.request(`/${sessionId}`)).status, 404)
    assert.equal((await app.request(`/${sessionId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'legacy escape' }) })).status, 404)
    assert.throws(() => jobs.createChat({ threadId: sessionId, idempotencyScope: 'native-owner-probe', idempotencyKey: 'fixture', requestFingerprint: 'fixture', derivedTitle: 'fixture', input: { content: 'legacy escape', attachments: [], autoApprove: null } }), /not found/)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 0)
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM durable_runs WHERE session_id=?').get(sessionId)!.n, 1)
  }
})
