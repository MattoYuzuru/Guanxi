import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutClock, layoutContextResponse, type LayoutDocument, type LayoutQuery } from '@guanxi/contract'
import { FederationChannel } from '../src/federation/channel.ts'
import { layoutsRoutes } from '../src/layouts/routes.ts'
import { layoutOperationKey } from '../src/layouts/operation.ts'
import { identity, SimNode } from './federation/harness.ts'
import { builtInLayout } from '../../web/src/features/workspace/defaults.ts'

const query: LayoutQuery = { account: 'owner', mode: 'developer', deviceClass: 'desktop', device: 'browser-a' }
function document(device: string, patch: Partial<LayoutDocument> = {}): LayoutDocument {
  return { ...builtInLayout(query), id: 'shared', scope: { account: 'owner', mode: 'developer', deviceClass: 'desktop' },
    rev: 1, updatedBy: { device }, ...patch }
}
function mount(node: SimNode) { node.app.route('/api/layouts', layoutsRoutes(node.db, [], () => node.federation.layouts)); return node }
function pull(reader: SimNode, source: SimNode) {
  return new FederationChannel({ local: reader.keys.identity, privateKey: reader.keys.privateKey, peer: source.keys.identity,
    transport: async request => source.app.request(request), clock: () => reader.time }).synchronize(reader.federation)
}
function pair() {
  const a = mount(new SimNode(identity('a'))), b = mount(new SimNode(identity('b')))
  a.trust(b); b.trust(a)
  return { a, b, close() { a.close(); b.close() } }
}

test('signed channel replicates concurrent whole layouts, converges by document clock and recovers the exact loser once', async () => {
  const nodes = pair(); const { a, b } = nodes
  try {
    // A later transport clock must not override U1's rev/time/device ordering.
    a.time += 100
    const left = document('device-a', { name: 'Left' }); left.blocks['guanxi.core/chat']!.priority = 111
    const right = document('device-b', { name: 'Right' }); right.blocks['guanxi.core/chat']!.priority = 222
    a.federation.layouts.save(left, true)
    b.federation.layouts.save(right, true)
    a.federation.layouts.saveGeometry(left.scope, 'browser-a', left.id, { detached: { left: 37.25, top: 42.25, width: 637.5, height: 412.5 } })
    assert.equal((await pull(a, b)).accepted, 1)
    assert.equal((await pull(b, a)).accepted, 1)
    await pull(a, b); await pull(b, a)
    for (const node of [a, b]) {
      const list = node.federation.layouts.list(query)
      assert.equal(list.documents.length, 2)
      assert.equal(list.documents.find(doc => doc.id === 'shared')?.name, 'Right')
      const recovered = list.documents.filter(doc => doc.name === 'Recovered layout')
      assert.equal(recovered.length, 1)
      assert.equal(recovered[0]!.blocks['guanxi.core/chat']!.priority, 111)
      assert.equal(list.active.length, 1)
      const state = Object.values(node.federation.config.state())
      assert.equal(state.find(value => value.kind === 'layout')?.document.name, 'Right')
    }
    assert.equal(a.federation.config.stateHash(), b.federation.config.stateHash())
    assert.deepEqual(a.federation.layouts.list(query), b.federation.layouts.list(query))
    assert.deepEqual(b.federation.layouts.geometry(right.scope, 'browser-a', right.id), {})
    assert.equal(a.federation.layouts.geometry(left.scope, 'browser-a', left.id).detached!.width, 637.5)
    assert.equal(JSON.stringify(a.federation.config.operations()).includes('637.5'), false)

    const next = { ...right, rev: 2, name: 'Sequential' }
    b.federation.layouts.save(next, true, layoutClock(right))
    await pull(a, b); await pull(a, b)
    assert.equal(a.federation.layouts.list(query).documents.filter(doc => doc.name === 'Recovered layout').length, 1)
    assert.equal(a.federation.layouts.list(query).documents.find(doc => doc.id === 'shared')?.name, 'Sequential')
  } finally { nodes.close() }
})

