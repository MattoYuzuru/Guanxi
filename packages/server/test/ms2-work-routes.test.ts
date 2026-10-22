import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import {
  WORK_ERROR_CODES,
  appendWorkEventResponseSchema,
  latestWorkRevisionResponseSchema,
  workErrorSchema,
  workExportResponseSchema,
  workItemsPageSchema,
  workModeSnapshotSchema,
  workPlanRevisionSchema,
  type WorkErrorCode,
} from '@guanxi/contract'
import { WorkError } from '../src/work/types.ts'
import { workFailure } from '../src/work/wire.ts'
import { REMOTE_PEER, T0, call, ms2Fixture } from './ms2-fixture.ts'

const P = '/api/work/projects/p1'
const plan = {
  items: [
    { id: 'a', title: 'First', acceptance: 'npm test' },
    { id: 'b', title: 'Second', dependsOn: ['a'], ownerRole: 'executor', protectedPaths: ['docs/x.md'] },
    { id: 'c', title: 'Third' },
  ],
}

function assertError(response: { status: number; json: unknown; text: string }, status: number, code: WorkErrorCode) {
  assert.equal(response.status, status, response.text)
  assert.deepEqual(response.json, { code })
  assert.doesNotThrow(() => workErrorSchema.parse(response.json))
}

async function withPlan(t: TestContext) {
  const f = await ms2Fixture(t)
  const response = await call(f.app, `${P}/revisions`, { json: plan })
  assert.equal(response.status, 201, response.text)
  return f
}

const statuses = async (f: Awaited<ReturnType<typeof ms2Fixture>>, query = '') => {
  const page = workItemsPageSchema.parse((await call(f.app, `${P}/items${query}`)).json)
  return Object.fromEntries(page.items.map((item) => [item.id, item.status]))
}

test('starts empty and off', async (t) => {
  const f = await ms2Fixture(t)
  assert.deepEqual(latestWorkRevisionResponseSchema.parse((await call(f.app, `${P}/revision`)).json), { revision: null })
  assert.deepEqual(workItemsPageSchema.parse((await call(f.app, `${P}/items`)).json), { revision: null, items: [], nextCursor: null, total: 0, warnings: [] })
  assert.deepEqual(workModeSnapshotSchema.parse((await call(f.app, `${P}/mode`)).json), { projectId: 'p1', mode: 'off', reason: 'default' })
  assertError(await call(f.app, `${P}/export`), 404, 'revision_not_found')
})

test('adds immutable numbered revisions authored by the user', async (t) => {
  const f = await ms2Fixture(t)
  const first = workPlanRevisionSchema.parse((await call(f.app, `${P}/revisions`, { json: plan })).json)
  assert.equal(first.revision, 1)
  assert.equal(first.author, 'user')
  assert.equal(first.createdAt, new Date(T0).toISOString())
  assert.deepEqual(first.items[2], { id: 'c', title: 'Third', acceptance: null, dependsOn: [], estimateMinutes: null, ownerRole: null, protectedPaths: [] }, 'defaults are filled')
  const second = workPlanRevisionSchema.parse((await call(f.app, `${P}/revisions`, { json: { items: [{ id: 'z', title: 'Only' }] } })).json)
  assert.equal(second.revision, 2)
  const latest = latestWorkRevisionResponseSchema.parse((await call(f.app, `${P}/revision`)).json)
  assert.deepEqual(latest.revision!.items.map((item) => item.id), ['z'])
  const rows = f.ledger()!.store.db.prepare('SELECT revision, author FROM wg1_plan_revisions WHERE project_id=? ORDER BY revision').all('p1')
  assert.deepEqual(rows.map((row) => [row.revision, row.author]), [[1, 'user'], [2, 'user']], 'revision 1 is still stored')
  assert.throws(() => f.ledger()!.store.db.prepare('UPDATE wg1_plan_revisions SET author=? WHERE revision=1').run('lead'), 'the table rejects edits')
  // Another project's ledger is separate.
  assert.equal(latestWorkRevisionResponseSchema.parse((await call(f.app, '/api/work/projects/p2/revision')).json).revision, null)
})

