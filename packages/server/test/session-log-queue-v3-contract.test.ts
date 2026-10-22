/**
 * Pure contract evidence for queue v3 and negotiated progress v2.
 *
 * No database, filesystem, helper, provider or browser is started. The last
 * case imports the event barrel and the native-agent contract in a fresh child
 * process, so a cold runtime cycle would fail instead of being hidden by tsc.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  INPUT_EXCERPT_BYTES,
  INPUT_INLINE_BYTES,
  SESSION_EVENT_VERSION,
  SESSION_EVENT_VERSION_2,
  SESSION_EVENT_VERSION_3,
  SESSION_EXPORT_VERSION,
  SESSION_EXPORT_VERSION_2,
  SESSION_EXPORT_VERSION_3,
  agentProgressQuerySchema,
  agentProgressV2Schema,
  inputArtifactOf,
  inputArtifactsOf,
  nativeProgressVersionUnsupportedSchema,
  queueAppendDataV3Schema,
  queueDataV3Schema,
  queueItemDisplayTextOf,
  queueV3SessionEventSchema,
  sessionEventSchema,
  sessionEventsQuery,
  sessionExportQuery,
  sessionExportSchema,
  type SessionEvent,
} from '@guanxi/contract'
import {
  SESSION_QUEUE_POLICY_TRIGGER_SQL,
  V33_POLICY_TRIGGER_SQL,
} from '../src/session-log/queue-schema.ts'
import { SESSION_INPUT_ARTIFACTS_MIGRATION } from '../src/session-log/schema.ts'

function normalized(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().replace(/;$/u, '')
}

function installedV33Trigger(): string {
  const start = SESSION_INPUT_ARTIFACTS_MIGRATION.indexOf('CREATE TRIGGER session_events_policy_insert')
  const end = SESSION_INPUT_ARTIFACTS_MIGRATION.indexOf('END;', start)
  assert.ok(start >= 0 && end > start)
  return SESSION_INPUT_ARTIFACTS_MIGRATION.slice(start, end + 'END;'.length)
}

const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111'
const CHECKSUM = `sha256:${'a'.repeat(64)}`
const CREATED_AT = '2026-10-22T10:00:00.000Z'

function artifact(excerpt = 'preview', byteSize = INPUT_INLINE_BYTES + 1) {
  return {
    artifactId: ARTIFACT_ID,
    checksum: CHECKSUM,
    byteSize,
    mediaType: 'text/plain; charset=utf-8' as const,
    excerpt,
    excerptBytes: Buffer.byteLength(excerpt, 'utf8'),
  }
}

function eventData(items: unknown[]) {
  return {
    sessionId: 's-queue-v3',
    seq: 10,
    id: '22222222-2222-4222-8222-222222222222',
    version: SESSION_EVENT_VERSION_3,
    type: 'agent.queue',
    class: 'standard',
    spanId: null,
    parentSpanId: null,
    jobId: null,
    writerEpoch: 1,
    redactions: 0,
    createdAt: CREATED_AT,
    data: { items },
  }
}

function parseEvent(items: unknown[]): SessionEvent {
  return sessionEventSchema.parse(eventData(items))
}

function progress(queue: unknown[]) {
  return {
    version: 2,
    sessionId: 's-progress',
    projectId: 'p-progress',
    connectionId: 'c-progress',
    model: 'fixture-model',
    mode: 'read-only',
    status: 'running',
    plan: [],
    queue,
    summary: '',
    error: null,
    observedAt: CREATED_AT,
    source: 'session.log',
    confidence: 'high',
  }
}

describe('queue v3 contract', () => {
  it('parses strict inline and artifact branches and preserves plural references', () => {
    const event = parseEvent([
      { id: 'item-inline', kind: 'inline', text: 'small input' },
      { id: 'item-artifact', kind: 'artifact', artifact: artifact() },
    ])
    assert.equal(event.type, 'agent.queue')
    assert.equal(event.version, SESSION_EVENT_VERSION_3)
    if (event.type !== 'agent.queue' || event.version !== SESSION_EVENT_VERSION_3) throw new Error('expected v3 queue')
    assert.deepEqual(event.data.items.map((item) => item.id), ['item-inline', 'item-artifact'])
    assert.deepEqual(inputArtifactsOf(event), [artifact()])
    assert.equal(inputArtifactOf(event), null, 'the singleton helper does not describe a plural snapshot')
    assert.equal(queueItemDisplayTextOf(event.data.items[0]!), 'small input')
    assert.equal(queueItemDisplayTextOf(event.data.items[1]!), 'preview')
    assert.deepEqual(inputArtifactsOf(sessionEventSchema.parse({
      sessionId: 's-v1', seq: 1, id: '33333333-3333-4333-8333-333333333333',
      version: SESSION_EVENT_VERSION, type: 'agent.queue', class: 'standard',
      spanId: null, parentSpanId: null, jobId: null, writerEpoch: 1, redactions: 0, createdAt: CREATED_AT,
      data: { items: [{ id: 'legacy', text: 'legacy inline' }] },
    })), [])
  })

  it('rejects opposite branches, duplicate ids, wrong media, wrong sizes and mismatched excerpt bytes', () => {
    const cases: unknown[][] = [
      [{ id: 'a', kind: 'inline', text: 'x', artifact: artifact() }],
      [{ id: 'a', kind: 'artifact', text: 'x', artifact: artifact() }],
      [
        { id: 'same', kind: 'inline', text: 'one' },
        { id: 'same', kind: 'inline', text: 'two' },
      ],
      [{ id: 'a', kind: 'artifact', artifact: artifact('x', INPUT_INLINE_BYTES) }],
      [{ id: 'a', kind: 'artifact', artifact: { ...artifact(), mediaType: 'application/json' } }],
      [{ id: 'a', kind: 'artifact', artifact: { ...artifact('x'), excerptBytes: 2 } }],
      [{ id: 'a', kind: 'inline', text: 'x'.repeat(INPUT_INLINE_BYTES + 1) }],
    ]
    for (const items of cases) assert.equal(queueDataV3Schema.safeParse({ items }).success, false, JSON.stringify(items).slice(0, 120))
    assert.equal(queueDataV3Schema.safeParse({ items: [] }).success, true)
  })

  it('accepts exactly 16 KiB of scrubbed UTF-8 but not one byte more', () => {
    const exact = 'ё'.repeat(INPUT_INLINE_BYTES / 2)
    assert.equal(Buffer.byteLength(exact, 'utf8'), INPUT_INLINE_BYTES)
    assert.equal(queueV3SessionEventSchema.safeParse(eventData([{ id: 'exact', kind: 'inline', text: exact }])).success, true)
    const over = `${exact}ё`
    assert.ok(Buffer.byteLength(over, 'utf8') > INPUT_INLINE_BYTES)
    assert.equal(queueV3SessionEventSchema.safeParse(eventData([{ id: 'over', kind: 'inline', text: over }])).success, false)
  })

  it('allows version 3 only for standard agent.queue snapshots', () => {
    const otherType = {
      ...eventData([{ id: 'a', kind: 'inline', text: 'x' }]),
      type: 'prompt',
      data: { origin: 'typed', messageId: 'm', attachmentCount: 0 },
    }
    assert.equal(sessionEventSchema.safeParse(otherType).success, false)
    assert.equal(sessionEventSchema.safeParse(eventData([{ id: 'a', kind: 'inline', text: 'x' }])).success, true)
  })

  it('requires append descriptors instead of caller-selected artifact ids', () => {
    const descriptor = {
      checksum: CHECKSUM,
      byteSize: INPUT_INLINE_BYTES + 1,
      mediaType: 'text/plain; charset=utf-8',
      excerpt: 'preview',
    }
    assert.equal(queueAppendDataV3Schema.safeParse({
      items: [{ id: 'a', kind: 'artifact', input: descriptor }],
    }).success, true)
    for (const bad of [
      { items: [{ id: 'a', kind: 'artifact', artifact: artifact() }] },
      { items: [{ id: 'a', kind: 'artifact', input: { ...descriptor, artifactId: ARTIFACT_ID } }] },
      { items: [{ id: 'a', kind: 'artifact', input: { ...descriptor, byteSize: INPUT_INLINE_BYTES } }] },
      { items: [{ id: 'a', kind: 'artifact', input: { ...descriptor, mediaType: 'application/json' } }] },
      { items: [{ id: 'a', kind: 'inline', text: 'x' }, { id: 'a', kind: 'inline', text: 'y' }] },
    ]) assert.equal(queueAppendDataV3Schema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 120))
  })

  it('defines strict progress2 branches and the typed legacy refusal', () => {
    const legacy = {
      id: 'legacy-preview', kind: 'legacy-preview', excerpt: 'preview',
      excerptBytes: Buffer.byteLength('preview'), byteSize: INPUT_INLINE_BYTES + 1,
    }
    const parsed = agentProgressV2Schema.parse(progress([
      { id: 'inline', kind: 'inline', text: 'x' },
      { id: 'artifact', kind: 'artifact', artifact: artifact() },
      legacy,
    ]))
    assert.equal(parsed.version, 2)
    assert.deepEqual(parsed.queue.map((item) => item.kind), ['inline', 'artifact', 'legacy-preview'])
    assert.equal(agentProgressV2Schema.safeParse({ ...progress([]), version: 1 }).success, false)
    assert.equal(agentProgressV2Schema.safeParse(progress([{ ...legacy, text: 'not executable' }])).success, false)
    assert.equal(agentProgressV2Schema.safeParse(progress([{ ...legacy, byteSize: INPUT_INLINE_BYTES }])).success, false)
    assert.equal(agentProgressQuerySchema.parse({ progressVersion: '1' }).progressVersion, 1)
    assert.equal(agentProgressQuerySchema.parse({ progressVersion: '2' }).progressVersion, 2)
    assert.equal(agentProgressQuerySchema.parse({}).progressVersion, 1)
    assert.equal(agentProgressQuerySchema.safeParse({ progressVersion: '3' }).success, false)
    assert.equal(agentProgressQuerySchema.safeParse({ progressVersion: '2', extra: 'x' }).success, false)
    assert.deepEqual(
      nativeProgressVersionUnsupportedSchema.parse({ code: 'native_progress_version_unsupported', supported: 1, required: 2 }),
      { code: 'native_progress_version_unsupported', supported: 1, required: 2 },
    )
    assert.equal(nativeProgressVersionUnsupportedSchema.safeParse({
      code: 'native_progress_version_unsupported', supported: 1, required: 2, message: 'extra',
    }).success, false)
  })

  it('keeps export v1/v2 exact and adds export v3', () => {
    const v3 = parseEvent([{ id: 'a', kind: 'artifact', artifact: artifact() }])
    const v2 = sessionEventSchema.parse({
      sessionId: 's-export', seq: 1, id: '44444444-4444-4444-8444-444444444444',
      version: SESSION_EVENT_VERSION_2, type: 'prompt', class: 'standard',
      spanId: null, parentSpanId: null, jobId: null, writerEpoch: 1, redactions: 0, createdAt: CREATED_AT,
      data: { origin: 'typed', messageId: 'm', attachmentCount: 0, artifact: artifact('excerpt') },
    })
    const base = {
      sessionId: 's-export', exportedAt: CREATED_AT, lastSeq: 1,
      excluded: { reasoning: 0 }, events: [v3],
    }
    assert.equal(sessionExportSchema.safeParse({ ...base, exportVersion: 1 }).success, false)
    assert.equal(sessionExportSchema.safeParse({ ...base, exportVersion: 2 }).success, false)
    assert.equal(sessionExportSchema.safeParse({ ...base, exportVersion: 3 }).success, true)
    assert.equal(sessionExportSchema.safeParse({ ...base, exportVersion: 2, events: [v2] }).success, true)
    assert.equal(sessionExportSchema.safeParse({ ...base, exportVersion: 1, events: [v2] }).success, false)
    assert.equal(sessionExportQuery.parse({ exportVersion: '3' }).exportVersion, SESSION_EXPORT_VERSION_3)
    assert.equal(sessionExportQuery.safeParse({ exportVersion: '4' }).success, false)
    assert.equal(sessionEventsQuery.parse({ eventVersion: '3' }).eventVersion, SESSION_EVENT_VERSION_3)
    assert.equal(sessionEventsQuery.safeParse({ eventVersion: '4' }).success, false)
    assert.equal(SESSION_EXPORT_VERSION_2, 2)
    assert.equal(SESSION_EXPORT_VERSION, 1)
    assert.equal(INPUT_EXCERPT_BYTES, 8192)
  })

  it('keeps the v33 trigger shape and the v1/v2/reasoning clauses verbatim in migration 40', () => {
    assert.equal(normalized(installedV33Trigger()), normalized(V33_POLICY_TRIGGER_SQL))
    const v33 = normalized(V33_POLICY_TRIGGER_SQL)
    const v40 = normalized(SESSION_QUEUE_POLICY_TRIGGER_SQL)
    assert.match(v40, /NEW\.event_version NOT IN \(1,2,3\)/u)
    // The v1/reasoning header and the whole v2 branch are unchanged.
    for (const fragment of [
      `WHEN NEW.event_version NOT IN (1,2)`,
      `OR NEW.payload IS NULL`,
      `OR NEW.purged_at IS NOT NULL`,
      `OR (NEW.class = 'reasoning') <> (NEW.type = 'reasoning')`,
      `OR (NEW.class = 'reasoning') <> (NEW.expires_at IS NOT NULL)`,
      `OR (NEW.event_version = 2 AND (`,
      `NEW.type NOT IN ('prompt','tool.call')`,
      `NEW.type NOT IN ('prompt','tool.call') OR json_type(NEW.payload, '$.artifact') IS NOT 'object'`,
      `OR NOT EXISTS ( SELECT 1 FROM session_input_artifacts artifact`,
    ]) {
      if (fragment.startsWith('WHEN')) assert.equal(v40.includes(fragment.replace('(1,2)', '(1,2,3)')), true, fragment)
      else assert.equal(v40.includes(fragment), true, fragment)
    }
    assert.equal(v40.includes('OR (NEW.event_version = 3 AND ('), true)
    assert.equal(v40.includes(`json_type(NEW.payload, '$.items') IS NOT 'array'`), true)
    assert.equal(v40.includes('json_extract(item.value'), true)
  })

  it('imports and parses from both public entries in a cold child process', () => {
    const eventsEntry = new URL('../../contract/src/events/index.ts', import.meta.url).href
    const nativeEntry = new URL('../../contract/src/native-agent.ts', import.meta.url).href
    const rootEntry = new URL('../../contract/src/index.ts', import.meta.url).href
    const fixture = parseEvent([
      { id: 'cold-inline', kind: 'inline', text: 'cold' },
      { id: 'cold-artifact', kind: 'artifact', artifact: artifact() },
    ])
    const script = `
      import { sessionEventSchema, inputArtifactsOf } from ${JSON.stringify(eventsEntry)}
      import { agentProgressV2Schema, agentProgressQuerySchema, nativeProgressVersionUnsupportedSchema } from ${JSON.stringify(nativeEntry)}
      import * as root from ${JSON.stringify(rootEntry)}
      const event = ${JSON.stringify(fixture)}
      if (!sessionEventSchema.safeParse(event).success) throw new Error('cold event parse failed')
      if (inputArtifactsOf(event).length !== 1) throw new Error('cold plural reference failed')
      if (!root.sessionEventSchema.safeParse(event).success) throw new Error('cold root parse failed')
      if (agentProgressQuerySchema.parse({ progressVersion: '2' }).progressVersion !== 2) throw new Error('cold query failed')
      if (!agentProgressV2Schema.safeParse(${JSON.stringify(progress([
        { id: 'inline', kind: 'inline', text: 'x' },
      ]))}).success) throw new Error('cold progress parse failed')
      if (!nativeProgressVersionUnsupportedSchema.safeParse({ code: 'native_progress_version_unsupported', supported: 1, required: 2 }).success) throw new Error('cold refusal parse failed')
      console.log('cold-import-ok')
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /cold-import-ok/u)
  })
})
