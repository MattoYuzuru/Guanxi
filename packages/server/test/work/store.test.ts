import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { WorkStore, shouldActivateProject } from '../../src/work/store.ts'
import { deriveStatuses } from '../../src/work/status.ts'
import { WorkError, type EvidenceEvent, type ItemSpec } from '../../src/work/types.ts'

const FIXED = Date.parse('2026-10-20T12:00:00.000Z')

function item(id: string, overrides: Partial<ItemSpec> = {}): ItemSpec {
  return {
    id, title: `Item ${id}`, acceptance: 'node --test', dependsOn: [],
    estimateMinutes: null, ownerRole: null, protectedPaths: [], ...overrides,
  }
}

function event(type: EvidenceEvent['type'], itemId: string): EvidenceEvent {
  if (type === 'acceptance_result') {
    return { type, itemId, at: new Date(FIXED).toISOString(), source: 'harness', passed: true, cleanCheckout: true, commit: 'c1', command: 'node --test' }
  }
  if (type === 'commit_accepted') {
    return { type, itemId, at: new Date(FIXED).toISOString(), source: 'lead', commit: 'c1' }
  }
  if (type === 'judge_verdict') {
    return { type, itemId, at: new Date(FIXED).toISOString(), source: 'judge', verdict: 'fail' }
  }
  if (type === 'human_decision') {
    return { type, itemId, at: new Date(FIXED).toISOString(), source: 'user', decision: 'cancel' }
  }
  if (type === 'proposed') {
    return { type, itemId, at: new Date(FIXED).toISOString(), source: 'agent', item: item(itemId) }
  }
  return { type, itemId, at: new Date(FIXED).toISOString(), source: 'executor' }
}

