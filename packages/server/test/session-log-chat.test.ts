/**
 * K2 exit gate, end to end through the legacy Chat execution owner with a
 * mocked Ollama stream:
 * - a planted secret never appears in session events, the FTS index, the
 *   inspector routes, the SSE stream, the export or the agent query tool;
 * - replay after a restart reproduces the state a live subscriber built, and
 *   the transcript the Chat UI shows (count assertions);
 * - an agent on a remote provider receives 0 reasoning events from the query
 *   tool while a local agent receives them all;
 * - reasoning is never written to plain logs.
 * Every secret here is a generated fake.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  SESSION_QUERY_TOOL_NAME,
  sessionEventSchema,
  sessionQueryToolResultSchema,
  type SessionEvent,
} from '@guanxi/contract'
import { createApp } from '../src/app.ts'
import { createAppContext, type AppContext } from '../src/context.ts'
import { formsOf } from '../src/egress/index.ts'
import { SecretScrubber } from '../src/egress/scrubber.ts'
import type { OllamaClient } from '../src/ollama/client.ts'
import type { OllamaAdapter } from '../src/ollama/plugin.ts'
import type { OllamaChatChunk } from '../src/ollama/types.ts'
import {
  SessionLog,
  audienceForAgent,
  createSessionQueryTool,
  projectSpans,
  projectTokenMeter,
  projectTranscript,
  querySessionLog,
} from '../src/session-log/index.ts'
import { openDb } from '../src/store/db.ts'
import { ToolRegistry } from '../src/tools/registry.ts'

const SECRET = `fake-${randomBytes(16).toString('hex')}`
const REASONING_WORD = 'walrusthought'

function chunk(message: Partial<OllamaChatChunk['message']> & object, done = false): OllamaChatChunk {
  return {
    model: 'fixture',
    created_at: '2026-10-20T10:00:00.000Z',
    message: { role: 'assistant', content: '', ...message },
    done,
    ...(done
      ? {
          done_reason: 'stop',
          prompt_eval_count: 40,
          prompt_eval_duration: 100_000_000,
          eval_count: 12,
          eval_duration: 50_000_000,
          total_duration: 150_000_000,
        }
      : {}),
  }
}

/** Odd calls: reasoning with a split secret, text, then a tool call; even calls: the final answer. */
async function* turnStream(call: number): AsyncGenerator<OllamaChatChunk> {
  if (call % 2 === 1) {
    yield chunk({ thinking: `${REASONING_WORD} plan with ${SECRET.slice(0, 11)}` })
    yield chunk({ thinking: `${SECRET.slice(11)} ok` })
    yield chunk({ content: 'Looking it up' })
    yield chunk({ tool_calls: [{ function: { name: 'lookup', arguments: { query: SECRET } } }] })
    yield chunk({}, true)
    return
  }
  yield chunk({ thinking: `${REASONING_WORD} second pass` })
  yield chunk({ content: `The key is ${SECRET.slice(0, 7)}` })
  yield chunk({ content: `${SECRET.slice(7)}.` })
  yield chunk({}, true)
}

function fakeAdapter(): OllamaAdapter {
  let calls = 0
  const client = {
    host: 'http://127.0.0.1:11434',
    chatStream(_request: unknown, _signal: AbortSignal) {
      calls += 1
      return turnStream(calls)
    },
    show: async () => { throw new Error('offline fixture') },
  } as unknown as OllamaClient
  return { client: () => client }
}

