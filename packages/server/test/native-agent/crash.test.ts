import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openDb } from '../../src/store/db.ts'
import { SessionLog } from '../../src/session-log/log.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { NativeAgents } from '../../src/native-agent/service.ts'
import { ProjectService } from '../../src/projects/service.ts'
import { ProjectStore } from '../../src/store/projects.ts'
import { WorkspaceStore } from '../../src/store/workspaces.ts'
import { RunStore } from '../../src/runs/store.ts'
const worker = fileURLToPath(new URL('./crash-worker.ts', import.meta.url))

test('crash at every native R1/K2 boundary: one writer, truthful recovery and no inference replay', { timeout: 240000 }, async t => {
  mkdirSync(join(process.cwd(), '.lane-data'), { recursive: true })
  const root = mkdtempSync(join(process.cwd(), '.lane-data/k4-crash-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const probe = join(root, 'probe'); mkdirSync(probe)
  const run = (path: string, index: number) => spawnSync(process.execPath, [worker, path, String(index)], { encoding: 'utf8', timeout: 20000 })
  const baseline = run(probe, -1)
  assert.equal(baseline.status, 0, baseline.stderr)
  const points = JSON.parse(readFileSync(join(probe, 'points.json'), 'utf8')) as string[]
  for (const expected of ['run:create:committed','run:start:committed','run:model_started:committed','run:cost:committed','run:complete:committed','log:event_inserted','model:dispatch']) assert.ok(points.includes(expected), expected)
  assert.ok(points.length > 70)
  for (let index = 0; index < points.length; index++) {
    const path = join(root, String(index)); mkdirSync(path)
    const killed = run(path, index)
    assert.equal(killed.signal, 'SIGKILL', `${index}:${points[index]} ${killed.stderr}`)
    const db = openDb(join(path, 'data/test.sqlite'))
    const scrubber = new SecretScrubber()
    const log = new SessionLog({ db, scrubber })
    let now = Date.now()
    const runs = new RunStore({ db, log, scrubber, clock: () => now })
    try {
      const calls = () => { try { return readFileSync(join(path, 'calls'), 'utf8') } catch { return '' } }
      const before = calls()
      // A contender cannot steal a live persisted home, even though SIGKILL killed its process.
      const home = db.prepare("SELECT released FROM leases WHERE key='durable-runs/home'").get()
      if (home && !home.released) { assert.throws(() => runs.heartbeat(), /writer_busy/); now += 100000 }
      runs.heartbeat(); runs.reconcile(); runs.tick(); runs.dispatch()
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_attempts WHERE state IN ('delivered','started')").get()!.n, 0, `${index}: no active writer after recovery`)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases WHERE key LIKE 'run:%/exec' AND released=0").get()!.n, 0)
      const states = db.prepare('SELECT id,state FROM durable_runs').all() as { id: string; state: string }[]
      for (const row of states) assert.ok(['input_required','completed'].includes(row.state), `${index}: ${row.state}`)
      for (const row of states) {
        const attempts = runs.attempts(row.id)
        if (attempts.length) assert.equal(row.state, attempts[0]!.state === 'completed' ? 'completed' : 'input_required', `${index}: terminal state follows the committed attempt`)
      }
      assert.equal(calls(), before, `${index}: no automatic model call`)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leases WHERE key=? AND released=0').get('durable-runs/home')!.n, 1)
      const other = new RunStore({ db, log, scrubber, clock: () => now })
      try { assert.throws(() => other.heartbeat(), /writer_busy/) } finally { other.close() }
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
      const sessions = db.prepare('SELECT id,thread_id FROM sessions').all()
      let inference = 0
      const policies = sessions.flatMap(row => log.readAll(String(row.id), 'person').filter(e => e.type === 'agent.policy'))
      const connections = {
        snapshot: () => ({ connections: policies.map(e => ({ id: e.data.connectionId, kind: 'model_api', provider: 'deepseek' })) }),
        complete: async () => { inference++; throw new Error('restart must not infer') },
        localChat: async () => { inference++; throw new Error('restart must not infer') },
      } as unknown as ConstructorParameters<typeof NativeAgents>[2]
      const host = { projects: new ProjectService(new ProjectStore(db)), workspaces: new WorkspaceStore(db) } as ConstructorParameters<typeof NativeAgents>[0]
      const native = new NativeAgents(host, log, connections, scrubber, join(path, 'data'), undefined, undefined, { db, runs })
      try {
        await new Promise(r => setImmediate(r))
        for (const row of sessions) {
          assert.equal(row.id, row.thread_id)
          const events = log.readAll(String(row.id), 'person')
          assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1))
          assert.equal(events.filter(e => e.type === 'agent.policy').length, 1)
          const progress = native.progress(String(row.id))
          assert.ok(['completed','input_required','interrupted'].includes(progress.status), `${index}: native projection ${progress.status}`)
          if (states.length && states[0]!.state === 'input_required') assert.equal(progress.status, 'input_required')
        }
        assert.equal(inference, 0, `${index}: actual native startup never calls either model transport`)
        assert.equal(calls(), before)
      } finally { await native.close() }
      if (sessions.length === 0) for (const dir of ['scratch','native-attachments']) {
        let entries: string[] = []; try { entries = readdirSync(join(path, 'data', dir)) } catch { /* absent is empty */ }
        assert.equal(entries.length, 0, `${index}: pre-admission orphan cleanup`)
      }
      db.exec("INSERT INTO session_events_fts(session_events_fts) VALUES('integrity-check')")
    } finally { runs.close(); log.close(); db.close() }
  }
  t.diagnostic(`${points.length} SIGKILL boundaries across a real native tool turn`)
})
