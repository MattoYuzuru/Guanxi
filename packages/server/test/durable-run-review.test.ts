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
