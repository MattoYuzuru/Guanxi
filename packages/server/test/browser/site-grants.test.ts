import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  SiteGrantStore,
  SiteGrantStoreError,
  normalizeSiteDomain,
  type SiteGrant,
  type SiteGrantChannel,
  type SiteGrantInput,
  type SiteGrantStoreErrorCode,
} from '../../src/browser/site-grants.ts'
import type { Principal } from '../../src/auth/types.ts'

const NOW = 1_800_000_000_000

const alice: Principal = { kind: 'user', userId: 'user-alice', role: 'member', groups: [] }
const bob: Principal = { kind: 'user', userId: 'user-bob', role: 'member', groups: [] }
const anonymous: Principal = { kind: 'anonymous' }

function input(overrides: Partial<SiteGrantInput> = {}): SiteGrantInput {
  return {
    projectId: 'project-1',
    role: 'editor',
    domain: 'www.example.com',
    source: 'login',
    syncMode: 'once',
    scopes: ['cookies', 'storage'],
    access: 'read',
    expiresAt: null,
    ...overrides,
  }
}

function fails(code: SiteGrantStoreErrorCode): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof SiteGrantStoreError && error.code === code
}

interface Fixture {
  store: SiteGrantStore
  path: string
  open: () => SiteGrantStore
  setNow: (value: number) => void
}

function fixture(t: TestContext): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-c1-browser-'))
  const path = join(dir, 'browser.sqlite')
  let now = NOW
  const stores: SiteGrantStore[] = []
  const open = (): SiteGrantStore => {
    const store = new SiteGrantStore(path, () => new Date(now))
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
  return { store, path, open, setNow: value => { now = value } }
}

function create(store: SiteGrantStore, overrides: Partial<SiteGrantInput> = {}, principal: Principal = alice): SiteGrant {
  return store.grant(principal, input(overrides), 'ui')
}