function withStore(run: (store: WorkStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'wg1a-store-'))
  const path = join(dir, 'work.sqlite')
  let store: WorkStore | null = null
  try {
    const clock = () => FIXED
    store = new WorkStore(path, clock)
    run(store, path)
  } finally {
    try { store?.close() } catch { /* the reopen test closes it explicitly */ }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('work database uses WAL, foreign keys and an idempotent v1 migration', () => {
  withStore((store, path) => {
    assert.equal(store.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal')
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
    assert.deepEqual(store.db.prepare('SELECT version FROM wg1_migrations').all().map(row => row.version), [1])
    const plan = store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    store.appendEvent('p', event('claimed', 'a'))
    store.close()

    const reopened = new WorkStore(path, () => FIXED)
    assert.deepEqual(reopened.latestRevision('p'), plan)
    assert.deepEqual(reopened.db.prepare('SELECT version FROM wg1_migrations').all().map(row => row.version), [1])
    assert.equal(reopened.events('p', {}).length, 1)
    reopened.close()
  })
})

test('revisions are sequential, immutable and validated before a write', () => {
  withStore(store => {
    const plan1 = store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    const plan2 = store.addRevision({ projectId: 'p', author: 'lead', items: [item('a'), item('b', { dependsOn: ['a'] })] })
    assert.equal(plan1.revision, 1)
    assert.equal(plan2.revision, 2)
    assert.deepEqual(store.latestRevision('p'), plan2)
    assert.equal(store.latestRevision('missing'), null)

    assert.throws(
      () => store.addRevision({ projectId: 'p', author: 'user', items: [item('x'), item('x')] }),
      /duplicate_item/,
    )
    assert.throws(
      () => store.addRevision({ projectId: 'q', author: 'user', items: [item('a', { dependsOn: ['missing'] })] }),
      /missing_dependency/,
    )
    let cycle: WorkError | null = null
    try {
      store.addRevision({
        projectId: 'q', author: 'user',
        items: [item('a', { dependsOn: ['b'] }), item('b', { dependsOn: ['c'] }), item('c', { dependsOn: ['a'] })],
      })
    } catch (error) {
      cycle = error as WorkError
    }
    assert.ok(cycle instanceof WorkError)
    assert.equal(cycle.code, 'dependency_cycle')
    assert.deepEqual(cycle.cycle, ['a', 'b', 'c', 'a'])
    assert.match(cycle.message, /a -> b -> c -> a/)

    assert.throws(() => store.addRevision({ projectId: 'q', author: 'user', items: [item('self', { dependsOn: ['self'] })] }), /self -> self/)
    assert.throws(() => store.db.exec("UPDATE wg1_plan_revisions SET author='lead'"), /immutable/)
    assert.throws(() => store.db.exec('DELETE FROM wg1_plan_revisions'), /immutable/)
    assert.throws(() => store.db.prepare('INSERT OR REPLACE INTO wg1_plan_revisions VALUES (?,?,?,?,?)')
      .run('p', 1, new Date(FIXED).toISOString(), 'lead', '[]'), /immutable/)
    assert.equal(store.latestRevision('p')!.revision, 2)
    assert.deepEqual(store.latestRevision('p')!.items.map(entry => entry.id), ['a', 'b'])

    // A rejected revision never consumes a revision number.
    assert.throws(() => store.addRevision({ projectId: 'r', author: 'user', items: [item('a', { dependsOn: ['nope'] })] }))
    assert.equal(store.latestRevision('r'), null)
  })
})

test('events are append-only, paged by sequence and shape-validated', () => {
  withStore(store => {
    const plan = store.addRevision({ projectId: 'p', author: 'user', items: [item('a'), item('b')] })
    const first = store.appendEvent('p', event('claimed', 'a'))
    const second = store.appendEvent('p', event('verification_requested', 'a'))
    const third = store.appendEvent('p', event('acceptance_result', 'a'))
    assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3])
    assert.deepEqual(store.events('p', { limit: 2 }).map(entry => entry.seq), [1, 2])
    assert.deepEqual(store.events('p', { afterSeq: 2 }).map(entry => entry.seq), [3])
    assert.deepEqual(store.events('p', {}).map(entry => entry.type), ['claimed', 'verification_requested', 'acceptance_result'])
    assert.equal(store.events('other', {}).length, 0)

    assert.throws(() => store.db.exec("UPDATE wg1_events SET type='released'"), /append only/)
    assert.throws(() => store.db.exec('DELETE FROM wg1_events'), /append only/)
    assert.throws(() => store.db.prepare(
      'INSERT OR REPLACE INTO wg1_events(seq, project_id, revision, item_id, type, at, payload) VALUES (?,?,?,?,?,?,?)',
    ).run(1, 'p', 1, 'a', 'released', new Date(FIXED).toISOString(), '{}'), /append only/)
    assert.equal(store.events('p', {}).length, 3)

    assert.throws(() => store.appendEvent('p', { type: 'claimed', itemId: 'a', at: 'not-a-time', source: 'agent' }), /invalid_shape/)
    assert.throws(() => store.appendEvent('p', { type: 'unknown', itemId: 'a', at: new Date(FIXED).toISOString(), source: 'agent' } as never), /invalid_shape/)
    assert.throws(() => store.appendEvent('p', { type: 'acceptance_result', itemId: 'a', at: new Date(FIXED).toISOString(), source: 'harness', passed: true, cleanCheckout: true, command: 'x' } as never), /invalid_shape/)
    assert.throws(() => store.appendEvent('p', {
      type: 'proposed', itemId: 'c', at: new Date(FIXED).toISOString(), source: 'agent', item: item('d'),
    }), /item.id must equal/)
    assert.throws(() => store.appendEvent('missing', event('claimed', 'a')), /revision_not_found/)
    assert.throws(() => store.events('p', { afterSeq: -1 }), /invalid_paging/)
    assert.throws(() => store.events('p', { limit: 0 }), /invalid_paging/)

    const direct = store.appendEvent({ ...event('claimed', 'b'), projectId: 'p' })
    assert.equal(direct.seq, 4)
    assert.equal(deriveStatuses(plan, store.events('p', {})).get('b')!.status, 'in_progress')
  })
})

