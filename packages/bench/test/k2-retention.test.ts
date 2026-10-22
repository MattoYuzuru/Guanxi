import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { Hono } from 'hono'
import { sessionExportSchema, type SessionEvent } from '@guanxi/contract'
import type { Connections } from '../../server/src/connections/service.ts'
import type { Attempt } from '../../server/src/runs/types.ts'
import type { Db } from '../../server/src/store/db.ts'
import type { SessionEventInput, SessionLogOptions } from '../../server/src/session-log/log.ts'
import { sessionLogRoutes } from '../../server/src/session-log/routes.ts'
import { runFixture } from '../../server/test/fixtures/durable-runs.ts'
import { createK2TrialRetention, SIGNATURE_PREFIX, type RetentionPolicy } from '../src/k2-retention.ts'
import { PrivateFrameDecoder, PrivateTrialChannel } from '../src/private-channel.ts'
import { createTrialBinding, type TrialBinding } from '../src/trial-binding.ts'

type CompletionResult = Awaited<ReturnType<Connections['complete']>>
const LOOPBACK = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
const policy: RetentionPolicy = {
  maximumRetainedBytes: 16_384, maximumReasoningTextBytes: 4_096,
  maximumSignatureBytes: 4_096, maximumAssistantTextBytes: 4_096,
  maximumToolCalls: 8, maximumToolArgumentBytes: 2_048,
}
const fakeSecret = 'fixture-fake-secret-value'
const RECEIPT_PREFIX = 'guanxi.bench.completion-receipt/v1\n'
const SPAN_DOMAIN = 'guanxi.bench.completion-span/v1\n'
const SQLITE_READ = 20
const SQLITE_DENY = 1

function spanFor(binding: TrialBinding, requestId: string): string {
  return createHash('sha256').update(`${SPAN_DOMAIN}${binding.nonce}\n${requestId}`).digest('hex')
}
function receiptText(event: SessionEvent): string | null {
  if (event.type !== 'reasoning' || event.data === null) return null
  const data = event.data as { step?: unknown; text?: unknown }
  return data.step === null && typeof data.text === 'string' && data.text.startsWith(RECEIPT_PREFIX) ? data.text : null
}
function receiptEvents(f: ReturnType<typeof runFixture>, binding: TrialBinding): SessionEvent[] {
  return f.log.readAll(binding.sessionId, 'person').filter(event => receiptText(event) !== null)
}
function receipt(f: ReturnType<typeof runFixture>, binding: TrialBinding, phase: 'begin' | 'done'): any {
  const found = receiptEvents(f, binding).map(event => JSON.parse(receiptText(event)!.slice(RECEIPT_PREFIX.length)))
    .filter(value => value.phase === phase)
  assert.equal(found.length, 1, `exactly one ${phase} receipt`)
  return found[0]
}

function result(patch: Partial<CompletionResult> = {}): CompletionResult {
  return {
    role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture-metered',
    content: [
      { type: 'thinking', thinking: 'private fixture reasoning', thinkingSignature: 'fixture-private-signature' },
      { type: 'text', text: 'public reply' },
      { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
      { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } },
    ],
    stopReason: 'toolUse', timestamp: 1_800_000_000_000,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...patch,
  } as CompletionResult
}

function fixture(logFault?: SessionLogOptions['fault']) {
  const f = runFixture(':memory:', logFault ? { logFault } : {})
  const run = f.store.create({ id: 'trial-run', sessionId: 'trial-session' })
  const attempt = f.store.start(run.id)
  f.store.modelStarted(attempt)
  const binding = createTrialBinding({
    experimentId: 'experiment-1', taskId: 'task-1', armId: 'candidate', seed: 0,
    runId: run.id, attemptId: attempt.id, sessionId: run.session_id,
    accountId: 'account-1', connectionId: 'connection-1', provider: 'fixture',
    model: 'fixture-metered', modelApi: 'openai-completions', outputTokenLimit: 32,
    toolSource: 'builtin', attempt,
  })
  const sink = createK2TrialRetention({ binding, attempt, runs: f.store, session: f.log,
    scrubber: f.scrubber, policy })
  return { f, run, attempt, binding, sink }
}

function retained(f: ReturnType<typeof runFixture>, binding: TrialBinding): SessionEvent[] {
  return f.log.readAll(binding.sessionId, 'person').filter(event =>
    ['reasoning', 'assistant.message', 'tool.call'].includes(event.type) && receiptText(event) === null)
}

function count(f: ReturnType<typeof runFixture>, binding: TrialBinding, type: string): number {
  return retained(f, binding).filter(event => event.type === type).length
}