test('migration v1 is idempotent on reopen, enables WAL/FKs and preserves grants and contexts', (t) => {
  const f = fixture(t)
  assert.equal((f.store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
  assert.equal((f.store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1)
  assert.equal((f.store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000)
  assert.equal(statSync(f.path).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(f.path)).mode & 0o777, 0o700)

  const grantColumns = f.store.db.prepare('PRAGMA table_info(site_grants)').all() as unknown as { name: string }[]
  assert.deepEqual(grantColumns.map(column => column.name), [
    'id', 'account_id', 'project_id', 'role', 'domain', 'source', 'sync_mode', 'scopes', 'access',
    'expires_at', 'last_used_at', 'created_by', 'created_at', 'revoked_at',
  ])
  const contextColumns = f.store.db.prepare('PRAGMA table_info(site_contexts)').all() as unknown as { name: string }[]
  assert.deepEqual(contextColumns.map(column => column.name), [
    'context_id', 'grant_id', 'opened_at', 'closed_at',
  ])
  const indexes = f.store.db.prepare(`SELECT name FROM sqlite_master
    WHERE type='index' AND tbl_name IN ('site_grants','site_contexts')
      AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all() as unknown as { name: string }[]
  assert.deepEqual(indexes.map(index => index.name), [
    'site_contexts_grant', 'site_grants_domain', 'site_grants_scope',
  ])

  const grant = create(f.store)
  f.store.openContext('context-1', grant.id, 'user-alice', 'project-1', 'editor')
  f.store.close()

  const reopened = f.open()
  const versions = reopened.db.prepare('SELECT version FROM c1_migrations ORDER BY version').all() as unknown as { version: number }[]
  assert.deepEqual(versions.map(row => row.version), [1])
  assert.deepEqual(reopened.grantsFor('user-alice', 'project-1', 'editor', NOW).map(row => row.id), [grant.id])
  const context = reopened.db.prepare('SELECT context_id, grant_id FROM site_contexts').get() as { context_id: string; grant_id: string }
  assert.deepEqual({ ...context }, { context_id: 'context-1', grant_id: grant.id })
})

test('only a user acting through the UI channel may grant a site', (t) => {
  const f = fixture(t)
  assert.throws(() => f.store.grant(alice, input(), 'agent'), fails('agent_cannot_grant'))
  // The default channel is the safe one: a caller must opt into the UI explicitly.
  assert.throws(() => f.store.grant(alice, input()), fails('agent_cannot_grant'))
  assert.throws(() => f.store.grant(anonymous, input(), 'ui'), fails('invalid_actor'))
  assert.throws(() => f.store.grant({ kind: 'link', linkId: 'link-1' }, input(), 'ui'), fails('invalid_actor'))
  assert.throws(() => f.store.grant(alice, input(), 'bogus' as unknown as SiteGrantChannel), fails('invalid_grant'))
  assert.throws(() => f.store.revoke(anonymous, 'grant-1', NOW), fails('invalid_actor'))
  assert.equal(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW).length, 0)
})

test('wildcard grants are refused and other domain forms are validated', (t) => {
  const f = fixture(t)
  for (const domain of ['*.example.com', 'example.*', '*']) {
    assert.throws(() => create(f.store, { domain }), fails('wildcard_domain_forbidden'), domain)
    assert.throws(() => normalizeSiteDomain(domain), fails('wildcard_domain_forbidden'), domain)
  }
  for (const domain of [
    '',
    'ftp://www.example.com',
    'example.com/path',
    'example.com:443',
    'user@example.com',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'co.uk',
    'example..com',
    'exa mple.com',
  ]) {
    assert.throws(() => create(f.store, { domain }), fails('invalid_domain'), domain)
  }
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS count FROM site_grants').get() as { count: number }).count, 0)
})

test('domains normalize to the exact lowercase host without scheme, port or trailing dot', (t) => {
  const f = fixture(t)
  assert.equal(normalizeSiteDomain('WWW.Example.COM.'), 'www.example.com')
  assert.equal(normalizeSiteDomain('https://WWW.Example.COM:8443/path?q#x'), 'www.example.com')
  assert.equal(normalizeSiteDomain('a.b.example.co.uk'), 'a.b.example.co.uk')
  assert.equal(normalizeSiteDomain('BÜCHER.example'), 'xn--bcher-kva.example')
  assert.equal(normalizeSiteDomain('agent.github.io'), 'agent.github.io')
  for (const host of ['shop.com.ua', 'x.spb.ru', 'bob.s3.amazonaws.com', 'me.ngrok.io', 'a.blogspot.co.uk']) {
    assert.equal(normalizeSiteDomain(host), host)
  }

  const plain = create(f.store, { domain: 'WWW.Example.COM.' })
  const deep = create(f.store, { domain: 'a.b.example.co.uk' })
  const idn = create(f.store, { domain: 'BÜCHER.example' })
  const url = create(f.store, { domain: 'https://WWW.Example.COM:8443/path?q#x' })
  assert.equal(plain.domain, 'www.example.com')
  assert.equal(deep.domain, 'a.b.example.co.uk')
  assert.equal(idn.domain, 'xn--bcher-kva.example')
  assert.equal(url.domain, 'www.example.com')
})

test('a grant stores the exact host and never widens it to a parent domain', (t) => {
  const f = fixture(t)
  const root = create(f.store, { domain: 'github.com' })
  const subdomain = create(f.store, { domain: 'gist.github.com' })
  assert.equal(root.domain, 'github.com')
  assert.equal(subdomain.domain, 'gist.github.com')
  assert.notEqual(root.domain, subdomain.domain)
  assert.deepEqual(
    f.store.grantsFor('user-alice', 'project-1', 'editor', NOW).map(grant => grant.domain),
    ['github.com', 'gist.github.com'],
  )
})

test('grant metadata comes from the principal and clock, never from forged input', (t) => {
  const f = fixture(t)
  const grant = f.store.grant(alice, {
    ...input(),
    // Deliberately forged: these are not input fields and must not be trusted.
    accountId: 'forged-account',
    createdBy: 'forged-user',
    createdAt: 1,
    revokedAt: NOW,
  } as unknown as SiteGrantInput, 'ui')
  assert.equal(grant.accountId, 'user-alice')
  assert.equal(grant.createdBy, 'user-alice')
  assert.equal(grant.createdAt, NOW)
  assert.equal(grant.revokedAt, null)
  assert.equal(grant.lastUsedAt, null)
  assert.deepEqual(grant.scopes, ['cookies', 'storage'])
  assert.deepEqual(Object.keys(grant).filter(key => /cookie|password|token|secret/i.test(key)), [])
  const row = f.store.db.prepare('SELECT account_id, created_by, scopes FROM site_grants WHERE id=?')
    .get(grant.id) as { account_id: string; created_by: string; scopes: string }
  assert.deepEqual({ ...row }, { account_id: 'user-alice', created_by: 'user-alice', scopes: '["cookies","storage"]' })
})

test('grant validates source, sync mode, access, scopes and expiry', (t) => {
  const f = fixture(t)
  const invalid: Array<[string, SiteGrantInput, SiteGrantStoreErrorCode]> = [
    ['unknown source', { ...input(), source: 'bulk_import' } as unknown as SiteGrantInput, 'invalid_grant'],
    ['unknown sync mode', { ...input(), syncMode: 'forever' } as unknown as SiteGrantInput, 'invalid_grant'],
    ['unknown access', { ...input(), access: 'execute' } as unknown as SiteGrantInput, 'invalid_grant'],
    ['scopes not an array', { ...input(), scopes: 'cookies' } as unknown as SiteGrantInput, 'invalid_grant'],
    ['scope with a space', input({ scopes: ['has space'] }), 'invalid_grant'],
    ['scope too long', input({ scopes: ['a'.repeat(65)] }), 'invalid_grant'],
    ['expiry at now', input({ expiresAt: NOW }), 'invalid_expiry'],
    ['expiry before now', input({ expiresAt: NOW - 1 }), 'invalid_expiry'],
    ['fractional expiry', input({ expiresAt: NOW + 1.5 }), 'invalid_expiry'],
    ['empty project', input({ projectId: ' ' }), 'invalid_grant'],
    ['empty role', input({ role: '' }), 'invalid_grant'],
  ]
  for (const [name, value, code] of invalid) {
    assert.throws(() => f.store.grant(alice, value, 'ui'), fails(code), name)
  }
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS count FROM site_grants').get() as { count: number }).count, 0)
})

test('grantsFor scopes by account, project and role and hides expired or revoked grants', (t) => {
  const f = fixture(t)
  const live = create(f.store, { expiresAt: NOW + 10 })
  const permanent = create(f.store, { role: 'editor', domain: 'permanent.example' })
  const viewer = create(f.store, { role: 'viewer', domain: 'viewer.example' })
  const otherProject = create(f.store, { projectId: 'project-2', domain: 'other.example' })
  const expired = create(f.store, { domain: 'expired.example', expiresAt: NOW + 5 })

  f.setNow(NOW + 6)
  assert.deepEqual(
    f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 6).map(grant => grant.id),
    [live.id, permanent.id],
  )
  assert.deepEqual(
    f.store.grantsFor('user-alice', 'project-1', 'viewer', NOW + 6).map(grant => grant.id),
    [viewer.id],
  )
  assert.deepEqual(
    f.store.grantsFor('user-alice', 'project-2', 'editor', NOW + 6).map(grant => grant.id),
    [otherProject.id],
  )
  assert.equal(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 10).some(grant => grant.id === live.id), false)
  assert.equal(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 10).some(grant => grant.id === expired.id), false)

  f.store.revoke(alice, permanent.id, NOW + 11)
  assert.deepEqual(
    f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 11).map(grant => grant.id),
    [],
  )
})

test('revoke returns exactly the open contexts using the grant and refuses later opens', (t) => {
  const f = fixture(t)
  const first = create(f.store, { domain: 'first.example' })
  const second = create(f.store, { domain: 'second.example' })
  f.setNow(NOW + 1)
  f.store.openContext('context-a1', first.id, 'user-alice', 'project-1', 'editor')
  f.setNow(NOW + 2)
  f.store.openContext('context-a2', first.id, 'user-alice', 'project-1', 'editor')
  f.setNow(NOW + 3)
  f.store.openContext('context-b1', second.id, 'user-alice', 'project-1', 'editor')
  assert.equal(f.store.closeContext('context-a1', NOW + 4), true)

  assert.deepEqual(f.store.revoke(alice, first.id, NOW + 5), ['context-a2'])
  const revoked = f.store.db.prepare('SELECT revoked_at FROM site_grants WHERE id=?').get(first.id) as { revoked_at: number }
  assert.equal(revoked.revoked_at, NOW + 5)
  assert.throws(() => f.store.openContext('context-a3', first.id, 'user-alice', 'project-1', 'editor'), fails('grant_revoked'))

  // Idempotent: the first revocation timestamp and still-open contexts are preserved.
  assert.deepEqual(f.store.revoke(alice, first.id, NOW + 6), ['context-a2'])
  assert.equal(
    (f.store.db.prepare('SELECT revoked_at FROM site_grants WHERE id=?').get(first.id) as { revoked_at: number }).revoked_at,
    NOW + 5,
  )
  assert.deepEqual(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 6).map(grant => grant.id), [second.id])
  assert.deepEqual(f.store.revoke(alice, second.id, NOW + 7), ['context-b1'])

  assert.equal(f.store.closeContext('context-a2', NOW + 8), true)
  assert.deepEqual(f.store.revoke(alice, first.id, NOW + 9), [])
})

test('openContext refuses unknown grants, contexts bound to another grant and closed ids', (t) => {
  const f = fixture(t)
  const first = create(f.store, { domain: 'first.example' })
  const second = create(f.store, { domain: 'second.example' })

  const context = f.store.openContext('context-1', first.id, 'user-alice', 'project-1', 'editor')
  assert.deepEqual(context, { contextId: 'context-1', grantId: first.id, openedAt: NOW, closedAt: null })
  assert.deepEqual(f.store.openContext('context-1', first.id, 'user-alice', 'project-1', 'editor'), context)
  assert.throws(() => f.store.openContext('context-1', second.id, 'user-alice', 'project-1', 'editor'), fails('context_foreign'))
  assert.throws(() => f.store.openContext('context-2', 'missing-grant', 'user-alice', 'project-1', 'editor'), fails('grant_not_found'))

  assert.equal(f.store.closeContext('missing-context', NOW), false)
  assert.equal(f.store.closeContext('context-1', NOW + 1), true)
  assert.equal(f.store.closeContext('context-1', NOW + 2), false)
  assert.throws(() => f.store.openContext('context-1', first.id, 'user-alice', 'project-1', 'editor'), fails('context_closed'))
  assert.throws(() => f.store.openContext('context-3', 'missing-grant', 'user-alice', 'project-1', 'editor'), fails('grant_not_found'))
})

test('openContext and touch require the full account, project and role scope', (t) => {
  const f = fixture(t)
  const grant = create(f.store, { projectId: 'pA', role: 'researcher' }, alice)
  const foreignScopes: Array<[string, [string, string, string]]> = [
    ['another project', ['user-alice', 'pB', 'researcher']],
    ['another role', ['user-alice', 'pA', 'viewer']],
    ['another account', ['user-bob', 'pA', 'researcher']],
  ]
  for (const [name, [account, project, role]] of foreignScopes) {
    assert.throws(() => f.store.openContext('context-1', grant.id, account, project, role), fails('context_foreign'), name)
    assert.throws(() => f.store.touch(grant.id, NOW + 1, account, project, role), fails('context_foreign'), name)
  }
  const context = f.store.openContext('context-1', grant.id, 'user-alice', 'pA', 'researcher')
  assert.equal(context.grantId, grant.id)
  assert.equal(f.store.touch(grant.id, NOW + 1, 'user-alice', 'pA', 'researcher'), true)
})

test('an expired grant cannot open a context and disappears from grantsFor', (t) => {
  const f = fixture(t)
  const grant = create(f.store, { expiresAt: NOW + 10 })
  f.setNow(NOW + 10)
  assert.throws(() => f.store.openContext('context-1', grant.id, 'user-alice', 'project-1', 'editor'), fails('grant_expired'))
  assert.equal(f.store.touch(grant.id, NOW + 10, 'user-alice', 'project-1', 'editor'), false)
  assert.deepEqual(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW + 10), [])
})

test('touch records last use for active grants only', (t) => {
  const f = fixture(t)
  const grant = create(f.store)
  assert.equal(f.store.touch(grant.id, NOW + 5, 'user-alice', 'project-1', 'editor'), true)
  assert.equal(
    (f.store.db.prepare('SELECT last_used_at FROM site_grants WHERE id=?').get(grant.id) as { last_used_at: number }).last_used_at,
    NOW + 5,
  )
  assert.throws(() => f.store.touch('missing-grant', NOW + 6, 'user-alice', 'project-1', 'editor'), fails('grant_not_found'))
  f.store.revoke(alice, grant.id, NOW + 7)
  assert.equal(f.store.touch(grant.id, NOW + 8, 'user-alice', 'project-1', 'editor'), false)
  assert.equal(
    (f.store.db.prepare('SELECT last_used_at FROM site_grants WHERE id=?').get(grant.id) as { last_used_at: number }).last_used_at,
    NOW + 5,
  )
  assert.equal(f.store.touch(grant.id, NOW + 9, 'user-alice', 'project-1', 'editor'), false)
})

test('secret-shaped field names are rejected before any row is written', (t) => {
  const f = fixture(t)
  const fields = ['cookie', 'cookies', 'cookieHeader', 'password', 'passwd', 'passwordHash', 'token', 'accessToken', 'clientSecret', 'secret']
  for (const field of fields) {
    const bad = { ...input(), [field]: 'planted-secret-value' } as unknown as SiteGrantInput
    assert.throws(() => f.store.grant(alice, bad, 'ui'), fails('secret_material_rejected'), field)
  }
  const nested = { ...input(), metadata: { password: 'planted' } } as unknown as SiteGrantInput
  assert.throws(() => f.store.grant(alice, nested, 'ui'), fails('secret_material_rejected'))
  const scopes = { ...input(), scopes: ['planted', { token: 'x' }] } as unknown as SiteGrantInput
  assert.throws(() => f.store.grant(alice, scopes, 'ui'), fails('secret_material_rejected'))
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS count FROM site_grants').get() as { count: number }).count, 0)
})

test('accounts are isolated: grantsFor and revoke never cross an account boundary', (t) => {
  const f = fixture(t)
  const grant = create(f.store, {}, alice)
  assert.deepEqual(f.store.grantsFor('user-bob', 'project-1', 'editor', NOW), [])
  assert.throws(() => f.store.revoke(bob, grant.id, NOW), fails('grant_not_found'))
  assert.deepEqual(f.store.grantsFor('user-alice', 'project-1', 'editor', NOW).map(row => row.id), [grant.id])
  assert.equal(f.store.revoke(alice, grant.id, NOW + 1).length, 0)
})
