import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStrip, utf8ByteCounter } from '../../src/work/strip.ts'
import { deriveStatuses, workView } from '../../src/work/status.ts'
import { query } from '../../src/work/query.ts'
import { exportMarkdown } from '../../src/work/export.ts'
import type {
  DerivedStatus, EvidenceEvent, ItemSpec, PlanRevision, StripBlockingIssue,
  StripView, StripWorkItem,
} from '../../src/work/types.ts'

const AT = '2026-10-20T12:00:00.000Z'

function item(id: string, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    id, title: `Item ${id}`, acceptance: 'node --test', dependsOn: [],
    estimateMinutes: null, ownerRole: null, protectedPaths: [], ...overrides,
  }
}

function plan(items: ItemSpec[], revision = 1): PlanRevision {
  return { projectId: 'project', revision, createdAt: AT, author: 'lead', items }
}

function stripItem(id: string, title: string, status: DerivedStatus, acceptance: string | null = 'node --test'): StripWorkItem {
  return { id, title, acceptance, status }
}

test('strip keeps all required fields when the budget fits', () => {
  const view: StripView = {
    current: stripItem('a', 'Implement parser', 'in_progress', 'node --test'),
    next: stripItem('b', 'Write documentation', 'ready'),
    blocking: [{ id: 'c', title: 'Blocked migration', blockedBy: ['a', 'b'] }],
  }
  const strip = buildStrip(view, utf8ByteCounter, 300)
  assert.match(strip, /^work: a in_progress$/m)
  assert.match(strip, /^current: Implement parser$/m)
  assert.match(strip, /^acceptance: node --test$/m)
  assert.match(strip, /^next: b Write documentation$/m)
  assert.match(strip, /^blocked: c \(Blocked migration\) <- a, b$/m)
  assert.ok(utf8ByteCounter(strip) <= 300)
})

test('buildStrip defaults to the conservative UTF-8 byte counter', () => {
  assert.equal(buildStrip({ current: null, next: null, blocking: [] }), 'work: idle')
  assert.equal(buildStrip({ current: null, next: null, blocking: [] }, utf8ByteCounter, 0), '')
})

test('strip truncates in the documented priority order and never splits UTF-8', () => {
  const view: StripView = {
    current: stripItem('current-item', 'A very long current title 🙂 with unicode', 'in_progress', 'npm run a-very-long-acceptance-command --flag=value'),
    next: stripItem('next-item', 'A very long next title 中文字符', 'ready'),
    blocking: [
      { id: 'blocked-one', title: 'First blocked title', blockedBy: ['dependency-one', 'dependency-two'] },
      { id: 'blocked-two', title: 'Second blocked title', blockedBy: ['dependency-three'] },
    ],
  }
  const header = 'work: current-item in_progress'
  const exactHeader = buildStrip(view, utf8ByteCounter, utf8ByteCounter(header))
  assert.equal(exactHeader, header)
  const reduced = buildStrip(view, utf8ByteCounter, utf8ByteCounter(header) - 1)
  assert.ok(utf8ByteCounter(reduced) <= utf8ByteCounter(header) - 1)
  assert.ok(reduced.startsWith('work: current-item'))
  assert.equal(buildStrip(view, utf8ByteCounter, 0), '')
  assert.equal(buildStrip(view, utf8ByteCounter, 1), 'w')

  const tight = buildStrip(view, utf8ByteCounter, 20)
  assert.ok(utf8ByteCounter(tight) <= 20)
  assert.ok(tight.includes('\u2026') || tight === 'work: current-item' || tight === 'work')
  assert.equal(Buffer.from(tight, 'utf8').toString('utf8'), tight)
  assert.doesNotMatch(tight, /\uFFFD/)
})

