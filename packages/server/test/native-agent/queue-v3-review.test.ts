/**
 * K4 queue v3, round Q1, independent-review fixes: pinned owner/fence rechecks,
 * restart during preparation, the agent queue tool and duplicate-id order under
 * the restriction, late-secret expansion of a stored inline item, preview
 * scrubbing, retention touch, BOM fidelity, strict query parsing and the
 * side-chat paths. Same conventions as `queue-v3-reader.test.ts`.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { INPUT_INLINE_BYTES, nativeQueueProducerUnavailableSchema, agentProgressV2Schema } from '@guanxi/contract'
import { NativeAgentError } from '../../src/native-agent/service.ts'
import { queueV2Of } from '../../src/native-agent/queue-state.ts'
import { RunStore } from '../../src/runs/store.ts'
import {
  big, build, deferred, events, peer, prompts, seedV3, started, tick, type Fixture,
} from './queue-v3-support.ts'

const routes = async (f: Fixture) => {
  const { nativeAgentRoutes } = await import('../../src/native-agent/routes.ts')
  return nativeAgentRoutes(() => f.agents() as unknown as import('../../src/native-agent/plugin.ts').NativeAgentService)
}
const typed = (code: string) => (e: unknown) => e instanceof NativeAgentError && e.code === code

/* ── M3: owner and fence rechecks are pinned at every await ─────────────────────────────────── */

type Hold = 'read' | 'replay'
type Action = 'stop' | 'leave' | 'fence'

async function heldPreparation(t: Parameters<typeof build>[0], hold: Hold, action: Action) {
  const gate = deferred(), reached = deferred()
  let armed = false, reads = 0
  // The seed prompt is stored as an artifact, so replay of history performs its own (second) read.
  const f = await build(t, undefined, { beforeRead: async () => {
    if (!armed) return
    reads += 1
    if (reads === 1) { reached.resolve(); await gate.promise }
  } })
  const sessionId = await started(f, { prompt: big('HISTORY'), ...(action === 'leave' ? { retention: 'session' } : {}) })
  await seedV3(f, sessionId, [hold === 'read' ? { id: 'queue-a', text: big('ITEM') } : { id: 'queue-a', text: 'small queued item' }])
  const requestsBefore = f.requests.length
  await f.agents().prompt(sessionId, 'continue')
  armed = true
  await reached.promise
  let successor: RunStore | undefined
  try {
    if (action === 'stop') f.agents().stop(sessionId)
    if (action === 'leave') f.agents().leaveSession(sessionId)
    if (action === 'fence') {
      f.runs.close()
      successor = new RunStore({ db: f.db, log: f.log, scrubber: f.scrubber })
      successor.heartbeat(); successor.reconcile()
    }
    const head = f.log.session(sessionId)!.lastSeq
    const readsAtHold = reads
    gate.resolve()
    const result = await f.agents().wait(sessionId).catch(() => null)
    await tick()
    return { f, sessionId, requestsBefore, head, result, readsAtHold, reads: () => reads }
  } finally { successor?.close() }
}

for (const hold of ['read', 'replay'] as const) {
  for (const action of ['stop', 'leave', 'fence'] as const) {
    test(`M3: ${action} during a held ${hold} dispatches nothing, appends no prompt marker and keeps the item pending`, { timeout: 60_000 }, async (t) => {
      const run = await heldPreparation(t, hold, action)
      const { f, sessionId } = run
      // 'continue' reached the provider once; the queued item never did.
      assert.equal(f.requests.length, run.requestsBefore + 1)
      assert.equal(prompts(events(f, sessionId)).some((e) => e.data.messageId === 'queue-a'), false, 'no prompt marker')
      // A fenced home owns no run store any more, so only the log is read after it.
      if (action === 'fence') assert.equal(f.log.session(sessionId)!.lastSeq, run.head, 'the deposed owner committed nothing')
      else assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a'])
      if (action === 'stop') assert.equal(run.result?.status, 'cancelled')
      if (action === 'leave') assert.equal(run.result?.status, 'failed')
      // Nothing after a held read may start the replay that reads history.
      if (hold === 'read') assert.equal(run.reads(), 1, 'the replay never started after the lost owner was seen')
    })
  }
}

/* ── M4: a restart during preparation ───────────────────────────────────────────────────────── */