test('an empty valid completion gets real fenced begin and done acknowledgements and an empty stored projection', async () => {
  const x = fixture()
  try {
    const projection = await x.sink.retainAndProject('request-empty', result({ content: [], stopReason: 'stop' }))
    assert.deepEqual(projection, { text: '', toolCalls: [], stopReason: 'stop' })
    const events = x.f.log.readAll(x.binding.sessionId, 'person')
    assert.equal(events.filter(event => receiptText(event) !== null).length, 2)
    assert.equal(retained(x.f, x.binding).length, 0)
    const begin = receipt(x.f, x.binding, 'begin')
    const done = receipt(x.f, x.binding, 'done')
    assert.equal(begin.phase, 'begin')
    assert.equal(begin.specCount, 0)
    assert.deepEqual(begin.specs, [])
    assert.equal(done.phase, 'done')
    assert.deepEqual(done.contentSeqs, [])
    assert.equal(done.manifestSha256, begin.manifestSha256)
    assert.equal(done.publicSha256, begin.publicSha256)
    assert.equal(begin.stopReason, 'stop')
    const span = spanFor(x.binding, 'request-empty')
    assert.deepEqual(events.filter(event => ['reasoning', 'assistant.message', 'tool.call'].includes(event.type))
      .map(event => event.spanId), [span, span])
  } finally { x.f.close() }
})

test('an empty completion on a canceled or deposed attempt rejects retention_fenced before any receipt', async () => {
  for (const mode of ['canceled', 'deposed'] as const) {
    const x = fixture()
    try {
      if (mode === 'canceled') x.f.store.cancel(x.run.id)
      else x.f.store.complete(x.attempt!, 'completed')
      await assert.rejects(x.sink.retainAndProject('request-empty-fenced',
        result({ content: [], stopReason: 'stop' })), { code: 'retention_fenced' })
      assert.equal(receiptEvents(x.f, x.binding).length, 0)
      assert.equal(retained(x.f, x.binding).length, 0)
    } finally { x.f.close() }
  }
})

test('the stored stop reason and full manifest make a same-key changed reason or changed payload refuse before success', async () => {
  const x = fixture()
  try {
    const first = await x.sink.retainAndProject('request-reason', result({ stopReason: 'stop' }))
    assert.equal(first.stopReason, 'stop')
    const before = x.f.log.readAll(x.binding.sessionId, 'person').length
    await assert.rejects(x.sink.retainAndProject('request-reason', result({ stopReason: 'length' })),
      { code: 'retention_idempotency_conflict' })
    assert.equal(x.f.log.readAll(x.binding.sessionId, 'person').length, before)
    assert.equal(receipt(x.f, x.binding, 'begin').stopReason, 'stop')
  } finally { x.f.close() }
})


function bindingFor(run: { id: string; session_id: string }, attempt: { id: string; run_id: string },
  suffix = '2'): TrialBinding {
  return createTrialBinding({
    experimentId: `experiment-${suffix}`, taskId: 'task-1', armId: 'candidate', seed: 0,
    runId: run.id, attemptId: attempt.id, sessionId: run.session_id,
    accountId: 'account-1', connectionId: 'connection-1', provider: 'fixture',
    model: 'fixture-metered', modelApi: 'openai-completions', outputTokenLimit: 32,
    toolSource: 'builtin', attempt,
  })
}
function receiptsForSpan(f: ReturnType<typeof runFixture>, span: string): any[] {
  return f.log.readAll('trial-session', 'person').map(event => {
    const text = receiptText(event)
    return text === null ? null : JSON.parse(text.slice(RECEIPT_PREFIX.length))
  }).filter(value => value !== null && value.span === span)
}
function receiptFor(f: ReturnType<typeof runFixture>, span: string, phase: 'begin' | 'done'): any {
  const found = receiptsForSpan(f, span).filter(value => value.phase === phase)
  assert.equal(found.length, 1, `exactly one ${phase} receipt for the span`)
  return found[0]
}
function contentForSpan(f: ReturnType<typeof runFixture>, span: string): SessionEvent[] {
  return f.log.readAll('trial-session', 'person').filter(event =>
    event.spanId === span && receiptText(event) === null &&
    ['reasoning', 'assistant.message', 'tool.call'].includes(event.type))
}
function rowCount(f: ReturnType<typeof runFixture>): number {
  return (f.db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n
}

test('two bindings with one session and identical request id keep independent receipt spans and content', async () => {
  const x = fixture()
  try {
    const other = bindingFor(x.run, x.attempt!)
    const sinkB = createK2TrialRetention({ binding: other, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy })
    const one = await x.sink.retainAndProject('request-shared', result())
    const two = await sinkB.retainAndProject('request-shared', result())
    assert.deepEqual(one, two)
    const spanA = spanFor(x.binding, 'request-shared')
    const spanB = spanFor(other, 'request-shared')
    assert.notEqual(spanA, spanB)
    assert.equal(receiptFor(x.f, spanA, 'begin').requestHash, receiptFor(x.f, spanB, 'begin').requestHash)
    assert.notEqual(receiptFor(x.f, spanA, 'begin').bindingHash, receiptFor(x.f, spanB, 'begin').bindingHash)
    assert.equal(contentForSpan(x.f, spanA).length, 5)
    assert.equal(contentForSpan(x.f, spanB).length, 5)
    assert.equal(contentForSpan(x.f, spanA).some(event =>
      (event.data as { text?: string } | null)?.text === 'public reply'), true)
  } finally { x.f.close() }
})

test('a pre-fix raw-span row from this binding refuses a retry before any receipt is appended', async () => {
  const x = fixture()
  try {
    const requestId = 'request-legacy'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    x.f.store.append(x.attempt!, { type: 'assistant.message',
      data: { messageId: requestId, step: 0, text: 'legacy public reply' }, spanId: requestId },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:assistant`, expectedSeq: head + 1 })
    const before = rowCount(x.f)
    await assert.rejects(x.sink.retainAndProject(requestId, result()),
      { code: 'retention_idempotency_conflict' })
    assert.equal(rowCount(x.f), before)
    assert.equal(receiptEvents(x.f, x.binding).length, 0)
  } finally { x.f.close() }
})


test('legacy raw-span reasoning, signature and tool rows are detected by same-binding key probes', async () => {
  const requestId = 'request-legacy-kind'
  const legacy = [
    { type: 'reasoning' as const, suffix: 'reasoning:0',
      data: { messageId: requestId, step: 0, text: 'legacy reasoning' } },
    { type: 'reasoning' as const, suffix: 'reasoning-signature:0',
      data: { messageId: requestId, step: 1, text: `${SIGNATURE_PREFIX}{"signature":"legacy"}` } },
    { type: 'tool.call' as const, suffix: `tool:${createHash('sha256').update('tool-legacy').digest('hex')}`,
      data: { toolCallId: 'tool-legacy', name: 'shell', arguments: {}, source: 'builtin' as const,
        parsedFrom: 'native' as const, diffPath: null } },
  ]
  for (const old of legacy) {
    const x = fixture()
    try {
      const head = x.f.log.session(x.binding.sessionId)!.lastSeq
      x.f.store.append(x.attempt!, { type: old.type, data: old.data, spanId: requestId } as never,
        { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:${old.suffix}`, expectedSeq: head + 1 })
      const before = rowCount(x.f)
      await assert.rejects(x.sink.retainAndProject(requestId, result()),
        { code: 'retention_idempotency_conflict' })
      assert.equal(rowCount(x.f), before)
      assert.equal(receiptEvents(x.f, x.binding).length, 0)
    } finally { x.f.close() }
  }
})

