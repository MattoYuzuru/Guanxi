import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { Hono } from 'hono'
import { ROUTES, layoutListResponse, compareLayouts, layoutClock, layoutDocumentSchema, resolveLayout, type LayoutDocument, type LayoutQuery, type LayoutList } from '@guanxi/contract'
import { openDb, MIGRATIONS } from '../src/store/db.ts'
import { LayoutStore } from '../src/layouts/store.ts'
import { layoutsRoutes } from '../src/layouts/routes.ts'
import { builtInLayout } from '../../web/src/features/workspace/defaults.ts'

const golden = JSON.parse(readFileSync(new URL('./fixtures/layout-resolution.golden.json', import.meta.url), 'utf8'))
const query: LayoutQuery = { account: 'local', project: 'project', mode: 'developer', deviceClass: 'desktop', device: 'device-a' }
function fixture(patch: Partial<LayoutDocument> = {}): LayoutDocument { return layoutDocumentSchema.parse({ ...builtInLayout(query), ...patch }) }
function listed(documents: LayoutDocument[]): LayoutList { return { documents, active: documents.map(d => ({ scope: d.scope, layoutId: d.id })) } }

test('layout resolution golden: device, project-mode, account-mode, built-in; named inactive ignored', () => {
  const base = fixture({ id: 'builtin' })
  const account = fixture({ id: 'account', scope: { account: 'local', mode: 'developer', deviceClass: 'desktop' } })
  const project = fixture({ id: 'project', scope: { ...account.scope, project: 'project' } })
  const device = fixture({ id: 'device' })
  const docs = [device, project, account]
  const actual = [0, 1, 2, 3].map(i => resolveLayout(listed(docs.slice(i)), query, base).id)
  assert.deepEqual(actual, golden.resolution)
  assert.equal(resolveLayout({ documents: [device], active: [] }, query, base).id, 'builtin')
  assert.equal(resolveLayout(listed([fixture({ scope: { ...query, device: 'other' } })]), query, base).id, 'builtin')
  assert.equal(resolveLayout(listed([fixture({ scope: { ...query, deviceClass: 'phone' } })]), query, base).id, 'builtin')
})

test('engine major mismatch falls back without trying lower-precedence data; unknown blocks survive', () => {
  const doc = fixture()
  doc.engineState.major++
  assert.equal(resolveLayout(listed([doc]), query, fixture({ id: 'builtin' })).id, 'builtin')
  const unknown = fixture()
  unknown.blocks['guanxi.core/chat']!.contribution = 'missing.plugin/view'
  assert.equal(layoutDocumentSchema.parse(unknown).blocks['guanxi.core/chat']!.contribution, 'missing.plugin/view')
})

test('validation rejects secrets, executable params, geometry, unknown fields, duplicate and unplaced blocks', () => {
  for (const params of [{ apiKey: 'synthetic-secret' }, { text: 'Bearer synthetic' }, { payload: { __jsExpr: 'run()' } }]) {
    const doc = fixture(); doc.blocks['guanxi.core/chat']!.params = params as never
    assert.equal(layoutDocumentSchema.safeParse(doc).success, false)
  }
  const safe = fixture(); safe.blocks['guanxi.core/chat']!.params = { credential: { ref: 'secret://opaque/reference' }, collapsed: true }
  assert.equal(layoutDocumentSchema.safeParse(safe).success, true)
  for (const mutate of [
    (d: any) => { d.engineState.geometry = { left: 123 } },
    (d: any) => { d.extra = true },
    (d: any) => { d.engineState.groups[0].blocks.push(d.engineState.groups[0].blocks[0]) },
    (d: any) => { d.engineState.groups[0].blocks.pop() },
    (d: any) => { d.hidden.push('missing') },
  ]) { const doc = fixture(); mutate(doc); assert.equal(layoutDocumentSchema.safeParse(doc).success, false) }
})