test('rejects bad revisions with codes that quote no item id, path or command', async (t) => {
  const f = await ms2Fixture(t)
  const secret = 'SECRET-ITEM-ID'
  const cases: Array<[unknown, number, WorkErrorCode]> = [
    [{ items: [{ id: secret, title: 'x' }, { id: secret, title: 'y' }] }, 422, 'duplicate_item'],
    [{ items: [{ id: 'a', title: 'x', dependsOn: [secret] }] }, 422, 'missing_dependency'],
    [{ items: [{ id: 'a', title: 'x', dependsOn: [secret] }, { id: secret, title: 'y', dependsOn: ['a'] }] }, 422, 'dependency_cycle'],
    [{ items: [{ id: 'a', title: 'x', ownerRole: 'boss' }] }, 400, 'validation_failed'],
    [{ items: [{ id: 'a', title: 'x', protectedPaths: ['../outside'] }] }, 400, 'validation_failed'],
    [{ items: [{ id: 'a', title: 'x', protectedPaths: ['/etc/passwd'] }] }, 400, 'validation_failed'],
    [{ items: [{ id: 'a', title: '' }] }, 400, 'validation_failed'],
    [{ items: [{ id: 'a', title: 'x', estimateMinutes: -1 }] }, 400, 'validation_failed'],
    [{ items: [{ id: 'a', title: 'x', status: 'done' }] }, 400, 'validation_failed'],
    [{ items: [], author: 'lead' }, 400, 'validation_failed'],
    [{ items: [], projectId: 'other' }, 400, 'validation_failed'],
    [{ items: 'nope' }, 400, 'validation_failed'],
  ]
  for (const [body, status, code] of cases) {
    const response = await call(f.app, `${P}/revisions`, { json: body })
    assertError(response, status, code)
    assert.ok(!response.text.includes(secret))
  }
  const count = f.ledger()!.store.db.prepare('SELECT COUNT(*) AS n FROM wg1_plan_revisions').get() as { n: number }
  assert.equal(count.n, 0, 'nothing was stored')
  assertError(await call(f.app, '/api/work/projects/bad%20id/revision'), 400, 'validation_failed')
  assertError(await call(f.app, '/api/work/projects/-x/revision'), 400, 'validation_failed')
})

test('derives statuses from evidence and pages the whole graph stably', async (t) => {
  const f = await withPlan(t)
  assert.deepEqual(await statuses(f), { a: 'ready', b: 'blocked', c: 'ready' })
  assert.deepEqual(await statuses(f, '?status=ready'), { a: 'ready', c: 'ready' })
  const first = workItemsPageSchema.parse((await call(f.app, `${P}/items?limit=2`)).json)
  assert.equal(first.revision, 1)
  assert.equal(first.total, 3)
  assert.deepEqual(first.items.map((item) => item.id), ['a', 'b'])
  assert.ok(first.nextCursor)
  const second = workItemsPageSchema.parse((await call(f.app, `${P}/items?limit=2&cursor=${first.nextCursor}`)).json)
  assert.deepEqual(second.items.map((item) => item.id), ['c'])
  assert.equal(second.nextCursor, null)
  assert.equal(workItemsPageSchema.parse((await call(f.app, `${P}/items`)).json).items.length, 3, 'no limit returns the whole graph')
  assertError(await call(f.app, `${P}/items?limit=2&status=ready&cursor=${first.nextCursor}`), 400, 'cursor_mismatch')
  assertError(await call(f.app, `${P}/items?cursor=AAAA`), 400, 'invalid_cursor')
  for (const query of ['status=nope', 'limit=0', 'limit=1001', 'limit=x', 'cursor=a+b', 'sort=id']) {
    assertError(await call(f.app, `${P}/items?${query}`), 400, 'validation_failed')
  }
})