test('another binding is not rejected by a raw-span legacy row that carries a different nonce', async () => {
  const x = fixture()
  try {
    const requestId = 'request-shared-legacy'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    x.f.store.append(x.attempt!, { type: 'assistant.message',
      data: { messageId: requestId, step: 0, text: 'foreign legacy row' }, spanId: requestId },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:assistant`, expectedSeq: head + 1 })
    const other = bindingFor(x.run, x.attempt!)
    const sinkB = createK2TrialRetention({ binding: other, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy })
    const projection = await sinkB.retainAndProject(requestId, result({
      content: [{ type: 'text', text: 'fresh binding reply' }] }))
    assert.equal(projection.text, 'fresh binding reply')
    assert.equal(receiptEvents(x.f, x.binding).length, 2)
    assert.equal(contentForSpan(x.f, spanFor(other, requestId)).some(event =>
      (event.data as { text?: string } | null)?.text === 'fresh binding reply'), true)
  } finally { x.f.close() }
})

test('a legacy raw-span tool row stays authoritative after its toolCallId is redacted', async () => {
  const x = fixture()
  try {
    const requestId = 'request-legacy-redacted-tool:%_:'
    const toolCallId = 'legacy-tool-late-secret-abcdef'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    x.f.store.append(x.attempt!, { type: 'tool.call', spanId: requestId,
      data: { toolCallId, name: 'shell', arguments: {}, source: 'builtin',
        parsedFrom: 'native', diffPath: null } },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:tool:${createHash('sha256').update(toolCallId).digest('hex')}`,
      expectedSeq: head + 1 })
    // The stored payload keeps its bytes; every later read hides the new secret in the tool id.
    x.f.scrubber.register('secret://fixture/legacy-tool', toolCallId)
    const raw = x.f.log.readAll(x.binding.sessionId, 'person').filter(event => event.spanId === requestId)
    assert.equal(raw.length, 1)
    assert.notEqual((raw[0]!.data as { toolCallId: string }).toolCallId, toolCallId)
    const before = rowCount(x.f)
    await assert.rejects(x.sink.retainAndProject(requestId, result()),
      { code: 'retention_idempotency_conflict' })
    assert.equal(rowCount(x.f), before)
    assert.equal(receiptEvents(x.f, x.binding).length, 0)
    assert.equal(contentForSpan(x.f, spanFor(x.binding, requestId)).length, 0)
  } finally { x.f.close() }
})

