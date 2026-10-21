import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fixture, plan, caps, reserves, window } from './fixture.ts'
import { runFixture } from '../fixtures/durable-runs.ts'
import { RelayStore } from '../../src/relay/store.ts'
import { canonical, hash, strip, byteHash, probes } from '../../src/relay/handoff.ts'
import type { Handoff } from '../../src/relay/types.ts'

export function candidate(f: ReturnType<typeof fixture>): Handoff {
  const l = f.relay.read(f.run.id); l.state = 'sealed'
  return { format: 'guanxi.handoff/v1', runId: f.run.id, cycle: l.cycle, attemptId: f.attempt.id, epoch: f.attempt.epoch, token: f.attempt.token,
    ledgerHash: hash(l), ledger: { ref: `run:${f.run.id}/cycles/${l.cycle}/ledger`, strip: strip(l), head: l.head, revision: l.plan.revision }, notes: [], narrative: '', degraded: false, bundleHash: byteHash(Buffer.from('fixture-git-bundle')) }
}
function prepared() {
  const f = fixture()
  f.relay.begin(f.attempt); f.relay.transition(f.attempt, 'work'); f.relay.transition(f.attempt, 'handoff_write'); f.relay.transition(f.attempt, 'handoff_validate')
  return f
}
test('stale attempt cannot upload a seal or become last sealed', () => {
  const f = prepared(); try {
    const h = candidate(f)
    f.setTime(1800000060001); f.store.tick()
    const replacement = f.store.start(f.run.id)
    assert.ok(replacement.token > f.attempt.token)
    assert.throws(() => f.relay.seal(f.attempt, h, Buffer.from('fixture-git-bundle'), 2400), /stale_lease/)
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n, 0)
    assert.equal(f.relay.sealed(replacement), null)
  } finally { f.close() }
})
test('hash mismatch, corrupt bundle, wrong revision/path references and size are rejected atomically', () => {
  const f = prepared(); try {
    const good = candidate(f)
    for (const bad of [{ ...good, ledgerHash: '0'.repeat(64) }, { ...good, bundleHash: '0'.repeat(64) },
      { ...good, ledger: { ...good.ledger, head: 'b'.repeat(40) } }, { ...good, narrative: 'x'.repeat(10000) }]) {
      assert.throws(() => f.relay.seal(f.attempt, bad, Buffer.from('fixture-git-bundle'), 2400))
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM relay_seals').get()!.n, 0)
      assert.equal(f.relay.read(f.run.id).state, 'handoff_validate')
    }
    f.relay.seal(f.attempt, good, Buffer.from('fixture-git-bundle'), 2400)
    assert.equal(f.relay.sealed(f.attempt)!.handoff.ledgerHash, hash(f.relay.sealed(f.attempt)!.ledger))
  } finally { f.close() }
})
test('corrupted handoff is caught by orient probes and rebuilt degraded before work', async () => {
  let work = 0, mutated = false
  const f = fixture({ actions: () => canonical(++work === 1 ? { action: 'handoff' } : work === 2 ? { action: 'verify', item: 'one' } : { action: 'handoff' }) })
  try {
    const call = f.model.call
    f.model.call = async (p,o) => {
      if (p.startsWith('Answer these five') && !mutated) {
        // Corrupt the uploaded artifact through a storage fault before a fresh orient read.
        mutated = true
      }
      return call(p,o)
    }
    const read = f.relay.sealed.bind(f.relay)
    f.relay.sealed = a => { const s = read(a); if (s && !mutated) { s.handoff.narrative = 'corrupted'; mutated = true }; return s }
    await f.executor.run(f.attempt)
    assert.equal(f.store.get(f.run.id).state, 'completed')
    const events = f.log.readAll(f.run.session_id, 'person')
    assert.ok(events.some(e => e.type === 'agent.note' && e.data.text.includes('"damaged":true')))
    assert.equal(f.prompts.filter(p => p.startsWith('Answer these five')).length, 1)
    assert.equal(f.relay.read(f.run.id).items.one, 'done')
  } finally { f.close() }
})
test('SIGKILL across seal upload, pointer, K2 append and commit preserves exact pre/post boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r2-crash-'))
  try {
    for (const point of ['seal_uploaded', 'seal_pointer', 'seal_trace', 'seal_committed', 'run:before_begin', 'run:begin', 'run:trace', 'run:before_commit', 'run:committed', 'k2:writer_checked', 'k2:event_inserted']) {
      const path = join(root, point + '.db')
      const result = spawnSync(process.execPath, ['packages/server/test/relay/seal-child.ts', path, point], { cwd: process.cwd(), encoding: 'utf8' })
      assert.equal(result.signal, 'SIGKILL', `${point}: ${result.stderr}`)
      const f = runFixture(path, { deferClaim: true })
      try {
        const rows = f.db.prepare('SELECT ledger,handoff FROM relay_seals').all()
        const committed = ['seal_committed','run:committed'].includes(point)
        assert.equal(rows.length, Number(committed), point)
        const l = JSON.parse(String(f.db.prepare('SELECT snapshot FROM relay_runs').get()!.snapshot))
        assert.equal(l.state, committed ? 'sealed' : 'handoff_validate', point)
        const events = f.db.prepare("SELECT payload FROM session_events WHERE type='agent.note'").all().filter(r => String(r.payload).includes('\\"relay\\":\\"sealed\\"'))
        assert.equal(events.length, Number(committed), point)
        if (committed) assert.equal(JSON.parse(String(rows[0]!.handoff)).ledgerHash, hash(JSON.parse(String(rows[0]!.ledger))))
        assert.equal(f.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
        assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0)
      } finally { f.close() }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('explicit restart recovery preserves observed ledger progress and notes without resuming inference', () => {
  const root=mkdtempSync(join(tmpdir(),'guanxi-r2-restart-')), path=join(root,'node.sqlite')
  try {
    const f=fixture({path}), id=f.run.id
    f.relay.begin(f.attempt);f.relay.transition(f.attempt,'work')
    f.relay.observe(f.attempt,{head:plan.base,files:[],diffstat:'',evidence:{item:'one',ok:true,output:'retained'}})
    f.relay.note(f.attempt,'decision','retained note',['one'],null)
    f.close()
    const g=runFixture(path)
    try {
      g.store.reconcile();const next=g.store.start(id), relay=new RelayStore(g.db,g.store,g.scrubber)
      relay.recover(next)
      assert.equal(relay.read(id).items.one,'done')
      assert.equal(relay.read(id).evidence[0]!.output,'retained')
      assert.equal(relay.notes(id)[0]!.text,'retained note')
      assert.equal(g.store.attempts(id).at(-1)!.first_model_at,null)
      assert.equal(relay.sealed(next),null)
    } finally {g.close()}
  } finally {rmSync(root,{recursive:true,force:true})}
})
