import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runFixture, RUN_TIME, RUN_DEADLINE } from './fixtures/durable-runs.ts'

const worker = fileURLToPath(new URL('./fixtures/durable-run-crash-worker.ts', import.meta.url))
for (const stage of ['hibernate', 'resolve', 'wake', 'ack']) {
  test(`crash property: every ${stage} store/K2 statement and commit boundary resolves and acknowledges exactly once`, (t) => {
    const root = mkdtempSync(join(tmpdir(), `guanxi-r1-${stage}-`))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const probe = spawnSync(process.execPath, [worker, join(root, 'probe.db'), stage, '-1'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const points = JSON.parse(probe.stdout) as string[]
    assert.ok(points.length > 5)
    assert.ok(points.includes(`${stage === 'resolve' ? 'complete' : stage === 'ack' ? 'model_started' : stage}:committed`))
    assert.ok(points.includes('log:event_inserted'), 'fault injection reaches K2 inside the run transaction')
    for (let index = 0; index < points.length; index++) {
      const path = join(root, `crash-${index}.db`)
      const killed = spawnSync(process.execPath, [worker, path, stage, String(index)], { encoding: 'utf8' })
      assert.equal(killed.signal, 'SIGKILL', `${index} ${points[index]}: ${killed.stderr}`)
      // The crashed owner is never presumed dead from a PID. Advance past its persisted
      // owner TTL + maximum attempt TTL + epsilon before claiming the execution home.
      const f = runFixture(path, { clock: () => RUN_TIME + 100_000 })
      try {
        f.store.reconcile()
        let promise = f.store.promises('lead')[0]
        if (!promise) {
          const retry = f.store.start('lead')
          promise = f.store.delegate(retry, { key: 'child', deadline: RUN_DEADLINE })
        }
        if (promise.outcome === null) {
          const child = f.store.start(promise.child_id)
          f.store.complete(child, 'completed')
        }
        const delivery = f.store.deliver('lead', 1)
        if (delivery) { f.store.modelStarted(delivery); f.store.modelStarted(delivery) }
        f.store.tick(); f.store.reconcile()
        assert.equal(f.store.promises('lead').length, 1, `one delegation: ${index}`)
        assert.equal(f.store.promises('lead')[0]!.outcome, 'completed')
        assert.equal(f.store.wakes('lead').length, 1, `one wake: ${index}`)
        assert.equal(f.store.wakes('lead').filter((w) => w.acknowledged_at !== null).length, 1)
        assert.equal(f.store.deliver('lead', 1), null, 'acknowledged wake is never delivered again')
        const events = f.log.read('lead', { audience: 'person', limit: 1_000 }).events
        assert.equal(events.filter((e) => e.type === 'run.lifecycle' && e.data.action === 'resolved').length, 1)
        assert.equal(events.filter((e) => e.type === 'run.lifecycle' && e.data.action === 'acknowledged').length, 1)
        assert.deepEqual(events.map((e) => e.seq), Array.from({ length: events.length }, (_, i) => i + 1))
        assert.equal((f.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
        assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0)
        f.db.prepare("INSERT INTO session_events_fts(session_events_fts) VALUES ('integrity-check')").run()
        assert.ok((f.db.prepare("SELECT COUNT(*) AS n FROM leases WHERE key LIKE 'run:%/exec' AND released=0").get() as { n: number }).n <= 1)
      } finally { f.close() }
    }
    t.diagnostic(`exhausted ${points.length} ${stage} crash boundaries (SIGKILL), including the committed boundary`)
  })
}