test('a new binding is not blocked by another binding redacted legacy tool row and does not adopt it', async () => {
  const x = fixture()
  try {
    const requestId = 'request-shared-redacted-tool'
    const toolCallId = 'legacy-tool-shared-secret-abcdef'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    x.f.store.append(x.attempt!, { type: 'tool.call', spanId: requestId,
      data: { toolCallId, name: 'shell', arguments: {}, source: 'builtin',
        parsedFrom: 'native', diffPath: null } },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:tool:${createHash('sha256').update(toolCallId).digest('hex')}`,
      expectedSeq: head + 1 })
    x.f.scrubber.register('secret://fixture/shared-legacy-tool', toolCallId)
    const other = bindingFor(x.run, x.attempt!)
    const sinkB = createK2TrialRetention({ binding: other, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy })
    const before = rowCount(x.f)
    const projection = await sinkB.retainAndProject(requestId, result({
      content: [{ type: 'text', text: 'fresh binding reply' }] }))
    assert.equal(projection.text, 'fresh binding reply')
    assert.deepEqual(projection.toolCalls, [])
    assert.equal(rowCount(x.f), before + 3)
    const old = x.f.log.readAll(x.binding.sessionId, 'person').filter(event => event.spanId === requestId)
    assert.equal(old.length, 1)
    assert.equal(old[0]!.type, 'tool.call')
    const fresh = contentForSpan(x.f, spanFor(other, requestId))
    assert.equal(fresh.length, 1)
    assert.equal(fresh[0]!.type, 'assistant.message')
    assert.equal((fresh[0]!.data as { text: string }).text, 'fresh binding reply')
  } finally { x.f.close() }
})

test('a metadata-read SQLite fault fails closed as retention_failed without a false clear or append', async () => {
  const x = fixture()
  const base = x.f.store
  try {
    const requestId = 'request-legacy-sql-fault'
    const toolCallId = 'legacy-tool-sql-fault'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    base.append(x.attempt!, { type: 'tool.call', spanId: requestId,
      data: { toolCallId, name: 'shell', arguments: {}, source: 'builtin',
        parsedFrom: 'native', diffPath: null } },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:tool:${createHash('sha256').update(toolCallId).digest('hex')}`,
      expectedSeq: head + 1 })
    let faulted = false
    const runs = {
      get: base.get.bind(base),
      renew: base.renew.bind(base),
      append: base.append.bind(base),
      mutate: <T>(attempt: Attempt, body: (db: Db, emit: (event: SessionEventInput) => void) => T): T =>
        base.mutate(attempt, (db, emit) => {
          if (faulted) return body(db, emit)
          faulted = true
          // Deny the metadata table read at SQLite's authorizer, independently of the query text.
          const authorized = db as Db & {
            setAuthorizer(callback: ((action: number, table: string | null) => number) | null): void
          }
          authorized.setAuthorizer((action, table) =>
            action === SQLITE_READ && table === 'session_events' ? SQLITE_DENY : 0)
          try { return body(db, emit) } finally { authorized.setAuthorizer(null) }
        }),
    }
    const sink = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
      runs, session: x.f.log, scrubber: x.f.scrubber, policy })
    const before = rowCount(x.f)
    await assert.rejects(sink.retainAndProject(requestId, result()), { code: 'retention_failed' })
    assert.equal(faulted, true)
    assert.equal(rowCount(x.f), before)
    assert.equal(receiptEvents(x.f, x.binding).length, 0)
  } finally { x.f.close() }
})

test('a stale attempt with a legacy raw-span row fails the metadata fence as retention_fenced', async () => {
  const x = fixture()
  try {
    const requestId = 'request-legacy-fenced'
    const toolCallId = 'legacy-tool-fenced'
    const head = x.f.log.session(x.binding.sessionId)!.lastSeq
    x.f.store.append(x.attempt!, { type: 'tool.call', spanId: requestId,
      data: { toolCallId, name: 'shell', arguments: {}, source: 'builtin',
        parsedFrom: 'native', diffPath: null } },
    { idempotencyKey: `bench:${x.binding.nonce}:${requestId}:tool:${createHash('sha256').update(toolCallId).digest('hex')}`,
      expectedSeq: head + 1 })
    x.f.store.cancel(x.run.id)
    const before = rowCount(x.f)
    await assert.rejects(x.sink.retainAndProject(requestId, result()), { code: 'retention_fenced' })
    assert.equal(rowCount(x.f), before)
    assert.equal(receiptEvents(x.f, x.binding).length, 0)
  } finally { x.f.close() }
})

test('changed stop reason, removed or reordered tools and changed private evidence refuse at the stored manifest', async () => {
  const x = fixture()
  try {
    await x.sink.retainAndProject('request-manifest', result())
    const before = rowCount(x.f)
    const changed = [
      result({ stopReason: 'length' }),
      result({ content: [{ type: 'thinking', thinking: 'private fixture reasoning', thinkingSignature: 'fixture-private-signature' },
        { type: 'text', text: 'public reply' },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }] }),
      result({ content: [{ type: 'thinking', thinking: 'private fixture reasoning', thinkingSignature: 'fixture-private-signature' },
        { type: 'text', text: 'public reply' },
        { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } }] }),
      result({ content: [{ type: 'thinking', thinking: 'changed private reasoning', thinkingSignature: 'fixture-private-signature' },
        { type: 'text', text: 'public reply' },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
        { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } }] }),
      result({ content: [{ type: 'thinking', thinking: 'private fixture reasoning', thinkingSignature: 'changed-private-signature' },
        { type: 'text', text: 'public reply' },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
        { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } }] }),
      result({ content: [{ type: 'thinking', thinking: 'private fixture reasoning', thinkingSignature: 'fixture-private-signature' },
        { type: 'text', text: 'public reply' },
        { type: 'toolCall', id: 'tool-1', name: 'shell', arguments: { command: 'whoami' } },
        { type: 'toolCall', id: 'tool-2', name: 'read', arguments: { path: 'README.md' } }] }),
    ]
    for (const attempt of changed) {
      await assert.rejects(x.sink.retainAndProject('request-manifest', attempt),
        { code: 'retention_idempotency_conflict' })
      assert.equal(rowCount(x.f), before)
    }
    assert.equal(receipt(x.f, x.binding, 'begin').stopReason, 'toolUse')
  } finally { x.f.close() }
})

