import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ZodTypeAny } from 'zod'
import {
  GLOSSARY_LANGUAGES,
  GLOSSARY_REVISION_OPS,
  GLOSSARY_REVISION_SOURCES,
  GLOSSARY_SCOPES,
  NOTIFICATION_ACTIONS,
  NOTIFICATION_LIST_DEFAULT_LIMIT,
  NOTIFICATION_STATES,
  NOTIFICATION_WIRE_ACTIONS,
  WORK_DERIVED_STATUSES,
  WORK_EVENT_TYPES,
  WORK_MODES,
  WORK_OWNER_ROLES,
  WORK_WIRE_EVENT_TYPES,
  addWorkRevisionBodySchema,
  appendWorkEventBodySchema,
  createGlossaryEntryBodySchema,
  executeNotificationActionBodySchema,
  glossaryEntryBodySchema,
  glossaryPreviewBodySchema,
  glossaryRevisionSchema,
  listGlossaryQuerySchema,
  listNotificationsQuerySchema,
  listWorkItemsQuerySchema,
  notificationActionAvailabilitySchema,
  notificationSchema,
  quotaWindowSchema,
  setWorkModeBodySchema,
  snoozeNotificationBodySchema,
  storedGlossaryEntrySchema,
  workEvidenceEventSchema,
  workItemSpecSchema,
  workPlanRevisionSchema,
  type NotificationWire,
} from '@guanxi/contract'
import { NOTIFICATION_ACTIONS as SERVER_ACTIONS, NOTIFICATION_STATES as SERVER_STATES, QUOTA_ALERT_ACTIONS } from '../src/notifications/store.ts'
import { WIRE_ACTIONS } from '../src/notifications/inbox.ts'
import type { QuotaWindowKind } from '../src/notifications/types.ts'
import { GlossaryStore, type GlossaryRevisionOp, type GlossaryRevisionSource } from '../src/voice/store.ts'
import { toStoredEntryWire } from '../src/voice/wire.ts'
import { compileGlossary, type GlossaryLanguage } from '../src/voice/glossary.ts'
import { DERIVED_STATUSES, OWNER_ROLES, PLAN_AUTHORS, WORK_MODES as SERVER_MODES, parseEvidenceEvent, type EvidenceEventType } from '../src/work/types.ts'

const sorted = (values: readonly string[]) => [...values].sort()

test('contract enums equal the server constants they mirror', () => {
  assert.deepEqual(sorted(NOTIFICATION_STATES), sorted(SERVER_STATES))
  assert.deepEqual(sorted(NOTIFICATION_ACTIONS), sorted(SERVER_ACTIONS))
  assert.deepEqual(sorted(NOTIFICATION_WIRE_ACTIONS), sorted(WIRE_ACTIONS), 'the executable subset is one list on both sides')
  assert.deepEqual(sorted(WORK_MODES), sorted(SERVER_MODES))
  assert.deepEqual(sorted(WORK_OWNER_ROLES), sorted(OWNER_ROLES))
  assert.deepEqual(sorted(WORK_DERIVED_STATUSES), sorted(DERIVED_STATUSES))
  assert.deepEqual(sorted(['user', 'lead']), sorted(PLAN_AUTHORS))
  // Type-level exhaustiveness: adding a window, op, source or language to the server breaks the build here.
  const windows = { five_hour: 1, seven_day: 1, daily: 1, monthly: 1, balance: 1, rate_requests: 1, rate_tokens: 1 } satisfies Record<QuotaWindowKind, 1>
  assert.deepEqual(sorted(quotaWindowSchema.options), sorted(Object.keys(windows)))
  const ops = { create: 1, update: 1, deactivate: 1, reactivate: 1, revert: 1 } satisfies Record<GlossaryRevisionOp, 1>
  assert.deepEqual(sorted(GLOSSARY_REVISION_OPS), sorted(Object.keys(ops)))
  const sources = { user: 1, import: 1, candidate: 1 } satisfies Record<GlossaryRevisionSource, 1>
  assert.deepEqual(sorted(GLOSSARY_REVISION_SOURCES), sorted(Object.keys(sources)))
  const languages = { en: 1, ru: 1, any: 1 } satisfies Record<GlossaryLanguage, 1>
  assert.deepEqual(sorted(GLOSSARY_LANGUAGES), sorted(Object.keys(languages)))
  assert.deepEqual([...GLOSSARY_SCOPES], ['account', 'project'])
  const events = { proposed: 1, accepted: 1, rejected: 1, claimed: 1, released: 1, verification_requested: 1, acceptance_result: 1, commit_accepted: 1, judge_verdict: 1, human_decision: 1 } satisfies Record<EvidenceEventType, 1>
  assert.deepEqual(sorted(WORK_EVENT_TYPES), sorted(Object.keys(events)))
})

