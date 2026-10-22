import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import type { Connections } from '../../src/connections/service.ts'
import { runFixture } from '../fixtures/durable-runs.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { RelayStarts } from '../../src/relay/start.ts'
import { relayStartRoutes } from '../../src/relay/routes.ts'
import { RelayRuntimeSource } from '../../src/relay/runtime.ts'
import { plan, caps, reserves } from './fixture.ts'
const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const input = { key: 'start-key', projectId: 'project', connectionId: 'local', model: 'fixture', consent: 'full-access', domains: [], plan, caps }
test('default public start refuses missing meter/workspace before allocating or writing any start/run/attempt', async () => {
  const f = runFixture(), store = new RelayStore(f.db, f.store, f.scrubber)
  let allocations = 0
  const connections = {} as Connections
  const make = (runtime?: RelayRuntimeSource) => new RelayStarts(f.db, f.store, f.log, connections, f.scrubber, store,
    { ...(runtime ? { runtime } : { allocate: async () => { allocations++; throw new Error('unexpected') } }), project: async () => { throw new Error('unexpected') }, reserves, nodePorts: () => [] })
  const starts = make(), app = new Hono().route('/api/relay', relayStartRoutes(() => starts))
  try {
    const response = await app.request('/api/relay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, peer)
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { code: 'runtime_meter_unavailable' })
    const missingWorkspace = make({} as RelayRuntimeSource)
    assert.throws(() => missingWorkspace.start(input), /relay_workspace_unavailable/)
    await missingWorkspace.close()
    assert.equal(allocations, 0)
    for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='relay_start_migrations'").get()!.n, 0)
  } finally { await starts.close(); f.close() }
})
test('public input cannot assert context/meter/placement, and loopback/origin/JSON guards remain explicit', async () => {
  const f = runFixture(), store = new RelayStore(f.db, f.store, f.scrubber)
  const starts = new RelayStarts(f.db, f.store, f.log, {} as Connections, f.scrubber, store,
    { project: async () => { throw new Error('unexpected') }, nodePorts: () => [] })
  const app = new Hono().route('/api/relay', relayStartRoutes(() => starts))
  const options = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    for (const patch of [{ W: 16000 }, { meter: {} }, { placement: 'installed_local' }, { contextTokens: 16000 }, { source: 'trusted' }]) {
      assert.equal((await app.request('/api/relay', options({ ...input, ...patch }), peer)).status, 400)
    }
    assert.equal((await app.request('/api/relay', options(input))).status, 403)
    assert.equal((await app.request('/api/relay', { ...options(input), headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.invalid' } }, peer)).status, 403)
    assert.equal((await app.request('/api/relay', { ...options(input), headers: {} }, peer)).status, 415)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM durable_runs').get()!.n, 0)
  } finally { await starts.close(); f.close() }
})

test('atomic R1 start rejects and rolls back an accidentally asynchronous extension', async () => {
  const f = runFixture()
  try {
    assert.throws(() => f.store.createStarted({ id: 'async-run', sessionId: 'async-session' },
      (() => Promise.reject(new Error('synthetic callback rejection'))) as any), /invalid_input/)
    await new Promise(resolve => setImmediate(resolve))
    for (const table of ['durable_runs', 'run_attempts', 'sessions']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0)
  } finally { f.close() }
})
