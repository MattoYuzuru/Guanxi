import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { uptime } from 'node:os'
import { test } from 'node:test'
import { admissionPolicyDigest } from '../../src/external-agents/admission.ts'
import { fixture } from './helpers.ts'

const bootMs = () => Math.round((Date.now() - uptime() * 1000) / 1000) * 1000
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

type Facts = { ownerPid: number; boot?: number; phase: 'prepared' | 'spawning' | 'running'; groupId?: number | null; startedAt?: number | null } | null
/** A holder row as a previous process would have left it, plus its boot-reconciliation facts. */
async function seed(f: Awaited<ReturnType<typeof fixture>>, facts: Facts) {
  const install = f.installations[0]!
  const path = join(f.dir, 'external-agents.sqlite')
  const db = new DatabaseSync(path)
  const holder = randomUUID()
  try {
    db.prepare(`INSERT INTO k5_admission (holder_id,instance_id,owner,adapter,billing_account,kind,policy_digest,created_at,state)
      VALUES (?,?,?,?,?,'run',?,?,'held')`).run(holder, 'previous-instance', install.ownerAccountId, install.adapter, install.billingAccount, admissionPolicyDigest(install), new Date().toISOString())
    if (facts) db.prepare('INSERT INTO k5_admission_process VALUES (?,?,?,?,?,?)')
      .run(holder, facts.ownerPid, facts.boot ?? bootMs(), facts.phase, facts.groupId ?? null, facts.startedAt ?? null)
  } finally { db.close() }
  const rows = () => {
    const reader = new DatabaseSync(path)
    try { return reader.prepare('SELECT holder_id,state,cleanup_reason FROM k5_admission').all() as unknown as { holder_id: string; state: string; cleanup_reason: string | null }[] } finally { reader.close() }
  }
  return { holder, rows }
}
/** A dead pid: a child that has exited and been reaped. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  await new Promise(resolve => child.once('close', resolve))
  return child.pid!
}
/** A detached process group leader, as K5 spawns agents. */
function orphan() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
  child.unref()
  return child.pid!
}

test('a holder whose owner is dead and that never reached a spawn is released at the next boot', async t => {
  const f = await fixture(t)
  const holder = await seed(f, { ownerPid: await deadPid(), phase: 'prepared' })
  await f.reload()
  await f.service().admissionReady()
  assert.deepEqual(holder.rows(), [])
})

test('a dead owner\'s running group is killed only when its start time proves it is ours, then the holder is released', async t => {
  const f = await fixture(t)
  const pid = orphan()
  t.after(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } })
  const holder = await seed(f, { ownerPid: await deadPid(), phase: 'running', groupId: pid, startedAt: Date.now() })
  await f.reload()
  await f.service().admissionReady()
  assert.deepEqual(holder.rows(), [])
  assert.equal(alive(pid), false, 'the orphan group was killed')
})

test('an alive process whose start time does not match is never signalled and the holder stays occupied as cleanup_unconfirmed', async t => {
  const f = await fixture(t)
  const pid = orphan()
  t.after(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } })
  const holder = await seed(f, { ownerPid: await deadPid(), phase: 'running', groupId: pid, startedAt: Date.now() - 3_600_000 })
  await f.reload()
  await f.service().admissionReady()
  assert.equal(alive(pid), true, 'a pid that may have been reused is left alone')
  assert.deepEqual(holder.rows().map(r => [r.state, r.cleanup_reason]), [['cleanup_unconfirmed', 'group_timeout']])
})

test('everything that cannot be proven stays: a live owner, a spawn nobody recorded, and a holder without boot facts', async t => {
  const f = await fixture(t)
  const live = await seed(f, { ownerPid: process.ppid, phase: 'prepared' })
  const spawning = await seed(f, { ownerPid: await deadPid(), phase: 'spawning' })
  const legacy = await seed(f, null)
  await f.reload()
  await f.service().admissionReady()
  const rows = new Map(live.rows().map(r => [r.holder_id, r]))
  assert.equal(rows.get(live.holder)!.state, 'held', 'the owner may be another live node on this sidecar')
  assert.equal(rows.get(spawning.holder)!.state, 'cleanup_unconfirmed')
  assert.equal(rows.get(legacy.holder)!.state, 'held', 'no evidence, no release')
})

test('after a machine reboot every old process is gone: the holder is released without signalling anything', async t => {
  const f = await fixture(t)
  const pid = orphan()
  t.after(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } })
  const holder = await seed(f, { ownerPid: await deadPid(), boot: bootMs() - 3_600_000, phase: 'running', groupId: pid, startedAt: Date.now() })
  await f.reload()
  await f.service().admissionReady()
  assert.deepEqual(holder.rows(), [])
  assert.equal(alive(pid), true, 'a pid from before the reboot is not ours to signal')
})

test('reconciled occupancy is visible through the service limits', async t => {
  const f = await fixture(t)
  await seed(f, { ownerPid: await deadPid(), phase: 'prepared' })
  await f.reload()
  await f.service().admissionReady()
  assert.deepEqual(f.service().limits(f.installations[0]!.ownerAccountId, f.installations[0]!.connectionId).durableLocalOccupancy, { held: 0, cleanupUnconfirmed: 0, total: 0 })
})
