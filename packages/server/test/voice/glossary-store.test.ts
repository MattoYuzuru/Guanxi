import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  GlossaryStore,
  GlossaryStoreError,
  type GlossaryListOptions,
} from '../../src/voice/store.ts'
import { GlossaryService } from '../../src/voice/service.ts'
import type { GlossaryEntry } from '../../src/voice/glossary.ts'

const HONO: GlossaryEntry = {
  id: 'hono',
  canonical: 'Hono',
  variants: ['хоно'],
  language: 'en',
}

const PR: GlossaryEntry = {
  id: 'pr',
  canonical: 'PR',
  variants: ['пиар'],
  language: 'en',
}

interface Harness {
  dir: string
  path: string
  store: GlossaryStore
  reopen(clock?: () => number): GlossaryStore
}

function harness(t: { after(run: () => void): void }, clock: () => number = Date.now): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-v1b-'))
  const path = join(dir, 'voice.sqlite')
  const stores: GlossaryStore[] = []
  const open = (nextClock: () => number): GlossaryStore => {
    const store = new GlossaryStore(path, nextClock)
    stores.push(store)
    return store
  }
  const store = open(clock)
  t.after(() => {
    for (const opened of stores) {
      try { opened.close() } catch { /* already closed or failed construction */ }
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, path, store, reopen: (nextClock = Date.now) => open(nextClock) }
}

function rowCounts(store: GlossaryStore): { entries: number; revisions: number } {
  const entries = store.db.prepare('SELECT COUNT(*) AS count FROM glossary_entries')
    .get() as unknown as { count: number }
  const revisions = store.db.prepare('SELECT COUNT(*) AS count FROM glossary_revisions')
    .get() as unknown as { count: number }
  return { entries: entries.count, revisions: revisions.count }
}

function expectStoreError(code: string, run: () => unknown): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof GlossaryStoreError && error.code === code,
  )
}

function listIds(store: GlossaryStore, accountId: string, options?: GlossaryListOptions): string[] {
  return store.list(accountId, options).map((row) => row.id)
}

describe('GlossaryStore migrations', () => {
  it('applies version 1 once and keeps rows across close and reopen', (t) => {
    const h = harness(t)
    h.store.create('acct', 'account', null, HONO, 'user')
    const versions = h.store.db.prepare('SELECT version FROM v1_migrations ORDER BY version')
      .all() as unknown as Array<{ version: number }>
    assert.deepEqual(versions.map((row) => row.version), [1])

    h.store.close()
    const reopened = h.reopen()
    const reopenedVersions = reopened.db.prepare('SELECT version FROM v1_migrations')
      .all() as unknown as Array<{ version: number }>
    assert.deepEqual(reopenedVersions.map((row) => row.version), [1])
    assert.deepEqual(listIds(reopened, 'acct'), ['hono'])
    assert.equal(reopened.history('acct', 'hono').length, 1)
  })
})