test('a recreated sink reconciles a partial begin/content prefix, appends only missing rows and completes the done ACK', async () => {
  let injected = true
  const x = fixture((point, detail) => {
    if (injected && point === 'writer_checked' && detail.type === 'assistant.message') {
      injected = false
      throw new Error('fixture private append failure')
    }
  })
  try {
    await assert.rejects(x.sink.retainAndProject('request-recreate', result()), { code: 'retention_failed' })
    assert.equal(receiptEvents(x.f, x.binding).length, 1)
    assert.equal(contentForSpan(x.f, spanFor(x.binding, 'request-recreate')).length, 2)
    const recreated = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy })
    const projection = await recreated.retainAndProject('request-recreate', result())
    assert.equal(projection.text, 'public reply')
    assert.equal(receiptEvents(x.f, x.binding).length, 2)
    assert.equal(contentForSpan(x.f, spanFor(x.binding, 'request-recreate')).length, 5)
    assert.deepEqual(receiptFor(x.f, spanFor(x.binding, 'request-recreate'), 'done').contentSeqs.length, 5)
  } finally { x.f.close() }
})

test('a recreated sink after a done receipt returns the stored projection without duplicates', async () => {
  const x = fixture()
  try {
    const first = await x.sink.retainAndProject('request-done-recreate', result())
    const before = rowCount(x.f)
    const recreated = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy })
    const second = await recreated.retainAndProject('request-done-recreate', result())
    assert.deepEqual(second, first)
    assert.equal(rowCount(x.f), before)
    assert.equal(receiptFor(x.f, spanFor(x.binding, 'request-done-recreate'), 'done').stopReason, 'toolUse')
  } finally { x.f.close() }
})

test('a late scrub that changes stored bytes within bounds fails closed after the begin receipt', async () => {
  const x = fixture()
  const late = 'late-secret-value-abcdef'
  let armed = false
  const sink = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
    runs: { get: x.f.store.get.bind(x.f.store), mutate: x.f.store.mutate.bind(x.f.store),
      renew: x.f.store.renew.bind(x.f.store),
      append: (attempt, input, options) => {
        if (!armed) { armed = true; x.f.scrubber.register('secret://fixture/late-bounded', late) }
        return x.f.store.append(attempt, input, options)
      } },
    session: x.f.log, scrubber: x.f.scrubber, policy })
  try {
    await assert.rejects(sink.retainAndProject('request-late-bounded', result({
      content: [{ type: 'text', text: late }],
    })), { code: 'retention_idempotency_conflict' })
    assert.equal(receiptEvents(x.f, x.binding).length, 1)
    assert.equal(contentForSpan(x.f, spanFor(x.binding, 'request-late-bounded')).length, 1)
    assert.equal(JSON.stringify(contentForSpan(x.f, spanFor(x.binding, 'request-late-bounded'))).includes(late), false)
  } finally { x.f.close() }
})

test('oversized begin receipts or planned content-plus-receipt bytes refuse before the first append', async () => {
  for (const custom of [
    { ...policy, maximumReasoningTextBytes: 64 },
    { ...policy, maximumRetainedBytes: 100 },
  ]) {
    const x = fixture()
    const sink = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
      runs: x.f.store, session: x.f.log, scrubber: x.f.scrubber, policy: custom })
    try {
      await assert.rejects(sink.retainAndProject('request-oversized', result()), { code: 'retention_too_large' })
      assert.equal(receiptEvents(x.f, x.binding).length, 0)
      assert.equal(retained(x.f, x.binding).length, 0)
    } finally { x.f.close() }
  }
})

test('a same-key retry after the reasoning TTL purge fails closed and preserves the event rows', async () => {
  const x = fixture()
  try {
    await x.sink.retainAndProject('request-purged', result())
    const before = rowCount(x.f)
    x.f.setTime(1_800_000_000_000 + 8 * 24 * 60 * 60 * 1_000)
    assert.equal(x.f.log.purgeAllExpiredReasoning() > 0, true)
    await assert.rejects(x.sink.retainAndProject('request-purged', result()),
      { code: 'retention_idempotency_conflict' })
    assert.equal(rowCount(x.f), before)
  } finally { x.f.close() }
})

