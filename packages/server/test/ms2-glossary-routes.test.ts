import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import {
  GLOSSARY_ERROR_CODES,
  GLOSSARY_PREVIEW_MAX_CHARS,
  glossaryErrorSchema,
  glossaryHistoryResponseSchema,
  glossaryPreviewResponseSchema,
  listGlossaryResponseSchema,
  storedGlossaryEntrySchema,
  type GlossaryErrorCode,
} from '@guanxi/contract'
import { GlossaryStoreError } from '../src/voice/store.ts'
import { glossaryRevisionHash } from '../src/voice/marker.ts'
import { GlossaryInvalidError, glossaryFailure, mutating } from '../src/voice/wire.ts'
import { REMOTE_PEER, call, ms2Fixture } from './ms2-fixture.ts'

const BASE = '/api/voice/glossary'
const hono = { canonical: 'Hono', variants: ['хоно', 'хона'], language: 'en' }

function assertError(response: { status: number; json: unknown; text: string }, status: number, code: GlossaryErrorCode) {
  assert.equal(response.status, status, response.text)
  assert.deepEqual(response.json, { code })
  assert.doesNotThrow(() => glossaryErrorSchema.parse(response.json))
}

async function create(f: Awaited<ReturnType<typeof ms2Fixture>>, body: unknown, app = f.app) {
  return call(app, BASE, { json: body })
}

async function seeded(t: TestContext) {
  const f = await ms2Fixture(t)
  const response = await create(f, { id: 'hono', scope: 'account', entry: hono })
  assert.equal(response.status, 201, response.text)
  return f
}

test('creates an account entry with a client id or a node-assigned id', async (t) => {
  const f = await ms2Fixture(t)
  const first = await create(f, { id: 'hono', scope: 'account', entry: hono })
  assert.equal(first.status, 201)
  const stored = storedGlossaryEntrySchema.parse(first.json)
  assert.deepEqual(stored.entry, { id: 'hono', ...hono, caseSensitive: false, inflect: true })
  assert.equal(stored.scope, 'account')
  assert.equal(stored.projectId, null)
  assert.equal(stored.active, true)
  assert.equal(stored.revision, 1)
  assert.ok(!first.text.includes('accountId') && !first.text.includes('"local"'), 'the account stays on the node')
  const assigned = storedGlossaryEntrySchema.parse((await create(f, { scope: 'account', entry: { canonical: 'PR', variants: ['пиар'], language: 'en' } })).json)
  assert.match(assigned.id, /^gl_[0-9a-f-]{36}$/)
  assertError(await create(f, { id: 'hono', scope: 'account', entry: { canonical: 'Other', variants: [], language: 'en' } }), 409, 'entry_exists')
  assert.equal(f.glossary()!.store.list('local', { includeInactive: true }).length, 2)
})

test('validates the create body and never lets HTTP choose the revision source', async (t) => {
  const f = await ms2Fixture(t)
  const bad: unknown[] = [
    { scope: 'project', entry: hono },
    { scope: 'project', projectId: null, entry: hono },
    { scope: 'account', projectId: 'p1', entry: hono },
    { scope: 'team', entry: hono },
    { scope: 'account', entry: { ...hono, language: 'de' } },
    { scope: 'account', entry: { ...hono, canonical: '' } },
    { scope: 'account', entry: { ...hono, variants: [''] } },
    { scope: 'account', entry: { ...hono, id: 'smuggled' } },
    { scope: 'account', entry: { ...hono, extra: true } },
    { scope: 'account', entry: hono, source: 'import' },
    { scope: 'account', entry: hono, accountId: 'other-account' },
    { id: 'has space', scope: 'account', entry: hono },
    { scope: 'account' },
  ]
  for (const body of bad) assertError(await create(f, body), 400, 'validation_failed')
  assert.equal(f.glossary()!.store.list('local', { includeInactive: true }).length, 0, 'nothing was written')
  const ok = await create(f, { id: 'hono', scope: 'account', entry: hono })
  assert.equal(ok.status, 201)
  const history = glossaryHistoryResponseSchema.parse((await call(f.app, `${BASE}/hono/history`)).json)
  assert.deepEqual(history.revisions.map((row) => row.source), ['user'])
})

