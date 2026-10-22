import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { GrantStore, GrantStoreError, type GrantKey } from '../../src/auth/grants.ts'
import type { Grant, Principal, Relation, Resource, SubjectType } from '../../src/auth/types.ts'

const NOW = 1_800_000_000_000

const owner: Principal = { kind: 'user', userId: 'user-owner', role: 'member', groups: [] }
const editor: Principal = { kind: 'user', userId: 'user-editor', role: 'member', groups: [] }
const viewer: Principal = { kind: 'user', userId: 'user-viewer', role: 'member', groups: [] }
const admin: Principal = { kind: 'user', userId: 'user-admin', role: 'admin', groups: [] }
const anonymous: Principal = { kind: 'anonymous' }

const project: Resource = { type: 'project', id: 'project-1', ownerUserId: 'user-owner' }
const session: Resource = {
  type: 'session', id: 'session-1', ownerUserId: 'user-owner',
  parent: { type: 'project', id: 'project-1' },
}
const connection: Resource = { type: 'connection', id: 'connection-1', ownerUserId: 'user-owner', connectionKind: 'api_key' }
const run: Resource = { type: 'run', id: 'run-1', ownerUserId: 'user-owner', parent: { type: 'project', id: 'project-1' } }
const node: Resource = { type: 'node', id: 'node-1', ownerUserId: 'user-owner' }

function grantOn(
  resource: Resource,
  relation: Relation,
  subjectId: string,
  expiresAt: number | null = null,
  subjectType: SubjectType = 'user',
): Grant {
  return {
    resourceType: resource.type,
    resourceId: resource.id,
    relation,
    subjectType,
    subjectId,
    // Deliberately forged: the store must override both fields from the actor and clock.
    createdBy: 'forged-user',
    createdAt: 1,
    expiresAt,
  }
}

function keyOn(
  resource: Resource,
  relation: Relation,
  subjectId: string,
  subjectType: SubjectType = 'user',
): GrantKey {
  return { resourceType: resource.type, resourceId: resource.id, relation, subjectType, subjectId }
}

interface Fixture {
  store: GrantStore
  path: string
  stores: GrantStore[]
  open: () => GrantStore
  setNow: (value: number) => void
}

