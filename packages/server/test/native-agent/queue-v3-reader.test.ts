/**
 * K4 queue v3 native reader regressions across historical v1 and current v3
 * snapshots, including explicitly seeded corrupt or foreign-node state.
 * Oracles are independent of the code under test: Buffer bytes, event/row
 * counts, a recording fake provider and deferred promises.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  INPUT_EXCERPT_BYTES, INPUT_INLINE_BYTES, SESSION_EVENT_MAX_VERSION, SESSION_EVENT_VERSION_3,
  agentProgressSchema, agentProgressV2Schema, nativeProgressVersionUnsupportedSchema,
} from '@guanxi/contract'
import { NativeAgentError, NativeProgressVersionError } from '../../src/native-agent/service.ts'
import { utf8Excerpt } from '../../src/session-log/input-artifacts.ts'
import { RunStore } from '../../src/runs/store.ts'
import {
  big, blobPath, build, deferred, events, peer, prompts, runIds, seedV1, seedV3, sha, started, tick,
  type Fixture, type Seed,
} from './queue-v3-support.ts'

test('Q06: a seeded v3 artifact is consumed once with its full verified bytes, in order, one fresh attempt per item', { timeout: 60_000 }, async (t) => {
  const tail = `Q06-TAIL-${randomBytes(8).toString('hex')}`
  const text = big(tail)
  const f = await build(t)
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text }, { id: 'queue-b', text: 'second inline item' }])
  const runsBefore = runIds(events(f, sessionId)).size
  const requestsBefore = f.requests.length

  assert.equal(await f.agents().prompt(sessionId, 'continue'), 'started')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')

  // 'continue', the artifact item, then the inline item: three requests, nothing else.
  assert.equal(f.requests.length, requestsBefore + 3)
  assert.equal(f.requests[requestsBefore + 1]!.includes(text), true, 'the first request carries every byte, tail included')
  assert.equal(f.requests[requestsBefore + 1]!.includes('second inline item'), false)
  assert.equal(f.requests[requestsBefore + 2]!.includes('second inline item'), true)
  const all = events(f, sessionId)
  const consumed = prompts(all).filter((e) => e.data.messageId === 'queue-a' || e.data.messageId === 'queue-b')
  assert.deepEqual(consumed.map((e) => [e.data.messageId, e.data.origin]), [['queue-a', 'queued'], ['queue-b', 'queued']])
  assert.equal(consumed[0]!.version, 2, 'the durable prompt re-artifactizes its own scrubbed text')
  assert.equal(consumed[0]!.version === 2 && consumed[0]!.data.artifact.checksum, sha(text))
  assert.equal(runIds(all).size, runsBefore + 3, 'continue, A and B each own one run')
  assert.equal(f.agents().progressV2(sessionId).queue.length, 0)
  assert.equal(JSON.stringify(f.agents().progressV2(sessionId)).includes(tail), false)
})

test('Q06: an inline legacy v1 oversized item is freshly scrubbed and consumed whole', { timeout: 60_000 }, async (t) => {
  const tail = `LEGACY-TAIL-${randomBytes(8).toString('hex')}`
  const late = `late-${randomBytes(12).toString('hex')}`
  const text = `${late} ${big(tail)}`
  const f = await build(t)
  const sessionId = await started(f)
  await seedV1(f, sessionId, [{ id: 'legacy-large', text }])
  await f.scrubber.register('secret://fixture/late-queue', late)
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2]!.includes(tail), true, 'the whole legacy text, tail included')
  assert.equal(f.requests[2]!.includes(late), false, 'scrubbed with the registry current at consumption')
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'legacy-large' && e.data.origin === 'queued').length, 1)
})

const unreadable: { name: string; seed: (f: Fixture, sessionId: string, text: string) => Promise<Seed>; damage: (f: Fixture, sessionId: string, text: string) => Promise<void> }[] = [
  { name: 'missing blob', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s, text) => { await rename(blobPath(f, s, text), `${blobPath(f, s, text)}.gone`) } },
  { name: 'same-size tampered bytes', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s, text) => {
    await rm(blobPath(f, s, text), { force: true }); await writeFile(blobPath(f, s, text), 'b'.repeat(Buffer.byteLength(text))) } },
  { name: 'truncated blob', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s, text) => {
    await rm(blobPath(f, s, text), { force: true }); await writeFile(blobPath(f, s, text), text.slice(0, 100)) } },
  { name: 'invalid UTF-8 content', seed: async () => ({ id: 'bad', bytes: Uint8Array.from([...Buffer.alloc(INPUT_INLINE_BYTES, 0x61), 0xff, 0xfe, 0x61]) }), damage: async () => undefined },
  { name: 'metadata row checksum differs from the reference', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s) => {
    f.db.prepare('UPDATE session_input_artifacts SET checksum = ? WHERE session_id = ?').run(`sha256:${'0'.repeat(64)}`, s) } },
  { name: 'metadata row size differs from the reference', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s) => {
    f.db.prepare('UPDATE session_input_artifacts SET byte_size = byte_size + 1 WHERE session_id = ?').run(s) } },
  { name: 'metadata row is absent for this session', seed: async (_f, _s, text) => ({ id: 'bad', text }), damage: async (f, s) => {
    f.db.prepare('DELETE FROM session_input_artifacts WHERE session_id = ?').run(s) } },
]

for (const variant of unreadable) {
  test(`Q07: ${variant.name} records one content-free failure on the new attempt and dispatches nothing`, { timeout: 60_000 }, async (t) => {
    const text = big(`Q07-TAIL-${randomBytes(6).toString('hex')}`)
    const f = await build(t)
    const sessionId = await started(f)
    await seedV3(f, sessionId, [await variant.seed(f, sessionId, text), { id: 'after', text: 'must stay behind the failed item' }])
    await variant.damage(f, sessionId, text)
    const requestsBefore = f.requests.length

    await f.agents().prompt(sessionId, 'continue')
    const result = await f.agents().wait(sessionId)
    assert.equal(result.status, 'failed')
    assert.equal(result.error, 'input_artifact_unavailable')
    assert.equal(f.requests.length, requestsBefore + 1, 'only the typed continue reached the provider')

    const all = events(f, sessionId)
    const doneEvents = all.filter((e) => e.type === 'turn.done')
    assert.equal(doneEvents.length, 3, 'seed, continue and exactly one failed preparation turn')
    const failedDone = all.findLastIndex((e) => e.type === 'turn.done')
    assert.equal(all[failedDone]!.type === 'turn.done' && all[failedDone]!.data.outcome, 'failed')
    const continueEnd = all.findLastIndex((e, index) => e.type === 'turn.done' && index < failedDone)
    const after = all.slice(continueEnd + 1)
    assert.equal(after.filter((e) => e.type === 'error').length, 1)
    const error = after.find((e) => e.type === 'error')
    assert.deepEqual(error?.type === 'error' ? error.data : null, { code: 'input_artifact_unavailable', message: 'Session input artifact unavailable' })
    assert.equal(JSON.stringify(error).includes('Q07-TAIL'), false)
    assert.equal(after.some((e) => e.type === 'prompt' || e.type === 'tool.call' || e.type === 'tool.result' || e.type === 'assistant.message'), false)
    assert.deepEqual(after.filter((e) => e.type === 'agent.state').map((e) => e.type === 'agent.state' ? e.data.status : null), ['running', 'failed'])
    // The failure belongs to a new run, not to the completed prior one.
    assert.equal(runIds(all).size, 3, 'seed, continue and the preparation attempt each own one run')
    const newRun = [...runIds(after)].filter((id) => !runIds(all.slice(0, continueEnd + 1)).has(id))
    assert.equal(newRun.length, 1)
    assert.equal(prompts(all).some((e) => e.data.messageId === 'bad' || e.data.messageId === 'after'), false)
    assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['bad', 'after'], 'the selected id stays pending and the next is never skipped to')
    assert.equal(JSON.stringify(f.agents().progressV2(sessionId)).includes('Q07-TAIL'), false)
  })
}

test('Q08: stop during a held read returns at once, cancels the preparation attempt and dispatches nothing', { timeout: 60_000 }, async (t) => {
  const reading = deferred(), gate = deferred()
  let reads = 0, armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; reads += 1; reading.resolve(); await gate.promise } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q08') }, { id: 'queue-b', text: 'behind' }])
  armed = true
  const requestsBefore = f.requests.length
  await f.agents().prompt(sessionId, 'continue')
  await reading.promise
  assert.equal(reads, 1)

  // Mutations are sealed while the queued turn prepares.
  await assert.rejects(f.agents().queue(sessionId, 'late add'), (e: unknown) => e instanceof NativeAgentError && e.code === 'session_not_running')
  await assert.rejects(f.agents().removeQueued(sessionId, 'queue-b'), (e: unknown) => e instanceof NativeAgentError && e.code === 'session_not_running')
  const waiting = f.agents().wait(sessionId)
  // stop() is synchronous: it records the intent and aborts while the read is still held.
  assert.equal(f.agents().stop(sessionId), undefined)
  gate.resolve()
  assert.equal((await waiting).status, 'cancelled')

  assert.equal(f.requests.length, requestsBefore + 1)
  const all = events(f, sessionId)
  assert.equal(prompts(all).some((e) => e.data.messageId === 'queue-a' || e.data.messageId === 'queue-b'), false)
  const last = all.findLastIndex((e) => e.type === 'turn.done')
  const interventions = all.map((e, index) => e.type === 'intervention' ? index : -1).filter((index) => index >= 0)
  assert.equal(interventions.length, 1, 'exactly one intervention')
  assert.ok(interventions[0]! < last, 'before exactly one terminal of the preparation attempt')
  assert.equal(all.filter((e) => e.type === 'error').length, 0)
  assert.equal(all[last]!.type === 'turn.done' && all[last]!.data.outcome, 'cancelled')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a', 'queue-b'])
})

test('Q08: leaving the session during a held read dispatches nothing and leaves the item pending', { timeout: 60_000 }, async (t) => {
  const reading = deferred(), gate = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; reading.resolve(); await gate.promise } })
  const sessionId = await started(f, { retention: 'session' })
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q08-LEAVE') }])
  armed = true
  const requestsBefore = f.requests.length
  await f.agents().prompt(sessionId, 'continue')
  await reading.promise
  f.agents().leaveSession(sessionId)
  gate.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'failed')
  assert.equal(f.requests.length, requestsBefore + 1)
  assert.equal(prompts(events(f, sessionId)).some((e) => e.data.messageId === 'queue-a'), false)
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a'])
})

test('Q08: a deposed home writes nothing and dispatches nothing after the held read', { timeout: 60_000 }, async (t) => {
  const reading = deferred(), gate = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; reading.resolve(); await gate.promise } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q08-FENCE') }])
  armed = true
  const requestsBefore = f.requests.length
  await f.agents().prompt(sessionId, 'continue')
  await reading.promise
  f.runs.close()
  const successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
  try {
    successor.heartbeat(); successor.reconcile()
    const head = f.log.session(sessionId)!.lastSeq
    gate.resolve()
    await f.agents().wait(sessionId).catch(() => undefined)
    assert.equal(f.log.session(sessionId)!.lastSeq, head, 'the deposed owner committed nothing')
    assert.equal(f.requests.length, requestsBefore + 1)
    assert.equal(prompts(events(f, sessionId)).some((e) => e.data.messageId === 'queue-a'), false)
  } finally { successor.close() }
})

test('Q2: add, remove and prompt routes accept pending v3 work without rewriting retained blobs', { timeout: 60_000 }, async (t) => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  const hold = deferred()
  let reads = 0
  const f = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] }, { beforeRead: () => { reads += 1 } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q2') }, { id: 'queue-b', text: 'other' }])
  const app = nativeAgentRoutes(() => f.agents() as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()

  const readsBefore = reads
  const rows = () => f.db.prepare('SELECT * FROM session_input_artifacts ORDER BY artifact_id').all()
  const dir = f.agents().inputArtifacts.directoryFor(sessionId)
  const before = { rows: rows(), blobs: await readdir(dir) }
  const artifact = f.agents().progressV2(sessionId).queue[0]!
  const post = await app.request(`/${sessionId}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'new work' }) }, peer)
  assert.equal(post.status, 202)
  assert.deepEqual(await post.json(), { ok: true })
  assert.deepEqual(f.agents().progressV2(sessionId).queue[0], artifact, 'retained artifact reference survives the add')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id).slice(0, 2), ['queue-a', 'queue-b'])
  const unsupported = await app.request(`/${sessionId}`, undefined, peer)
  assert.equal(unsupported.status, 406)
  assert.deepEqual(nativeProgressVersionUnsupportedSchema.parse(await unsupported.json()), { code: 'native_progress_version_unsupported', supported: 1, required: 2 })
  const retained = agentProgressV2Schema.parse(await (await app.request(`/${sessionId}?progressVersion=2`, undefined, peer)).json())
  assert.deepEqual(retained.queue[0], artifact)
  for (const id of ['queue-a', 'queue-b', 'never-existed']) {
    const removed = await app.request(`/${sessionId}/queue/${id}`, { method: 'DELETE' }, peer)
    assert.equal(removed.status, 200)
    assert.deepEqual(await removed.json(), { ok: true })
  }
  const prompted = await app.request(`/${sessionId}/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'queued behind' }) }, peer)
  assert.equal(prompted.status, 202)
  const queue = agentProgressV2Schema.parse(await (await app.request(`/${sessionId}?progressVersion=2`, undefined, peer)).json()).queue
  assert.deepEqual(queue.map((item) => item.kind === 'inline' ? item.text : null), ['new work', 'queued behind'])
  assert.equal(new Set(queue.map((item) => item.id)).size, 2)
  assert.deepEqual({ rows: rows(), blobs: await readdir(dir) }, before, 'retained and removed artifacts are neither rewritten nor deleted')
  assert.equal(reads, readsBefore, 'mutations never hydrate retained blobs')
  const snapshots = events(f, sessionId).filter((e) => e.type === 'agent.queue')
  assert.equal(snapshots.length, 6, 'seed, add, three removals and queued prompt each append once')
  assert.equal(snapshots.every((e) => e.version === SESSION_EVENT_VERSION_3), true)

  f.agents().stop(sessionId)
  hold.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'cancelled')
})

test('Q2: a v3 snapshot whose items are all consumed accepts fresh v3 mutations', { timeout: 60_000 }, async (t) => {
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 3) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: 'only inline item' }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 3) await tick() // call 3 consumes queue-a and is held; the queue is empty
  assert.deepEqual(f.agents().progressV2(sessionId).queue, [])
  assert.equal(await f.agents().queue(sessionId, 'fresh v3 item'), 'queued')
  const queueEvents = events(f, sessionId).filter((e) => e.type === 'agent.queue')
  assert.equal(queueEvents.at(-1)!.version, SESSION_EVENT_VERSION_3)
  hold.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
})

test('Q11: progress1 keeps the legacy text or refuses typed 406; progress2 follows the strict v2 branches without opening a blob', { timeout: 60_000 }, async (t) => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  let reads = 0
  const f = await build(t, undefined, { beforeRead: () => { reads += 1 } })
  const app = nativeAgentRoutes(() => f.agents() as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
  const legacyTail = `LEGACY-LARGE-${randomBytes(8).toString('hex')}`
  const legacy = big(legacyTail)
  const sessionId = await started(f)
  await seedV1(f, sessionId, [{ id: 'legacy-small', text: 'small item' }, { id: 'legacy-large', text: legacy }])

  const get = async (query = '') => app.request(`/${sessionId}${query}`, undefined, peer)
  const one = agentProgressSchema.parse(await (await get()).json())
  assert.deepEqual(one.queue.map((item) => item.text), ['small item', legacy], 'unversioned keeps the complete legacy text')
  assert.deepEqual(agentProgressSchema.parse(await (await get('?progressVersion=1')).json()), one)
  const two = agentProgressV2Schema.parse(await (await get('?progressVersion=2')).json())
  assert.equal(two.version, 2)
  assert.equal(two.queue[0]!.kind, 'inline')
  const preview = two.queue[1]!
  assert.equal(preview.kind, 'legacy-preview')
  if (preview.kind !== 'legacy-preview') throw new Error('unreachable')
  assert.equal(preview.byteSize, Buffer.byteLength(legacy))
  assert.equal(preview.excerpt, utf8Excerpt(legacy))
  assert.equal(preview.excerptBytes, Buffer.byteLength(preview.excerpt))
  assert.ok(preview.excerptBytes <= INPUT_EXCERPT_BYTES)
  assert.equal('text' in preview, false)
  assert.equal(JSON.stringify(two).includes(legacyTail), false)
  assert.equal((await get('?progressVersion=3')).status, 400)
  assert.equal((await get('?progressVersion=2&extra=1')).status, 400)
  // A pending artifact: progress1 is the typed content-free 406, progress2 the artifact branch.
  const artifactTail = `ARTIFACT-${randomBytes(8).toString('hex')}`
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big(artifactTail) }, { id: 'queue-b', text: 'inline sibling' }])
  const refused = await get()
  assert.equal(refused.status, 406)
  assert.deepEqual(nativeProgressVersionUnsupportedSchema.parse(await refused.json()), { code: 'native_progress_version_unsupported', supported: 1, required: 2 })
  assert.equal((await get('?progressVersion=1')).status, 406)
  assert.throws(() => f.agents().progress(sessionId), (e: unknown) => e instanceof NativeProgressVersionError)
  const v2 = agentProgressV2Schema.parse(await (await get('?progressVersion=2')).json())
  assert.deepEqual(v2.queue.map((item) => [item.id, item.kind]), [['queue-a', 'artifact'], ['queue-b', 'inline']])
  const artifact = v2.queue[0]!
  assert.equal(artifact.kind === 'artifact' && artifact.artifact.excerpt.includes(artifactTail), false)
  assert.equal(artifact.kind === 'artifact' && artifact.artifact.byteSize, Buffer.byteLength(big(artifactTail)))
  assert.equal(JSON.stringify(v2).includes(artifactTail), false)
  assert.equal(reads, 0, 'neither the 406 nor progress2 opened a blob')

  // /result is untouched by the queue contents.
  const result = await app.request(`/${sessionId}/result`, undefined, peer)
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(await result.json() as object), ['version', 'sessionId', 'status', 'text', 'error'])
})

test('Q11: a v3 queue of inline items answers progress1 in the exact legacy shape', { timeout: 60_000 }, async (t) => {
  const f = await build(t)
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'one', text: 'first' }, { id: 'two', text: 'second' }])
  assert.deepEqual(f.agents().progress(sessionId).queue, [{ id: 'one', text: 'first' }, { id: 'two', text: 'second' }])
  assert.deepEqual(f.agents().progressV2(sessionId).queue, [{ id: 'one', kind: 'inline', text: 'first' }, { id: 'two', kind: 'inline', text: 'second' }])
})

test('Q09: restart never dispatches a pending item; an explicit continuation consumes it once and never again', { timeout: 60_000 }, async (t) => {
  const f = await build(t)
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q09') }])
  await f.restart()
  await tick()
  assert.equal(f.requests.length, 1, 'reopen starts no inference')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a'])
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 3)
  await f.restart()
  await f.agents().prompt(sessionId, 'again')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 4, 'the committed id is not dispatched again')
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'queue-a').length, 1)
})

test('Q09: after the prompt commit a restart leaves it consumed, the sibling pending, and starts no inference', { timeout: 60_000 }, async (t) => {
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 3) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('Q09-COMMIT') }, { id: 'queue-b', text: 'sibling' }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 3) await tick() // the provider call for queue-a is in flight
  const inFlight = f.requests.length
  await f.restart(undefined, true)
  await tick()
  assert.equal(f.requests.length, inFlight, 'no inference after reopen')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-b'])
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'queue-a').length, 1)
})

test('rollback floor: max-2 reads legacy v1 but stops before native v3 production', { timeout: 60_000 }, async (t) => {
  assert.equal(SESSION_EVENT_MAX_VERSION, 3)
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  await seedV1(f, sessionId, [{ id: 'legacy', text: big('LEGACY-FLOOR') }])
  const legacy = f.log.read(sessionId, { audience: 'person', maxVersion: 2, limit: 500 })
  assert.equal(legacy.unsupportedSeq, null)
  assert.equal(legacy.requiredVersion, null)
  assert.equal(legacy.events.length, events(f, sessionId).length, 'a max-2 reader still reads historical v1 queues')

  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()
  await f.agents().queue(sessionId, big('FLOOR-TAIL'))
  await f.agents().queue(sessionId, 'removable')
  const removable = f.agents().progressV2(sessionId).queue.find((item) => item.kind === 'inline' && item.text === 'removable')!
  await f.agents().removeQueued(sessionId, removable.id)
  const all = events(f, sessionId)
  const produced = all.filter((e) => e.type === 'agent.queue').slice(1)
  assert.equal(produced.length, 3)
  assert.equal(produced.every((e) => e.version === SESSION_EVENT_VERSION_3), true, 'all new snapshots use v3')
  const old = f.log.read(sessionId, { audience: 'person', maxVersion: 2, limit: 500 })
  assert.equal(old.requiredVersion, 3)
  assert.equal(old.unsupportedSeq, produced[0]!.seq)
  assert.equal(old.events.every((e) => e.version <= 2), true)
  assert.equal(old.events.length, all.findIndex((e) => e.seq === produced[0]!.seq), 'no partial v3 event escapes to an older reader')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.kind), ['artifact', 'artifact'])
  f.agents().stop(sessionId)
  hold.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'cancelled')
})

// Review regression: side-chat uses the same durable queue producer as ordinary prompts.

test('side-chat Send onto a pending v3 queue appends once and preserves the existing work', { timeout: 60_000 }, async (t) => {
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('SC') }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()
  const request = { operationId: randomUUID(), text: 'send me' }
  const sent = await f.agents().sideChatSend(sessionId, request)
  assert.equal(sent.delivery, 'queued')
  assert.equal(sent.duplicate, false)
  const head = f.log.session(sessionId)!.lastSeq
  assert.deepEqual(await f.agents().sideChatSend(sessionId, request), { ...sent, duplicate: true })
  assert.equal(f.log.session(sessionId)!.lastSeq, head, 'duplicate Send writes no second snapshot')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a', sent.messageId])
  assert.equal(events(f, sessionId).filter((e) => e.type === 'agent.queue').length, 2)
  hold.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === sent.messageId).length, 1)
})