test('strip drops blocking entries before touching next or current fields', () => {
  const view: StripView = {
    current: stripItem('a', 'Current', 'in_progress', 'command'),
    next: stripItem('b', 'Next', 'ready'),
    blocking: [
      { id: 'c', title: 'First', blockedBy: ['a'] },
      { id: 'd', title: 'Second', blockedBy: ['a'] },
    ],
  }
  const full = buildStrip(view, utf8ByteCounter, 10_000)
  const lastLine = 'blocked: d (Second) <- a'
  const trimmed = buildStrip(view, utf8ByteCounter, utf8ByteCounter(full) - utf8ByteCounter(lastLine) - 1)
  assert.equal(trimmed, full.split('\n').slice(0, -1).join('\n'))
  assert.ok(trimmed.includes('blocked: c (First) <- a'))
  assert.ok(trimmed.includes('next: b Next'))
})

test('strip property: 500 seeded plans/views stay within both counters', () => {
  const random = mulberry32(0x5eed1234)
  const chars = ['a', 'B', '0', ' ', '-', '_', 'é', 'Ж', '中', '🙂', '🧪', '\n']
  const statuses: DerivedStatus[] = ['proposed', 'blocked', 'ready', 'in_progress', 'verification_requested', 'done', 'failed', 'canceled']
  const text = (max: number): string => {
    const length = Math.floor(random() * max)
    let value = ''
    for (let index = 0; index < length; index++) value += chars[Math.floor(random() * chars.length)]
    return value
  }
  const maybeItem = (): StripWorkItem | null => random() < 0.2 ? null : stripItem(
    `id-${Math.floor(random() * 1000)}-${text(8)}`,
    text(400),
    statuses[Math.floor(random() * statuses.length)]!,
    random() < 0.2 ? null : text(300),
  )
  const tight = (value: string): number => Math.ceil(Buffer.byteLength(value, 'utf8') / 6)
  for (let testCase = 0; testCase < 500; testCase++) {
    const blocking: StripBlockingIssue[] = []
    const blockingCount = Math.floor(random() * 6)
    for (let index = 0; index < blockingCount; index++) {
      const deps = Array.from({ length: Math.floor(random() * 5) }, () => `dep-${text(12)}`)
      blocking.push({ id: `blocked-${index}-${text(10)}`, title: text(200), blockedBy: deps })
    }
    const randomView: StripView = { current: maybeItem(), next: random() < 0.3 ? null : maybeItem(), blocking }
    const planItems = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, index) => item(
      `generated-${testCase}-${index}`,
      { title: text(400), acceptance: random() < 0.2 ? null : text(300), dependsOn: [] },
    ))
    const generatedPlan = plan(planItems, 1 + testCase % 3)
    const generatedEvents: EvidenceEvent[] = []
    for (let count = 0; count < Math.floor(random() * 8); count++) {
      const target = planItems[Math.floor(random() * planItems.length)]!
      const roll = random()
      if (roll < 0.25) generatedEvents.push({ type: 'claimed', itemId: target.id, at: AT, source: 'agent:executor' })
      else if (roll < 0.45) generatedEvents.push({ type: 'verification_requested', itemId: target.id, at: AT, source: 'agent:executor' })
      else if (roll < 0.65) generatedEvents.push({
        type: 'acceptance_result', itemId: target.id, at: AT, source: 'harness:acceptance',
        passed: random() < 0.7, cleanCheckout: random() < 0.7, commit: `commit-${count}`, command: 'node --test',
      })
      else if (roll < 0.8) generatedEvents.push({ type: 'commit_accepted', itemId: target.id, at: AT, source: 'harness:commits', commit: `commit-${count}` })
      else if (roll < 0.9) generatedEvents.push({ type: 'human_decision', itemId: target.id, at: AT, source: 'user:owner', decision: 'cancel' })
      else generatedEvents.push({ type: 'human_decision', itemId: target.id, at: AT, source: 'user:owner', decision: 'reopen' })
    }
    const view = random() < 0.5 ? workView(generatedPlan, deriveStatuses(generatedPlan, generatedEvents)) : randomView
    const budgets = [0, 1, 2, 5, 10, 25, 50, 100, 300, Math.floor(random() * 600)]
    for (const budget of budgets) {
      for (const count of [tight, utf8ByteCounter]) {
        const strip = buildStrip(view, count, budget)
        assert.equal(typeof strip, 'string')
        assert.ok(
          count(strip) <= budget,
          `case=${testCase} budget=${budget} count=${count(strip)} strip=${JSON.stringify(strip.slice(0, 120))}`,
        )
      }
    }
  }
})

