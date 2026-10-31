/**
 * K4 queue v3, round Q1, review round 2: image staging order, the owner-truth
 * classification of a failed preparation, a held replay under stop, the side-chat
 * Send answer during preparation, and deleting a session whose stored queue can
 * no longer be projected.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { open, rename, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { INPUT_INLINE_BYTES } from '@guanxi/contract'
import { piModels } from '../../src/connections/pi.ts'
import { RunStore } from '../../src/runs/store.ts'
import { NativeAgentError } from '../../src/native-agent/service.ts'
import {
  big, blobPath, build, deferred, events, peer, prompts, seedV3, started, tick, type Fixture,
} from './queue-v3-support.ts'

const routes = async (f: Fixture) => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  return nativeAgentRoutes(() => f.agents() as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
}

/** An openai image-capable model on a fixture connection whose download serves one image attachment. */
function imageSession(f: Fixture) {
  const model = piModels('openai').find((candidate) => candidate.input.includes('image'))!
  const connection = f.connections.create('local', { name: 'Image fixture', provider: 'openai', kind: 'model_api', auth: 'api_key' })
  f.connections.saveSecret('local', connection.id, f.secret)
  f.agents().host.artifactTransfers.download = async () => ({
    content: Buffer.from('fixture-image-bytes'), attachment: { artifact: { mediaType: 'image/png' }, displayName: 'image' },
  }) as unknown as Awaited<ReturnType<import('../../src/native-agent/service.ts').NativeHost['artifactTransfers']['download']>>
  return { model: model.id, connectionId: connection.id, attachmentIds: ['image'] }
}

for (const action of ['leave', 'fence'] as const) {
  test(`M1: ${action} while a queued turn stages its image attachment dispatches nothing and appends no prompt marker`, { timeout: 60_000 }, async (t) => {
    const hold = deferred()
    let reads = 0
    const f = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] }, { beforeRead: () => { reads += 1 } })
    const sessionId = await started(f, { ...imageSession(f), ...(action === 'leave' ? { retention: 'session' } : {}) })
    await seedV3(f, sessionId, [{ id: 'queue-a', text: big('M1') }])
    await f.agents().prompt(sessionId, 'continue') // call 2, held: its own staging already finished
    while (f.requests.length < 2) await tick()
    const policy = events(f, sessionId).find((e) => e.type === 'agent.policy')
    if (policy?.type !== 'agent.policy') throw new Error('missing policy')
    // Turn the staged image into a FIFO: the next staging blocks on open() until a writer appears.
    const path = policy.data.attachments[0]!
    await rm(path, { force: true })
    execFileSync('mkfifo', [path])
    hold.resolve()
    // The queued turn writes its `agent.state: running` before staging; then it blocks on the FIFO.
    while (events(f, sessionId).filter((e) => e.type === 'agent.state' && e.data.status === 'running').length < 3) await tick()
    await tick(); await tick()
    let successor: RunStore | undefined
    try {
      if (action === 'leave') f.agents().leaveSession(sessionId)
      else {
        f.runs.close()
        successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
        successor.heartbeat(); successor.reconcile()
      }
      const head = f.log.session(sessionId)!.lastSeq
      const writer = await open(path, 'w') // releases the blocked staging
      await writer.write('fixture-image-bytes'); await writer.close()
      await f.agents().wait(sessionId).catch(() => undefined)
      await tick()
      assert.equal(f.requests.length, 2, 'the queued item never reached the provider')
      assert.equal(reads, 0, 'a lost owner started no read of the queued artifact')
      assert.equal(prompts(events(f, sessionId)).some((e) => e.data.messageId === 'queue-a'), false, 'no prompt marker')
      if (action === 'fence') assert.equal(f.log.session(sessionId)!.lastSeq, head, 'the deposed owner committed nothing')
    } finally { successor?.close() }
  })
}

test('M2: a lost owner during a held read of an unreadable input is recorded as the owner truth, never as a missing input', { timeout: 60_000 }, async (t) => {
  const gate = deferred(), reached = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; armed = false; reached.resolve(); await gate.promise } })
  const sessionId = await started(f, { retention: 'session' })
  const text = big('M2-OWNER')
  await seedV3(f, sessionId, [{ id: 'queue-a', text }])
  await rename(blobPath(f, sessionId, text), `${blobPath(f, sessionId, text)}.gone`)
  armed = true
  await f.agents().prompt(sessionId, 'continue')
  await reached.promise
  f.agents().leaveSession(sessionId) // the read will fail as not found, but the session was left first
  gate.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'failed')
  const all = events(f, sessionId)
  assert.equal(all.filter((e) => e.type === 'error').length, 0, 'no input_artifact_unavailable claim')
  const states = all.filter((e) => e.type === 'agent.state').map((e) => e.type === 'agent.state' ? e.data : null)
  assert.deepEqual(states.at(-1), { status: 'failed', error: 'agent_failed' })
  assert.equal(prompts(all).some((e) => e.data.messageId === 'queue-a'), false)
})

test('L5: stop during a held replay settles without waiting for the held history read', { timeout: 60_000 }, async (t) => {
  const gate = deferred(), reached = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; armed = false; reached.resolve(); await gate.promise } })
  const sessionId = await started(f, { prompt: big('HISTORY') }) // the seed prompt is an artifact, so replay reads it
  await seedV3(f, sessionId, [{ id: 'queue-a', text: 'small queued item' }])
  await f.agents().prompt(sessionId, 'continue')
  armed = true
  await reached.promise
  f.agents().stop(sessionId)
  const settled = await Promise.race([f.agents().wait(sessionId).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500))])
  assert.equal(settled, true, 'the abort reached the replay read')
  gate.resolve()
})

test('L4: side-chat Send during a queued turn\'s preparation is the 409 session_busy, not a 503', { timeout: 60_000 }, async (t) => {
  const gate = deferred(), reached = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; armed = false; reached.resolve(); await gate.promise } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('L4') }])
  armed = true
  await f.agents().prompt(sessionId, 'continue')
  await reached.promise
  const route = await routes(f)
  const send = await route.request(`/${sessionId}/side-chat/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID(), text: 'send during preparation' }) }, peer)
  assert.equal(send.status, 409)
  assert.deepEqual(await send.json(), { code: 'session_busy' })
  gate.resolve()
  await f.agents().wait(sessionId)
})

test('L2: a session whose stored queue can no longer be projected can still be deleted', { timeout: 60_000 }, async (t) => {
  const secret = `late-${randomBytes(12).toString('hex')}`
  const f = await build(t)
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: `${secret} `.repeat(Math.floor(INPUT_INLINE_BYTES / (secret.length + 1))) }])
  await f.scrubber.register('secret://fixture/delete', secret)
  assert.throws(() => f.agents().progress(sessionId), (e: unknown) => e instanceof NativeAgentError && e.code === 'stored_data_invalid')
  assert.deepEqual(await f.agents().deleteSession(sessionId), { sessionId, deleted: true })
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?').get(sessionId) as { n: number }).n, 0)
})