test('hostile nested grid is rejected before recursive parsing', () => {
  const doc = fixture()
  let tree: any = { group: doc.engineState.groups[0]!.id, size: 1 }
  for (let i = 0; i < 2000; i++) tree = { children: [tree], size: 1 }
  doc.engineState.grid = { root: tree, orientation: 'HORIZONTAL', width: 800, height: 600 }
  assert.equal(layoutDocumentSchema.safeParse(doc).success, false)
})

test('replication LWW clock is rev then timestamp then lexical device', () => {
  const base = fixture({ rev: 2 })
  assert.ok(compareLayouts(fixture({ rev: 3, updatedAt: '2020-01-01T00:00:00.000Z' }), base) > 0)
  assert.ok(compareLayouts(fixture({ rev: 2, updatedAt: '2026-10-22T00:00:00.000Z' }), base) > 0)
  assert.ok(compareLayouts(fixture({ rev: 2, updatedBy: { device: 'device-z' } }), base) > 0)
})

test('concurrent delivery converges and preserves exactly one recovered loser, including replay', () => {
  for (const reverse of [false, true]) {
    const db = openDb(':memory:'); const store = new LayoutStore(db)
    try {
      const a = fixture({ rev: 1, name: 'A' }); a.blocks['guanxi.core/chat']!.priority = 111
      const b = fixture({ rev: 1, name: 'B', updatedBy: { device: 'device-b' } })
      b.blocks['guanxi.core/chat']!.priority = 222
      const [first, second] = reverse ? [b, a] : [a, b]
      store.save(first!, true)
      store.save(second!, true)
      store.save(a, true); store.save(b, true); store.save(a, true)
      const docs = store.list(query).documents
      assert.equal(docs.filter(doc => doc.name === 'Recovered layout').length, 1)
      assert.equal(docs.find(doc => doc.id === a.id)?.name, 'B')
      assert.equal(docs.find(doc => doc.name === 'Recovered layout')?.blocks['guanxi.core/chat']?.priority, a.blocks['guanxi.core/chat']?.priority)
    } finally { db.close() }
  }
})

test('sequential save produces no recovered layout; equal-clock divergence is an atomic conflict', () => {
  const db = openDb(':memory:'); const store = new LayoutStore(db)
  try {
    const initial = fixture({ rev: 1 }); store.save(initial, true)
    const next = fixture({ rev: 2, name: 'Next' }); store.save(next, true, layoutClock(initial))
    assert.equal(store.list(query).documents.filter(d => d.name === 'Recovered layout').length, 0)
    assert.throws(() => store.save({ ...next, name: 'Collision' }, true), /layout_clock_collision/)
    assert.equal(store.list(query).documents.find(d => d.id === next.id)?.name, 'Next')
  } finally { db.close() }
})

