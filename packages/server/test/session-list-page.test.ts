import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { SESSION_ROUTES, listSessionsResponse, sessionPageCursorSchema, sessionPageResponse, sessionSummarySchema } from '@guanxi/contract'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import { SessionLog } from '../src/session-log/log.ts'
import { sessionLogRoutes } from '../src/session-log/routes.ts'
import { ChatSessionMirror } from '../src/session-log/chat-mirror.ts'
import { RunStore } from '../src/runs/store.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { openDb } from '../src/store/db.ts'

const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
function fixture() {
  const db = openDb(':memory:'), scrubber = new SecretScrubber()
  const log = new SessionLog({ db, scrubber, clock: () => new Date('2026-10-22T00:00:00.000Z') })
  const app = new Hono().route('/api/sessions', sessionLogRoutes(() => log))
  return { db, scrubber, log, app, close() { log.close(); db.close() } }
}
function cursor(value: string) { return sessionPageCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) }
function thread(f: ReturnType<typeof fixture>, projectId?: string) {
  const store = new ThreadStore(f.db), input = { title: 'Synthetic', model: 'fixture', options: { numCtx: 4096, temperature: 0, think: 'high' as const } }
  return projectId ? store.createWithOwnership({ ...input, projectId }) : store.create({ ...input, mode: 'chat', workspaceId: null })
}

test('session metadata pages pass the legacy 200 boundary with stable tied dates, exact counts and no duplicate IDs', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 211; i++) f.log.open(`session-${String(i).padStart(3, '0')}`, { kind: 'agent' }).close()
    f.log.open('page', { kind: 'agent' }).close()
    const first = sessionPageResponse.parse(await (await f.app.request(`${SESSION_ROUTES.page()}?limit=200`, {}, LOOPBACK)).json())
    assert.equal(first.sessions.length, 200)
    assert.ok(first.nextCursor)
    const boundary = cursor(first.nextCursor)
    assert.equal(boundary.sessionId, first.sessions.at(-1)!.sessionId)
    const second = sessionPageResponse.parse(await (await f.app.request(`${SESSION_ROUTES.page()}?limit=200&cursor=${first.nextCursor}`, {}, LOOPBACK)).json())
    assert.equal(second.sessions.length, 12); assert.equal(second.nextCursor, null)
    const ids = [...first.sessions, ...second.sessions].map(row => row.sessionId)
    assert.equal(new Set(ids).size, 212)
    assert.deepEqual(ids, [...ids].sort().reverse())
    assert.equal(first.sessions.every(row => row.execution === null), true)
    // A valid pre-existing session named "page" retains its summary route.
    assert.equal(sessionSummarySchema.parse(await (await f.app.request('/api/sessions/page', {}, LOOPBACK)).json()).sessionId, 'page')
    const old = listSessionsResponse.parse(await (await f.app.request('/api/sessions?limit=1', {}, LOOPBACK)).json())
    assert.equal(old.sessions.length, 1)
    assert.equal(Object.hasOwn(old.sessions[0]!, 'execution'), false)
  } finally { f.close() }
})

test('paged metadata withholds late secrets, scrubs titles and includes no reasoning or private payload fields', async () => {
  const f = fixture()
  try {
    const late = 'synthetic-late-secret', reference = 'secret://fixture/late'
    const visible = f.log.open('visible', { kind: 'agent' })
    visible.append({ type: 'prompt', data: { origin: 'typed', messageId: 'prompt', text: `Title ${late}`, attachmentCount: 0 } })
    visible.append({ type: 'reasoning', data: { messageId: 'prompt', step: 0, text: 'PRIVATE-REASONING-FIXTURE' } })
    f.log.open(`withheld-${late}`, { kind: 'agent' }).close()
    f.scrubber.register(reference, late)
    const response = await f.app.request(`${SESSION_ROUTES.page()}?limit=1`, {}, LOOPBACK)
    const text = await response.text(), page = sessionPageResponse.parse(JSON.parse(text))
    assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0]!.sessionId, 'visible')
    assert.equal(page.omitted.withheld, true); assert.equal(page.nextCursor, null)
    assert.equal(text.includes(late), false); assert.equal(text.includes('PRIVATE-REASONING-FIXTURE'), false)
    assert.equal(text.includes('attachmentCount'), false)
    f.scrubber.expect('pending-source')
    assert.equal((await f.app.request(SESSION_ROUTES.page(), {}, LOOPBACK)).status, 503)
  } finally { f.close() }
})