function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-u3-grants-'))
  const path = join(dir, 'auth.sqlite')
  let now = NOW
  const stores: GrantStore[] = []
  const open = (): GrantStore => {
    // Existing stores accept a Date clock; the grant store normalizes it to epoch milliseconds.
    const store = new GrantStore(path, () => new Date(now))
    stores.push(store)
    return store
  }
  const store = open()
  t.after(() => {
    for (const opened of stores.reverse()) {
      try { opened.close() } catch { /* already closed by the test */ }
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, path, stores, open, setNow: value => { now = value } }
}

test('migration v1 is idempotent, enables WAL/FKs and preserves grants across reopen', (t) => {
  const f = fixture(t)
  assert.equal((f.store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
  assert.equal((f.store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)

  const columns = f.store.db.prepare('PRAGMA table_info(grants)').all() as unknown as { name: string }[]
  assert.deepEqual(columns.map(column => column.name), [
    'resource_type', 'resource_id', 'relation', 'subject_type', 'subject_id',
    'created_by', 'created_at', 'expires_at',
  ])
  const indexes = f.store.db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name='grants' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`)
    .all() as unknown as { name: string }[]
  assert.deepEqual(indexes.map(index => index.name), ['grants_resource', 'grants_subject'])

  f.store.grant(owner, grantOn(project, 'viewer', 'user-viewer'), project)
  f.store.close()

  const reopened = f.open()
  const versions = reopened.db.prepare('SELECT version FROM u3_migrations ORDER BY version').all() as unknown as { version: number }[]
  assert.deepEqual(versions.map(row => row.version), [1])
  assert.equal(reopened.forResource('project', 'project-1').length, 1)
})

test('the grant tuple is unique, while a subject may hold a different relation on the same resource', (t) => {
  const f = fixture(t)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-viewer'), project)
  assert.throws(
    () => f.store.grant(owner, grantOn(project, 'viewer', 'user-viewer'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'grant_exists',
  )
  f.store.grant(owner, grantOn(project, 'editor', 'user-viewer'), project)
  assert.equal(f.store.forResource('project', 'project-1').length, 2)
  assert.equal(f.store.forSubject('user', 'user-viewer').length, 2)
})

test('grant and revoke require share permission; run and node grants are not shareable', (t) => {
  const f = fixture(t)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-viewer'), project)
  f.store.grant(owner, grantOn(project, 'editor', 'user-editor'), project)

  assert.throws(
    () => f.store.grant(viewer, grantOn(project, 'viewer', 'user-x'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.throws(
    () => f.store.grant(editor, grantOn(project, 'viewer', 'user-x'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.throws(
    () => f.store.grant(admin, grantOn(project, 'viewer', 'user-x'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.throws(
    () => f.store.grant(anonymous, grantOn(project, 'viewer', 'user-x'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'invalid_actor',
  )

  assert.throws(
    () => f.store.revoke(viewer, keyOn(project, 'viewer', 'user-viewer'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.throws(
    () => f.store.revoke(editor, keyOn(project, 'editor', 'user-editor'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.equal(f.store.revoke(owner, keyOn(project, 'viewer', 'user-viewer'), project), true)
  assert.equal(f.store.revoke(owner, keyOn(project, 'viewer', 'user-viewer'), project), false)
  assert.deepEqual(f.store.forResource('project', 'project-1').map(grant => grant.subjectId), ['user-editor'])

  f.store.grant(owner, grantOn(connection, 'editor', 'user-editor'), connection)
  assert.throws(
    () => f.store.grant(editor, grantOn(connection, 'viewer', 'user-x'), connection),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'forbidden',
  )
  assert.equal(f.store.revoke(owner, keyOn(connection, 'editor', 'user-editor'), connection), true)

  for (const resource of [run, node]) {
    assert.throws(
      () => f.store.grant(owner, grantOn(resource, 'viewer', 'user-viewer'), resource),
      (error: unknown) => error instanceof GrantStoreError && error.code === 'resource_not_shareable',
    )
  }
})

test('owner grants are rejected without touching the table', (t) => {
  const f = fixture(t)
  assert.throws(
    () => f.store.grant(owner, grantOn(project, 'owner', 'user-other'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'owner_grant_forbidden',
  )
  assert.throws(
    () => f.store.grant(owner, grantOn(session, 'owner', 'user-other'), session),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'owner_grant_forbidden',
  )
  assert.equal(f.store.forResource('project', 'project-1').length, 0)
  assert.equal(f.store.forResource('session', 'session-1').length, 0)
})

test('link grants are viewer-only', (t) => {
  const f = fixture(t)
  assert.throws(
    () => f.store.grant(owner, grantOn(project, 'editor', 'link-1', null, 'link'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'link_grant_forbidden',
  )
  assert.throws(
    () => f.store.grant(owner, grantOn(project, 'owner', 'link-1', null, 'link'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'owner_grant_forbidden',
  )
  assert.equal(f.store.forResource('project', 'project-1').length, 0)

  f.store.grant(owner, grantOn(project, 'viewer', 'link-1', null, 'link'), project)
  assert.equal(f.store.forResource('project', 'project-1').length, 1)
})

test('grant and revoke reject a tuple that does not match the supplied resource', (t) => {
  const f = fixture(t)
  assert.throws(
    () => f.store.grant(owner, { ...grantOn(project, 'viewer', 'user-viewer'), resourceId: 'project-2' }, project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'resource_mismatch',
  )
  assert.throws(
    () => f.store.revoke(owner, { ...keyOn(project, 'viewer', 'user-viewer'), resourceId: 'project-2' }, project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'resource_mismatch',
  )
  assert.equal(f.store.forResource('project', 'project-1').length, 0)
})

test('expiry purge removes grants at or before now and keeps live ones', (t) => {
  const f = fixture(t)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-a', NOW + 1), project)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-b', NOW + 2), project)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-c', null), project)
  f.store.grant(owner, grantOn(session, 'viewer', 'user-a', NOW + 3), session)

  assert.equal(f.store.forResource('project', 'project-1').length, 3)
  assert.equal(f.store.purgeExpired(NOW + 2), 2)
  assert.deepEqual(f.store.forResource('project', 'project-1').map(grant => grant.subjectId), ['user-c'])
  assert.equal(f.store.forResource('session', 'session-1').length, 1)
  assert.equal(f.store.purgeExpired(NOW + 2), 0)
})

test('grant expiry must be null or a safe integer after now', (t) => {
  const f = fixture(t)
  const invalid: Array<{ name: string; value: number }> = [
    { name: 'NaN', value: Number.NaN },
    { name: 'Infinity', value: Number.POSITIVE_INFINITY },
    { name: 'negative Infinity', value: Number.NEGATIVE_INFINITY },
    { name: 'fractional', value: 1.5 },
    { name: 'past', value: -1 },
    { name: 'now', value: NOW },
    { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 2 },
  ]

  for (const { name, value } of invalid) {
    assert.throws(
      () => f.store.grant(owner, grantOn(project, 'viewer', `user-${name}`, value), project),
      (error: unknown) => error instanceof GrantStoreError && error.code === 'invalid_expiry',
      name,
    )
  }
  assert.equal(f.store.forResource('project', 'project-1').length, 0)

  const live = f.store.grant(owner, grantOn(project, 'viewer', 'user-live', NOW + 1), project)
  assert.equal(live.expiresAt, NOW + 1)
  assert.equal(f.store.forResource('project', 'project-1').length, 1)
})

test('queries span resources and provenance comes from the actor and clock', (t) => {
  const f = fixture(t)
  f.setNow(4_242)
  const created = f.store.grant(owner, grantOn(project, 'viewer', 'user-a'), project)
  assert.equal(created.createdBy, 'user-owner')
  assert.equal(created.createdAt, 4_242)
  f.store.grant(owner, grantOn(session, 'editor', 'user-a'), session)

  const rows = f.store.forSubject('user', 'user-a')
  assert.deepEqual(rows.map(grant => grant.resourceType), ['project', 'session'])
  assert.deepEqual(rows.map(grant => grant.createdAt), [4_242, 4_242])
})

test('a failed insert or delete rolls back the transaction and leaves prior grants intact', (t) => {
  const f = fixture(t)
  f.store.grant(owner, grantOn(project, 'viewer', 'user-keep'), project)
  f.store.db.exec(`CREATE TRIGGER reject_boom BEFORE INSERT ON grants WHEN NEW.subject_id='user-boom'
    BEGIN SELECT RAISE(ABORT, 'boom'); END;`)
  assert.throws(
    () => f.store.grant(owner, grantOn(project, 'viewer', 'user-boom'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'write_failed',
  )
  assert.deepEqual(f.store.forResource('project', 'project-1').map(grant => grant.subjectId), ['user-keep'])

  f.store.db.exec('DROP TRIGGER reject_boom')
  f.store.grant(owner, grantOn(project, 'viewer', 'user-boom'), project)

  f.store.db.exec(`CREATE TRIGGER reject_revoke BEFORE DELETE ON grants WHEN OLD.subject_id='user-keep'
    BEGIN SELECT RAISE(ABORT, 'keep'); END;`)
  assert.throws(
    () => f.store.revoke(owner, keyOn(project, 'viewer', 'user-keep'), project),
    (error: unknown) => error instanceof GrantStoreError && error.code === 'write_failed',
  )
  assert.equal(f.store.forResource('project', 'project-1').some(grant => grant.subjectId === 'user-keep'), true)
  f.store.db.exec('DROP TRIGGER reject_revoke')
  assert.equal(f.store.revoke(owner, keyOn(project, 'viewer', 'user-keep'), project), true)
})