test('every action a quota alert offers is representable on the wire', () => {
  for (const [kind, actions] of Object.entries(QUOTA_ALERT_ACTIONS)) {
    for (const action of actions) assert.ok((NOTIFICATION_ACTIONS as readonly string[]).includes(action), `${kind}:${action}`)
  }
  assert.deepEqual(notificationActionAvailabilitySchema.options, ['available', 'not_configured', 'not_exposed'])
  const offeredButNotExposed = SERVER_ACTIONS.filter((action) => !(NOTIFICATION_WIRE_ACTIONS as readonly string[]).includes(action))
  assert.deepEqual(sorted(offeredButNotExposed), ['add_prompt', 'choose_action', 'raise_budget'])
  for (const action of offeredButNotExposed) {
    for (const actions of Object.values(QUOTA_ALERT_ACTIONS)) assert.ok(!actions.includes(action), `quota alerts offer no ${action}`)
  }
})

test('every glossary language the compiler accepts, and no other, is a wire language', () => {
  for (const language of GLOSSARY_LANGUAGES) {
    assert.doesNotThrow(() => compileGlossary([{ id: 'x', canonical: 'Term', variants: [], language }]), language)
    assert.ok(glossaryEntryBodySchema.safeParse({ canonical: 'Term', variants: [], language }).success)
  }
  assert.throws(() => compileGlossary([{ id: 'x', canonical: 'Term', variants: [], language: 'de' as never }]))
  assert.ok(!glossaryEntryBodySchema.safeParse({ canonical: 'Term', variants: [], language: 'de' }).success)
})

test('a store revision of every op and source parses as a wire revision', () => {
  const store = new GlossaryStore(':memory:', () => 1)
  try {
    store.create('a', 'account', null, { id: 'one', canonical: 'One', variants: [], language: 'en' }, 'import')
    store.create('a', 'project', 'p1', { id: 'two', canonical: 'Two', variants: [], language: 'en' }, 'candidate')
    store.update('a', 'one', { id: 'one', canonical: 'One', variants: ['uno'], language: 'en' }, 'user')
    store.deactivate('a', 'one'); store.reactivate('a', 'one'); store.revert('a', 'one')
    const seen = new Set<string>()
    for (const id of ['one', 'two']) {
      for (const revision of store.history('a', id)) {
        const wire = glossaryRevisionSchema.parse(revision)
        seen.add(`${wire.op}/${wire.source}`)
      }
    }
    for (const op of GLOSSARY_REVISION_OPS) assert.ok([...seen].some((key) => key.startsWith(`${op}/`)), op)
    for (const source of GLOSSARY_REVISION_SOURCES) assert.ok([...seen].some((key) => key.endsWith(`/${source}`)), source)
    for (const row of store.list('a', { includeInactive: true })) {
      assert.doesNotThrow(() => storedGlossaryEntrySchema.parse(toStoredEntryWire(row)))
      assert.ok(!storedGlossaryEntrySchema.safeParse(row).success, 'the raw row, with its account id, is not a wire shape')
    }
  } finally { store.close() }
})