test('a person closes an item and the dependent unblocks; the node supplies source and time', async (t) => {
  const f = await withPlan(t)
  f.clock.now = T0 + 90_000
  const response = await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'a', decision: 'done' } })
  assert.equal(response.status, 201, response.text)
  const appended = appendWorkEventResponseSchema.parse(response.json)
  assert.equal(appended.seq, 1)
  assert.deepEqual(appended.event, { type: 'human_decision', itemId: 'a', decision: 'done', at: new Date(T0 + 90_000).toISOString(), source: 'user:local' })
  assert.deepEqual(await statuses(f), { a: 'done', b: 'ready', c: 'ready' })
  const page = workItemsPageSchema.parse((await call(f.app, `${P}/items?status=done`)).json)
  assert.equal(page.items[0]!.evidence.length, 1)
  assert.equal(f.appFor('someone-else') !== f.app, true)
  const other = await call(f.appFor('someone-else'), `${P}/events`, { json: { type: 'human_decision', itemId: 'c', decision: 'done' } })
  assert.equal(appendWorkEventResponseSchema.parse(other.json).event.source, 'user:someone-else', 'provenance follows the account that acted')
})

test('HTTP can never forge harness, judge or agent evidence', async (t) => {
  const f = await withPlan(t)
  const forged: unknown[] = [
    { type: 'acceptance_result', itemId: 'a', passed: true, commit: 'abc', cleanCheckout: true, command: 'npm test', source: 'harness:acceptance' },
    { type: 'commit_accepted', itemId: 'a', commit: 'abc' },
    { type: 'judge_verdict', itemId: 'a', verdict: 'pass' },
    { type: 'claimed', itemId: 'a' },
    { type: 'released', itemId: 'a' },
    { type: 'verification_requested', itemId: 'a' },
    { type: 'proposed', itemId: 'x', item: { id: 'x', title: 'sneaky' } },
    { type: 'human_decision', itemId: 'a', decision: 'done', source: 'harness:acceptance' },
    { type: 'human_decision', itemId: 'a', decision: 'done', at: '1999-01-01T00:00:00.000Z' },
    { type: 'accepted', itemId: 'a', source: 'user:owner' },
    { type: 'human_decision', itemId: 'a', decision: 'approved' },
    { type: 'human_decision', itemId: 'a', decision: 'done', projectId: 'p2' },
  ]
  for (const body of forged) assertError(await call(f.app, `${P}/events`, { json: body }), 400, 'validation_failed')
  assert.deepEqual(await statuses(f), { a: 'ready', b: 'blocked', c: 'ready' }, 'no forged evidence changed a status')
  const stored = f.ledger()!.store.db.prepare('SELECT COUNT(*) AS n FROM wg1_events').get() as { n: number }
  assert.equal(stored.n, 0)
  await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'a', decision: 'done' } })
  await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'c', decision: 'cancel' } })
  const sources = f.ledger()!.store.db.prepare('SELECT payload FROM wg1_events').all().map((row) => (JSON.parse(String(row.payload)) as { source: string }).source)
  assert.ok(sources.length === 2 && sources.every((source) => source === 'user:local'), 'every stored event is attributed to the person')
})

test('refuses events for unknown items, missing plans and non-proposals', async (t) => {
  const f = await ms2Fixture(t)
  assertError(await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'a', decision: 'done' } }), 404, 'revision_not_found')
  await call(f.app, `${P}/revisions`, { json: plan })
  assertError(await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'ghost', decision: 'done' } }), 404, 'item_not_found')
  assertError(await call(f.app, `${P}/events`, { json: { type: 'accepted', itemId: 'a' } }), 422, 'invalid_proposal')
  assertError(await call(f.app, `${P}/events`, { json: { type: 'rejected', itemId: 'a' } }), 422, 'invalid_proposal')
  const count = f.ledger()!.store.db.prepare('SELECT COUNT(*) AS n FROM wg1_events').get() as { n: number }
  assert.equal(count.n, 0, 'refused events leave no unattributable row')
})