describe('GlossaryStore revisions', () => {
  it('records create, update, deactivate and reactivate as one chain', (t) => {
    const fixed = () => 1_000
    const h = harness(t, fixed)
    h.store.create('acct', 'account', null, HONO, 'user')
    const updated: GlossaryEntry = { ...HONO, canonical: 'Honojs' }
    const afterUpdate = h.store.update('acct', 'hono', updated, 'import')
    const afterDeactivate = h.store.deactivate('acct', 'hono')
    const afterReactivate = h.store.reactivate('acct', 'hono')

    assert.equal(afterUpdate.revision, 2)
    assert.equal(afterUpdate.entry.canonical, 'Honojs')
    assert.equal(afterDeactivate.active, false)
    assert.equal(afterDeactivate.revision, 3)
    assert.equal(afterReactivate.active, true)
    assert.equal(afterReactivate.revision, 4)

    const history = h.store.history('acct', 'hono')
    assert.deepEqual(
      history.map((row) => [row.revision, row.op, row.source, row.entry?.canonical]),
      [
        [1, 'create', 'user', 'Hono'],
        [2, 'update', 'import', 'Honojs'],
        [3, 'deactivate', 'user', 'Honojs'],
        [4, 'reactivate', 'user', 'Honojs'],
      ],
    )
    assert.equal(new Set(history.map((row) => row.createdAt)).size, 1)
  })

  it('reverts an update to the previous entry and appends a revert revision', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    h.store.update('acct', 'hono', { ...HONO, canonical: 'Honojs' }, 'user')

    const reverted = h.store.revert('acct', 'hono')
    assert.equal(reverted.revision, 3)
    assert.equal(reverted.entry.canonical, 'Hono')
    assert.equal(reverted.active, true)
    const history = h.store.history('acct', 'hono')
    assert.equal(history[2]?.op, 'revert')
    assert.equal(history[2]?.entry?.canonical, 'Hono')
  })

  it('reverts a deactivate back to the active previous entry', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    h.store.deactivate('acct', 'hono')

    const reverted = h.store.revert('acct', 'hono')
    assert.equal(reverted.active, true)
    assert.equal(reverted.entry.canonical, 'Hono')
    assert.equal(reverted.revision, 3)
    assert.equal(h.store.history('acct', 'hono')[2]?.op, 'revert')
  })

  it('deactivates when reverting a create and can toggle back', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')

    const reverted = h.store.revert('acct', 'hono')
    assert.equal(reverted.active, false)
    assert.equal(reverted.entry.canonical, 'Hono')
    assert.equal(reverted.revision, 2)
    assert.deepEqual(h.store.history('acct', 'hono').map((row) => row.op), ['create', 'revert'])

    const restored = h.store.revert('acct', 'hono')
    assert.equal(restored.active, true)
    assert.equal(restored.entry.canonical, 'Hono')
    assert.equal(restored.revision, 3)
  })

  it('rejects updating or reactivating in impossible states', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    expectStoreError('already_active', () => h.store.reactivate('acct', 'hono'))
    h.store.deactivate('acct', 'hono')
    expectStoreError('already_inactive', () => h.store.deactivate('acct', 'hono'))
    expectStoreError('entry_inactive', () => h.store.update('acct', 'hono', HONO, 'user'))
    assert.deepEqual(rowCounts(h.store), { entries: 1, revisions: 2 })
  })
})