test('M4: a restart during a held read changes nothing afterwards, keeps the item pending and consumes it exactly once later', { timeout: 60_000 }, async (t) => {
  const gate = deferred(), reached = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; armed = false; reached.resolve(); await gate.promise } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('M4') }])
  await f.agents().prompt(sessionId, 'continue')
  armed = true
  await reached.promise
  const requestsBefore = f.requests.length
  await f.restart(undefined, true)
  const head = f.log.session(sessionId)!.lastSeq
  gate.resolve()
  await tick(); await tick()
  assert.equal(f.log.session(sessionId)!.lastSeq, head, 'the released read of the old process committed nothing')
  assert.equal(f.requests.length, requestsBefore, 'no inference after the restart')
  assert.deepEqual(f.agents().progressV2(sessionId).queue.map((item) => item.id), ['queue-a'])
  assert.equal(prompts(events(f, sessionId)).some((e) => e.data.messageId === 'queue-a'), false)

  await f.agents().prompt(sessionId, 'continue again')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, requestsBefore + 2, 'the explicit turn and the item, once')
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'queue-a').length, 1)
})

/* ── M5: the agent tool, duplicate order, preview scrubbing ─────────────────────────────────── */

test('M5: the agent queue tool under the restriction is a tool error with the typed code and writes nothing', { timeout: 60_000 }, async (t) => {
  const f = await build(t, async (call) => call === 2
    ? [{ type: 'toolCall', id: 'queue-tool', name: 'queue', arguments: { text: 'agent adds work' } }]
    : [{ type: 'text', text: `answer ${call}` }])
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: 'pending inline' }])
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed', 'a refused tool call does not fail the turn')
  const all = events(f, sessionId)
  const result = all.find((e) => e.type === 'tool.result' && e.data.toolCallId === 'queue-tool')
  assert.equal(result?.type === 'tool.result' ? result.data.status : null, 'error')
  assert.equal(result?.type === 'tool.result' ? result.data.error : null, 'native_queue_producer_unavailable')
  assert.equal(all.filter((e) => e.type === 'agent.queue').length, 1, 'only the seeded snapshot exists')
})