test('accepts or rejects an agent proposal made through the kernel service', async (t) => {
  const f = await withPlan(t)
  const propose = (id: string) => f.ledger()!.store.appendEvent('p1', {
    type: 'proposed', itemId: id, at: T0, source: 'agent:executor',
    item: { id, title: `Proposal ${id}`, acceptance: null, dependsOn: ['a'], estimateMinutes: null, ownerRole: null, protectedPaths: [] },
  })
  propose('x'); propose('y')
  assert.deepEqual(await statuses(f), { a: 'ready', b: 'blocked', c: 'ready', x: 'proposed', y: 'proposed' })
  assert.equal((await call(f.app, `${P}/events`, { json: { type: 'accepted', itemId: 'x' } })).status, 201)
  assert.equal((await call(f.app, `${P}/events`, { json: { type: 'rejected', itemId: 'y' } })).status, 201)
  assert.deepEqual(await statuses(f), { a: 'ready', b: 'blocked', c: 'ready', x: 'blocked' }, 'the accepted proposal joins the graph, the rejected one leaves it')
  assertError(await call(f.app, `${P}/events`, { json: { type: 'accepted', itemId: 'x' } }), 422, 'invalid_proposal')
  assertError(await call(f.app, `${P}/events`, { json: { type: 'accepted', itemId: 'y' } }), 404, 'item_not_found')
})

test('a canceled item accepts only a reopen', async (t) => {
  const f = await withPlan(t)
  const decide = (decision: string) => call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'c', decision } })
  assert.equal((await decide('cancel')).status, 201)
  assert.equal((await statuses(f))['c'], 'canceled')
  assertError(await decide('done'), 409, 'item_canceled')
  assert.equal((await decide('reopen')).status, 201)
  assert.equal((await statuses(f))['c'], 'ready')
})

test('sets and reads the mode with a reason', async (t) => {
  const f = await ms2Fixture(t)
  const set = await call(f.app, `${P}/mode`, { method: 'PUT', json: { mode: 'project', reason: 'two executors' } })
  assert.deepEqual(workModeSnapshotSchema.parse(set.json), { projectId: 'p1', mode: 'project', reason: 'two executors' })
  assert.deepEqual(workModeSnapshotSchema.parse((await call(f.app, `${P}/mode`)).json).mode, 'project')
  assert.equal(workModeSnapshotSchema.parse((await call(f.app, '/api/work/projects/p2/mode')).json).mode, 'off', 'modes are per project')
  for (const body of [{ mode: 'turbo', reason: 'x' }, { mode: 'off', reason: '' }, { mode: 'off', reason: '   ' }, { mode: 'off' }, { reason: 'x' }, { mode: 'off', reason: 'x', extra: 1 }]) {
    assertError(await call(f.app, `${P}/mode`, { method: 'PUT', json: body }), 400, 'validation_failed')
  }
  assert.equal(workModeSnapshotSchema.parse((await call(f.app, `${P}/mode`)).json).mode, 'project', 'refused writes changed nothing')
})