test('workView selects active work, the next ready item and blocking issues', () => {
  const p = plan([
    item('a', { dependsOn: ['b'] }),
    item('b'),
    item('c'),
    item('d', { dependsOn: ['a'] }),
  ])
  const statuses = deriveStatuses(p, [
    { type: 'claimed', itemId: 'b', at: AT, source: 'agent:executor' },
  ])
  const view = workView(p, statuses)
  assert.equal(view.current?.id, 'b')
  assert.equal(view.current?.status, 'in_progress')
  assert.equal(view.next?.id, 'c')
  assert.deepEqual(view.blocking.map(issue => [issue.id, issue.blockedBy]), [['a', ['b']], ['d', ['a']]])
})

test('query pages the full graph with an id cursor that survives new events', () => {
  const p = plan([item('a'), item('b'), item('c'), item('d'), item('e')])
  let statuses = deriveStatuses(p, [])
  const first = query(statuses, p, { limit: 2 })
  assert.deepEqual(first.items.map(entry => entry.id), ['a', 'b'])
  assert.equal(first.total, 5)
  assert.equal(first.nextCursor === null, false)

  statuses = deriveStatuses(p, [{ type: 'claimed', itemId: 'a', at: AT, source: 'agent:executor' }])
  const second = query(statuses, p, { limit: 2, cursor: first.nextCursor! })
  assert.deepEqual(second.items.map(entry => entry.id), ['c', 'd'])
  assert.equal(second.total, 5)
  assert.equal(second.items.some(entry => entry.id === 'a' || entry.id === 'b'), false)

  const third = query(statuses, p, { limit: 2, cursor: second.nextCursor! })
  assert.deepEqual(third.items.map(entry => entry.id), ['e'])
  assert.equal(third.nextCursor, null)

  assert.deepEqual(query(statuses, p, {}).items.map(entry => entry.id), ['a', 'b', 'c', 'd', 'e'])

  const filtered = query(statuses, p, { status: 'in_progress', limit: 10 })
  assert.deepEqual(filtered.items.map(entry => [entry.id, entry.status]), [['a', 'in_progress']])
  assert.throws(() => query(statuses, p, { status: 'in_progress', limit: 1, cursor: first.nextCursor! }), /cursor_mismatch/)
  assert.throws(() => query(statuses, p, { limit: 0 }), /invalid_paging/)
  assert.throws(() => query(statuses, p, { limit: 1, cursor: 'not-a-cursor' }), /invalid_cursor/)
})

test('query cursor survives rejection of the cursor item and earlier proposals', () => {
  const p = plan([item('a')])
  const b = item('b')
  const c = item('c')
  const d = item('d')
  const events: EvidenceEvent[] = [
    { type: 'proposed', itemId: 'b', at: AT, source: 'agent:planner', item: b },
    { type: 'accepted', itemId: 'b', at: AT, source: 'lead:owner' },
    { type: 'proposed', itemId: 'c', at: AT, source: 'agent:planner', item: c },
    { type: 'accepted', itemId: 'c', at: AT, source: 'lead:owner' },
    { type: 'proposed', itemId: 'd', at: AT, source: 'agent:planner', item: d },
    { type: 'accepted', itemId: 'd', at: AT, source: 'lead:owner' },
  ]
  const first = query(deriveStatuses(p, events), p, { limit: 3 })
  assert.deepEqual(first.items.map(entry => entry.id), ['a', 'b', 'c'])
  const rejected: EvidenceEvent[] = [
    ...events,
    { type: 'rejected', itemId: 'b', at: AT, source: 'lead:owner' },
    { type: 'rejected', itemId: 'c', at: AT, source: 'lead:owner' },
  ]
  const page = query(deriveStatuses(p, rejected), p, { limit: 10, cursor: first.nextCursor! })
  assert.deepEqual(page.items.map(entry => entry.id), ['d'])
  assert.equal(page.total, 2)
})