test('M5: the restriction is decided before the duplicate-id check, so a reused operation id is refused, never reported duplicate', { timeout: 60_000 }, async (t) => {
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  const operation = randomUUID()
  await seedV3(f, sessionId, [{ id: operation, text: 'already pending under this id' }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()
  await assert.rejects(f.agents().queue(sessionId, 'same operation again', true, operation), typed('native_queue_producer_unavailable'))
  f.agents().stop(sessionId)
  hold.resolve()
  await f.agents().wait(sessionId)
})

test('M5: a legacy preview is cut from the complete current-registry-scrubbed text, so a late secret straddling the cut leaves no prefix', { timeout: 60_000 }, async (t) => {
  const secret = `late-${randomBytes(12).toString('hex')}`
  const hold = deferred()
  const f = await build(t, async (call) => { if (call === 1) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const { sessionId } = await f.agents().create(f.input)
  while (f.requests.length === 0) await tick()
  // The secret begins 10 bytes before the 8 KiB excerpt cut.
  await f.agents().queue(sessionId, `${'a'.repeat(8192 - 10)}${secret}${'b'.repeat(INPUT_INLINE_BYTES)}`)
  await f.scrubber.register('secret://fixture/straddle', secret)
  const item = f.agents().progressV2(sessionId).queue[0]!
  assert.equal(item.kind, 'legacy-preview')
  if (item.kind !== 'legacy-preview') throw new Error('unreachable')
  assert.equal(item.excerpt, 'a'.repeat(8192 - 10), 'the whole marker is dropped at the cut, and no secret prefix remains')
  assert.equal(item.excerpt.includes(secret.slice(0, 5)), false)
  assert.equal(item.excerptBytes, Buffer.byteLength(item.excerpt))
  hold.resolve()
  await f.agents().wait(sessionId)
})

test('M5: queueV2Of cuts the preview from the complete scrubbed text, never from the raw text', () => {
  const secret = `late-${randomBytes(12).toString('hex')}`
  const raw = `${'a'.repeat(8192 - 10)}${secret}${'b'.repeat(INPUT_INLINE_BYTES)}`
  const scrub = (text: string) => text.split(secret).join('⟦REDACTED secret://fixture/straddle⟧')
  const [item] = queueV2Of([{ id: 'legacy', kind: 'inline', text: raw }], scrub)
  assert.equal(item?.kind, 'legacy-preview')
  if (item?.kind !== 'legacy-preview') throw new Error('unreachable')
  assert.equal(item.excerpt, 'a'.repeat(8192 - 10), 'the unclosed marker is dropped whole at the cut')
  assert.equal(item.excerpt.includes(secret.slice(0, 5)), false)
  assert.equal(item.byteSize, Buffer.byteLength(scrub(raw)), 'the size is that of the complete scrubbed text')
})

/* ── M2: late secret expansion of a stored v3 inline item ───────────────────────────────────── */

test('M2: a late secret that expands a stored v3 inline item fails closed with a typed content-free error everywhere, and dispatches nothing', { timeout: 60_000 }, async (t) => {
  const secret = `late-${randomBytes(12).toString('hex')}`
  const gate = deferred()
  const f = await build(t, async (call) => { if (call === 2) await gate.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  const body = `${secret} `.repeat(Math.floor(INPUT_INLINE_BYTES / (secret.length + 1)))
  assert.ok(Buffer.byteLength(body) <= INPUT_INLINE_BYTES)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: body }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()
  await f.scrubber.register('secret://fixture/expand', secret)
  const requestsBefore = f.requests.length

  // The running turn is unaffected by a refused mutation read.
  await assert.rejects(f.agents().removeQueued(sessionId, 'queue-a'), typed('stored_data_invalid'))
  gate.resolve()
  await assert.rejects(f.agents().wait(sessionId), typed('stored_data_invalid'))
  assert.equal(f.requests.length, requestsBefore, 'the stored item was never dispatched')

  for (const read of [() => f.agents().progress(sessionId), () => f.agents().progressV2(sessionId), () => f.agents().result(sessionId)]) {
    assert.throws(read, typed('stored_data_invalid'))
  }
  await assert.rejects(f.agents().prompt(sessionId, 'another turn'), typed('stored_data_invalid'))
  assert.equal(f.requests.length, requestsBefore)
  const route = await routes(f)
  const response = await route.request(`/${sessionId}?progressVersion=2`, undefined, peer)
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { code: 'stored_data_invalid' })

  // The stored payload is preserved, the item never got a prompt marker, and the failure is on its own attempt.
  const raw = f.db.prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'agent.queue'").all(sessionId) as { payload: string }[]
  assert.equal(raw.length, 1)
  assert.equal(raw[0]!.payload.includes(secret), true, 'stored input untouched')
  const errors = f.db.prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'error'").all(sessionId) as { payload: string }[]
  assert.equal(errors.length, 1)
  assert.deepEqual(JSON.parse(errors[0]!.payload), { code: 'stored_data_invalid', message: 'Stored session data is unreadable' })
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE session_id = ? AND type = 'prompt' AND payload LIKE '%queue-a%'").get(sessionId)!.n, 0)
})

/* ── L1 / L2 / L8 ────────────────────────────────────────────────────────────────────────── */

test('L1: a refused add does not extend retention while an accepted add does', { timeout: 60_000 }, async (t) => {
  const gate = deferred()
  const f = await build(t, async (call) => { if (call === 1 || call === 3) await gate.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const activity = (id: string) => (f.db.prepare('SELECT t.last_user_activity_at AS at FROM threads t JOIN native_sessions n ON n.thread_id = t.id WHERE n.session_id = ?').get(id) as { at: string | null }).at
  const open = (await f.agents().create(f.input)).sessionId // call 1, held
  while (f.requests.length < 1) await tick()
  const beforeAccepted = activity(open)
  await new Promise((resolve) => setTimeout(resolve, 15))
  await f.agents().queue(open, 'accepted')
  assert.notEqual(activity(open), beforeAccepted, 'control: an accepted add records user activity')

  const restricted = await started(f) // call 2
  await seedV3(f, restricted, [{ id: 'queue-a', text: 'pending' }])
  await f.agents().prompt(restricted, 'continue') // call 3, held
  while (f.requests.length < 3) await tick()
  const before = activity(restricted)
  await new Promise((resolve) => setTimeout(resolve, 15))
  await assert.rejects(f.agents().queue(restricted, 'refused'), typed('native_queue_producer_unavailable'))
  assert.equal(activity(restricted), before, 'a refused add leaves retention alone')
  gate.resolve()
  await f.agents().wait(open); await f.agents().wait(restricted)
})

test('L2/L8: side-chat Send onto a restricted queue is the typed 409; Save during preparation goes through its FIFO', { timeout: 60_000 }, async (t) => {
  const reading = deferred(), gate = deferred()
  let armed = false
  const f = await build(t, undefined, { beforeRead: async () => { if (!armed) return; armed = false; reading.resolve(); await gate.promise } })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: big('L8') }])
  const route = await routes(f)
  const post = (path: string, body: unknown) => route.request(`/${sessionId}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, peer)

  // While idle nothing runs, so Send would start a turn; hold a turn first to exercise the queue path.
  armed = true
  await f.agents().prompt(sessionId, 'continue')
  await reading.promise // the queued item's read is held: the session is preparing

  const operationId = randomUUID()
  const viaFifo: string[] = []
  const append = f.runs.append.bind(f.runs)
  f.runs.append = ((attempt, event, options) => { viaFifo.push(event.type); return append(attempt, event, options) }) as typeof f.runs.append
  const saved = await post('/side-chat/save', { operationId, messages: [{ role: 'user', text: 'kept note' }] })
  assert.equal(saved.status, 200, 'Save does not fail the preparing turn')
  assert.equal((await post('/side-chat/save', { operationId, messages: [{ role: 'user', text: 'kept note' }] })).status, 200)
  assert.equal(viaFifo.filter((type) => type === 'agent.note').length, 2, 'both Save calls (the second an idempotent repeat) went through the preparing attempt FIFO')
  gate.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const notes = events(f, sessionId).filter((e) => e.type === 'agent.note')
  assert.equal(notes.length, 1, 'exactly one note, once')
  assert.equal(prompts(events(f, sessionId)).filter((e) => e.data.messageId === 'queue-a').length, 1, 'the preparing turn still consumed its item')

  // Restricted again: a pending v3 item under a held turn.
  const hold = deferred()
  const g = await build(t, async (call) => { if (call === 2) await hold.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const other = await started(g)
  await seedV3(g, other, [{ id: 'queue-b', text: 'pending' }])
  await g.agents().prompt(other, 'continue')
  while (g.requests.length < 2) await tick()
  const groute = await routes(g)
  const send = await groute.request(`/${other}/side-chat/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID(), text: 'send me' }) }, peer)
  assert.equal(send.status, 409)
  assert.deepEqual(nativeQueueProducerUnavailableSchema.parse(await send.json()), { code: 'native_queue_producer_unavailable' })
  g.agents().stop(other)
  hold.resolve()
  await g.agents().wait(other)
})