test('lists account and project entries with the documented filters', async (t) => {
  const f = await seeded(t)
  await create(f, { id: 'api', scope: 'project', projectId: 'p1', entry: { canonical: 'API', variants: ['апи'], language: 'en' } })
  await create(f, { id: 'cli', scope: 'project', projectId: 'p2', entry: { canonical: 'CLI', variants: ['кли'], language: 'en' } })
  const ids = async (query: string) => listGlossaryResponseSchema.parse((await call(f.app, `${BASE}${query}`)).json).entries.map((row) => row.id).sort()
  assert.deepEqual(await ids(''), ['api', 'cli', 'hono'], 'no project filter lists everything the account owns')
  assert.deepEqual(await ids('?projectId=p1'), ['api', 'hono'])
  assert.deepEqual(await ids('?projectId=p2'), ['cli', 'hono'])
  await call(f.app, `${BASE}/hono/deactivate`, { json: {} })
  assert.deepEqual(await ids('?projectId=p1'), ['api'])
  assert.deepEqual(await ids('?projectId=p1&includeInactive=true'), ['api', 'hono'])
  for (const query of ['?includeInactive=yes', '?projectId=bad id', '?scope=account']) {
    assertError(await call(f.app, `${BASE}${query}`), 400, 'validation_failed')
  }
})

test('updates, deactivates, reactivates and reverts with an append-only history', async (t) => {
  const f = await seeded(t)
  const update = await call(f.app, `${BASE}/hono`, { method: 'PUT', json: { entry: { ...hono, variants: ['хоно'] } } })
  assert.equal(storedGlossaryEntrySchema.parse(update.json).revision, 2)
  assert.deepEqual(storedGlossaryEntrySchema.parse(update.json).entry.variants, ['хоно'])
  const off = storedGlossaryEntrySchema.parse((await call(f.app, `${BASE}/hono/deactivate`, { json: {} })).json)
  assert.equal(off.active, false)
  assertError(await call(f.app, `${BASE}/hono/deactivate`, { json: {} }), 409, 'already_inactive')
  assertError(await call(f.app, `${BASE}/hono`, { method: 'PUT', json: { entry: hono } }), 409, 'entry_inactive')
  const on = storedGlossaryEntrySchema.parse((await call(f.app, `${BASE}/hono/reactivate`, { json: {} })).json)
  assert.equal(on.active, true)
  assertError(await call(f.app, `${BASE}/hono/reactivate`, { json: {} }), 409, 'already_active')
  const reverted = storedGlossaryEntrySchema.parse((await call(f.app, `${BASE}/hono/revert`, { json: {} })).json)
  assert.equal(reverted.revision, 5)
  assert.equal(reverted.active, false, 'reverting a reactivation restores the inactive state')
  const history = glossaryHistoryResponseSchema.parse((await call(f.app, `${BASE}/hono/history`)).json)
  assert.deepEqual(history.revisions.map((row) => [row.revision, row.op]), [[1, 'create'], [2, 'update'], [3, 'deactivate'], [4, 'reactivate'], [5, 'revert']])
  assert.deepEqual(history.revisions[0]!.entry!.variants, ['хоно', 'хона'], 'the first revision still holds its original variants')
})

test('maps missing entries, bad ids and non-empty lifecycle bodies', async (t) => {
  const f = await seeded(t)
  for (const [method, path, json] of [
    ['PUT', `${BASE}/ghost`, { entry: hono }],
    ['POST', `${BASE}/ghost/deactivate`, {}],
    ['POST', `${BASE}/ghost/reactivate`, {}],
    ['POST', `${BASE}/ghost/revert`, {}],
    ['GET', `${BASE}/ghost/history`, undefined],
  ] as const) {
    assertError(await call(f.app, path, { method, json }), 404, 'entry_not_found')
  }
  assertError(await call(f.app, `${BASE}/bad%20id/history`), 400, 'validation_failed')
  assertError(await call(f.app, `${BASE}/hono/deactivate`, { json: { force: true } }), 400, 'validation_failed')
  assertError(await call(f.app, `${BASE}/hono`, { method: 'PUT', json: { entry: { ...hono, id: 'other' } } }), 400, 'validation_failed')
  assertError(await call(f.app, `${BASE}/hono`, { method: 'PUT', json: { entry: hono, source: 'candidate' } }), 400, 'validation_failed')
})