test('execution facts join the actual run session and retain exact source, state, attempt and observation time', () => {
  const f = fixture()
  let now = Date.parse('2026-10-22T00:00:00.000Z')
  const runs = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber, clock: () => now, alwaysOn: true })
  try {
    runs.heartbeat()
    const run = runs.create({ id: 'run-unrelated-to-session-name', sessionId: 'mapped-session' })
    const attempt = runs.start(run.id)
    f.log.open('no-execution', { kind: 'agent' }).close()
    f.log.open(run.id, { kind: 'agent' }).close()
    const page = f.log.page(50)
    assert.deepEqual(page.sessions.find(row => row.sessionId === 'mapped-session')!.execution,
      { state: 'working', attemptState: 'delivered', source: 'run-home', observedAt: new Date(now).toISOString(), confidence: 'observed' })
    assert.equal(page.sessions.find(row => row.sessionId === run.id)!.execution, null, 'never infer association by matching a run ID to a session ID')
    assert.equal(page.sessions.find(row => row.sessionId === 'no-execution')!.execution, null)
    now += 1000; runs.complete(attempt, 'completed')
    assert.deepEqual(f.log.page(50).sessions.find(row => row.sessionId === 'mapped-session')!.execution,
      { state: 'completed', attemptState: 'completed', source: 'run-home', observedAt: new Date(now).toISOString(), confidence: 'observed' })
    now += 1000
    const next = runs.create({ id: 'next-root', sessionId: 'mapped-session' }), nextAttempt = runs.start(next.id)
    const child = runs.delegate(nextAttempt, { key: 'child', deadline: now + 10000 })
    assert.equal(runs.get(child.child_id).session_id, 'mapped-session')
    assert.deepEqual(f.log.page(50).sessions.find(row => row.sessionId === 'mapped-session')!.execution,
      { state: 'waiting_children', attemptState: 'sleeping', source: 'run-home', observedAt: new Date(now).toISOString(), confidence: 'observed' },
      'a child sharing the same session must not replace its sleeping root observation')
  } finally { runs.close(); f.close() }
})

