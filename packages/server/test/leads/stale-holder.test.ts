import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { admissionPolicyDigest } from '../../src/external-agents/admission.ts'
import { typedWakeFailure } from '../../src/leads/failure.ts'
import { leadFixture } from './helpers.ts'

type Fixture = Awaited<ReturnType<typeof leadFixture>>
const bootMs = () => Math.round((Date.now() - uptime() * 1000) / 1000) * 1000
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  await new Promise(resolve => child.once('close', resolve))
  return child.pid!
}
/** The holder a SIGKILLed node leaves behind in K5's sidecar. */
async function leaveStaleHolder(f: Fixture, phase: 'prepared' | 'spawning') {
  const install = f.installations[0]!
  const db = new DatabaseSync(join(f.dir, 'external-agents.sqlite'))
  try {
    const id = randomUUID()
    db.prepare(`INSERT INTO k5_admission (holder_id,instance_id,owner,adapter,billing_account,kind,policy_digest,created_at,state)
      VALUES (?,?,?,?,?,'run',?,?,'held')`).run(id, 'killed-node', install.ownerAccountId, install.adapter, install.billingAccount, admissionPolicyDigest(install), new Date().toISOString())
    db.prepare('INSERT INTO k5_admission_process (holder_id,owner_pid,boot_ms,phase) VALUES (?,?,?,?)').run(id, await deadPid(), bootMs(), phase)
  } finally { db.close() }
}
const resumed = async (f: Fixture) => (await f.events()).filter(e => e.event === 'prompt' && String(e.text).includes('guanxi.wake/v1'))

test('a wake left blocked by a killed node\'s admission holder is delivered once after the restart', async t => {
  const f = await leadFixture(t)
  const { runId, first } = f.start()
  await first
  await leaveStaleHolder(f, 'prepared')
  f.children.complete()
  // The node comes back: K5 and the lead service restart; the stale holder belongs to a process that is provably dead.
  await f.reload()
  await f.restartLead()
  await f.service().admissionReady()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'completed')
  assert.equal((await resumed(f)).length, 1, 'exactly one resumed turn')
  assert.deepEqual(run.wakes(runId).map(w => [w.acknowledged_at !== null, w.deliveries]), [[true, 1]], 'delivered on the first try, not after back-off')
  assert.deepEqual(f.notices, [])
})

test('a holder that cannot be proven dead keeps the wake pending, then a person is asked with a typed code instead of retrying forever', async t => {
  const f = await leadFixture(t, { plugin: { wakeFailureLimit: 3, retryMs: () => 0 } })
  const { runId, first } = f.start()
  await first
  await leaveStaleHolder(f, 'spawning')
  f.children.complete()
  await f.reload()
  await f.restartLead()
  await f.service().admissionReady()
  const run = f.runs()
  for (let i = 0; i < 6 && run.get(runId).state !== 'input_required'; i++) { f.lead().pump(); await f.lead().idle() }
  assert.equal(run.get(runId).state, 'input_required')
  assert.equal(run.wakes(runId)[0]!.acknowledged_at, null, 'the wake and its packet are kept')
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lead_wakes').get()!.n, 1)
  assert.equal((await resumed(f)).length, 0)
  assert.deepEqual(f.notices.filter(n => n.kind === 'lead_unavailable').length, 2, 'two back-offs, then the ceiling')
  const last = f.notices.at(-1)!
  assert.deepEqual([last.kind, 'code' in last ? last.code : null], ['lead_failed', 'admission_stuck'])
  assert.equal(f.lead().sessions()[0]!.failures, 3)
})

test('failure codes map to three typed reasons', () => {
  for (const [code, typed] of [['account_busy', 'admission_stuck'], ['cleanup_unconfirmed', 'admission_stuck'], ['admission_unavailable', 'admission_stuck'],
    ['admission_release_failed', 'admission_stuck'], ['quota_exhausted', 'quota_exhausted'], ['mcp_http_unsupported', 'agent_unavailable'], ['timeout', 'agent_unavailable'],
    ['anything_else', 'agent_unavailable']] as const) assert.equal(typedWakeFailure(code), typed, code)
})

test('an unavailable agent is typed agent_unavailable, and a person\'s resume clears the counter so the pending wake is delivered once', async t => {
  const f = await leadFixture(t, { plugin: { wakeFailureLimit: 1 } })
  const { runId, first } = f.start()
  await first
  await f.scenario({ mcpHttp: false })
  f.children.complete()
  f.lead().pump()
  await f.lead().idle()
  const run = f.runs()
  assert.equal(run.get(runId).state, 'input_required')
  const last = f.notices.at(-1)!
  assert.deepEqual([last.kind, 'code' in last ? last.code : null], ['lead_failed', 'agent_unavailable'])
  await f.scenario({ mcpHttp: true })
  assert.equal((await f.lead().resume(runId, 'The agent is back, please continue')).outcome, 'yielded', 'the decision turn yields because the wake is still pending')
  assert.equal(f.lead().sessions()[0]!.failures, 0)
  f.lead().pump()
  await f.lead().idle()
  assert.equal(run.get(runId).state, 'completed')
  assert.deepEqual(run.wakes(runId).map(w => w.acknowledged_at !== null), [true])
  assert.equal((await resumed(f)).length, 1)
})