test('exports Markdown on demand and writes no file', async (t) => {
  const f = await withPlan(t)
  await call(f.app, `${P}/events`, { json: { type: 'human_decision', itemId: 'a', decision: 'done' } })
  const before = (await readdir(f.dir)).sort()
  const response = await call(f.app, `${P}/export`)
  assert.equal(response.status, 200)
  const exported = workExportResponseSchema.parse(response.json)
  assert.equal(exported.projectId, 'p1')
  assert.equal(exported.revision, 1)
  assert.match(exported.markdown, /^# Work ledger — p1/)
  assert.ok(exported.markdown.includes('Second') && exported.markdown.includes('- done: 1'))
  assert.deepEqual((await readdir(f.dir)).sort(), before, 'the data directory gained no file')
})

test('guards: non-JSON, cross-origin, non-loopback, oversize and malformed bodies', async (t) => {
  const f = await withPlan(t)
  const body = { type: 'human_decision', itemId: 'a', decision: 'done' }
  assertError(await call(f.app, `${P}/events`, { raw: JSON.stringify(body), headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  assertError(await call(f.app, `${P}/mode`, { method: 'PUT', raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  assertError(await call(f.app, `${P}/events`, { json: body, origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, `${P}/items`, { origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, `${P}/events`, { json: body, peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, `${P}/export`, { peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, `${P}/revisions`, { raw: '{oops' }), 400, 'validation_failed')
  assertError(await call(f.app, `${P}/revisions`, { raw: JSON.stringify({ items: [], pad: 'x'.repeat(2 * 1024 * 1024 + 1) }) }), 413, 'body_too_large')
  assert.deepEqual(await statuses(f), { a: 'ready', b: 'blocked', c: 'ready' }, 'refused writes changed nothing')
})

test('answers work_unavailable once the service is gone', async (t) => {
  const f = await withPlan(t)
  await f.handles.work.dispose()
  assertError(await call(f.app, `${P}/items`), 503, 'work_unavailable')
  assertError(await call(f.app, `${P}/events`, { json: { type: 'accepted', itemId: 'a' } }), 503, 'work_unavailable')
})

test('every library failure maps to a documented wire code', () => {
  const codes = ['invalid_shape', 'invalid_source', 'invalid_revision', 'invalid_event', 'duplicate_item', 'missing_dependency', 'dependency_cycle', 'invalid_proposal', 'canceled', 'revision_not_found', 'item_not_found', 'invalid_paging', 'invalid_cursor', 'cursor_mismatch', 'invalid_activation', 'invalid_clock', 'schema_version', 'something_new']
  for (const code of codes) {
    const failure = workFailure(new WorkError(code, 'quoted item SECRET'))
    assert.ok((WORK_ERROR_CODES as readonly string[]).includes(failure.code), code)
  }
  assert.equal(workFailure(new WorkError('canceled', 'x')).code, 'item_canceled')
  assert.deepEqual(workFailure(new Error('x')), { code: 'internal_error', status: 500 })
})

test('the ledger fixes provenance itself, whatever a caller passes in', async (t) => {
  const f = await withPlan(t)
  const forged = { type: 'human_decision', itemId: 'a', decision: 'done', source: 'harness:acceptance', at: '1999-01-01T00:00:00.000Z' }
  const stored = f.ledger()!.appendHumanEvent('local', 'p1', forged as never)
  assert.equal(stored.source, 'user:local')
  assert.equal(stored.at, new Date(T0).toISOString())
  assert.throws(() => f.ledger()!.appendHumanEvent('local', 'p1', { type: 'judge_verdict', itemId: 'b', verdict: 'pass' } as never), { code: 'invalid_source' }, 'a non-human event cannot be written as a user')
  assert.throws(() => f.ledger()!.appendHumanEvent('local', 'p1', { type: 'acceptance_result', itemId: 'b', passed: true, commit: 'c', cleanCheckout: true, command: 'x' } as never), { code: 'invalid_source' })
})

test('an oversized or oddly named row written by a kernel caller never breaks the read routes', async (t) => {
  const f = await ms2Fixture(t)
  f.ledger()!.store.addRevision({
    projectId: 'p1', author: 'lead',
    items: [{ id: 'planner item/with spaces', title: 'T'.repeat(600), acceptance: 'A'.repeat(5000), dependsOn: [], estimateMinutes: null, ownerRole: null, protectedPaths: ['/abs/path'] }],
  })
  const revision = await call(f.app, `${P}/revision`)
  assert.equal(revision.status, 200, revision.text)
  const items = await call(f.app, `${P}/items`)
  assert.equal(items.status, 200, items.text)
  assert.equal(workItemsPageSchema.parse(items.json).items[0]!.title.length, 600)
  assert.equal((await call(f.app, `${P}/export`)).status, 200)
  // The same row is refused when it arrives over HTTP.
  assertError(await call(f.app, `${P}/revisions`, { json: { items: [{ id: 'a', title: 'T'.repeat(501) }] } }), 400, 'validation_failed')
})