/* ── L3 / L4 / L5 ────────────────────────────────────────────────────────────────────────── */

test('L3: a leading byte order mark is part of the run text, equal to the verified bytes', { timeout: 60_000 }, async (t) => {
  const f = await build(t)
  const sessionId = await started(f)
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(big('BOM-TAIL'))])
  await seedV3(f, sessionId, [{ id: 'queue-a', bytes }])
  const before = f.requests.length
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const request = f.requests[before + 1]!
  assert.equal(request.includes(`﻿${'a'.repeat(64)}`), true, 'the BOM survives into the request')
  assert.equal(request.includes('BOM-TAIL'), true)
  const consumed = prompts(events(f, sessionId)).find((e) => e.data.messageId === 'queue-a')
  assert.equal(consumed?.version === 2 && consumed.data.artifact.checksum, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, 'the durable prompt hashes exactly the verified bytes')
})

test('L4: progressVersion accepts only the exact strings 1 and 2 and no repeated key', { timeout: 60_000 }, async (t) => {
  const f = await build(t)
  const sessionId = await started(f)
  const route = await routes(f)
  const status = async (query: string) => (await route.request(`/${sessionId}${query}`, undefined, peer)).status
  for (const ok of ['', '?progressVersion=1', '?progressVersion=2']) assert.equal(await status(ok), 200, ok)
  for (const bad of ['?progressVersion=02', '?progressVersion=%202', '?progressVersion=2.0', '?progressVersion=0x2', '?progressVersion=', '?progressVersion=1&progressVersion=2', '?progressVersion=2&progressVersion=2', '?progressVersion=true']) {
    assert.equal(await status(bad), 400, bad)
  }
  assert.equal(agentProgressV2Schema.parse(await (await route.request(`/${sessionId}?progressVersion=2`, undefined, peer)).json()).version, 2)
})

test('L5: a failed read inside removeQueued is returned, not thrown into the turn FIFO, so the running turn survives', { timeout: 60_000 }, async (t) => {
  const secret = `late-${randomBytes(12).toString('hex')}`
  const gate = deferred()
  // A v3 inline item that a late secret expands past the bound makes every log read refuse.
  const f = await build(t, async (call) => { if (call === 2) await gate.promise; return [{ type: 'text', text: `answer ${call}` }] })
  const sessionId = await started(f)
  await seedV3(f, sessionId, [{ id: 'queue-a', text: `${secret} `.repeat(Math.floor(INPUT_INLINE_BYTES / (secret.length + 1))) }])
  await f.agents().prompt(sessionId, 'continue')
  while (f.requests.length < 2) await tick()
  await f.scrubber.register('secret://fixture/l5', secret)
  await assert.rejects(f.agents().removeQueued(sessionId, 'queue-a'), typed('stored_data_invalid'))
  await assert.rejects(f.agents().queue(sessionId, 'x'), typed('stored_data_invalid'))
  // The FIFO was not latched: the continue turn still completes normally (its own terminal is completed).
  gate.resolve()
  await f.agents().wait(sessionId).catch(() => undefined)
  // Plain SQL: every log read refuses while the stored snapshot cannot be projected.
  const done = (f.db.prepare("SELECT payload FROM session_events WHERE session_id = ? AND type = 'turn.done' ORDER BY seq").all(sessionId) as { payload: string }[]).map((row) => JSON.parse(row.payload) as { outcome: string })
  assert.equal(done[1]!.outcome, 'completed')
})
