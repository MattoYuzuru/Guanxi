import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { start } from '../src/index.ts'
import { RunStore } from '../src/runs/store.ts'
import { bootServerKernel } from '../src/runtime/kernel.ts'
import { runFixture, RUN_TIME } from './fixtures/durable-runs.ts'

// Adapted from the cross-family crash-boot and clockback probes.
test('H1: immediate start after SIGKILL serves requests while R1 reports writer_busy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r1-boot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const child = spawnSync(process.execPath, [new URL('./fixtures/durable-run-boot-worker.ts', import.meta.url).pathname, root], { encoding: 'utf8' })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  assert.match(child.stdout, /started/)
  const app = await start({ dataDir: root, port: 0, webDir: '/nonexistent' })
  try {
    assert.equal((await fetch(`${app.url}/api/settings`)).status, 200)
    assert.deepEqual(app.kernel.durableRuns!.health(), { failure: 'writer_busy' })
    assert.throws(() => app.kernel.durableRuns!.store.create(), { code: 'writer_busy' })
  } finally { await app.close() }
})

test('H1: pump claims the bounded predecessor lease and loses inherited attempts', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = runFixture()
  f.store.start(f.store.create({ id: 'inherited' }).id)
  // Simulate the predecessor clock being a day ahead; it never releases its home.
  f.db.prepare("UPDATE leases SET expires_at=expires_at+86400000,regrant_after=regrant_after+86400000").run()
  f.log.close()
  let now = RUN_TIME
  const kernel = await bootServerKernel(undefined, { db: f.db, runs: { clock: () => now, tickMs: 10 } })
  try {
    kernel.scrubber.ready('vault')
    assert.equal(kernel.durableRuns!.health().failure, 'writer_busy')
    now += 90_999; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, 'writer_busy')
    now += 1; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.equal(kernel.durableRuns!.store.attempts('inherited')[0]!.state, 'lost')
    assert.equal(kernel.durableRuns!.store.get('inherited').state, 'interrupted')
    assert.throws(() => f.store.create(), { code: 'stale_lease' })
  } finally { await kernel.node.dispose(); f.close() }
})

test('H2: pump recovers after ten minutes asleep and fires the deadline due in the gap', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = runFixture(); f.store.close(); f.log.close()
  let now = RUN_TIME
  const kernel = await bootServerKernel(undefined, { db: f.db, runs: { alwaysOn: true, clock: () => now, tickMs: 10 } })
  try {
    kernel.scrubber.ready('vault'); t.mock.timers.tick(10)
    const store = kernel.durableRuns!.store
    const a = store.start(store.create({ id: 'lead' }).id)
    const p = store.delegate(a, { key: 'child', deadline: now + 100_000 })
    store.start(p.child_id)
    const before = f.db.prepare("SELECT holder,token FROM leases WHERE key='durable-runs/home'").get()
    now += 600_000; t.mock.timers.tick(10)
    assert.equal(kernel.durableRuns!.health().failure, null)
    assert.deepEqual(f.db.prepare("SELECT holder,token FROM leases WHERE key='durable-runs/home'").get(), before)
    assert.equal(store.attempts(p.child_id)[0]!.state, 'lost')
    assert.equal(store.promises('lead')[0]!.outcome, 'deadline')
    assert.equal(store.wakes('lead').length, 1)
    assert.equal(store.create().state, 'submitted')
  } finally { await kernel.node.dispose(); f.close() }
})