test('named activation and independent mode layouts converge across opposite delivery orders', async () => {
  const nodes = pair(); const { a, b } = nodes
  try {
    a.federation.layouts.save(document('a', { id: 'first' }), true)
    b.time++
    b.federation.layouts.save(document('b', { id: 'second' }), true)
    a.federation.layouts.save(document('a', { id: 'inactive' }), false)
    const visual = document('a', { id: 'visual', scope: { account: 'owner', mode: 'visual', deviceClass: 'desktop' } })
    a.federation.layouts.save(visual, true)
    await pull(a, b); await pull(b, a); await pull(a, b)
    for (const node of [a, b]) {
      assert.equal(node.federation.layouts.list(query).active[0]?.layoutId, 'second')
      assert.equal(node.federation.layouts.list(query).documents.length, 3)
      assert.equal(node.federation.layouts.list({ ...query, mode: 'visual' }).active[0]?.layoutId, 'visual')
    }
    assert.deepEqual(a.federation.layouts.list(query), b.federation.layouts.list(query))
  } finally { nodes.close() }
})

test('replicated document revisions precede timestamp, which precedes the writer device', async () => {
  for (const [leftPatch, rightPatch] of [
    [{ rev: 2, updatedAt: '2020-01-01T00:00:00.000Z' }, { rev: 1, updatedAt: '2026-10-21T00:00:00.000Z' }],
    [{ updatedAt: '2026-10-22T00:00:00.000Z' }, { updatedAt: '2026-10-21T00:00:00.000Z' }],
  ]) {
    const nodes = pair(); const { a, b } = nodes
    try {
      b.time++
      a.federation.layouts.save(document('device-a', { ...leftPatch, name: 'Document-clock winner' }), true)
      b.federation.layouts.save(document('device-z', { ...rightPatch, name: 'Later transport clock' }), true)
      await pull(a, b); await pull(b, a)
      for (const node of [a, b]) assert.equal(node.federation.layouts.list(query).documents.find(doc => doc.id === 'shared')?.name, 'Document-clock winner')
      assert.equal(a.federation.config.stateHash(), b.federation.config.stateHash())
    } finally { nodes.close() }
  }
})

test('REST discovers the configured account, uses signed writes and rejects foreign accounts', async () => {
  const nodes = pair(); const { a, b } = nodes
  try {
    assert.deepEqual(await (await a.app.request('/api/layouts/context')).json(), { account: 'owner', replication: true })
    const put = (path: string, body: unknown) => a.app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await put('/api/layouts', { document: document('a'), activate: true })).status, 200)
    assert.equal(a.federation.config.operations().length, 1)
    await pull(b, a)
    assert.equal(b.federation.layouts.list(query).documents.length, 1)
    const foreign = document('a', { scope: { ...document('a').scope, account: 'other' } })
    assert.equal((await put('/api/layouts', { document: foreign, activate: true })).status, 403)
    assert.equal((await a.app.request('/api/layouts?' + new URLSearchParams({ ...query, account: 'other' }))).status, 403)
    assert.equal((await put('/api/layouts/geometry', { scope: foreign.scope, device: 'browser-a', layoutId: foreign.id, geometry: {} })).status, 403)
    assert.equal(a.federation.config.operations().length, 1)
  } finally { nodes.close() }
})

test('layout context and persistence support the full F1 account identifier budget', async () => {
  const account = 'a'.repeat(200)
  const node = mount(new SimNode(identity('long-account-node', { accountId: account })))
  try {
    const response = await node.app.request('/api/layouts/context')
    assert.deepEqual(layoutContextResponse.parse(await response.json()), { account, replication: true })
    const layout = document('long-account-node', { scope: { ...document('a').scope, account } })
    node.federation.layouts.save(layout, true)
    assert.equal(node.federation.layouts.list({ ...query, account }).documents.length, 1)
  } finally { node.close() }
})