test('K2 sink durably retains scrubbed reasoning, signature, public text and tools before returning the same projection', async () => {
  const x = fixture()
  try {
    const projection = await x.sink.retainAndProject('request-1', result())
    assert.deepEqual(projection, { text: 'public reply', stopReason: 'toolUse', toolCalls: [
      { id: 'tool-1', name: 'shell', arguments: { command: 'pwd' } },
      { id: 'tool-2', name: 'read', arguments: { path: 'README.md' } },
    ] })
    const events = retained(x.f, x.binding)
    assert.deepEqual(events.map(event => event.type), ['reasoning', 'reasoning', 'assistant.message', 'tool.call', 'tool.call'])
    const reasoning = events.filter(event => event.type === 'reasoning')
    assert.equal(reasoning.length, 2)
    assert.equal((reasoning[0]!.data as { text: string }).text, 'private fixture reasoning')
    assert.equal((reasoning[1]!.data as { text: string }).text,
      `${SIGNATURE_PREFIX}${JSON.stringify({ signature: 'fixture-private-signature', redacted: false })}`)
    assert.equal((reasoning[1]!.data as { messageId: string }).messageId, 'request-1')
    const assistant = events.find(event => event.type === 'assistant.message')!
    assert.deepEqual(assistant.data, { messageId: 'request-1', step: 2, text: 'public reply' })
    assert.equal(assistant.spanId, spanFor(x.binding, 'request-1'))
    const tools = events.filter(event => event.type === 'tool.call')
    assert.deepEqual(tools.map(event => event.data), [
      { toolCallId: 'tool-1', name: 'shell', arguments: { command: 'pwd' }, source: 'builtin', parsedFrom: 'native', diffPath: null },
      { toolCallId: 'tool-2', name: 'read', arguments: { path: 'README.md' }, source: 'builtin', parsedFrom: 'native', diffPath: null },
    ])
    assert.equal(JSON.stringify(assistant.data).includes('fixture-private-signature'), false)
    assert.equal(JSON.stringify(events).includes('"usage"'), false)
    assert.deepEqual(x.f.log.readAll(x.binding.sessionId, 'remote_agent').filter(event => event.class === 'reasoning'), [])
    const receiptTexts = receiptEvents(x.f, x.binding).map(event => receiptText(event)!).join('\n')
    for (const privateValue of ['private fixture reasoning', 'fixture-private-signature', 'pwd', 'README.md',
      x.binding.nonce, 'request-1']) {
      assert.equal(receiptTexts.includes(privateValue), false, privateValue)
    }
  } finally { x.f.close() }
})

test('K2 export and remote audience omit both reasoning text and the versioned signature envelope', async () => {
  const x = fixture()
  try {
    await x.sink.retainAndProject('request-export', result())
    const remote = x.f.log.readAll(x.binding.sessionId, 'remote_agent')
    assert.equal(remote.some(event => event.type === 'reasoning'), false)
    assert.equal(JSON.stringify(remote).includes('private fixture reasoning'), false)
    assert.equal(JSON.stringify(remote).includes(SIGNATURE_PREFIX), false)
    const app = new Hono()
    app.route('/api/sessions', sessionLogRoutes(() => x.f.log))
    const exported = sessionExportSchema.parse(await (await app.request(
      `/api/sessions/${x.binding.sessionId}/export`, {}, LOOPBACK)).json())
    assert.equal(exported.excluded.reasoning, 4, 'two content reasoning rows plus the begin/done receipt metadata')
    assert.equal(exported.events.some(event => event.class === 'reasoning'), false)
    assert.equal(JSON.stringify(exported).includes('private fixture reasoning'), false)
    assert.equal(JSON.stringify(exported).includes(SIGNATURE_PREFIX), false)
    assert.equal(JSON.stringify(remote).includes(RECEIPT_PREFIX), false)
    assert.equal(JSON.stringify(exported).includes(RECEIPT_PREFIX), false)
    assert.equal(exported.events.some(event => event.type === 'assistant.message'), true)
  } finally { x.f.close() }
})

test('K2 sink keeps the public projection equal to scrubbed stored events and never leaks a newly registered value', async () => {
  const x = fixture()
  try {
    x.f.scrubber.register('secret://fixture/new', fakeSecret)
    const projection = await x.sink.retainAndProject('request-secret', result())
    assert.equal(projection.text.includes(fakeSecret), false)
    assert.equal(JSON.stringify(projection).includes(fakeSecret), false)
    const events = retained(x.f, x.binding)
    assert.equal(JSON.stringify(events).includes(fakeSecret), false)
    const assistant = events.find(event => event.type === 'assistant.message')!
    assert.equal((assistant.data as { text: string }).text, projection.text)
  } finally { x.f.close() }
})

test('same-key idempotency deduplicates equal retries, refuses changed payloads and leaves an idempotent partial trace', async () => {
  const equal = fixture()
  try {
    const first = await equal.sink.retainAndProject('request-idem', result())
    const before = retained(equal.f, equal.binding).length
    const second = await equal.sink.retainAndProject('request-idem', result())
    assert.deepEqual(second, first)
    assert.equal(retained(equal.f, equal.binding).length, before)
    await assert.rejects(equal.sink.retainAndProject('request-idem', result({ content: [{ type: 'text', text: 'changed' }] })),
      { code: 'retention_idempotency_conflict' })
    assert.equal(retained(equal.f, equal.binding).length, before)
  } finally { equal.f.close() }

  let injected = true
  const partial = fixture((point, detail) => {
    if (injected && point === 'writer_checked' && detail.type === 'assistant.message') {
      injected = false
      throw new Error('fixture private append failure')
    }
  })
  try {
    await assert.rejects(partial.sink.retainAndProject('request-partial', result()), { code: 'retention_failed' })
    assert.equal(count(partial.f, partial.binding, 'reasoning'), 2)
    assert.equal(count(partial.f, partial.binding, 'assistant.message'), 0)
    const projection = await partial.sink.retainAndProject('request-partial', result())
    assert.equal(projection.text, 'public reply')
    assert.equal(count(partial.f, partial.binding, 'reasoning'), 2)
    assert.equal(count(partial.f, partial.binding, 'assistant.message'), 1)
    assert.equal(count(partial.f, partial.binding, 'tool.call'), 2)
  } finally { partial.f.close() }
})

