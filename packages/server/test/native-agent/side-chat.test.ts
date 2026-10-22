import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  parseSideChatSavedNote, promptTextOf, sideChatRespondResponseSchema, sideChatSaveResponseSchema, sideChatSendResponseSchema,
} from '@guanxi/contract'
import { fixture } from './fixture.ts'
import { nativeAgentRoutes } from '../../src/native-agent/routes.ts'
import { renderSessionContext, sideChatMessageId } from '../../src/native-agent/side-chat.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>
const peer = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const held = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release: () => release() } }
const uuid = () => crypto.randomUUID()
const post = (f: Fixture, id: string, kind: 'respond' | 'save' | 'send', body: unknown, init: RequestInit = {}) =>
  nativeAgentRoutes(() => f.agents() as never).request(`/${id}/side-chat/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...init }, peer)
const respond = (f: Fixture, id: string, messages: { role: 'user' | 'assistant'; text: string }[], context: unknown = { include: 'session' }, init: RequestInit = {}) =>
  post(f, id, 'respond', { requestId: uuid(), messages, context }, init)

/** Every row of every node-database table, so "nothing was written" is one exact comparison. */
function tableCounts(f: Fixture): Record<string, number> {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  return Object.fromEntries(tables.map(({ name }) => [name, Number((f.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]))
}
async function files(f: Fixture): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (!/\.sqlite(-wal|-shm)?$/u.test(entry.name)) out.push(`${relative(f.data, path)}:${(await stat(path)).size}`)
    }
  }
  await walk(f.data)
  return out.sort()
}
const events = (f: Fixture, id: string) => f.log.readAll(id, 'person')
const notes = (f: Fixture, id: string) => events(f, id).filter(event => event.type === 'agent.note')

test('an unsaved side chat writes nothing: completed, failed and canceled conversations add zero rows and files', { timeout: 30000 }, async t => {
  let side = 0
  const f = await fixture(t, async (call, _context, signal) => {
    if (call === 1) return [{ type: 'thinking', thinking: 'private chain of thought' }, { type: 'text', text: 'main answer ALPHA' }]
    side++
    if (side === 1) return [{ type: 'text', text: 'side answer BETA' }]
    if (side === 2) throw new Error('provider down')
    await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return []
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: `inspect ${f.secret}` })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const before = { rows: tableCounts(f), files: await files(f), head: f.log.session(sessionId)!.lastSeq, requests: f.requests.length }

  const done = await respond(f, sessionId, [{ role: 'user', text: `what did it say? ${f.secret}` }])
  assert.equal(done.status, 200)
  const answer = sideChatRespondResponseSchema.parse(await done.json())
  assert.equal(answer.text, 'side answer BETA')
  assert.deepEqual({ source: answer.context.source, include: answer.context.include, turns: answer.context.turns, upToSeq: answer.context.upToSeq },
    { source: 'session.log', include: 'session', turns: 1, upToSeq: before.head })
  const request = f.requests.at(-1)!
  assert.match(request, /main answer ALPHA/)
  assert.match(request, /what did it say/)
  assert.equal(request.includes('private chain of thought'), false, 'reasoning never reaches a side chat')
  assert.equal(request.includes(f.secret), false, 'registered secrets are scrubbed from the draft and the transcript')
  assert.match(request, /untrusted data/)
  assert.doesNotMatch(request, /"tools"/)

  assert.equal((await respond(f, sessionId, [{ role: 'user', text: 'again' }])).status, 502, 'a provider failure is a content-free error')
  const controller = new AbortController()
  const pending = respond(f, sessionId, [{ role: 'user', text: 'cancel me' }], { include: 'session' }, { signal: controller.signal })
  while (f.requests.length < before.requests + 3) await new Promise(resolve => setTimeout(resolve, 5))
  controller.abort()
  await Promise.resolve(pending).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.deepEqual(tableCounts(f), before.rows, 'no node database table gained a row (events, runs, attempts, jobs, threads, costs)')
  assert.deepEqual(await files(f), before.files, 'no file was created or resized')
  assert.equal(f.log.session(sessionId)!.lastSeq, before.head)
  assert.equal(events(f, sessionId).length, before.head)
  await f.restart()
  assert.equal(f.log.session(sessionId)!.lastSeq, before.head, 'still zero after restart')
})

test('context selection is explicit: none, the whole session or the last turns; oversize is refused with its boundary', { timeout: 60000 }, async t => {
  const f = await fixture(t, async call => call === 1 ? [{ type: 'text', text: 'HUGE'.repeat(200_000) }] : call === 2 ? [{ type: 'text', text: 'small second answer' }] : [{ type: 'text', text: 'ok' }])
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'first turn' })
  await f.agents().wait(sessionId)
  await f.agents().prompt(sessionId, 'second turn')
  await f.agents().wait(sessionId)
  const before = tableCounts(f)

  const refused = await respond(f, sessionId, [{ role: 'user', text: 'q' }])
  assert.equal(refused.status, 413)
  const body = await refused.json() as { code: string; details: { bytes: number; boundBytes: number; windowTokens: number; outputTokens: number; source: string } }
  assert.equal(body.code, 'context_too_large')
  assert.equal(body.details.boundBytes, body.details.windowTokens - body.details.outputTokens)
  assert.ok(body.details.bytes > body.details.boundBytes)
  assert.match(body.details.source, /catalog/)
  const providerCalls = f.requests.length

  assert.equal((await respond(f, sessionId, [{ role: 'user', text: 'q' }], { include: 'none' })).status, 200)
  assert.equal(f.requests.at(-1)!.includes('HUGE'), false)
  assert.equal(f.requests.at(-1)!.includes('second answer'), false)
  assert.equal((await respond(f, sessionId, [{ role: 'user', text: 'q' }], { include: 'session', lastTurns: 1 })).status, 200)
  assert.equal(f.requests.at(-1)!.includes('HUGE'), false)
  assert.match(f.requests.at(-1)!, /second answer/)
  assert.equal(f.requests.length, providerCalls + 2, 'a refused context never reaches the provider')
  assert.deepEqual(tableCounts(f), before)
})

test('rendering reads only prompts and assistant messages and counts bounded excerpts', () => {
  const at = (seq: number, type: string, data: unknown, version = 1) => ({ seq, type, version, class: 'standard', data, createdAt: '2026-10-23T00:00:00.000Z' }) as never
  const log = [
    at(1, 'agent.policy', {}), at(2, 'prompt', { origin: 'typed', messageId: 'a', text: 'one', attachmentCount: 0 }),
    at(3, 'tool.call', { toolCallId: 't', name: 'shell', arguments: { cmd: 'SECRET_TOOL' }, source: 'builtin', parsedFrom: 'native', diffPath: null }),
    at(4, 'tool.result', { toolCallId: 't', status: 'ok', result: 'TOOL_RESULT', error: null, durationMs: 1 }),
    at(5, 'agent.note', { text: 'a saved note' }), at(6, 'assistant.message', { messageId: 'm', step: 0, text: 'two' }),
    at(7, 'prompt', { origin: 'typed', messageId: 'b', attachmentCount: 0, artifact: { excerpt: 'three (excerpt)' } }, 2),
  ]
  const all = renderSessionContext(log, { include: 'session' })
  assert.equal(all.text, '[user]\none\n\n[assistant]\ntwo\n\n[user]\nthree (excerpt)')
  assert.deepEqual({ turns: all.facts.turns, excerpted: all.facts.excerpted, upToSeq: all.facts.upToSeq }, { turns: 2, excerpted: 1, upToSeq: 7 })
  for (const leaked of ['SECRET_TOOL', 'TOOL_RESULT', 'saved note']) assert.equal(all.text.includes(leaked), false, leaked)
  assert.equal(renderSessionContext(log, { include: 'session', lastTurns: 1 }).text, '[user]\nthree (excerpt)')
  assert.equal(renderSessionContext(log, { include: 'none' }).facts.bytes, 0)
  assert.equal(promptTextOf(log[1] as never), 'one')
})

test('Save appends exactly one history-only note, is idempotent, conflicts on changed content and never becomes input', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input)
  await f.agents().wait(sessionId)
  const before = { head: f.log.session(sessionId)!.lastSeq, prompts: events(f, sessionId).filter(e => e.type === 'prompt').length, queue: f.agents().progress(sessionId).queue.length, requests: f.requests.length }
  const operationId = uuid()
  const messages = [{ role: 'user' as const, text: 'What changed? NOTE_USER' }, { role: 'assistant' as const, text: 'Nothing. NOTE_ASSISTANT' }]

  const first = await post(f, sessionId, 'save', { operationId, messages })
  assert.equal(first.status, 200)
  const saved = sideChatSaveResponseSchema.parse(await first.json())
  assert.equal(saved.duplicate, false)
  const added = events(f, sessionId).slice(before.head)
  assert.deepEqual(added.filter(e => e.type !== 'writer.acquired').map(e => e.type), ['agent.note'], 'exactly one session-log event besides the writer handover bookkeeping')
  assert.ok(added.filter(e => e.type === 'writer.acquired').length <= 1)
  const note = notes(f, sessionId)[0]!
  assert.equal(note.type === 'agent.note' && note.id, saved.eventId)
  assert.deepEqual(note.type === 'agent.note' && parseSideChatSavedNote(note.data.text), { sideChat: 'saved', operationId, messages })

  // Lost response: the same operation returns the original receipt and appends nothing.
  const afterFirst = f.log.session(sessionId)!.lastSeq
  const retry = sideChatSaveResponseSchema.parse(await (await post(f, sessionId, 'save', { operationId, messages })).json())
  assert.deepEqual({ ...retry, duplicate: false }, { ...saved, duplicate: false })
  assert.equal(retry.duplicate, true)
  assert.equal(f.log.session(sessionId)!.lastSeq, afterFirst)
  assert.equal(notes(f, sessionId).length, 1)
  // The same operation with different content is a conflict, not a second event.
  const conflict = await post(f, sessionId, 'save', { operationId, messages: [{ role: 'user', text: 'different' }] })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json() as { code: string }).code, 'operation_conflict')
  assert.equal(f.log.session(sessionId)!.lastSeq, afterFirst)
  // A distinct operation is a distinct explicit action.
  assert.equal((await post(f, sessionId, 'save', { operationId: uuid(), messages })).status, 200)
  assert.equal(notes(f, sessionId).length, 2)

  // Saving is not input: no prompt, no queue item, no model call; the agent never replays it.
  assert.equal(events(f, sessionId).filter(e => e.type === 'prompt').length, before.prompts)
  assert.equal(f.agents().progress(sessionId).queue.length, before.queue)
  assert.equal(f.requests.length, before.requests)
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed', 'the writer handover after a save does not block the next turn')
  assert.equal(f.requests.at(-1)!.includes('NOTE_USER'), false)
  assert.equal(f.requests.at(-1)!.includes('NOTE_ASSISTANT'), false)
  await f.restart()
  assert.equal(notes(f, sessionId).length, 2)
})

test('Save during a running turn goes through its FIFO without disturbing the turn, and a failed save cannot abort it', { timeout: 30000 }, async t => {
  const block = held()
  const f = await fixture(t, async call => { if (call === 1) await block.promise; return [{ type: 'text', text: `answer ${call}` }] })
  t.after(block.release)
  const { sessionId } = await f.agents().create(f.input)
  const operationId = uuid()
  const messages = [{ role: 'user' as const, text: 'during the run' }]
  assert.equal((await post(f, sessionId, 'save', { operationId, messages })).status, 200)
  assert.equal((await post(f, sessionId, 'save', { operationId, messages })).status, 200)
  const conflict = await post(f, sessionId, 'save', { operationId, messages: [{ role: 'user', text: 'changed' }] })
  assert.equal(conflict.status, 409, 'an idempotency conflict is reported, not thrown into the turn')
  block.release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(notes(f, sessionId).length, 1)
  const seqs = events(f, sessionId).map(e => e.seq)
  assert.deepEqual(seqs, seqs.map((_, index) => index + 1), 'the log stayed gap-free')
})

test('Send posts exactly once to an idle session; a retry or a lost response never posts again', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'first' })
  await f.agents().wait(sessionId)
  const operationId = uuid()
  const messageId = sideChatMessageId(operationId)
  assert.match(messageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(messageId, sideChatMessageId(operationId), 'stable per operation')
  assert.notEqual(messageId, sideChatMessageId(uuid()))
  const before = { requests: f.requests.length, notes: notes(f, sessionId).length }

  const sent = sideChatSendResponseSchema.parse(await (await post(f, sessionId, 'send', { operationId, text: 'Please also run the linter.' })).json())
  assert.deepEqual({ delivery: sent.delivery, duplicate: sent.duplicate, messageId: sent.messageId }, { delivery: 'started', duplicate: false, messageId })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const prompts = events(f, sessionId).filter(e => e.type === 'prompt' && e.data.messageId === messageId)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]!.type === 'prompt' && promptTextOf(prompts[0]!), 'Please also run the linter.')
  assert.equal(f.requests.length, before.requests + 1, 'one main-agent turn ran')

  const retry = sideChatSendResponseSchema.parse(await (await post(f, sessionId, 'send', { operationId, text: 'Please also run the linter.' })).json())
  assert.deepEqual({ delivery: retry.delivery, duplicate: retry.duplicate }, { delivery: 'already_sent', duplicate: true })
  assert.equal(events(f, sessionId).filter(e => e.type === 'prompt' && e.data.messageId === messageId).length, 1)
  assert.equal(f.requests.length, before.requests + 1)
  assert.equal(notes(f, sessionId).length, before.notes, 'Send does not also Save')
  await f.restart()
  const afterRestart = sideChatSendResponseSchema.parse(await (await post(f, sessionId, 'send', { operationId, text: 'Please also run the linter.' })).json())
  assert.equal(afterRestart.duplicate, true, 'the durable log, not process memory, is the receipt')
})

test('Send to a running session queues exactly once under concurrent retries and the queued prompt runs once', { timeout: 30000 }, async t => {
  const block = held()
  const f = await fixture(t, async call => { if (call === 1) await block.promise; return [{ type: 'text', text: `answer ${call}` }] })
  t.after(block.release)
  const { sessionId } = await f.agents().create(f.input)
  const operationId = uuid()
  const body = { operationId, text: 'queued from side chat' }
  const answers = await Promise.all([post(f, sessionId, 'send', body), post(f, sessionId, 'send', body), post(f, sessionId, 'send', body)])
  assert.deepEqual(answers.map(response => response.status), [202, 202, 202])
  const parsed = await Promise.all(answers.map(async response => sideChatSendResponseSchema.parse(await response.json())))
  assert.equal(parsed.filter(item => item.delivery === 'queued').length, 1)
  assert.equal(parsed.filter(item => item.delivery === 'already_sent').length, 2)
  assert.deepEqual(f.agents().progress(sessionId).queue.map(item => item.text), ['queued from side chat'])
  assert.equal(notes(f, sessionId).length, 0)
  block.release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const messageId = sideChatMessageId(operationId)
  assert.equal(events(f, sessionId).filter(e => e.type === 'prompt' && e.data.messageId === messageId).length, 1)
  assert.equal(f.requests.length, 2, 'the queued message produced exactly one more turn')
  assert.equal(f.agents().progress(sessionId).queue.length, 0)
  const retry = sideChatSendResponseSchema.parse(await (await post(f, sessionId, 'send', body)).json())
  assert.equal(retry.delivery, 'already_sent')
  assert.equal(f.requests.length, 2)
})

test('concurrent Send to an idle session starts one turn; the loser is told to retry or already-sent, never a second prompt', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create(f.input)
  await f.agents().wait(sessionId)
  const operationId = uuid()
  const results = await Promise.all([1, 2, 3].map(() => post(f, sessionId, 'send', { operationId, text: 'once' })))
  const statuses = await Promise.all(results.map(async response => ({ status: response.status, body: await response.json() as { delivery?: string; code?: string } })))
  assert.equal(statuses.filter(item => item.status === 202 && item.body.delivery === 'started').length, 1)
  for (const item of statuses) assert.ok((item.status === 202 && ['started', 'already_sent'].includes(item.body.delivery!)) || (item.status === 409 && item.body.code === 'session_busy'), JSON.stringify(item))
  await f.agents().wait(sessionId)
  assert.equal(events(f, sessionId).filter(e => e.type === 'prompt' && e.data.messageId === sideChatMessageId(operationId)).length, 1)
})

test('refusals are explicit: validation, unknown or unavailable session, unready scrubber and non-loopback peers', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const { sessionId } = await f.agents().create({ ...f.input, retention: 'session' })
  await f.agents().wait(sessionId)
  const before = tableCounts(f)
  const code = async (response: Response) => ({ status: response.status, code: (await response.json() as { code: string }).code })
  assert.deepEqual(await code(await post(f, sessionId, 'respond', '{broken')), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await post(f, sessionId, 'respond', { requestId: uuid(), messages: [{ role: 'assistant', text: 'x' }], context: { include: 'none' } })), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await post(f, sessionId, 'respond', { requestId: uuid(), messages: [{ role: 'user', text: '  ' }], context: { include: 'none' } })), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await post(f, sessionId, 'respond', { requestId: uuid(), messages: [{ role: 'user', text: 'x' }], context: { include: 'session', lastTurns: 0 } })), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await post(f, sessionId, 'save', { operationId: 'not-a-uuid', messages: [{ role: 'user', text: 'x' }] })), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await post(f, sessionId, 'send', { operationId: uuid(), text: ' ', extra: true })), { status: 400, code: 'validation_failed' })
  assert.deepEqual(await code(await respond(f, 'missing-session', [{ role: 'user', text: 'x' }])), { status: 404, code: 'session_not_found' })
  const app = nativeAgentRoutes(() => f.agents() as never)
  assert.equal((await app.request(`/${sessionId}/side-chat/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, { incoming: { socket: { remoteAddress: '10.0.0.8' } } })).status, 403)
  assert.equal((await app.request(`/${sessionId}/side-chat/respond`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, peer)).status, 415)
  const providerCalls = f.requests.length
  f.scrubber.expect('unready')
  assert.deepEqual(await code(await respond(f, sessionId, [{ role: 'user', text: 'x' }])), { status: 503, code: 'egress_unavailable' })
  assert.deepEqual(await code(await post(f, sessionId, 'save', { operationId: uuid(), messages: [{ role: 'user', text: 'x' }] })), { status: 503, code: 'egress_unavailable' })
  f.scrubber.ready('unready')
  f.agents().leaveSession(sessionId)
  assert.deepEqual(await code(await respond(f, sessionId, [{ role: 'user', text: 'x' }])), { status: 409, code: 'session_unavailable' })
  assert.deepEqual(await code(await post(f, sessionId, 'send', { operationId: uuid(), text: 'x' })), { status: 409, code: 'session_unavailable' })
  assert.equal(f.requests.length, providerCalls, 'no refusal reached the provider')
  assert.equal(tableCounts(f).session_events, before.session_events, 'no refusal wrote an event')
})