describe('GlossaryStore collisions and overrides', () => {
  it('rejects a project entry that collides with an account entry and changes nothing', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    const before = rowCounts(h.store)

    assert.throws(
      () => h.store.create('acct', 'project', 'p1', {
        id: 'hono-project',
        canonical: 'Хоно',
        variants: [],
        language: 'ru',
      }, 'user'),
      TypeError,
    )
    assert.deepEqual(rowCounts(h.store), before)
    assert.deepEqual(listIds(h.store, 'acct'), ['hono'])
  })

  it('rejects an update that would collide and rolls the row back', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    h.store.create('acct', 'project', 'p1', {
      id: 'guanxi',
      canonical: 'Guanxi',
      variants: ['гуанси'],
      language: 'en',
    }, 'user')
    const before = rowCounts(h.store)
    const beforeEntry = h.store.list('acct', { includeInactive: true })
      .find((row) => row.id === 'hono')
    assert.ok(beforeEntry)

    assert.throws(
      () => h.store.update('acct', 'hono', { ...HONO, variants: ['гуанси'] }, 'user'),
      TypeError,
    )
    assert.deepEqual(rowCounts(h.store), before)
    assert.deepEqual(
      h.store.list('acct', { includeInactive: true }).find((row) => row.id === 'hono'),
      beforeEntry,
    )
    assert.equal(h.store.history('acct', 'hono').length, 1)
  })

  it('rejects a reactivation that would collide and leaves the row inactive', (t) => {
    const h = harness(t, () => 1_000)
    const accountEntry: GlossaryEntry = {
      id: 'alpha',
      canonical: 'Alpha',
      variants: ['альфа'],
      language: 'en',
    }
    const projectEntry: GlossaryEntry = {
      id: 'project',
      canonical: 'Project',
      variants: ['проект'],
      language: 'en',
    }
    h.store.create('acct', 'account', null, accountEntry, 'user')
    h.store.create('acct', 'project', 'p1', projectEntry, 'user')
    h.store.deactivate('acct', 'project')
    h.store.update('acct', 'alpha', { ...accountEntry, variants: ['проект'] }, 'user')
    const before = rowCounts(h.store)

    assert.throws(() => h.store.reactivate('acct', 'project'), TypeError)
    assert.deepEqual(rowCounts(h.store), before)
    assert.equal(h.store.list('acct', { projectId: 'p1' })[0]?.id, 'alpha')
    const project = h.store.list('acct', { includeInactive: true })
      .find((row) => row.id === 'project')
    assert.equal(project?.active, false)
    assert.equal(project?.revision, 2)
  })

  it('rejects a revert that would collide and keeps the current revision', (t) => {
    const h = harness(t, () => 1_000)
    const accountEntry: GlossaryEntry = {
      id: 'alpha',
      canonical: 'Alpha',
      variants: ['альфа'],
      language: 'en',
    }
    const projectEntry: GlossaryEntry = {
      id: 'project',
      canonical: 'Project',
      variants: ['проект'],
      language: 'en',
    }
    h.store.create('acct', 'account', null, accountEntry, 'user')
    h.store.create('acct', 'project', 'p1', projectEntry, 'user')
    h.store.update('acct', 'project', {
      ...projectEntry,
      canonical: 'ProjectTwo',
      variants: ['проект2'],
    }, 'user')
    h.store.update('acct', 'alpha', { ...accountEntry, variants: ['проект'] }, 'user')
    const before = rowCounts(h.store)

    assert.throws(() => h.store.revert('acct', 'project'), TypeError)
    assert.deepEqual(rowCounts(h.store), before)
    const project = h.store.list('acct', { includeInactive: true })
      .find((row) => row.id === 'project')
    assert.equal(project?.entry.canonical, 'ProjectTwo')
    assert.equal(project?.revision, 2)
    assert.equal(h.store.history('acct', 'project').length, 2)
  })

  it('lets a project canonical override an account entry for that project only', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    h.store.create('acct', 'project', 'p1', {
      id: 'hono-p1',
      canonical: 'hono',
      variants: [],
      language: 'en',
    }, 'user')
    h.store.create('acct', 'project', 'p2', PR, 'user')
    const service = new GlossaryService(h.store)

    assert.deepEqual(service.effective('acct', 'p1').map((entry) => entry.id), ['hono-p1'])
    assert.deepEqual(service.effective('acct', 'p2').map((entry) => entry.id), ['pr', 'hono'])
    assert.deepEqual(service.effective('acct', 'p3').map((entry) => entry.id), ['hono'])
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'hono')
    assert.equal(service.apply('acct', 'p2', 'хоно').text, 'Hono')
    assert.deepEqual(service.effective('acct', 'p1').map((entry) => entry.revision), [1])
    assert.equal(h.store.list('acct', { includeInactive: true }).length, 3)
  })

  it('filters list by project and inactive state', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, HONO, 'user')
    h.store.create('acct', 'project', 'p1', PR, 'user')
    h.store.create('acct', 'project', 'p2', {
      id: 'worktree',
      canonical: 'worktree',
      variants: ['ворктри'],
      language: 'en',
    }, 'user')
    h.store.deactivate('acct', 'pr')

    assert.deepEqual(listIds(h.store, 'acct'), ['worktree', 'hono'])
    assert.deepEqual(listIds(h.store, 'acct', { projectId: 'p1' }), ['hono'])
    assert.deepEqual(listIds(h.store, 'acct', { projectId: 'p1', includeInactive: true }), [
      'pr',
      'hono',
    ])
    assert.deepEqual(listIds(h.store, 'acct', { includeInactive: true }), [
      'pr',
      'worktree',
      'hono',
    ])
  })

  it('rejects malformed entries and scope combinations with typed errors', (t) => {
    const h = harness(t, () => 1_000)
    expectStoreError('invalid_scope', () => h.store.create('acct', 'account', 'p1', HONO, 'user'))
    expectStoreError('project_required', () => h.store.create('acct', 'project', null, HONO, 'user'))
    expectStoreError('invalid_source', () => h.store.create(
      'acct',
      'account',
      null,
      HONO,
      'nope' as 'user',
    ))
    assert.throws(
      () => h.store.create('acct', 'account', null, { ...HONO, canonical: '' }, 'user'),
      TypeError,
    )
    assert.deepEqual(rowCounts(h.store), { entries: 0, revisions: 0 })
  })
})

