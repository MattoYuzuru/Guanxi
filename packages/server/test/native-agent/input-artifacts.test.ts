/**
 * Native input-artifact producer and replay (K4 bounded slice). Uses the fake
 * provider and an injected command runner: no sandbox, model, container or
 * network is started.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { INPUT_EXCERPT_BYTES, INPUT_INLINE_BYTES, type SessionEvent } from '@guanxi/contract'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { nativeTools } from '../../src/native-agent/tools.ts'
import { NativeTraceError } from '../../src/native-agent/append-queue.ts'
import { SessionInputError, SessionInputStore, utf8Excerpt } from '../../src/session-log/input-artifacts.ts'
import type { SessionHandle, SessionLog } from '../../src/session-log/log.ts'
import type { SandboxPolicy } from '../../src/native-agent/sandbox.ts'
import { fixture } from './fixture.ts'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function promptEvent(events: readonly SessionEvent[], messageId?: string): Extract<SessionEvent, { type: 'prompt' }> {
  const event = events.find((candidate) => candidate.type === 'prompt' && (messageId === undefined || candidate.data.messageId === messageId))
  assert.ok(event, 'expected a prompt event')
  return event as Extract<SessionEvent, { type: 'prompt' }>
}

function promptText(event: Extract<SessionEvent, { type: 'prompt' }>): string {
  return event.version === 1 ? event.data.text : event.data.artifact.excerpt
}

function artifactOf(event: Extract<SessionEvent, { type: 'prompt' }>) {
  return event.version === 2 ? event.data.artifact : null
}

function terminalEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const done = events.findIndex((event) => event.type === 'turn.done')
  return done < 0 ? [] : events.slice(done + 1)
}

const runnerResult = { code: 0, stdout: 'ok', stderr: '', truncated: false } as const

test('artifactizes a typed oversized prompt and replays the full bytes, never the excerpt', { timeout: 30_000 }, async (t) => {
  const tail = `PROMPT-TAIL-${randomBytes(8).toString('hex')}`
  const prompt = `${'p'.repeat(INPUT_INLINE_BYTES)}${tail}`
  const f = await fixture(t, async () => [{ type: 'text', text: 'fixture answer' }])
  const { sessionId } = await f.agents().create({ ...f.input, prompt })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')

  const events = f.log.readAll(sessionId, 'person')
  const event = promptEvent(events)
  assert.equal(event.version, 2)
  const artifact = artifactOf(event)
  assert.ok(artifact)
  assert.equal('text' in event.data, false)
  assert.equal(artifact!.byteSize, Buffer.byteLength(prompt))
  assert.equal(artifact!.excerptBytes, Buffer.byteLength(utf8Excerpt(prompt)))
  assert.ok(artifact!.excerptBytes <= INPUT_EXCERPT_BYTES)
  assert.equal(artifact!.excerpt.includes(tail), false)
  assert.equal(promptText(event).includes(tail), false)
  assert.equal(JSON.stringify(events).includes(tail), false)
  assert.equal((f.db.prepare("SELECT payload FROM session_events WHERE type='prompt'").get() as { payload: string }).payload.includes(tail), false)
  assert.equal(f.log.search(tail, { audience: 'person' }).length, 0)
  assert.equal(f.log.list().sessions.find((session) => session.sessionId === sessionId)?.title?.includes(tail), false)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 1)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0]!.includes(prompt), true, 'the model receives the full prompt')

  await f.restart()
  await f.agents().prompt(sessionId, 'continue')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1]!.includes(prompt), true, 'replay restores the full prompt bytes')
  assert.equal(f.requests[1]!.includes(tail), true)
})

test('artifactizes oversized tool.call arguments after a durable ack and executes the full arguments once', { timeout: 30_000 }, async (t) => {
  const tail = `ARG-TAIL-${randomBytes(8).toString('hex')}`
  const content = `${'a'.repeat(INPUT_INLINE_BYTES)}${tail}`
  let bodies = 0
  const commands: string[] = []
  const runner = async (_policy: SandboxPolicy, command: string) => {
    bodies += 1
    commands.push(command)
    return runnerResult
  }
  const f = await fixture(t, async (call) => call === 1
    ? [{ type: 'toolCall', id: 'big-write', name: 'file_write', arguments: { path: 'big.txt', content } }]
    : [{ type: 'text', text: 'done' }], undefined, undefined, runner)
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'write the big file' })
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(bodies, 1)
  assert.equal(commands.length, 1)
  assert.equal(commands[0]!.includes(tail), true, 'the tool body receives the full arguments')
  assert.equal(commands[0]!.includes(content), true)

  const events = f.log.readAll(sessionId, 'person')
  const call = events.find((event) => event.type === 'tool.call')
  assert.ok(call)
  if (call?.type !== 'tool.call' || call.version !== 2) throw new Error('expected v2 tool.call')
  assert.equal('arguments' in call.data, false)
  assert.equal(call.data.artifact.excerpt.includes(tail), false)
  assert.equal(JSON.stringify(events).includes(tail), false)
  const bytes = await f.agents().inputArtifacts.read(sessionId, call.data.artifact)
  assert.equal(Buffer.from(bytes).toString('utf8'), JSON.stringify({ path: 'big.txt', content }))
  assert.equal(events.filter((event) => event.type === 'tool.result').length, 1)
})

test('holds the actual tool body at zero while the tool.call durable ack is blocked', { timeout: 30_000 }, async (t) => {
  const gate = deferred()
  const started = deferred()
  let bodies = 0
  const runner = async () => { bodies += 1; return runnerResult }
  const f = await fixture(t, async (call) => call === 1
    ? [{ type: 'toolCall', id: 'held-write', name: 'file_write', arguments: { path: 'held.txt', content: `${'h'.repeat(INPUT_INLINE_BYTES)}` } }]
    : [{ type: 'text', text: 'done' }], undefined, undefined, runner, {
    inputArtifacts: (db, dataDir) => new SessionInputStore({
      dataDir,
      db,
      hooks: {
        beforeWrite: async () => {
          started.resolve()
          await gate.promise
        },
      },
    }),
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'hold the tool' })
  await started.promise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bodies, 0, 'the tool body must not run before its durable tool.call commit')
  assert.equal(f.requests.length, 1, 'the next model request also waits')
  gate.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(bodies, 1)
})

test('a rejected tool.call durable ack aborts the turn with zero tool bodies', { timeout: 30_000 }, async (t) => {
  let bodies = 0
  const runner = async () => { bodies += 1; return runnerResult }
  const f = await fixture(t, async (call) => call === 1
    ? [{ type: 'toolCall', id: 'failed-write', name: 'file_write', arguments: { path: 'failed.txt', content: `${'f'.repeat(INPUT_INLINE_BYTES)}` } }]
    : [{ type: 'text', text: 'unreachable' }], undefined, undefined, runner, {
    inputArtifacts: (db, dataDir) => new SessionInputStore({
      dataDir,
      db,
      hooks: {
        beforeWrite: async () => { throw new SessionInputError('storage_failure', 'injected storage failure') },
      },
    }),
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'fail the tool trace' })
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'failed')
  assert.equal(bodies, 0)
  assert.equal(f.requests.length, 1)
  const events = f.log.readAll(sessionId, 'person')
  assert.equal(events.some((event) => event.type === 'tool.call'), false)
  assert.equal(events.some((event) => event.type === 'tool.result'), false)
  const error = events.find((event) => event.type === 'error')
  assert.equal(error?.type === 'error' ? error.data.code : null, 'input_artifact_storage_failed')
  const state = events.filter((event) => event.type === 'agent.state').at(-1)
  assert.equal(state?.type === 'agent.state' ? state.data.status : null, 'failed')
  assert.deepEqual(terminalEvents(events).map((event) => event.type), ['run.lifecycle'])
})

test('an initial prompt write failure dispatches zero model calls and writes one content-free terminal', { timeout: 30_000 }, async (t) => {
  let modelCalls = 0
  let bodies = 0
  const runner = async () => { bodies += 1; return runnerResult }
  const f = await fixture(t, async () => {
    modelCalls += 1
    return [{ type: 'text', text: 'unreachable' }]
  }, undefined, undefined, runner, {
    inputArtifacts: (db, dataDir) => new SessionInputStore({
      dataDir,
      db,
      hooks: { beforeWrite: async () => { throw new SessionInputError('storage_failure', 'injected initial failure') } },
    }),
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: `${'x'.repeat(INPUT_INLINE_BYTES)}initial` })
  const result = await f.agents().wait(sessionId)
  assert.equal(result.status, 'failed')
  assert.equal(modelCalls, 0)
  assert.equal(bodies, 0)
  const events = f.log.readAll(sessionId, 'person')
  assert.equal(events.filter((event) => event.type === 'error').length, 1)
  assert.equal(events.filter((event) => event.type === 'turn.done').length, 1)
  assert.equal(events.some((event) => event.type === 'prompt'), false)
  assert.equal(events.some((event) => event.version === 2), false)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 0)
})

test('stop enqueues the intervention before the terminal pair and no native event follows turn.done', { timeout: 30_000 }, async (t) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(t, async (_call, _context, signal) => {
    await Promise.race([
      held,
      new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    ])
    return [{ type: 'text', text: 'late' }]
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'stop me' })
  while (f.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  f.agents().stop(sessionId)
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'cancelled')
  const events = f.log.readAll(sessionId, 'person')
  const intervention = events.findIndex((event) => event.type === 'intervention')
  const done = events.findIndex((event) => event.type === 'turn.done')
  assert.ok(intervention >= 0)
  assert.ok(done > intervention)
  const state = events.find((event) => event.type === 'agent.state' && event.data.status === 'cancelled')
  assert.ok(state)
  assert.deepEqual(terminalEvents(events).map((event) => event.type), ['run.lifecycle'])
  await f.agents().close()
})

test('stop during an input artifact write leaves no event after the terminal', { timeout: 30_000 }, async (t) => {
  const gate = deferred()
  const started = deferred()
  const f = await fixture(t, async (call) => call === 1
    ? [{ type: 'toolCall', id: 'stop-write', name: 'file_write', arguments: { path: 'stop.txt', content: `${'s'.repeat(INPUT_INLINE_BYTES)}` } }]
    : [{ type: 'text', text: 'unreachable' }], undefined, undefined, async () => runnerResult, {
    inputArtifacts: (db, dataDir) => new SessionInputStore({
      dataDir,
      db,
      hooks: {
        beforeWrite: async () => {
          started.resolve()
          await gate.promise
        },
      },
    }),
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'stop the artifact write' })
  await started.promise
  f.agents().stop(sessionId)
  gate.resolve()
  assert.equal((await f.agents().wait(sessionId)).status, 'cancelled')
  const events = f.log.readAll(sessionId, 'person')
  const done = events.findIndex((event) => event.type === 'turn.done')
  assert.ok(done >= 0)
  assert.deepEqual(events.slice(done + 1).map((event) => event.type), ['run.lifecycle'])
  assert.equal(events.some((event) => event.type === 'tool.call'), false)
  const state = events.filter((event) => event.type === 'agent.state').at(-1)
  assert.equal(state?.type === 'agent.state' ? state.data.status : null, 'cancelled')
})

test('concurrent queue mutations preserve every accepted item exactly once and in FIFO order', { timeout: 30_000 }, async (t) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const f = await fixture(t, async (call) => {
    if (call === 1) await held
    return [{ type: 'text', text: `answer ${call}` }]
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'queue concurrently' })
  while (f.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
  await Promise.all([
    f.agents().queue(sessionId, 'first accepted'),
    f.agents().queue(sessionId, 'second accepted'),
  ])
  const accepted = f.agents().progress(sessionId).queue
  assert.deepEqual(accepted.map((item) => item.text), ['first accepted', 'second accepted'])
  assert.equal(new Set(accepted.map((item) => item.id)).size, 2)
  await Promise.all([
    f.agents().queue(sessionId, 'third accepted'),
    f.agents().removeQueued(sessionId, accepted[0]!.id),
  ])
  const remaining = f.agents().progress(sessionId).queue
  assert.deepEqual(remaining.map((item) => item.text), ['second accepted', 'third accepted'])
  assert.deepEqual(remaining.map((item) => item.id), [accepted[1]!.id, remaining[1]!.id])
  assert.equal(new Set(remaining.map((item) => item.id)).size, 2)
  const queueEvents = f.log.readAll(sessionId, 'person').filter((event) => event.type === 'agent.queue')
  assert.deepEqual(queueEvents.map((event) => event.type === 'agent.queue' ? event.data.items.map((item) => item.text) : null), [
    ['first accepted'],
    ['first accepted', 'second accepted'],
    ['first accepted', 'second accepted', 'third accepted'],
    ['second accepted', 'third accepted'],
  ])
  const last = queueEvents.at(-1)
  assert.equal(last?.type === 'agent.queue' ? JSON.stringify(last.data.items) : null, JSON.stringify(remaining))
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
})

test('keeps queued prompts inline in agent.queue and declares the v2 prompt residual honestly', { timeout: 30_000 }, async (t) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const queuedTail = `QUEUED-TAIL-${randomBytes(8).toString('hex')}`
  const queued = `${'q'.repeat(INPUT_INLINE_BYTES)}${queuedTail}`
  const f = await fixture(t, async (call) => {
    if (call === 1) await held
    return [{ type: 'text', text: `answer ${call}` }]
  })
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'first prompt' })
  await f.agents().queue(sessionId, queued)
  release()
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  const events = f.log.readAll(sessionId, 'person')
  const queue = events.find((event) => event.type === 'agent.queue')
  assert.equal(queue?.type === 'agent.queue' ? queue.data.items[0]?.text : null, queued)
  const prompts = events.filter((event): event is Extract<SessionEvent, { type: 'prompt' }> => event.type === 'prompt')
  assert.equal(prompts.length, 2)
  assert.equal(prompts[0]!.version, 1)
  const consumed = prompts.find((event) => event.data.messageId !== promptEvent(events).data.messageId)
  assert.ok(consumed)
  assert.equal(consumed!.version, 2, 'the consumed prompt event takes v2, but the queue event stays inline')
  assert.equal(JSON.stringify(events).includes(queuedTail), true, 'the queue residual is explicit')
})

test('fails closed on missing, foreign and late-secret input artifacts without partial replay', { timeout: 30_000 }, async (t) => {
  const late = `late-${randomBytes(12).toString('hex')}`
  const prompt = `${late}${'z'.repeat(INPUT_INLINE_BYTES)}`
  const f = await fixture(t, async () => [{ type: 'text', text: 'answer' }])
  const { sessionId } = await f.agents().create({ ...f.input, prompt })
  await f.agents().wait(sessionId)
  const event = promptEvent(f.log.readAll(sessionId, 'person'))
  const artifact = artifactOf(event)
  assert.ok(artifact)
  const path = join(f.agents().inputArtifacts.directoryFor(sessionId), artifact!.checksum.slice(7))

  await f.scrubber.register('secret://fixture/late', late)
  assert.equal(JSON.stringify(f.log.readAll(sessionId, 'person')).includes(late), false)
  assert.equal(f.log.readAll(sessionId, 'person').some((candidate) => JSON.stringify(candidate).includes('REDACTED')), true)
  const before = f.requests.length
  await f.agents().prompt(sessionId, 'continue after redaction')
  assert.equal((await f.agents().wait(sessionId)).status, 'completed')
  assert.equal(f.requests.length, before + 1)
  assert.equal(f.requests.at(-1)!.includes(late), false)
  assert.equal(f.requests.at(-1)!.includes('REDACTED'), true)

  const missing = await fixture(t, async () => [{ type: 'text', text: 'answer' }])
  const created = await missing.agents().create({ ...missing.input, prompt: `${'m'.repeat(INPUT_INLINE_BYTES)}missing` })
  await missing.agents().wait(created.sessionId)
  const missingEvent = promptEvent(missing.log.readAll(created.sessionId, 'person'))
  const missingArtifact = artifactOf(missingEvent)
  assert.ok(missingArtifact)
  const missingPath = join(missing.agents().inputArtifacts.directoryFor(created.sessionId), missingArtifact!.checksum.slice(7))
  await rename(missingPath, `${missingPath}.gone`)
  const dispatched = missing.requests.length
  await assert.rejects(
    missing.agents().prompt(created.sessionId, 'continue without bytes'),
    (error: unknown) => error instanceof Error && error.message === 'input_artifact_unavailable' && !error.message.includes(missingPath),
  )
  assert.equal(missing.requests.length, dispatched)
})

test('deletes input artifacts with the session and leaves no rows or directory behind', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, async () => [{ type: 'text', text: 'answer' }])
  const { sessionId } = await f.agents().create({ ...f.input, prompt: `${'d'.repeat(INPUT_INLINE_BYTES)}delete` })
  await f.agents().wait(sessionId)
  const dir = f.agents().inputArtifacts.directoryFor(sessionId)
  assert.ok(await readdir(dir))
  await f.agents().deleteSession(sessionId)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 0)
  await assert.rejects(readdir(dir), { code: 'ENOENT' })
})

test('reasoning and assistant/state events stay v1 and create no input artifacts', { timeout: 30_000 }, async (t) => {
  const f = await fixture(t, async () => [
    { type: 'thinking', thinking: 'fixture reasoning' },
    { type: 'text', text: 'answer' },
  ])
  const { sessionId } = await f.agents().create({ ...f.input, prompt: 'small prompt' })
  await f.agents().wait(sessionId)
  const events = f.log.readAll(sessionId, 'person')
  assert.equal(events.some((event) => event.version === 2), false)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 0)
  const reasoning = events.find((event) => event.type === 'reasoning')
  assert.ok(reasoning)
  assert.equal(reasoning!.class, 'reasoning')
  const dir = join(f.data, 'session-artifacts')
  assert.deepEqual(await readdir(dir).catch(() => []), [])
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM session_input_artifacts').get() as { n: number }).n, 0)
})

test('the tool wrapper gates the body on the exact toolCallId and aborts on a missing ack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-native-tool-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const policy: SandboxPolicy = {
    mode: 'read-only',
    scratch: root,
    roots: [],
    attachments: [],
    protectedPaths: [],
    domains: [],
  }
  const scrubber = new SecretScrubber()
  let bodies = 0
  const runner = async () => { bodies += 1; return runnerResult }
  const hold = deferred()
  let aborted = false
  const handle = {
    sessionId: 'gate-session',
    epoch: 1,
    closed: false,
    append: () => { throw new Error('unused') },
    close: () => undefined,
  } as unknown as SessionHandle
  const tools = nativeTools({
    policy,
    log: {} as SessionLog,
    handle,
    scrubber,
    executeCommand: runner,
    guard: () => undefined,
    queue: () => undefined,
    awaitToolCall: async () => { await hold.promise },
    abortTurn: () => { aborted = true },
  })
  const write = tools.find((tool) => tool.name === 'file_write')
  assert.ok(write)
  const execution = write!.execute('call-gated', { path: 'gate.txt', content: 'payload' }, new AbortController().signal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bodies, 0)
  hold.reject(new NativeTraceError('input_artifact_storage_failed'))
  const result = await execution
  assert.equal(bodies, 0)
  assert.equal(aborted, true)
  assert.equal(result.isError, true)
  assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : null, 'input_artifact_storage_failed')
})