async function fixture(test: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-k2-chat-'))
  const dbPath = join(root, 'guanxi.db')
  const db = openDb(dbPath)
  const scrubber = new SecretScrubber()
  scrubber.register('secret://test/planted', SECRET)
  const sessionLog = new SessionLog({ db, scrubber })
  const context = await createAppContext({
    dbPath,
    db,
    appVersion: 'k2-fixture',
    ollama: fakeAdapter(),
    sessionLog,
  })
  test.after(async () => {
    await context.maintenance?.close()
    await context.chatExecution.shutdown().catch(() => undefined)
    sessionLog.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const app = createApp(context)
  const threadId = context.threads.create({
    title: 'Trace',
    mode: 'chat',
    model: 'fixture',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'high' },
  }).id
  return { app, context, scrubber, sessionLog, dbPath, threadId }
}

async function sendTurn(app: ReturnType<typeof createApp>, threadId: string, content: string): Promise<void> {
  const response = await app.request(`/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  assert.equal(response.status, 200)
  await response.text()
}

async function waitForTerminal(context: AppContext, count: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const done = (context.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('completed','failed','cancelled','interrupted')",
    ).get() as { n: number }).n
    if (done >= count) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`expected ${count} terminal Chat Jobs`)
}

/** Reads SSE frames until `stop` returns true for a parsed event. */
async function collectStream(
  response: Response,
  stop: (event: SessionEvent) => boolean,
): Promise<{ events: SessionEvent[]; raw: string }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let raw = ''
  const events: SessionEvent[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    const text = decoder.decode(next.value, { stream: true })
    raw += text
    buffer += text
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame.split('\n').find((line) => line.startsWith('data: '))
      if (data) {
        const event = sessionEventSchema.parse(JSON.parse(data.slice(6)))
        events.push(event)
        if (stop(event)) {
          await reader.cancel()
          return { events, raw }
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  return { events, raw }
}

function assertNoSecret(text: string, where: string): void {
  for (const form of formsOf(SECRET)) assert.equal(text.includes(form), false, `${where} contains a form of the secret`)
  assert.equal(text.includes(SECRET.slice(5)), false, `${where} contains the secret's random part`)
}

describe('session log through the legacy Chat Job owner', () => {
  it('a planted secret never appears in events, search, routes, stream, export or the query tool', async (test) => {
    const { app, context, threadId, sessionLog } = await fixture(test)
    await sendTurn(app, threadId, `My key is ${SECRET}, keep it`)
    await waitForTerminal(context, 1)

    const raw = JSON.stringify(context.db.prepare('SELECT * FROM session_events').all())
    assert.ok(raw.length > 1_000, 'the trace was written')
    assertNoSecret(raw, 'session_events')
    assert.equal(sessionLog.search(SECRET, { audience: 'person' }).length, 0)
    assert.equal(sessionLog.search(SECRET.slice(5), { audience: 'person' }).length, 0)
    assert.ok(sessionLog.counts(threadId).redactions >= 4, 'prompt, reasoning, tool arguments and answer were redacted')

    const routes = [
      `/api/sessions`,
      `/api/sessions/${threadId}`,
      `/api/sessions/${threadId}/events?after=0&limit=500`,
      `/api/sessions/${threadId}/spans`,
      `/api/sessions/${threadId}/export`,
      `/api/sessions/search?q=${encodeURIComponent('key')}`,
      `/api/sessions/search?q=${encodeURIComponent(SECRET)}`,
    ]
    for (const route of routes) {
      const response = await app.request(route)
      assert.equal(response.status, 200, route)
      assertNoSecret(await response.text(), route)
    }
    const exported = await (await app.request(`/api/sessions/${threadId}/export`)).json() as {
      events: SessionEvent[]
      excluded: { reasoning: number }
    }
    assert.equal(exported.events.filter((event) => event.class === 'reasoning').length, 0, 'exports carry no reasoning')
    assert.equal(exported.excluded.reasoning, 2)

    const stream = await app.request(`/api/sessions/${threadId}/stream?after=0`)
    const streamed = await collectStream(stream, (event) => event.type === 'job.lifecycle' && event.data.state === 'completed')
    assertNoSecret(streamed.raw, 'SSE stream')

    for (const audience of ['local_agent', 'remote_agent'] as const) {
      const result = querySessionLog(sessionLog, threadId, audience, { limit: 100 })
      assertNoSecret(JSON.stringify(result), `query tool (${audience})`)
    }
  })

  it('replay after a restart reproduces the live state and the Chat transcript', async (test) => {
    const { app, context, threadId, sessionLog, dbPath, scrubber } = await fixture(test)
    await sendTurn(app, threadId, 'first question')
    await waitForTerminal(context, 1)

    // A live inspector subscribes from the start and stays through a second turn.
    const stream = await app.request(`/api/sessions/${threadId}/stream?after=0`)
    let completed = 0
    const live = collectStream(stream, (event) => event.type === 'job.lifecycle' && event.data.state === 'completed' && ++completed === 2)
    await sendTurn(app, threadId, 'second question')
    await waitForTerminal(context, 2)
    const { events: liveEvents } = await live

    // Restart: a new connection and a new log instance read the file from scratch.
    const reopened = openDb(dbPath)
    test.after(() => reopened.close())
    const replayed = new SessionLog({ db: reopened, scrubber }).readAll(threadId, 'person')
    assert.deepEqual(replayed, liveEvents, 'the live stream and the replay are the same events')
    assert.deepEqual(projectTranscript(replayed), projectTranscript(liveEvents))
    assert.deepEqual(projectSpans(replayed), projectSpans(liveEvents))
    assert.deepEqual(projectTokenMeter(replayed), projectTokenMeter(liveEvents))

    // Paging through the route with a small page size yields the same events, once each.
    const paged: SessionEvent[] = []
    let after = 0
    while (true) {
      const page = await (await app.request(`/api/sessions/${threadId}/events?after=${after}&limit=3`)).json() as {
        events: SessionEvent[]
        nextAfter: number
        hasMore: boolean
      }
      paged.push(...page.events)
      after = page.nextAfter
      if (!page.hasMore) break
    }
    assert.deepEqual(paged.map((event) => event.seq), replayed.map((event) => event.seq))

    const state = projectTranscript(replayed)
    assert.deepEqual(state.counts, {
      'session.created': 1,
      'writer.acquired': 1,
      prompt: 2,
      'job.lifecycle': 24,
      'assistant.started': 4,
      reasoning: 4,
      'assistant.message': 4,
      'tool.call': 2,
      'tool.result': 2,
      usage: 4,
      context: 4,
      'turn.done': 2,
    })
    const lifecycle = (context.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE type = 'lifecycle'").get() as { n: number }).n
    assert.equal(state.counts['job.lifecycle'], lifecycle, 'every lifecycle Job event is in the trace, once')
    assert.equal(state.lastSeq, replayed.length)
    assert.deepEqual(Object.values(state.turns), ['completed', 'completed'])
    assert.equal(state.reasoningEvents, 4)

    // The trace reproduces the transcript the Chat UI shows from the Messages table.
    const messages = context.threads.messages(threadId)
    const users = messages.filter((message) => message.role === 'user')
    const assistants = messages.filter((message) => message.role === 'assistant')
    assert.deepEqual(state.prompts.map((prompt) => prompt.text), users.map((message) => scrubber.scrub(message.content)))
    assert.deepEqual(state.prompts.map((prompt) => prompt.messageId), users.map((message) => message.id))
    assert.equal(assistants.length, 4)
    for (const message of assistants) {
      assert.equal(state.assistantText[message.id], scrubber.scrub(message.content), `assistant message ${message.id}`)
    }
    assert.deepEqual(
      state.toolCalls.map((call) => [call.name, call.status]),
      [['lookup', 'error'], ['lookup', 'error']],
    )
    const turns = projectSpans(replayed).filter((span) => span.kind === 'turn')
    assert.equal(turns.length, 2)
    assert.ok(turns.every((span) => span.status === 'completed' && span.promptTokens > 0))
  })

  it('an agent on a remote provider receives 0 reasoning events; a local agent receives them all', async (test) => {
    const { app, context, threadId, sessionLog } = await fixture(test)
    await sendTurn(app, threadId, 'question for agents')
    await waitForTerminal(context, 1)
    const stored = sessionLog.readAll(threadId, 'person').filter((event) => event.class === 'reasoning')
    assert.equal(stored.length, 2, 'the session holds reasoning')

    const onDevice = { endpoint: 'http://127.0.0.1:11434', runtime: 'ollama', model: 'qwen3:8b' }
    assert.equal(audienceForAgent(onDevice), 'local_agent')
    assert.equal(audienceForAgent({ ...onDevice, endpoint: 'http://localhost:11434' }), 'local_agent')
    assert.equal(audienceForAgent({ ...onDevice, endpoint: 'http://[::1]:11434' }), 'local_agent')
    for (const [label, execution] of [
      ['remote API', { ...onDevice, endpoint: 'https://api.deepseek.com' }],
      ['LAN host', { ...onDevice, endpoint: 'http://192.168.1.20:11434' }],
      ['mDNS host', { ...onDevice, endpoint: 'http://studio.local:11434' }],
      ['not a URL', { ...onDevice, endpoint: 'not a url' }],
      ['no endpoint', { ...onDevice, endpoint: null }],
      ['Ollama cloud model on the local daemon', { ...onDevice, model: 'gpt-oss:120b-cloud' }],
      ['Ollama :cloud tag', { ...onDevice, model: 'deepseek-v3.1:cloud' }],
      ['loopback proxy of unknown runtime', { ...onDevice, runtime: 'litellm' }],
      ['unknown runtime', { ...onDevice, runtime: null }],
      ['unknown model', { ...onDevice, model: null }],
    ] as const) {
      assert.equal(audienceForAgent(execution), 'remote_agent', label)
    }

    const run = async (endpoint: string, args: Record<string, unknown>) => {
      const audience = audienceForAgent({ endpoint, runtime: 'ollama', model: 'qwen3:8b' })
      const registry = new ToolRegistry({
        hasWorkspace: false,
        enableBash: false,
        external: [createSessionQueryTool({ log: sessionLog, sessionId: threadId, audience })],
      })
      const tool = registry.get(SESSION_QUERY_TOOL_NAME)!
      const output = await tool.execute(args, { workspaceRoot: null, enableBash: false, signal: new AbortController().signal })
      return sessionQueryToolResultSchema.parse(JSON.parse(output.content))
    }
    const reasoningOf = (result: { events: SessionEvent[] }) => result.events.filter((event) => event.class === 'reasoning')

    const remoteQueries = [{ limit: 100 }, { types: ['reasoning'], limit: 100 }, { text: REASONING_WORD, limit: 100 }, { afterSeq: 0 }]
    for (const args of remoteQueries) {
      const remote = await run('https://api.deepseek.com/v1', args)
      assert.equal(remote.audience, 'remote_agent')
      assert.equal(reasoningOf(remote).length, 0, JSON.stringify(args))
      assert.equal(JSON.stringify(remote).includes(REASONING_WORD), false, 'no reasoning text reaches the remote agent')
    }
    assert.ok((await run('https://api.deepseek.com/v1', { limit: 100 })).events.length > 0, 'the remote agent still gets the trace')

    const local = await run('http://127.0.0.1:11434', { limit: 100 })
    assert.equal(local.audience, 'local_agent')
    assert.equal(reasoningOf(local).length, 2)
    assert.equal(reasoningOf(await run('http://127.0.0.1:11434', { text: REASONING_WORD, limit: 100 })).length, 2)
    await assert.rejects(run('https://api.deepseek.com', { audience: 'person' }), /Invalid session_log_query arguments/)
  })

  it('never writes reasoning to plain logs', async (test) => {
    const captured: string[] = []
    const originals = {
      stdout: process.stdout.write.bind(process.stdout),
      stderr: process.stderr.write.bind(process.stderr),
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }
    const record = (...parts: unknown[]) => {
      captured.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part))).join(' '))
    }
    process.stdout.write = ((chunkText: unknown, ...rest: unknown[]) => {
      record(chunkText instanceof Uint8Array ? Buffer.from(chunkText).toString('utf8') : chunkText)
      return (originals.stdout as (...args: unknown[]) => boolean)(chunkText, ...rest)
    }) as typeof process.stdout.write
    process.stderr.write = ((chunkText: unknown, ...rest: unknown[]) => {
      record(chunkText instanceof Uint8Array ? Buffer.from(chunkText).toString('utf8') : chunkText)
      return (originals.stderr as (...args: unknown[]) => boolean)(chunkText, ...rest)
    }) as typeof process.stderr.write
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[level] = (...args: unknown[]) => record(...args)
    }
    try {
      const { app, context, threadId, sessionLog } = await fixture(test)
      await sendTurn(app, threadId, 'log check')
      await waitForTerminal(context, 1)
      for (const route of [`/api/sessions/${threadId}/events`, `/api/sessions/${threadId}/export`, `/api/sessions/search?q=${REASONING_WORD}`]) {
        await (await app.request(route)).text()
      }
      assert.equal(sessionLog.readAll(threadId, 'person').filter((event) => event.class === 'reasoning').length, 2)
    } finally {
      process.stdout.write = originals.stdout
      process.stderr.write = originals.stderr
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = originals[level]
    }
    assert.equal(captured.some((line) => line.includes(REASONING_WORD)), false, 'reasoning reached a plain log')
  })
})