test('retention refuses readiness withdrawal, oversized or unsupported content and invalid tool ids before appending', async () => {
  const ready = fixture()
  try {
    ready.f.scrubber.expect('fixture-source')
    await assert.rejects(ready.sink.retainAndProject('request-not-ready', result()), { code: 'retention_not_ready' })
    const stored = ready.f.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type IN ('reasoning','assistant.message','tool.call')").get() as { n: number }
    assert.equal(stored.n, 0)
    ready.f.scrubber.ready('fixture-source')
  } finally { ready.f.close() }

  const oversized = fixture()
  try {
    await assert.rejects(oversized.sink.retainAndProject('request-big', result({
      content: [{ type: 'text', text: 'x'.repeat(policy.maximumAssistantTextBytes + 1) }],
    })), { code: 'retention_too_large' })
    assert.equal(retained(oversized.f, oversized.binding).length, 0)
  } finally { oversized.f.close() }

  const unsupported = fixture()
  try {
    await assert.rejects(unsupported.sink.retainAndProject('request-image', result({
      content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' } as never],
    })), { code: 'retention_unsupported_content' })
    await assert.rejects(unsupported.sink.retainAndProject('request-tool-id', result({
      content: [{ type: 'toolCall', id: 'x'.repeat(201), name: 'shell', arguments: {} }],
    })), { code: 'retention_id_invalid' })
    assert.equal(retained(unsupported.f, unsupported.binding).length, 0)
  } finally { unsupported.f.close() }
})

test('retention fences a stale R1 attempt, a foreign attempt or a session mismatch before appending', async () => {
  const stale = fixture()
  try {
    stale.f.store.complete(stale.attempt, 'completed')
    await assert.rejects(stale.sink.retainAndProject('request-stale', result()), { code: 'retention_fenced' })
    assert.equal(retained(stale.f, stale.binding).length, 0)
  } finally { stale.f.close() }

  const foreign = fixture()
  try {
    const other = createK2TrialRetention({
      binding: foreign.binding, attempt: { ...foreign.attempt, id: 'other-attempt' },
      runs: foreign.f.store, session: foreign.f.log, scrubber: foreign.f.scrubber, policy,
    })
    await assert.rejects(other.retainAndProject('request-foreign', result()), { code: 'retention_fenced' })
    const mismatch = createK2TrialRetention({
      binding: { ...foreign.binding, sessionId: 'other-session' }, attempt: foreign.attempt,
      runs: foreign.f.store, session: foreign.f.log, scrubber: foreign.f.scrubber, policy,
    })
    await assert.rejects(mismatch.retainAndProject('request-mismatch', result()), { code: 'retention_fenced' })
    assert.equal(retained(foreign.f, foreign.binding).length, 0)
  } finally { foreign.f.close() }
})

test('concurrent retain calls serialize and preserve each completion\'s sequence', async () => {
  const x = fixture()
  try {
    const first = result({ content: [{ type: 'text', text: 'first' }] })
    const second = result({ content: [{ type: 'text', text: 'second' }] })
    const [one, two] = await Promise.all([
      x.sink.retainAndProject('request-one', first),
      x.sink.retainAndProject('request-two', second),
    ])
    assert.equal(one.text, 'first'); assert.equal(two.text, 'second')
    const messages = retained(x.f, x.binding).filter(event => event.type === 'assistant.message')
    assert.deepEqual(messages.map(event => (event.data as { text: string }).text), ['first', 'second'])
    assert.deepEqual(messages.map(event => event.spanId),
      [spanFor(x.binding, 'request-one'), spanFor(x.binding, 'request-two')])
  } finally { x.f.close() }
})

test('the channel frame is derived from the same scrubbed public projection durably acknowledged by K2', async () => {
  const x = fixture()
  const channelPolicy = { maximumPayloadBytes: 65_536, maximumRequests: 2, requestTimeoutMs: 5_000 }
  const fake = 'fixture-runtime-secret-value'
  const completion = result({
    content: [{ type: 'text', text: `public ${fake}` },
      { type: 'toolCall', id: 'tool-secret', name: 'shell', arguments: { command: fake } }],
  })
  const host = {
    model: { api: 'openai-completions', provider: 'fixture', id: 'fixture-metered' },
    gateway: { async complete() { return { requestId: 'request-frame', result: completion } } },
    retain: x.sink.retain,
    async retainAndProject(requestId: string, value: CompletionResult) {
      // The registry changes after the gateway returns and before retention.
      x.f.scrubber.register('secret://fixture/runtime', fake)
      return x.sink.retainAndProject(requestId, value)
    },
  }
  try {
    const channel = new PrivateTrialChannel(host, channelPolicy)
    const frame = await channel.handle({ version: 1, id: 0, operation: 'complete',
      context: { messages: [{ role: 'user', text: 'fixture' }], tools: [] } })
    const decoder = new PrivateFrameDecoder(channelPolicy.maximumPayloadBytes)
    const decoded = [...decoder.push(frame)] as Array<{ status: string; message: any }>
    decoder.finish()
    assert.equal(decoded.length, 1); assert.equal(decoded[0]!.status, 'ok')
    const assistant = retained(x.f, x.binding).find(event => event.type === 'assistant.message')!
    const tools = retained(x.f, x.binding).filter(event => event.type === 'tool.call')
    assert.equal(decoded[0]!.message.text, (assistant.data as { text: string }).text)
    assert.deepEqual(decoded[0]!.message.toolCalls, tools.map(event => ({
      id: (event.data as { toolCallId: string }).toolCallId,
      name: (event.data as { name: string }).name,
      arguments: (event.data as { arguments: Record<string, unknown> }).arguments,
    })))
    assert.equal(JSON.stringify([frame.toString('utf8'), retained(x.f, x.binding)]).includes(fake), false)
    assert.equal(decoded[0]!.message.text.includes('\u27E6REDACTED'), true)
    assert.equal(receiptFor(x.f, spanFor(x.binding, 'request-frame'), 'done').publicSha256,
      receiptFor(x.f, spanFor(x.binding, 'request-frame'), 'begin').publicSha256)
    await channel.settled()
  } finally { x.f.close() }
})