test('every evidence event the library accepts parses on the wire; only the human subset is writable', () => {
  const item = { id: 'a', title: 'A', acceptance: null, dependsOn: [], estimateMinutes: null, ownerRole: null, protectedPaths: [] }
  const base = { itemId: 'a', at: '2026-10-23T00:00:00.000Z' }
  const samples: Record<string, unknown> = {
    proposed: { ...base, type: 'proposed', source: 'agent:executor', item },
    accepted: { ...base, type: 'accepted', source: 'user:local' },
    rejected: { ...base, type: 'rejected', source: 'user:local' },
    claimed: { ...base, type: 'claimed', source: 'agent:executor' },
    released: { ...base, type: 'released', source: 'agent:executor' },
    verification_requested: { ...base, type: 'verification_requested', source: 'agent:executor' },
    acceptance_result: { ...base, type: 'acceptance_result', source: 'harness:acceptance', passed: true, commit: 'abc', cleanCheckout: true, command: 'npm test' },
    commit_accepted: { ...base, type: 'commit_accepted', source: 'harness:acceptance', commit: 'abc' },
    judge_verdict: { ...base, type: 'judge_verdict', source: 'harness:judge', verdict: 'pass' },
    human_decision: { ...base, type: 'human_decision', source: 'user:local', decision: 'done' },
  }
  assert.deepEqual(sorted(Object.keys(samples)), sorted(WORK_EVENT_TYPES))
  for (const [type, sample] of Object.entries(samples)) {
    assert.doesNotThrow(() => parseEvidenceEvent(sample), type)
    assert.doesNotThrow(() => workEvidenceEventSchema.parse({ ...(sample as object), seq: 3 }), type)
    assert.ok(!workEvidenceEventSchema.safeParse({ ...(sample as object), extra: 1 }).success, `${type} rejects unknown keys`)
    const writable = (WORK_WIRE_EVENT_TYPES as readonly string[]).includes(type)
    const body = { type, itemId: 'a', ...(type === 'human_decision' ? { decision: 'done' } : {}) }
    assert.equal(appendWorkEventBodySchema.safeParse(body).success, writable, `${type} writable=${writable}`)
  }
  assert.deepEqual(sorted(WORK_WIRE_EVENT_TYPES), ['accepted', 'human_decision', 'rejected'])
  // Producer prefixes: the three writable types are exactly those a user may produce.
  for (const type of WORK_WIRE_EVENT_TYPES) assert.doesNotThrow(() => parseEvidenceEvent({ ...base, type, source: 'user:local', decision: 'done', itemId: 'a' }))
  for (const type of WORK_EVENT_TYPES.filter((candidate) => !(WORK_WIRE_EVENT_TYPES as readonly string[]).includes(candidate))) {
    assert.throws(() => parseEvidenceEvent({ ...(samples[type] as object), source: 'user:local' }), { code: 'invalid_source' }, `${type} cannot be produced by a user`)
  }
})

test('request schemas reject unknown keys and boundary values', () => {
  const strictCases: Array<[string, ZodTypeAny, unknown]> = [
    ['snooze', snoozeNotificationBodySchema, { untilMs: 1 }],
    ['action open', executeNotificationActionBodySchema, { action: 'open', args: {} }],
    ['glossary body', glossaryEntryBodySchema, { canonical: 'A', variants: [], language: 'en' }],
    ['glossary create', createGlossaryEntryBodySchema, { scope: 'account', entry: { canonical: 'A', variants: [], language: 'en' } }],
    ['preview', glossaryPreviewBodySchema, { text: 'x' }],
    ['revision', addWorkRevisionBodySchema, { items: [] }],
    ['item', workItemSpecSchema, { id: 'a', title: 'A' }],
    ['event', appendWorkEventBodySchema, { type: 'accepted', itemId: 'a' }],
    ['mode', setWorkModeBodySchema, { mode: 'off', reason: 'x' }],
  ]
  for (const [name, schema, sample] of strictCases) {
    assert.ok(schema.safeParse(sample).success, `${name} accepts its sample`)
    assert.ok(!schema.safeParse({ ...(sample as object), extra: 1 }).success, `${name} rejects an unknown key`)
  }
  assert.ok(!snoozeNotificationBodySchema.safeParse({ untilMs: -1 }).success)
  assert.ok(!snoozeNotificationBodySchema.safeParse({ untilMs: 1.5 }).success)
  assert.ok(!snoozeNotificationBodySchema.safeParse({ untilMs: Number.MAX_SAFE_INTEGER + 2 }).success)
})