test('projection conflict rolls back signed operation, HLC clock and layout rows atomically', () => {
  const nodes = pair(); const { a } = nodes
  try {
    const original = document('a')
    a.federation.layouts.save(original, true)
    const clock = a.db.prepare('SELECT * FROM federation_clock').all()
    assert.throws(() => a.federation.layouts.save({ ...original, name: 'Divergent same clock' }, true), /layout_clock_collision/)
    assert.equal(a.federation.config.operations().length, 1)
    assert.deepEqual(a.db.prepare('SELECT * FROM federation_clock').all(), clock)
    assert.deepEqual(a.federation.layouts.list(query).documents, [original])
    assert.throws(() => a.federation.config.create('wrong-key', { kind: 'layout', document: original, activate: true }), /invalid_layout_key/)
    const foreign = { ...original, scope: { ...original.scope, account: 'other' } }
    assert.throws(() => a.federation.layouts.save(foreign, true), /owner_mismatch/)
    assert.throws(() => a.federation.config.create(layoutOperationKey(foreign), { kind: 'layout', document: foreign, activate: true }), /owner_mismatch/)
    assert.throws(() => a.federation.config.create(layoutOperationKey(original), {
      kind: 'layout', document: { ...original, geometry: { width: 600 } } as LayoutDocument, activate: true,
    }))
    assert.equal(a.federation.config.operations().length, 1)
  } finally { nodes.close() }
})

test('tampered signed layout is refused without changing the remote projection', async () => {
  const nodes = pair(); const { a, b } = nodes
  try {
    a.federation.layouts.save(document('a'), true)
    const channel = new FederationChannel({ local: b.keys.identity, privateKey: b.keys.privateKey, peer: a.keys.identity,
      clock: () => b.time, transport: async request => {
        if (new URL(request.url).pathname.endsWith('/config')) {
          const operations = a.federation.config.operations()
          const value = operations[0]!.operation.value
          if (value.kind === 'layout') value.document.name = 'Unsigned replacement'
          return Response.json({ operations })
        }
        return a.app.request(request)
      } })
    const result = await channel.synchronize(b.federation)
    assert.equal(result.accepted, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.reasons.unauthenticated, 1)
    assert.equal(b.federation.config.operations().length, 0)
    assert.equal(b.federation.layouts.list(query).documents.length, 0)
  } finally { nodes.close() }
})

test('older minor peers get an explicit upgrade response instead of an incomplete causal history', async () => {
  const nodes = pair(); const { a, b } = nodes
  try {
    a.federation.config.create('setting', { kind: 'setting', value: true })
    assert.equal((await b.request(a, 'GET', '/config')).status, 200)
    a.federation.layouts.save(document('a'), true)
    a.federation.config.create('dependent-setting', { kind: 'setting', value: 'after-layout' })
    const incompatible = await b.request(a, 'GET', '/config')
    assert.equal(incompatible.status, 426)
    assert.deepEqual(await incompatible.json(), { code: 'contract_feature_unavailable' })
    assert.equal((await pull(b, a)).accepted, 3)
    assert.equal(b.federation.config.operations().length, 3)
  } finally { nodes.close() }
})

test('replicated documents and activation survive restart without changing device geometry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guanxi-layout-federation-'))
  const keys = identity('persistent')
  let local = mount(new SimNode(keys, join(directory, 'node.db')))
  const remote = mount(new SimNode(identity('remote')))
  try {
    local.trust(remote); remote.trust(local)
    const layout = document('remote')
    remote.federation.layouts.save(layout, true)
    local.federation.layouts.saveGeometry(layout.scope, 'browser-a', layout.id, { popup: { left: 1, top: 2, width: 333, height: 444 } })
    await pull(local, remote)
    local.close(); local = mount(new SimNode(keys, join(directory, 'node.db')))
    assert.equal(local.federation.layouts.list(query).documents.length, 1)
    assert.equal(local.federation.layouts.list(query).active[0]!.layoutId, layout.id)
    assert.equal(local.federation.layouts.geometry(layout.scope, 'browser-a', layout.id).popup!.width, 333)
    assert.equal(local.federation.config.operations().length, 1)
  } finally { local.close(); remote.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('held layout facades fail closed after federation shutdown', () => {
  const node = mount(new SimNode(identity('closing')))
  try {
    const layouts = node.federation.layouts
    node.federation.close()
    assert.throws(() => layouts.list(query), /closed/)
    assert.throws(() => layouts.save(document('closing'), true), /closed/)
    assert.throws(() => layouts.geometry(document('closing').scope, 'browser-a', 'shared'), /closed/)
    assert.throws(() => layouts.saveGeometry(document('closing').scope, 'browser-a', 'shared', {}), /closed/)
  } finally { node.close() }
})