test('a colliding entry is a glossary_invalid that quotes no term and changes nothing', async (t) => {
  const f = await seeded(t)
  const response = await create(f, { id: 'dup', scope: 'account', entry: { canonical: 'Other', variants: ['хоно'], language: 'en' } })
  assertError(response, 422, 'glossary_invalid')
  for (const term of ['хоно', 'Hono', 'Other']) assert.ok(!response.text.includes(term))
  assert.deepEqual(listGlossaryResponseSchema.parse((await call(f.app, BASE)).json).entries.map((row) => row.id), ['hono'])
  const revisions = f.glossary()!.store.db.prepare('SELECT COUNT(*) AS n FROM glossary_revisions').get() as { n: number }
  assert.equal(revisions.n, 1, 'the failed mutation appended no revision')
  const second = storedGlossaryEntrySchema.parse((await create(f, { id: 'ok', scope: 'account', entry: { canonical: 'Ok', variants: [], language: 'en' } })).json)
  const { id: _id, ...editable } = second.entry
  assertError(await call(f.app, `${BASE}/ok`, { method: 'PUT', json: { entry: { ...editable, variants: ['хона'] } } }), 422, 'glossary_invalid')
  assert.deepEqual(f.glossary()!.store.list('local').find((row) => row.id === 'ok')!.entry.variants, [], 'a refused update keeps the old entry')
})

test('previews replacement without storing anything and names the effective revision', async (t) => {
  const f = await seeded(t)
  const preview = await call(f.app, `${BASE}/apply-preview`, { json: { text: '`хоно` и хоно' } })
  assert.equal(preview.status, 200, preview.text)
  const result = glossaryPreviewResponseSchema.parse(preview.json)
  assert.equal(result.text, '`хоно` и Hono', 'code spans are protected')
  assert.deepEqual(result.replacements, [{ start: 9, end: 13, original: 'хоно', replacement: 'Hono', entryId: 'hono' }])
  assert.equal(result.entryCount, 1)
  assert.equal(result.glossaryRevision, glossaryRevisionHash([{ id: 'hono', revision: 1 }]))
  await call(f.app, `${BASE}/hono`, { method: 'PUT', json: { entry: { ...hono, variants: ['хоно'] } } })
  const next = glossaryPreviewResponseSchema.parse((await call(f.app, `${BASE}/apply-preview`, { json: { text: 'хоно' } })).json)
  assert.equal(next.glossaryRevision, glossaryRevisionHash([{ id: 'hono', revision: 2 }]))
  assert.notEqual(next.glossaryRevision, result.glossaryRevision, 'an edit changes the named revision')
  const rows = f.glossary()!.store.db.prepare('SELECT COUNT(*) AS n FROM glossary_revisions').get() as { n: number }
  assert.equal(rows.n, 2, 'two edits, and the two previews appended nothing')
  const none = glossaryPreviewResponseSchema.parse((await call(f.app, `${BASE}/apply-preview`, { json: { text: '' } })).json)
  assert.deepEqual(none.replacements, [])
})

test('a project entry overrides the account entry for that project only', async (t) => {
  const f = await seeded(t)
  await create(f, { id: 'hono-p1', scope: 'project', projectId: 'p1', entry: { canonical: 'hono', variants: ['хонго'], language: 'en' } })
  const preview = async (projectId: string | null, text: string) =>
    glossaryPreviewResponseSchema.parse((await call(f.app, `${BASE}/apply-preview`, { json: { text, projectId } })).json)
  assert.equal((await preview('p1', 'хонго и хона')).text, 'hono и хона', 'the project spelling wins and hides the account variants')
  assert.equal((await preview(null, 'хонго и хона')).text, 'хонго и Hono')
  assert.equal((await preview('p2', 'хонго и хона')).text, 'хонго и Hono', 'another project is untouched')
})

test('bounds the preview body by characters and bytes', async (t) => {
  const f = await seeded(t)
  assertError(await call(f.app, `${BASE}/apply-preview`, { json: { text: 'a'.repeat(GLOSSARY_PREVIEW_MAX_CHARS + 1) } }), 400, 'validation_failed')
  assert.equal((await call(f.app, `${BASE}/apply-preview`, { json: { text: 'a'.repeat(GLOSSARY_PREVIEW_MAX_CHARS) } })).status, 200)
  assertError(await call(f.app, `${BASE}/apply-preview`, { raw: JSON.stringify({ text: 'a', pad: 'b'.repeat(2 * 1024 * 1024 + 1) }) }), 413, 'body_too_large')
  assertError(await call(f.app, `${BASE}/apply-preview`, { json: { text: 'x', extra: 1 } }), 400, 'validation_failed')
})