test('query includes accepted proposals and drops rejected ones', () => {
  const p = plan([item('a')])
  const d = item('d', { title: 'Proposal D' })
  const e = item('e', { title: 'Proposal E' })
  const events: EvidenceEvent[] = [
    { type: 'proposed', itemId: 'd', at: AT, source: 'agent:planner', item: d },
    { type: 'accepted', itemId: 'd', at: AT, source: 'lead:owner' },
  ]
  let statuses = deriveStatuses(p, events)
  let page = query(statuses, p, { limit: 10 })
  assert.deepEqual(page.items.map(entry => [entry.id, entry.status]), [['a', 'ready'], ['d', 'ready']])

  statuses = deriveStatuses(p, [
    ...events,
    { type: 'proposed', itemId: 'e', at: AT, source: 'agent:planner', item: e },
    { type: 'rejected', itemId: 'e', at: AT, source: 'lead:owner' },
  ])
  page = query(statuses, p, { limit: 10 })
  assert.deepEqual(page.items.map(entry => entry.id), ['a', 'd'])
})

test('exportMarkdown projects status, acceptance and evidence without writing files', () => {
  const p = plan([
    item('a', { title: 'Parser', acceptance: 'node --test', protectedPaths: ['src/parser.ts'] }),
    item('b', { title: 'Docs', acceptance: null, dependsOn: ['a'] }),
  ], 2)
  const events: EvidenceEvent[] = [
    { type: 'claimed', itemId: 'a', at: AT, source: 'agent:executor' },
    { type: 'verification_requested', itemId: 'a', at: AT, source: 'agent:executor' },
    { type: 'acceptance_result', itemId: 'a', at: AT, source: 'harness:acceptance', passed: true, cleanCheckout: true, commit: 'abc123', command: 'node --test' },
    { type: 'commit_accepted', itemId: 'a', at: AT, source: 'harness:commits', commit: 'abc123' },
    { type: 'judge_verdict', itemId: 'a', at: AT, source: 'harness:judge', verdict: 'pass' },
  ]
  const statuses = deriveStatuses(p, events)
  const markdown = exportMarkdown(p, statuses)
  assert.match(markdown, /^# Work ledger — project$/m)
  assert.match(markdown, /^Revision 2 · lead · 2026-10-20T12:00:00.000Z$/m)
  assert.match(markdown, /^- done: 1$/m)
  assert.match(markdown, /^- ready: 1$/m)
  assert.match(markdown, /^### \[done\] `a` — Parser$/m)
  assert.match(markdown, /^### \[ready\] `b` — Docs$/m)
  assert.match(markdown, /- Acceptance: `node --test`/)
  assert.match(markdown, /- Acceptance: none \(human decision only\)/)
  assert.match(markdown, /- Depends on: `a`/)
  assert.match(markdown, /- Protected paths: `src\/parser\.ts`/)
  assert.match(markdown, /`acceptance_result` at `2026-10-20T12:00:00.000Z` from `harness:acceptance`/)
  assert.match(markdown, /commit=`abc123`/)
  assert.ok(markdown.endsWith('\n'))
  assert.doesNotMatch(markdown, /undefined/)
})

test('exportMarkdown reports unknown-item warnings', () => {
  const p = plan([item('a')])
  const statuses = deriveStatuses(p, [{ type: 'claimed', itemId: 'ghost', at: AT, source: 'agent:executor' }])
  const markdown = exportMarkdown(p, statuses)
  assert.match(markdown, /^## Warnings$/m)
  assert.match(markdown, /- `ghost`: unknown_item \(`claimed`\)/)
})

/** Small deterministic PRNG: no dependency and identical on every Node release. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
