import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runStateSnapshot } from './fixtures/durable-run-state.ts'
import { runFixture, reconcileAllForTest, RUN_TIME, RUN_DEADLINE } from './fixtures/durable-runs.ts'

const worker = fileURLToPath(new URL('./fixtures/durable-run-crash-worker.ts', import.meta.url))
for (const stage of ['hibernate', 'resolve', 'wake', 'ack', 'deadline', 'signal', 'input', 'yield', 'resleep', 'cancel', 'child-start', 'child-model', 'report', 'recovery']) {
  test(`crash property: every ${stage} store/K2 boundary preserves resolution, wake or cancellation counts`, (t) => {
    const root = mkdtempSync(join(tmpdir(), `guanxi-r1-${stage}-`))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    let seedIndex = -1
    if (stage === 'recovery') {
      const seedProbe = spawnSync(process.execPath, [worker, join(root, 'seed-probe.db'), 'wake', '-1'], { encoding: 'utf8' })
      assert.equal(seedProbe.status, 0, seedProbe.stderr)
      seedIndex = (JSON.parse(seedProbe.stdout) as { points: string[] }).points.indexOf('wake:committed')
      assert.ok(seedIndex >= 0)
    }
    const seedRecovery = (path: string) => {
      const killed = spawnSync(process.execPath, [worker, path, 'wake', String(seedIndex)], { encoding: 'utf8' })
      assert.equal(killed.signal, 'SIGKILL')
    }
    if (stage === 'recovery') seedRecovery(join(root, 'probe.db'))
    const probe = spawnSync(process.execPath, [worker, join(root, 'probe.db'), stage, '-1'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, probe.stderr)
    const { points, windows } = JSON.parse(probe.stdout) as { points: string[]; windows: { from: number; to: number; before: unknown; after: unknown }[] }
    assert.ok(points.length > 5)
    const operations: Record<string, string> = { resolve: 'complete', ack: 'model_started', deadline: 'timers', signal: 'signal', input: 'input_required', yield: 'hibernate', resleep: 'hibernate', 'child-start': 'start', 'child-model': 'model_started', report: 'complete', recovery: 'reconcile' }
    const operation = operations[stage] ?? stage
    assert.ok(points.includes(`${operation}:committed`))
    assert.ok(points.includes('log:event_inserted'), 'fault injection reaches K2 inside the run transaction')
    for (let index = 0; index < points.length; index++) {
      const path = join(root, `crash-${index}.db`)
      if (stage === 'recovery') seedRecovery(path)
      const killed = spawnSync(process.execPath, [worker, path, stage, String(index)], { encoding: 'utf8' })
      assert.equal(killed.signal, 'SIGKILL', `${index} ${points[index]}: ${killed.stderr}`)
      // The crashed owner is never presumed dead from a PID. Advance past its persisted
      // owner TTL + maximum attempt TTL + epsilon before claiming the execution home.
      let now = RUN_TIME
      const f = runFixture(path, { deferClaim: true, clock: () => now })
      try {
        assert.throws(() => f.store.heartbeat(), { code: 'writer_busy' })
        now += stage === 'recovery' ? 200_000 : 100_000
        f.store.heartbeat()
        const window = windows.find((w) => w.from <= index && index <= w.to)!
        assert.ok(window, `transaction window for ${index} ${points[index]}`)
        assert.deepEqual(runStateSnapshot(f.db), index === window.to ? window.after : window.before,
          `legal committed pre/post state at ${stage}:${index}:${points[index]}`)
        reconcileAllForTest(f.store)
        let promise = f.store.promises('lead')[0]
        if (!promise) {
          const retry = f.store.start('lead')
          promise = f.store.delegate(retry, { key: 'child', deadline: RUN_DEADLINE })
        }
        if (stage === 'cancel') {
          f.store.cancel('lead'); f.store.cancel('lead'); f.store.tick()
          const runs = f.db.prepare('SELECT id,state,cancel_count FROM durable_runs').all() as { id: string; state: string; cancel_count: number }[]
          assert.equal(runs.length, 3)
          const events = f.log.read('lead', { audience: 'person', limit: 1_000 }).events
          for (const run of runs) {
            assert.equal(run.state, 'canceled'); assert.equal(run.cancel_count, 1)
            assert.equal(events.filter((e) => e.type === 'run.lifecycle' && e.data.runId === run.id && e.data.action === 'canceled').length, 1)
          }
          assert.equal(f.store.wakes('lead').length, 0)
          assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE state='pending'").get() as { n: number }).n, 0)
        } else {
          if (promise.outcome === null) {
            let child = f.store.get(promise.child_id).state === 'input_required' ? f.store.decide(promise.child_id) : f.store.start(promise.child_id)
            if (stage === 'signal' && f.store.wakes('lead').length === 0) f.store.signal(child, 'crash-signal')
            if (stage === 'input' && f.store.wakes('lead').length === 0) {
              f.store.inputRequired(child)
              child = f.store.decide(promise.child_id)
            }
            f.store.complete(child, 'completed')
          }
          if (stage === 'report' && f.store.get(promise.child_id).state !== 'canceled') {
            f.store.complete(f.store.start(promise.child_id), 'completed')
          }
          if (stage === 'report') assert.equal(f.store.get(promise.child_id).cancel_count, 1)
          for (const wake of f.store.wakes('lead')) {
            const delivery = f.store.deliver('lead', wake.wake_seq)
            if (delivery) {
              f.store.modelStarted(delivery); f.store.modelStarted(delivery)
              if (f.store.wakes('lead').some((w) => w.wake_seq > wake.wake_seq && w.acknowledged_at === null)) f.store.hibernate(delivery)
            }
          }
          f.store.tick(); reconcileAllForTest(f.store)
          const wakes = ['signal', 'input', 'yield', 'resleep'].includes(stage) ? 2 : 1
          assert.equal(f.store.promises('lead').length, 1, `one delegation: ${index}`)
          assert.equal(f.store.promises('lead')[0]!.outcome, ['deadline', 'report'].includes(stage) ? 'deadline' : 'completed')
          assert.equal(f.store.wakes('lead').length, wakes, `exact wake count: ${index}`)
          assert.equal(f.store.wakes('lead').filter((w) => w.acknowledged_at !== null).length, wakes)
          assert.equal(f.store.deliver('lead', 1), null, 'acknowledged wake is never delivered again')
          const events = f.log.read('lead', { audience: 'person', limit: 1_000 }).events
          assert.equal(events.filter((e) => e.type === 'run.lifecycle' && e.data.action === 'resolved').length, 1)
          assert.equal(events.filter((e) => e.type === 'run.lifecycle' && e.data.action === 'acknowledged').length, wakes)
        }
        const events = f.log.read('lead', { audience: 'person', limit: 1_000 }).events
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