test('a canceled item accepts only reopen; reopen restores the dependency state', () => {
  withStore(store => {
    const plan = store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    store.appendEvent('p', event('claimed', 'a'))
    store.appendEvent('p', event('human_decision', 'a'))
    assert.equal(deriveStatuses(plan, store.events('p', {})).get('a')!.status, 'canceled')
    assert.throws(() => store.appendEvent('p', event('claimed', 'a')), (error: unknown) => {
      assert.ok(error instanceof WorkError)
      assert.equal(error.code, 'canceled')
      return true
    })
    assert.throws(() => store.appendEvent('p', event('verification_requested', 'a')), /canceled/)
    const reopened = store.appendEvent('p', {
      type: 'human_decision', itemId: 'a', at: new Date(FIXED).toISOString(), source: 'user', decision: 'reopen',
    })
    assert.equal(reopened.seq, 3)
    assert.equal(deriveStatuses(plan, store.events('p', {})).get('a')!.status, 'ready')
    store.appendEvent('p', event('claimed', 'a'))
    assert.equal(deriveStatuses(plan, store.events('p', {})).get('a')!.status, 'in_progress')
  })
})

test('activation defaults off and records an explicit mode and reason', () => {
  withStore(store => {
    assert.equal(store.mode('p'), 'off')
    assert.deepEqual(store.activation('p'), { projectId: 'p', mode: 'off', reason: 'default' })
    assert.deepEqual(store.setMode('p', 'project', 'two executors'), { projectId: 'p', mode: 'project', reason: 'two executors' })
    assert.equal(store.mode('p'), 'project')
    assert.equal(store.activation('p').reason, 'two executors')
    assert.deepEqual(store.setMode('p', 'run', 'delegated run'), { projectId: 'p', mode: 'run', reason: 'delegated run' })
    assert.equal(store.mode('p'), 'run')
    assert.throws(() => store.setMode('p', 'bogus' as never, 'x'), /invalid_shape/)
    assert.throws(() => store.setMode('p', 'off', ' '), /invalid_activation/)
  })

  assert.equal(shouldActivateProject({ executors: 0, linkedTracker: false, backlogOpened: false }), 'off')
  assert.equal(shouldActivateProject({ executors: 1, linkedTracker: false, backlogOpened: false }), 'off')
  assert.equal(shouldActivateProject({ executors: 2, linkedTracker: false, backlogOpened: false }), 'project')
  assert.equal(shouldActivateProject({ executors: 0, linkedTracker: true, backlogOpened: false }), 'project')
  assert.equal(shouldActivateProject({ executors: 0, linkedTracker: false, backlogOpened: true }), 'project')
  assert.throws(() => shouldActivateProject({ executors: -1, linkedTracker: false, backlogOpened: false }), /invalid_activation/)
})

test('unknown-item events are appended so derivation can report warnings', () => {
  withStore(store => {
    const plan = store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    const appended = store.appendEvent('p', event('claimed', 'ghost'))
    assert.equal(appended.seq, 1)
    const statuses = deriveStatuses(plan, store.events('p'))
    assert.deepEqual(statuses.warnings, [{ itemId: 'ghost', type: 'claimed', reason: 'unknown_item' }])
    assert.equal(statuses.get('a')!.status, 'ready')
  })
})

test('event timestamps accept epoch milliseconds', () => {
  withStore(store => {
    store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    const stored = store.appendEvent('p', {
      type: 'claimed', itemId: 'a', at: FIXED, source: 'executor',
    })
    assert.equal(stored.at, FIXED)
    assert.equal(store.events('p', {})[0]!.at, FIXED)
  })
})

test('events reference an existing revision through a foreign key', () => {
  withStore(store => {
    store.addRevision({ projectId: 'p', author: 'user', items: [item('a')] })
    assert.throws(() => store.db.prepare(
      'INSERT INTO wg1_events(project_id, revision, item_id, type, at, payload) VALUES (?,?,?,?,?,?)',
    ).run('p', 99, 'a', 'claimed', new Date(FIXED).toISOString(), '{}'), /FOREIGN KEY/)
  })
})