test('mode layouts and named copies survive restart; geometry stays on its device and outside documents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-layout-'))
  let db = openDb(join(dir, 'test.db'))
  try {
    let store = new LayoutStore(db)
    const developer = fixture({ name: 'Developer custom' })
    const visualQuery = { ...query, mode: 'visual' as const }
    const visual = builtInLayout(visualQuery)
    store.save(developer, true); store.save(visual, true)
    store.save({ ...developer, id: 'named', name: 'Named' }, false)
    store.saveGeometry(developer.scope, 'device-a', developer.id, { floating: { left: 15, top: 20, width: 640, height: 480 } })
    db.close(); db = openDb(join(dir, 'test.db')); store = new LayoutStore(db)
    assert.equal(resolveLayout(store.list(query), query, fixture()).name, 'Developer custom')
    assert.equal(resolveLayout(store.list(visualQuery), visualQuery, visual).scope.mode, 'visual')
    assert.equal(store.list(query).documents.length, 2)
    assert.deepEqual(store.geometry(developer.scope, 'device-b', developer.id), {})
    assert.deepEqual(store.geometry({ ...developer.scope, project: 'different-project' }, 'device-a', developer.id), {})
    assert.deepEqual(store.geometry({ ...developer.scope, mode: 'visual' }, 'device-a', developer.id), {})
    assert.equal(store.geometry(developer.scope, 'device-a', developer.id).floating?.left, 15)
    assert.ok(!JSON.stringify(store.list(query)).includes('640'))
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('REST validates query, both writes, response, conflict and mode scope', async () => {
  const db = openDb(':memory:'); const app = new Hono().route('/api/layouts', layoutsRoutes(db))
  const put = (path: string, body: unknown) => app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await app.request('/api/layouts')).status, 400)
    assert.equal((await put('/api/layouts', { document: { schema: 'invalid' } })).status, 400)
    assert.equal((await put('/api/layouts', { document: fixture(), activate: true })).status, 200)
    assert.equal((await put('/api/layouts', { document: fixture({ name: 'equal-clock collision' }) })).status, 409)
    const response = await app.request(`/api/layouts?${new URLSearchParams(query)}`)
    assert.equal(response.status, 200)
    const list = await response.json() as LayoutList
    assert.equal(list.documents.length, 1); assert.equal(list.active.length, 1)
    const body = { scope: query, device: 'device-a', layoutId: fixture().id, geometry: { window: { left: 0, top: 0, width: 100, height: 100 } } }
    assert.equal((await put('/api/layouts/geometry', body)).status, 200)
    assert.equal((await put('/api/layouts/geometry', { ...body, geometry: { window: { left: 0, top: 0, width: -1, height: 100 } } })).status, 400)
    const geometry = await app.request(`/api/layouts/geometry?account=local&project=project&mode=developer&deviceClass=desktop&scopeDevice=device-a&device=device-b&layoutId=${body.layoutId}`)
    assert.deepEqual(await geometry.json(), { geometry: {} })
  } finally { db.close() }
})

test('Developer and Visual default block placement matches the committed golden', () => {
  for (const mode of ['developer', 'visual'] as const) {
    const doc = builtInLayout({ ...query, mode })
    const zones = Object.fromEntries(doc.engineState.groups.map(group => [group.zone, group.blocks.map(id => id.split('/')[1])]))
    assert.deepEqual(zones, golden[mode])
  }
})

test('component migration rolls back, retries once and rejects future versions without touching main migrations', () => {
  const db = openDb(':memory:')
  const mainVersion = db.prepare('PRAGMA user_version').get()!.user_version
  const mainMigrations = JSON.stringify(MIGRATIONS)
  const settings = db.prepare('SELECT * FROM settings').all()
  try {
    db.exec('CREATE TABLE layout_active (collision TEXT)')
    assert.throws(() => new LayoutStore(db), /already exists/)
    for (const name of ['layout_migrations', 'layout_documents']) assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name), undefined)
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, mainVersion)
    db.exec('DROP TABLE layout_active')
    const store = new LayoutStore(db)
    store.save(fixture(), true)
    new LayoutStore(db)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM layout_migrations').get()!.n, 1)
    assert.equal(db.prepare('SELECT version FROM layout_migrations').get()!.version, 1)
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, mainVersion)
    assert.equal(JSON.stringify(MIGRATIONS), mainMigrations)
    assert.deepEqual(db.prepare('SELECT * FROM settings').all(), settings)
    db.exec('UPDATE layout_migrations SET version=2')
    assert.throws(() => new LayoutStore(db), /Unsupported layout storage version/)
    assert.equal(db.prepare('SELECT version FROM layout_migrations').get()!.version, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM layout_documents').get()!.n, 1)
  } finally { db.close() }
})

test('the real application mounts the contract routes without model or filesystem services', async () => {
  const db = openDb(':memory:')
  const context = { db } as AppContext
  context.ollama = () => { throw new Error('Network/model access forbidden') }
  const app = createApp(context)
  try {
    const saved = await app.request(ROUTES.layouts(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: fixture() }) })
    assert.equal(saved.status, 200)
    const response = await app.request(`${ROUTES.layouts()}?${new URLSearchParams(query)}`)
    assert.equal(response.status, 200)
    assert.equal(layoutListResponse.parse(await response.json()).documents.length, 1)
    const foreign = await app.request(ROUTES.layouts(), { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.invalid', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ document: fixture() }) })
    assert.equal(foreign.status, 403)
  } finally { db.close() }
})