test('page query validation and loopback trust boundary fail closed; deferred mirrors remain omitted', async () => {
  const f = fixture()
  try {
    for (const suffix of ['?limit=0', '?limit=201', '?limit=2&limit=3', '?cursor=not-json', '?cursor=%%%%', '?extra=1']) {
      assert.equal((await f.app.request(SESSION_ROUTES.page() + suffix, {}, LOOPBACK)).status, 400)
    }
    assert.equal((await f.app.request(SESSION_ROUTES.page())).status, 403)
    assert.equal((await f.app.request(SESSION_ROUTES.page(), {}, { incoming: { socket: { remoteAddress: '192.0.2.1' } } })).status, 403)
    const mirror = new ChatSessionMirror({ db: f.db, log: f.log, catchUpRetryMs: 60000 })
    const jobs = new JobStore(f.db, { sessionMirror: mirror })
    const thread = new ThreadStore(f.db).create({ title: 'Synthetic', mode: 'chat', model: 'fixture', workspaceId: null,
      options: { numCtx: 4096, temperature: 0, think: 'high' } })
    const job = jobs.createChat({ threadId: thread.id, idempotencyScope: 'synthetic', idempotencyKey: 'synthetic-key', requestFingerprint: 'fixture',
      input: { content: 'Synthetic prompt', attachments: [], autoApprove: null }, derivedTitle: 'Synthetic' }).job
    f.scrubber.expect('mirror-source')
    jobs.transition({ jobId: job.id, expectedStatus: 'queued', status: 'reserving' })
    f.scrubber.ready('mirror-source')
    const page = f.log.page(1)
    assert.equal(page.sessions.length, 0); assert.equal(page.omitted.catchingUp, true)
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally { f.close() }
})

test('navigation targets come from native and thread ownership records rather than session kind or guessed IDs', () => {
  const f = fixture()
  try {
    const project = new ProjectStore(f.db).create('Synthetic project'), local = thread(f), owned = thread(f, project.id), native = thread(f)
    f.log.open('local-chat', { kind: 'chat', threadId: local.id }).close()
    f.log.open('owned-chat', { kind: 'chat', threadId: owned.id }).close()
    f.log.open('native-record', { kind: 'agent', threadId: native.id }).close()
    f.db.prepare('INSERT INTO native_sessions(session_id,thread_id) VALUES (?,?)').run('native-record', native.id)
    f.log.open('generic-agent', { kind: 'agent' }).close()
    const page = f.log.page(50)
    const navigation = (id: string) => page.sessions.find(session => session.sessionId === id)!.navigation
    assert.deepEqual(navigation('local-chat'), { kind: 'chat', threadId: local.id, projectId: null })
    assert.deepEqual(navigation('owned-chat'), { kind: 'chat', threadId: owned.id, projectId: project.id })
    assert.deepEqual(navigation('native-record'), { kind: 'native', sessionId: 'native-record' })
    assert.deepEqual(navigation('generic-agent'), { kind: 'inspector', sessionId: 'generic-agent' })
  } finally { f.close() }
})

test('later-withheld thread and project references never become route targets or leak raw values', () => {
  const f = fixture()
  try {
    const project = new ProjectStore(f.db).create('Synthetic project'), local = thread(f), owned = thread(f, project.id)
    f.log.open('local-record', { kind: 'chat', threadId: local.id }).close()
    f.log.open('project-record', { kind: 'chat', threadId: owned.id }).close()
    f.scrubber.register('secret://fixture/thread', local.id)
    f.scrubber.register('secret://fixture/project', project.id)
    const page = f.log.page(50), text = JSON.stringify(page)
    assert.equal(text.includes(local.id), false); assert.equal(text.includes(project.id), false)
    for (const session of page.sessions) assert.deepEqual(session.navigation, { kind: 'inspector', sessionId: session.sessionId })
  } finally { f.close() }
})

test('retained native and trashed chat records never become active chat targets', () => {
  const f = fixture()
  try {
    const native = thread(f)
    f.log.open('retained-native', { kind: 'agent', threadId: native.id }).close()
    f.db.prepare('INSERT INTO native_sessions(session_id,thread_id) VALUES (?,?)').run('retained-native', native.id)
    for (const field of ['leave_at', 'trashed_at', 'deletion_requested']) {
      f.db.prepare('UPDATE native_sessions SET leave_at=NULL,trashed_at=NULL,deletion_requested=0').run()
      f.db.prepare(`UPDATE native_sessions SET ${field}=?`).run(field === 'deletion_requested' ? 1 : '2026-10-22T00:00:00.000Z')
      assert.deepEqual(f.log.page(50).sessions[0]!.navigation, { kind: 'inspector', sessionId: 'retained-native' })
    }
    const legacy = thread(f)
    f.log.open('trashed-chat', { kind: 'chat', threadId: legacy.id }).close()
    f.db.prepare(`UPDATE threads SET chat_lifecycle_state='trash',chat_tombstoned_at=?,
      chat_tombstone_activity_at=?,chat_tombstone_reason='ttl_expired',chat_lifecycle_reason='ttl_expired' WHERE id=?`)
      .run('2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', legacy.id)
    assert.deepEqual(f.log.page(50).sessions.find(row => row.sessionId === 'trashed-chat')!.navigation,
      { kind: 'inspector', sessionId: 'trashed-chat' })
  } finally { f.close() }
})