test('notification action arguments hold identifiers, enums and integers, never prose', () => {
  const parse = (body: unknown) => executeNotificationActionBodySchema.safeParse(body).success
  for (const body of [
    { action: 'open' }, { action: 'wake_leads' }, { action: 'wake_leads', args: { connectionId: 'conn-1' } },
    { action: 'accept_recommendation', args: { recommendation: 'snooze' } },
    { action: 'switch_connection', args: { connectionId: 'deepseek-flash', role: 'reviewer' } },
    { action: 'pause_runs', args: { runIds: ['run_1', 'run_2'] } }, { action: 'resume_runs', args: { connectionId: 'c' } },
    { action: 'snooze', args: { untilMs: 1_800_000_000_000 } },
  ]) assert.ok(parse(body), JSON.stringify(body))
  for (const body of [
    { action: 'add_prompt', args: { prompt: 'x' } }, { action: 'choose_action', args: { choice: 'x' } }, { action: 'raise_budget', args: {} },
    { action: 'switch_connection', args: { connectionId: 'two words' } }, { action: 'switch_connection', args: { connectionId: 'c', role: 'Any Role' } },
    { action: 'switch_connection', args: {} }, { action: 'accept_recommendation', args: { recommendation: 'anything else' } },
    { action: 'pause_runs', args: { runIds: ['has space'] } }, { action: 'pause_runs', args: { runIds: [] } },
    { action: 'wake_leads', args: { connectionId: '../etc' } }, { action: 'snooze', args: {} }, { action: 'snooze', args: { untilMs: 'tomorrow' } },
    { action: 'open', args: { url: 'https://example.invalid' } },
  ]) assert.ok(!parse(body), JSON.stringify(body))
  const oversized = 'x'.repeat(129)
  assert.ok(!parse({ action: 'wake_leads', args: { connectionId: oversized } }))
})

test('query schemas parse the strings a URL carries and apply the documented defaults', () => {
  const defaults = listNotificationsQuerySchema.parse({})
  assert.equal(defaults.limit, NOTIFICATION_LIST_DEFAULT_LIMIT)
  assert.equal(defaults.state, undefined)
  assert.equal(defaults.before, undefined)
  assert.deepEqual(listNotificationsQuerySchema.parse({ state: 'unread,read,unread', limit: '200' }).state, ['unread', 'read'])
  assert.equal(listNotificationsQuerySchema.parse({ limit: '200' }).limit, 200)
  for (const bad of [{ limit: '0' }, { limit: '201' }, { limit: '1.5' }, { state: 'unread,' }, { before: 'ntf_x' }]) {
    assert.ok(!listNotificationsQuerySchema.safeParse(bad).success, JSON.stringify(bad))
  }
  assert.equal(listGlossaryQuerySchema.parse({}).includeInactive, false)
  assert.equal(listGlossaryQuerySchema.parse({ includeInactive: 'true' }).includeInactive, true)
  assert.equal(listWorkItemsQuerySchema.parse({}).limit, undefined, 'no limit means the whole graph')
  assert.equal(listWorkItemsQuerySchema.parse({ limit: '1000' }).limit, 1000)
  assert.ok(!listWorkItemsQuerySchema.safeParse({ limit: '1001' }).success)
})

test('response schemas refuse fields that belong on the node', () => {
  const row: NotificationWire = {
    id: `ntf_${'a'.repeat(40)}`, kind: 'threshold', severity: 'info', subject: { type: 'connection', id: 'c' },
    facts: { window: 'five_hour', threshold: 20, remainingPercent: 19, resetsAt: null, source: 's', observedAt: 't', confidence: 'observed' },
    actions: ['open'], state: 'unread', snoozedUntil: null, createdAt: 1, updatedAt: 1,
  }
  assert.ok(notificationSchema.safeParse(row).success)
  for (const leak of ['accountId', 'idempotencyKey', 'instanceKey']) assert.ok(!notificationSchema.safeParse({ ...row, [leak]: 'x' }).success, leak)
  assert.ok(!notificationSchema.safeParse({ ...row, facts: { ...row.facts, instanceKey: 'x' } }).success)
  const entry = { id: 'e', canonical: 'E', variants: [], language: 'en' }
  const stored = { id: 'e', scope: 'account', projectId: null, entry, active: true, revision: 1, createdAt: 1, updatedAt: 1 }
  assert.ok(storedGlossaryEntrySchema.safeParse(stored).success)
  assert.ok(!storedGlossaryEntrySchema.safeParse({ ...stored, accountId: 'a' }).success)
  const plan = { projectId: 'p', revision: 1, createdAt: 't', author: 'user', items: [] }
  assert.ok(workPlanRevisionSchema.safeParse(plan).success)
  assert.ok(!workPlanRevisionSchema.safeParse({ ...plan, author: 'harness' }).success)
})