test('readiness withdrawal between gateway return and retention yields no successful task response and no K2 event', async () => {
  const x = fixture()
  const channelPolicy = { maximumPayloadBytes: 65_536, maximumRequests: 2, requestTimeoutMs: 5_000 }
  let calls = 0
  const host = {
    model: { api: 'openai-completions', provider: 'fixture', id: 'fixture-metered' },
    gateway: { async complete() { calls++; return { requestId: 'request-not-ready', result: result() } } },
    retain: x.sink.retain,
    async retainAndProject(requestId: string, value: CompletionResult) {
      x.f.scrubber.expect('fixture-withdraw')
      return x.sink.retainAndProject(requestId, value)
    },
  }
  try {
    const channel = new PrivateTrialChannel(host, channelPolicy)
    const decoder = new PrivateFrameDecoder(channelPolicy.maximumPayloadBytes)
    const decoded = [...decoder.push(await channel.handle({ version: 1, id: 0, operation: 'complete',
      context: { messages: [{ role: 'user', text: 'fixture' }], tools: [] } }))] as Array<{ status: string }>
    decoder.finish()
    assert.equal(calls, 1)
    assert.equal(decoded[0]!.status, 'error')
    assert.equal(decoded.some(value => value.status === 'ok'), false)
    const stored = x.f.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE type IN ('reasoning','assistant.message','tool.call')").get() as { n: number }
    assert.equal(stored.n, 0)
  } finally { x.f.close() }
})

test('the K2 sink scrubs the full completion through the configured scrubber before its first append', async () => {
  const x = fixture()
  let scrubs = 0, appends = 0
  const spy = {
    register: (ref: Parameters<typeof x.f.scrubber.register>[0], value: string) => x.f.scrubber.register(ref, value),
    unregister: (ref: Parameters<typeof x.f.scrubber.unregister>[0]) => x.f.scrubber.unregister(ref),
    scrub: <T>(value: T): T => { scrubs++; return x.f.scrubber.scrub(value) },
    expect: (source: string) => x.f.scrubber.expect(source),
    ready: (source: string) => x.f.scrubber.ready(source),
    isReady: () => x.f.scrubber.isReady(),
    pendingSources: () => x.f.scrubber.pendingSources(),
    whenReady: (signal?: AbortSignal) => x.f.scrubber.whenReady(signal),
  }
  const sink = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
    runs: { get: x.f.store.get.bind(x.f.store), mutate: x.f.store.mutate.bind(x.f.store),
      renew: x.f.store.renew.bind(x.f.store),
      append: (attempt, input, options) => { appends++; return x.f.store.append(attempt, input, options) } },
    session: x.f.log, scrubber: spy, policy })
  try {
    await sink.retainAndProject('request-spy', result())
    assert.equal(scrubs, 1)
    assert.equal(appends, 7, 'begin receipt, five content rows and the done receipt')
  } finally { x.f.close() }
})

test('a bound is rechecked after K2 write-time scrubbing so a late secret cannot enlarge the retained public text', async () => {
  const x = fixture()
  const late = 'late-secret-value-abcdef'
  const strict = { ...policy, maximumAssistantTextBytes: 30 }
  let armed = false
  const sink = createK2TrialRetention({ binding: x.binding, attempt: x.attempt!,
    runs: { get: x.f.store.get.bind(x.f.store), mutate: x.f.store.mutate.bind(x.f.store),
      renew: x.f.store.renew.bind(x.f.store),
      append: (attempt, input, options) => {
        if (!armed) { armed = true; x.f.scrubber.register('secret://fixture/late', late) }
        return x.f.store.append(attempt, input, options)
      } },
    session: x.f.log, scrubber: x.f.scrubber, policy: strict })
  try {
    await assert.rejects(sink.retainAndProject('request-late', result({
      content: [{ type: 'text', text: late }],
    })), { code: 'retention_too_large' })
    const events = retained(x.f, x.binding)
    assert.equal(events.filter(event => event.type === 'assistant.message').length, 1)
    assert.equal(JSON.stringify(events).includes(late), false)
  } finally { x.f.close() }
})
