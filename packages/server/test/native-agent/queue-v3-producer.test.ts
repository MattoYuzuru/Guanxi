/** Q2 producer evidence: real artifact storage, synthetic provider, no models or containers. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rename } from 'node:fs/promises'
import { test } from 'node:test'
import { INPUT_EXCERPT_BYTES, INPUT_INLINE_BYTES, SESSION_EVENT_VERSION_3, agentProgressV2Schema, nativeProgressVersionUnsupportedSchema, type SessionEvent } from '@guanxi/contract'
import { RunStore } from '../../src/runs/store.ts'
import { SessionInputError, type SessionInputStoreHooks } from '../../src/session-log/input-artifacts.ts'
import { big, blobPath, build, deferred, events, peer, prompts, sha, started, tick, type Fixture } from './queue-v3-support.ts'

const queues = (f: Fixture, id: string) => events(f, id).filter((e): e is Extract<SessionEvent, { type: 'agent.queue'; version: 3 }> => e.type === 'agent.queue' && e.version === SESSION_EVENT_VERSION_3)
const rows = (f: Fixture) => Number(f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get()!.n)

async function held(t: Parameters<typeof build>[0], hooks?: SessionInputStoreHooks, retention = 'keep') {
  const gate = deferred()
  t.after(() => gate.resolve())
  const f = await build(t, async (call) => { if (call === 1) await gate.promise; return [{ type: 'text', text: `answer ${call}` }] }, hooks)
  const { sessionId } = await f.agents().create({ ...f.input, retention })
  while (f.requests.length === 0) await tick()
  return { f, sessionId, release: gate.resolve }
}

for (const [name, text] of [
  ['below', 'a'.repeat(INPUT_INLINE_BYTES - 1)],
  ['exact', 'a'.repeat(INPUT_INLINE_BYTES)],
  ['above', 'a'.repeat(INPUT_INLINE_BYTES + 1)],
  ['unicode chunks', `${'😀é'.repeat(40_000)}UNICODE-TAIL`],
  ['surrogate', `${'😀'.repeat(5000)}\ud800SURROGATE-TAIL`],
] as const) {
  test(`Q01/Q06: ${name} uses scrubbed UTF-8 bytes and dispatches full queued input once`, { timeout: 60_000 }, async (t) => {
    const { f, sessionId, release } = await held(t)
    const id = randomUUID()
    assert.equal(await f.agents().queue(sessionId, text, true, id), 'queued')
    const snapshot = queues(f, sessionId)
    assert.equal(snapshot.length, 1)
    const item = snapshot[0]!.data.items[0]!
    assert.equal(item.id, id)
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length <= INPUT_INLINE_BYTES) {
      assert.deepEqual(item, { id, kind: 'inline', text })
      assert.equal(rows(f), 0)
    } else {
      assert.equal(item.kind, 'artifact')
      if (item.kind !== 'artifact') throw new Error('expected artifact')
      assert.equal('text' in item, false)
      assert.equal(item.artifact.byteSize, bytes.length)
      assert.equal(item.artifact.checksum, sha(text))
      assert.equal(item.artifact.excerptBytes, Buffer.byteLength(item.artifact.excerpt))
      assert.ok(item.artifact.excerptBytes <= INPUT_EXCERPT_BYTES)
      assert.deepEqual(await readFile(blobPath(f, sessionId, text)), bytes)
      assert.equal(rows(f), 1)
    }
    release()
    assert.equal((await f.agents().wait(sessionId)).status, 'completed')
    assert.equal(f.requests.length, 2, 'typed turn and exactly one queued turn')
    assert.equal(f.requests[1]!.includes(JSON.stringify(bytes.toString('utf8')).slice(1, -1)), true)
    assert.deepEqual(prompts(events(f, sessionId)).filter((e) => e.data.origin === 'queued').map((e) => e.data.messageId), [id])
    assert.equal(f.agents().progressV2(sessionId).queue.length, 0)
  })
}

test('Q02: equal large inputs keep distinct work IDs and reuse one metadata row and blob', { timeout: 60_000 }, async (t) => {
  const { f, sessionId, release } = await held(t)
  const text = big('SAME-TEXT-TAIL')
  await f.agents().queue(sessionId, text, true, 'one')
  await f.agents().queue(sessionId, text, true, 'two')
  assert.equal(await f.agents().queue(sessionId, text, true, 'one'), 'duplicate')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((e) => e.id), ['one', 'two'])
  assert.equal(queues(f, sessionId).length, 2, 'duplicate admission appends no snapshot')
  assert.equal(rows(f), 1)
  assert.deepEqual(await readdir(f.agents().inputArtifacts.directoryFor(sessionId)), [sha(text).slice(7)])
  release()
  await f.agents().wait(sessionId)
  assert.equal(f.requests.length, 3)
  assert.deepEqual(prompts(events(f, sessionId)).filter((e) => e.data.origin === 'queued').map((e) => e.data.messageId), ['one', 'two'])
})

for (const mutation of ['add', 'remove'] as const) {
  test(`Q04: ${mutation} normalizes retained legacy-large input without rewriting its historical event`, { timeout: 60_000 }, async (t) => {
    const gate = deferred()
    t.after(() => gate.resolve())
    let reads = 0
    const f = await build(t, async (call) => { if (call === 2) await gate.promise; return [{ type: 'text', text: 'answer' }] }, { beforeRead: () => { reads += 1 } })
    const sessionId = await started(f)
    const text = big('LEGACY-TAIL')
    const handle = f.log.open(sessionId, { kind: 'agent' })
    handle.append({ type: 'agent.queue', data: { items: [{ id: 'legacy', text }, { id: 'remove', text: 'discard' }] } })
    handle.close()
    const raw = () => f.db.prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'agent.queue' ORDER BY seq LIMIT 1").get(sessionId)!.payload
    const before = raw()
    await f.agents().prompt(sessionId, 'continue')
    while (f.requests.length < 2) await tick()
    if (mutation === 'add') await f.agents().queue(sessionId, 'new item', true, 'new')
    else await f.agents().removeQueued(sessionId, 'remove')
    assert.equal(raw(), before)
    const items = queues(f, sessionId).at(-1)!.data.items
    assert.deepEqual(items.map((i) => i.id), mutation === 'add' ? ['legacy', 'remove', 'new'] : ['legacy'])
    assert.equal(items[0]!.kind, 'artifact')
    assert.equal(JSON.stringify(items).includes('LEGACY-TAIL'), false)
    assert.deepEqual(await readFile(blobPath(f, sessionId, text)), Buffer.from(text))
    assert.equal(reads, 0, 'normalization and previews never hydrate retained work')
    f.agents().stop(sessionId)
    gate.resolve()
    await f.agents().wait(sessionId)
  })
}

test('Q04: a broken artifact can be removed without opening blobs or deleting historical metadata', { timeout: 60_000 }, async (t) => {
  let reads = 0, writes = 0
  const { f, sessionId, release } = await held(t, { beforeRead: () => { reads += 1 }, beforeWrite: () => { writes += 1 } })
  const text = big('BROKEN-TAIL')
  await f.agents().queue(sessionId, text, true, 'broken')
  await f.agents().queue(sessionId, text, true, 'retained')
  const path = blobPath(f, sessionId, text)
  await rename(path, `${path}.gone`)
  await f.agents().removeQueued(sessionId, 'broken')
  await f.agents().removeQueued(sessionId, 'retained')
  await f.agents().removeQueued(sessionId, 'absent')
  assert.deepEqual(queues(f, sessionId).at(-1)!.data.items, [])
  assert.equal(reads, 0)
  assert.equal(writes, 2, 'retained descriptors need no rewrite')
  assert.equal(rows(f), 1, 'historical metadata is retained')
  assert.deepEqual(await readdir(f.agents().inputArtifacts.directoryFor(sessionId)), [`${sha(text).slice(7)}.gone`])
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 1, 'removed items never dispatch')
})

test('Q03: held write serializes add/add/remove without losing or dispatching removed work', { timeout: 60_000 }, async (t) => {
  const writing = deferred(), gate = deferred()
  t.after(() => gate.resolve())
  let writes = 0
  const { f, sessionId, release } = await held(t, { beforeWrite: async () => { if (++writes === 1) { writing.resolve(); await gate.promise } } })
  await f.agents().queue(sessionId, 'remove this', true, 'remove')
  const first = f.agents().queue(sessionId, big('FIFO-FIRST'), true, 'first')
  await writing.promise
  const second = f.agents().queue(sessionId, big('FIFO-SECOND'), true, 'second')
  const removal = f.agents().removeQueued(sessionId, 'remove')
  assert.deepEqual(queues(f, sessionId).map((e) => e.data.items.map((i) => i.id)), [['remove']])
  gate.resolve()
  await Promise.all([first, second, removal])
  assert.deepEqual(queues(f, sessionId).map((e) => e.data.items.map((i) => i.id)), [
    ['remove'], ['remove', 'first'], ['remove', 'first', 'second'], ['first', 'second'],
  ])
  assert.equal(writes, 2, 'retained artifacts are not rewritten')
  release()
  await f.agents().wait(sessionId)
  assert.equal(f.requests.length, 3)
  assert.deepEqual(prompts(events(f, sessionId)).filter((e) => e.data.origin === 'queued').map((e) => e.data.messageId), ['first', 'second'])
})

test('Q03: provider completion during a held queue write preserves the admitted input before the terminal', { timeout: 60_000 }, async (t) => {
  const writing = deferred(), gate = deferred(), finishing = deferred(), provider = deferred()
  t.after(() => gate.resolve())
  t.after(() => provider.resolve())
  const f = await build(t, async (call) => {
    if (call === 1) { await provider.promise; finishing.resolve() }
    return [{ type: 'text', text: 'answer' }]
  }, { beforeWrite: async () => { writing.resolve(); await gate.promise } })
  const { sessionId } = await f.agents().create(f.input)
  while (f.requests.length === 0) await tick()
  const added = f.agents().queue(sessionId, big('SEALED-TAIL'), true, 'kept')
  await writing.promise
  provider.resolve()
  await finishing.promise
  gate.resolve()
  assert.equal(await added, 'queued')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 2)
  const all = events(f, sessionId)
  assert.ok(all.findIndex((e) => e.type === 'agent.queue') < all.findIndex((e) => e.type === 'turn.done'))
  assert.equal(prompts(all).filter((e) => e.data.messageId === 'kept').length, 1)
})

for (const action of ['stop', 'leave', 'fence', 'helper failure'] as const) {
  test(`Q05: ${action} during a held queue write commits no acceptance and dispatches no later item`, { timeout: 60_000 }, async (t) => {
    const writing = deferred(), gate = deferred()
    t.after(() => gate.resolve())
    const { f, sessionId, release } = await held(t, { beforeWrite: async () => {
      writing.resolve(); await gate.promise
      if (action === 'helper failure') throw new SessionInputError('storage_failure', 'synthetic failure')
    } }, action === 'leave' ? 'session' : 'keep')
    const added = f.agents().queue(sessionId, big('NEVER-ACCEPTED'), true, 'uncommitted')
    const rejected = assert.rejects(added)
    await writing.promise
    const later = f.agents().queue(sessionId, 'never dispatch later', true, 'later')
    const laterRejected = assert.rejects(later)
    let successor: RunStore | undefined
    try {
      if (action === 'stop') assert.equal(f.agents().stop(sessionId), undefined, 'stop returns while storage is held')
      if (action === 'leave') f.agents().leaveSession(sessionId)
      if (action === 'fence') {
        f.runs.close()
        successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
        successor.heartbeat(); successor.reconcile()
      }
      const head = f.log.session(sessionId)!.lastSeq
      gate.resolve()
      await rejected; await laterRejected
      release()
      const result = await f.agents().wait(sessionId).catch(() => null)
      assert.equal(queues(f, sessionId).length, 0)
      assert.equal(rows(f), 0)
      assert.equal(f.requests.length, 1)
      const all = events(f, sessionId)
      assert.equal(prompts(all).filter((e) => e.data.origin === 'queued').length, 0)
      if (action === 'fence') assert.equal(f.log.session(sessionId)!.lastSeq, head)
      else {
        assert.equal(result?.status, action === 'stop' ? 'cancelled' : 'failed')
        assert.equal(all.filter((e) => e.type === 'turn.done').length, 1)
        assert.equal(all.filter((e) => e.type === 'intervention').length, action === 'stop' ? 1 : 0)
        const done = all.findIndex((e) => e.type === 'turn.done')
        if (action === 'stop') assert.ok(all.findIndex((e) => e.type === 'intervention') < done)
        assert.deepEqual(all.slice(done + 1).map((e) => e.type), ['run.lifecycle'])
      }
    } finally { successor?.close() }
  })
}

test('Q05: a lost owner after successful storage cannot publish its descriptor', { timeout: 60_000 }, async (t) => {
  const { f, sessionId, release } = await held(t, undefined, 'session')
  const store = f.agents().inputArtifacts
  const write = store.write.bind(store)
  store.write = async (...args) => { const written = await write(...args); f.agents().leaveSession(sessionId); return written }
  await assert.rejects(f.agents().queue(sessionId, big('POST-WRITE'), true, 'lost'))
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'failed')
  assert.equal(queues(f, sessionId).length, 0)
  assert.equal(rows(f), 0)
  assert.equal(f.requests.length, 1)
})

test('Q09: restart after producer acceptance preserves pending input without inference; explicit continuation consumes once', { timeout: 60_000 }, async (t) => {
  const { f, sessionId, release } = await held(t)
  await f.agents().queue(sessionId, big('RESTART-TAIL'), true, 'pending')
  await f.restart(undefined, true)
  release()
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((i) => i.id), ['pending'])
  await f.agents().prompt(sessionId, 'continue explicitly')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'pending').length, 1)
  await f.restart(undefined, true)
  assert.equal(f.requests.length, 3)
  assert.deepEqual(f.agents().progressV2(sessionId).queue, [])
})

test('Q10: producer scrubs known secrets before storage and late secrets before full-byte dispatch', { timeout: 60_000 }, async (t) => {
  const { f, sessionId, release } = await held(t)
  const known = `known-${randomUUID()}`, late = `late-${randomUUID()}`, tail = 'PRIVATE-QUEUE-TAIL'
  await f.scrubber.register('secret://fixture/known', known)
  const text = `${known} ${'x'.repeat(INPUT_INLINE_BYTES)} ${late} ${tail}`
  await f.agents().queue(sessionId, text, true, 'private')
  const queue = queues(f, sessionId)[0]!
  const item = queue.data.items[0]!
  if (item.kind !== 'artifact') throw new Error('expected artifact')
  const bytes = await f.agents().inputArtifacts.read(sessionId, item.artifact)
  assert.equal(Buffer.from(bytes).toString('utf8').includes(known), false)
  assert.equal(Buffer.from(bytes).toString('utf8').includes(tail), true, 'full bytes stay available privately')
  await f.scrubber.register('secret://fixture/late', late)
  assert.equal(JSON.stringify(f.agents().progressV2(sessionId)).includes(tail), false)
  assert.equal(JSON.stringify(events(f, sessionId)).includes(tail), false)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type = 'agent.queue' AND search_text IS NOT NULL").get()!.n, 0)
  release()
  await f.agents().wait(sessionId)
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1]!.includes(tail), true)
  assert.equal(f.requests[1]!.includes(known), false)
  assert.equal(f.requests[1]!.includes(late), false)
})

test('Q22: an unchanged large HTTP POST is accepted; legacy progress refuses while progress2 and stop/result work', { timeout: 60_000 }, async (t) => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  let reads = 0
  const { f, sessionId, release } = await held(t, { beforeRead: () => { reads += 1 } })
  const app = nativeAgentRoutes(() => f.agents() as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
  const text = big('HTTP-QUEUE-TAIL')
  const response = await app.request(`/${sessionId}/queue`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  }, peer)
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { ok: true })
  for (const query of ['', '?progressVersion=1']) {
    const legacy = await app.request(`/${sessionId}${query}`, undefined, peer)
    assert.equal(legacy.status, 406)
    assert.deepEqual(nativeProgressVersionUnsupportedSchema.parse(await legacy.json()), { code: 'native_progress_version_unsupported', supported: 1, required: 2 })
  }
  const progress = await app.request(`/${sessionId}?progressVersion=2`, undefined, peer)
  assert.equal(progress.status, 200)
  const body = agentProgressV2Schema.parse(await progress.json())
  assert.equal(body.queue.length, 1)
  const item = body.queue[0]!
  if (item.kind !== 'artifact') throw new Error('expected artifact')
  assert.equal(item.artifact.checksum, sha(text))
  assert.equal(item.artifact.byteSize, Buffer.byteLength(text))
  assert.equal(JSON.stringify(body).includes('HTTP-QUEUE-TAIL'), false)
  assert.equal(reads, 0, 'progress never opens the accepted input')
  const stop = await app.request(`/${sessionId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, peer)
  assert.equal(stop.status, 200)
  release()
  await f.agents().wait(sessionId)
  const result = await app.request(`/${sessionId}/result`, undefined, peer)
  assert.equal(result.status, 200)
  const record = await result.json() as { version: number; status: string }
  assert.equal(record.version, 1)
  assert.equal(record.status, 'cancelled')
  assert.equal(f.requests.length, 1)
  assert.equal(queues(f, sessionId).length, 1, 'no mutation replay')
})