test('accounts are isolated: another account cannot see, change or collide with an entry', async (t) => {
  const f = await seeded(t)
  assert.deepEqual(listGlossaryResponseSchema.parse((await call(f.other, BASE)).json).entries, [])
  assertError(await call(f.other, `${BASE}/hono/history`), 404, 'entry_not_found')
  assertError(await call(f.other, `${BASE}/hono/deactivate`, { json: {} }), 404, 'entry_not_found')
  assertError(await call(f.other, `${BASE}/hono`, { method: 'PUT', json: { entry: hono } }), 404, 'entry_not_found')
  const mirror = await call(f.other, BASE, { json: { id: 'hono', scope: 'account', entry: { canonical: 'Hono', variants: ['хоно'], language: 'en' } } })
  assert.equal(mirror.status, 201, 'the same id and the same spoken form are fine in another account')
  const preview = glossaryPreviewResponseSchema.parse((await call(f.other, `${BASE}/apply-preview`, { json: { text: 'хона' } })).json)
  assert.equal(preview.text, 'хона', "the other account's glossary does not hold the first account's variant")
  const mine = listGlossaryResponseSchema.parse((await call(f.app, BASE)).json).entries
  assert.deepEqual(mine[0]!.entry.variants, ['хоно', 'хона'], 'the first account is unchanged')
})

test('guards: non-JSON, cross-origin, non-loopback and malformed bodies', async (t) => {
  const f = await seeded(t)
  assertError(await call(f.app, BASE, { raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  assertError(await call(f.app, `${BASE}/hono`, { method: 'PUT', raw: '{}', headers: { 'content-type': 'text/plain' } }), 415, 'json_required')
  assertError(await call(f.app, BASE, { json: { scope: 'account', entry: hono }, origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, BASE, { origin: 'https://evil.example' }), 403, 'origin_denied')
  assertError(await call(f.app, BASE, { peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, BASE, { json: { scope: 'account', entry: hono }, peer: REMOTE_PEER }), 403, 'loopback_only')
  assertError(await call(f.app, BASE, { raw: '{oops' }), 400, 'validation_failed')
  assert.equal(listGlossaryResponseSchema.parse((await call(f.app, BASE)).json).entries.length, 1, 'refused writes changed nothing')
})

test('answers glossary_unavailable once the service is gone', async (t) => {
  const f = await seeded(t)
  await f.handles.voice.dispose()
  assertError(await call(f.app, BASE), 503, 'glossary_unavailable')
  assertError(await call(f.app, `${BASE}/apply-preview`, { json: { text: 'x' } }), 503, 'glossary_unavailable')
})

test('every library failure maps to a documented wire code', () => {
  const codes = ['already_active', 'already_inactive', 'entry_exists', 'entry_inactive', 'entry_not_found', 'id_mismatch', 'invalid_clock', 'invalid_scope', 'invalid_source', 'project_required', 'store_closed'] as const
  for (const code of codes) {
    const failure = glossaryFailure(new GlossaryStoreError(code, 'quoted term'))
    assert.ok((GLOSSARY_ERROR_CODES as readonly string[]).includes(failure.code), code)
  }
  assert.deepEqual(glossaryFailure(new GlossaryInvalidError()), { code: 'glossary_invalid', status: 422 })
  assert.throws(() => mutating(() => { throw new TypeError('Glossary entry "x" collides on "term"') }), GlossaryInvalidError)
  assert.throws(() => mutating(() => { throw new RangeError('x') }), RangeError)
  assert.deepEqual(glossaryFailure(new TypeError('a bug outside a mutation')), { code: 'internal_error', status: 500 })
  assert.deepEqual(glossaryFailure(new Error('x')), { code: 'internal_error', status: 500 })
})

test('an oversized or oddly named entry written by a kernel caller never breaks the read routes', async (t) => {
  const f = await ms2Fixture(t)
  f.glossary()!.store.create('local', 'account', null, { id: 'imported entry/1', canonical: 'C'.repeat(300), variants: ['v'.repeat(300)], language: 'en' }, 'import')
  const list = await call(f.app, BASE)
  assert.equal(list.status, 200, list.text)
  assert.equal(listGlossaryResponseSchema.parse(list.json).entries[0]!.entry.canonical.length, 300)
  assert.equal((await call(f.app, `${BASE}/apply-preview`, { json: { text: 'x' } })).status, 200)
  assertError(await call(f.app, `${BASE}/imported%20entry%2F1/history`), 400, 'validation_failed')
  assertError(await create(f, { scope: 'account', entry: { canonical: 'C'.repeat(201), variants: [], language: 'en' } }), 400, 'validation_failed')
})