describe('GlossaryStore account isolation', () => {
  it('refuses another account on every entry-scoped method', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('owner', 'account', null, HONO, 'user')
    const before = rowCounts(h.store)

    expectStoreError('account_mismatch', () => h.store.update(
      'intruder',
      'hono',
      { ...HONO, canonical: 'Hijacked' },
      'user',
    ))
    expectStoreError('account_mismatch', () => h.store.deactivate('intruder', 'hono'))
    expectStoreError('account_mismatch', () => h.store.reactivate('intruder', 'hono'))
    expectStoreError('account_mismatch', () => h.store.revert('intruder', 'hono'))
    expectStoreError('account_mismatch', () => h.store.history('intruder', 'hono'))
    expectStoreError('entry_not_found', () => h.store.deactivate('intruder', 'missing'))

    assert.deepEqual(rowCounts(h.store), before)
    assert.deepEqual(h.store.list('intruder'), [])
    assert.equal(h.store.list('owner')[0]?.entry.canonical, 'Hono')
  })
})

describe('GlossaryService', () => {
  it('orders project entries before account entries by created_at then id', (t) => {
    const h = harness(t, () => 1_000)
    h.store.create('acct', 'account', null, { ...HONO, id: 'a2' }, 'user')
    h.store.create('acct', 'account', null, {
      ...HONO,
      id: 'a1',
      canonical: 'Alpha',
      variants: [],
    }, 'user')
    h.store.create('acct', 'project', 'p1', {
      ...PR,
      id: 'p2',
      canonical: 'PR2',
      variants: [],
    }, 'user')
    h.store.create('acct', 'project', 'p1', {
      ...PR,
      id: 'p1',
      canonical: 'PR1',
      variants: [],
    }, 'user')
    const service = new GlossaryService(h.store)

    assert.deepEqual(service.effective('acct', 'p1').map((entry) => entry.id), [
      'p1',
      'p2',
      'a1',
      'a2',
    ])
  })

  it('caches compiled glossaries and invalidates on store mutations', (t) => {
    const h = harness(t, () => 1_000)
    const service = new GlossaryService(h.store)
    h.store.create('acct', 'account', null, HONO, 'user')

    const first = service.effective('acct', 'p1')
    assert.equal(service.effective('acct', 'p1'), first)
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'Hono')

    h.store.update('acct', 'hono', { ...HONO, canonical: 'Honojs' }, 'user')
    const second = service.effective('acct', 'p1')
    assert.notEqual(second, first)
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'Honojs')

    h.store.deactivate('acct', 'hono')
    assert.deepEqual(service.effective('acct', 'p1'), [])
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'хоно')

    h.store.reactivate('acct', 'hono')
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'Honojs')
  })

  it('invalidates only the affected project cache on project mutations', (t) => {
    const h = harness(t, () => 1_000)
    const service = new GlossaryService(h.store)
    h.store.create('acct', 'project', 'p1', { ...PR, id: 'pr-p1' }, 'user')
    h.store.create('acct', 'project', 'p2', { ...PR, id: 'pr-p2' }, 'user')

    const p1 = service.effective('acct', 'p1')
    const p2 = service.effective('acct', 'p2')
    h.store.update('acct', 'pr-p1', { ...PR, id: 'pr-p1', canonical: 'Пиар' }, 'user')

    assert.notEqual(service.effective('acct', 'p1'), p1)
    assert.equal(service.effective('acct', 'p2'), p2)
    assert.equal(service.apply('acct', 'p1', 'пиар').text, 'Пиар')
    assert.equal(service.apply('acct', 'p2', 'пиар').text, 'PR')
  })

  it('excludes inactive entries from the effective set and apply', (t) => {
    const h = harness(t, () => 1_000)
    const service = new GlossaryService(h.store)
    h.store.create('acct', 'account', null, HONO, 'user')
    assert.equal(service.apply('acct', 'p1', 'хоно').text, 'Hono')

    h.store.deactivate('acct', 'hono')
    assert.deepEqual(service.effective('acct', 'p1'), [])
    assert.deepEqual(service.apply('acct', 'p1', 'хоно'), {
      text: 'хоно',
      replacements: [],
    })
  })
})
