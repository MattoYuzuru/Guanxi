/**
 * Site-grant metadata for the agent browser (ADR-0035 decisions 4–6).
 *
 * Grants live in `<dataDir>/browser.sqlite`, a database separate from sessions, auth and
 * connections, with its own append-only `c1_migrations` table. This store is metadata only:
 * it never accepts or returns a cookie value, password, token or other secret. A caller that
 * needs a session bundle stores it encrypted in the account vault; the browser context resolves
 * it there and passes only the grant id to this store.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Principal } from '../auth/types.ts'

/** Where a site grant came from. Bridge sources are explicit user actions. */
export const SITE_GRANT_SOURCES = [
  'login',
  'bridge_once',
  'bridge_run_start',
  'bridge_live',
  'live_chrome',
] as const
export type SiteGrantSource = (typeof SITE_GRANT_SOURCES)[number]

/** Sync mode requested from the Bridge: once, at run start, or live for the session. */
export const SITE_SYNC_MODES = ['once', 'run_start', 'live'] as const
export type SiteGrantSyncMode = (typeof SITE_SYNC_MODES)[number]

/** Grants are read-only or read/write for the granted site. */
export const SITE_GRANT_ACCESS = ['read', 'write'] as const
export type SiteGrantAccess = (typeof SITE_GRANT_ACCESS)[number]

/** Who may create a grant. An agent channel is always refused. */
export type SiteGrantChannel = 'ui' | 'agent'

/** Input accepted by `grant`; account and creator come from the authenticated principal. */
export interface SiteGrantInput {
  projectId: string
  /** Project role the grant is scoped to. */
  role: string
  /** Host or URL; stored as the exact lowercase host without widening. */
  domain: string
  source: SiteGrantSource
  syncMode: SiteGrantSyncMode
  /** Named scopes such as `cookies` or `storage`; never values. */
  scopes: string[]
  access: SiteGrantAccess
  /** Epoch milliseconds, or null/undefined for no expiry. */
  expiresAt?: number | null
}

/** A stored grant. It contains metadata only, never session material. */
export interface SiteGrant {
  id: string
  accountId: string
  projectId: string
  role: string
  domain: string
  source: SiteGrantSource
  syncMode: SiteGrantSyncMode
  scopes: string[]
  access: SiteGrantAccess
  expiresAt: number | null
  lastUsedAt: number | null
  createdBy: string
  createdAt: number
  revokedAt: number | null
}

/** A browser context opened against one grant. */
export interface SiteContext {
  contextId: string
  grantId: string
  openedAt: number
  closedAt: number | null
}

/** A clock may return epoch milliseconds directly or a `Date`, matching existing stores. */
export type SiteGrantClock = () => number | Date

/** Stable failure codes for route and host callers. */
export type SiteGrantStoreErrorCode =
  | 'invalid_actor'
  | 'agent_cannot_grant'
  | 'invalid_grant'
  | 'invalid_domain'
  | 'wildcard_domain_forbidden'
  | 'secret_material_rejected'
  | 'invalid_expiry'
  | 'grant_not_found'
  | 'grant_revoked'
  | 'grant_expired'
  | 'context_foreign'
  | 'context_closed'
  | 'write_failed'

/** A typed site-grant failure. */
export class SiteGrantStoreError extends Error {
  readonly code: SiteGrantStoreErrorCode

  constructor(code: SiteGrantStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SiteGrantStoreError'
    this.code = code
  }
}

/**
 * Known multi-label public suffixes. They are used only to refuse a grant for the suffix itself;
 * grants are stored as the exact host and never widened, so this list cannot broaden any grant.
 * Subdomain grouping would need the real Public Suffix List and is deliberately not implemented.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'nhs.uk', 'org.uk', 'plc.uk',
  'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.jp', 'ed.jp', 'gr.jp', 'lg.jp', 'ne.jp', 'or.jp',
  'co.in', 'firm.in', 'gen.in', 'ind.in', 'net.in', 'org.in',
  'com.br', 'net.br', 'org.br',
  'com.cn', 'gov.cn', 'net.cn', 'org.cn',
  'com.tr', 'net.tr', 'org.tr',
  'co.za', 'net.za', 'org.za',
  'co.il', 'co.id', 'co.kr', 'co.th',
  'com.ar', 'com.hk', 'com.mx', 'com.my', 'com.ph', 'com.sg', 'com.tw', 'com.vn',
  // Known private suffixes; used only to refuse a grant for the suffix itself.
  'appspot.com', 'azurewebsites.net', 'blogspot.com', 'cloudfront.net', 'firebaseapp.com',
  'fly.dev', 'github.io', 'gitlab.io', 'glitch.me', 'herokuapp.com', 'netlify.app',
  'onrender.com', 'pages.dev', 'vercel.app', 'web.app', 'workers.dev',
])

/** Input field names that would imply secret material; checked recursively, by name only. */
const SECRET_FIELD = /(cookie|password|passwd|token|secret)/i
/** Scopes are names, not opaque blobs; the pattern keeps them short but cannot prove intent. */
const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/

/** Frozen v1 schema. Later slices append v2+ and never rewrite this statement. */
const MIGRATION_V1 = `
  CREATE TABLE site_grants(
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    role TEXT NOT NULL,
    domain TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('login','bridge_once','bridge_run_start','bridge_live','live_chrome')),
    sync_mode TEXT NOT NULL,
    scopes TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read','write')),
    expires_at INTEGER,
    last_used_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX site_grants_scope ON site_grants(account_id, project_id, role);
  CREATE INDEX site_grants_domain ON site_grants(domain);
  CREATE TABLE site_contexts(
    context_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL REFERENCES site_grants(id),
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX site_contexts_grant ON site_contexts(grant_id);
  INSERT INTO c1_migrations VALUES(1);
`

interface SiteGrantRow {
  id: string
  account_id: string
  project_id: string
  role: string
  domain: string
  source: SiteGrantSource
  sync_mode: SiteGrantSyncMode
  scopes: string
  access: SiteGrantAccess
  expires_at: number | null
  last_used_at: number | null
  created_by: string
  created_at: number
  revoked_at: number | null
}

interface SiteContextRow {
  context_id: string
  grant_id: string
  opened_at: number
  closed_at: number | null
}

/** A separate SQLite file with its own migration table, like the K3 connection store. */
export class SiteGrantStore {
  readonly db: DatabaseSync
  private readonly clock: SiteGrantClock
  private closed = false

  constructor(path: string, clock: SiteGrantClock = Date.now) {
    this.clock = clock
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      if (path !== ':memory:') chmodSync(path, 0o600)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS c1_migrations(version INTEGER PRIMARY KEY);`)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (!this.db.prepare('SELECT version FROM c1_migrations WHERE version=1').get()) {
          this.db.exec(MIGRATION_V1)
        }
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch { /* Preserve the original migration failure. */ }
        throw error
      }
    } catch (error) {
      try { this.db.close() } catch { /* Preserve the open failure. */ }
      this.closed = true
      throw error
    }
    if (path !== ':memory:') {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600)
      }
    }
  }

  /**
   * Create a grant. Only an authenticated user acting through the UI may do this; an agent
   * channel is refused with `agent_cannot_grant`, so an agent can never grant itself a site.
   * The account and creator are taken from the principal, never from the input.
   */
  grant(principal: Principal, input: SiteGrantInput, channel: SiteGrantChannel = 'agent'): SiteGrant {
    if (channel === 'agent') {
      throw new SiteGrantStoreError('agent_cannot_grant', 'An agent channel cannot create a site grant')
    }
    if (channel !== 'ui') {
      throw new SiteGrantStoreError('invalid_grant', 'channel must be ui or agent')
    }
    const accountId = requireUser(principal)
    rejectSecretFields(input)
    if (typeof input !== 'object' || input === null) {
      throw new SiteGrantStoreError('invalid_grant', 'grant input must be an object')
    }
    const now = this.now()
    const projectId = requireName(input.projectId, 'projectId')
    const role = requireName(input.role, 'role')
    if (!SITE_GRANT_SOURCES.includes(input.source)) {
      throw new SiteGrantStoreError('invalid_grant', 'source must be a known site-grant source')
    }
    if (!SITE_SYNC_MODES.includes(input.syncMode)) {
      throw new SiteGrantStoreError('invalid_grant', 'syncMode must be once, run_start or live')
    }
    if (!SITE_GRANT_ACCESS.includes(input.access)) {
      throw new SiteGrantStoreError('invalid_grant', 'access must be read or write')
    }
    const scopes = validateScopes(input.scopes)
    const expiresAt = input.expiresAt ?? null
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) {
      throw new SiteGrantStoreError('invalid_expiry', 'expiresAt must be null or a safe integer after now')
    }
    const domain = normalizeSiteDomain(input.domain)
    const grant: SiteGrant = {
      id: randomUUID(),
      accountId,
      projectId,
      role,
      domain,
      source: input.source,
      syncMode: input.syncMode,
      scopes,
      access: input.access,
      expiresAt,
      lastUsedAt: null,
      createdBy: accountId,
      createdAt: now,
      revokedAt: null,
    }

    this.transaction(() => {
      this.db.prepare(`INSERT INTO site_grants
        (id, account_id, project_id, role, domain, source, sync_mode, scopes, access,
          expires_at, last_used_at, created_by, created_at, revoked_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(grant.id, grant.accountId, grant.projectId, grant.role, grant.domain, grant.source,
          grant.syncMode, JSON.stringify(grant.scopes), grant.access, grant.expiresAt,
          grant.lastUsedAt, grant.createdBy, grant.createdAt, grant.revokedAt)
    })
    return grant
  }

  /**
   * Revoke one grant owned by the principal's account and return the open context ids that
   * used it. The caller must close those contexts within one lease TTL; this store only
   * records `revoked_at`. Repeating the call is idempotent and keeps the first timestamp.
   */
  revoke(principal: Principal, grantId: string, now: number): string[] {
    const accountId = requireUser(principal)
    const id = requireName(grantId, 'grantId')
    const revokedAt = requireTimestamp(now, 'now')
    return this.transaction(() => {
      const row = this.db.prepare('SELECT account_id, revoked_at FROM site_grants WHERE id=?')
        .get(id) as { account_id: string; revoked_at: number | null } | undefined
      if (!row || row.account_id !== accountId) {
        throw new SiteGrantStoreError('grant_not_found', 'Site grant not found for this account')
      }
      if (row.revoked_at === null) {
        this.db.prepare('UPDATE site_grants SET revoked_at=? WHERE id=?').run(revokedAt, id)
      }
      return (this.db.prepare(`SELECT context_id FROM site_contexts
        WHERE grant_id=? AND closed_at IS NULL ORDER BY opened_at, rowid`)
        .all(id) as unknown as { context_id: string }[]).map(context => context.context_id)
    })
  }

  /** Active, unexpired grants for one account/project/role scope, in creation order. */
  grantsFor(accountId: string, projectId: string, role: string, now: number): SiteGrant[] {
    const account = requireName(accountId, 'accountId')
    const project = requireName(projectId, 'projectId')
    const projectRole = requireName(role, 'role')
    const at = requireTimestamp(now, 'now')
    const rows = this.db.prepare(`SELECT * FROM site_grants
      WHERE account_id=? AND project_id=? AND role=? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at, rowid`).all(account, project, projectRole, at) as unknown as SiteGrantRow[]
    return rows.map(rowToGrant)
  }

  /**
   * Open a context id against a grant in the caller's account/project/role scope. The lookup is
   * scoped by all three: an unknown grant is `grant_not_found`, while a grant that exists in
   * another scope is `context_foreign`. Revoked and expired grants are refused; a context id
   * already bound to another grant is refused as well. Re-opening an already-open context for
   * the same grant returns the existing record.
   */
  openContext(contextId: string, grantId: string, accountId: string, projectId: string, role: string): SiteContext {
    const id = requireName(contextId, 'contextId')
    const grantKey = requireName(grantId, 'grantId')
    const account = requireName(accountId, 'accountId')
    const project = requireName(projectId, 'projectId')
    const projectRole = requireName(role, 'role')
    const now = this.now()
    return this.transaction(() => {
      const grant = this.db.prepare(`SELECT expires_at, revoked_at FROM site_grants
        WHERE id=? AND account_id=? AND project_id=? AND role=?`)
        .get(grantKey, account, project, projectRole) as
        { expires_at: number | null; revoked_at: number | null } | undefined
      if (!grant) {
        if (!this.db.prepare('SELECT 1 FROM site_grants WHERE id=?').get(grantKey)) {
          throw new SiteGrantStoreError('grant_not_found', 'Site grant not found')
        }
        throw new SiteGrantStoreError('context_foreign', 'Site grant belongs to another account, project or role')
      }
      if (grant.revoked_at !== null) throw new SiteGrantStoreError('grant_revoked', 'Site grant is revoked')
      if (grant.expires_at !== null && grant.expires_at <= now) {
        throw new SiteGrantStoreError('grant_expired', 'Site grant is expired')
      }
      const existing = this.db.prepare('SELECT * FROM site_contexts WHERE context_id=?')
        .get(id) as SiteContextRow | undefined
      if (existing) {
        if (existing.grant_id !== grantKey) {
          throw new SiteGrantStoreError('context_foreign', 'Context id belongs to another grant')
        }
        if (existing.closed_at !== null) {
          throw new SiteGrantStoreError('context_closed', 'Context id was already closed')
        }
        return rowToContext(existing)
      }
      this.db.prepare('INSERT INTO site_contexts VALUES(?,?,?,NULL)').run(id, grantKey, now)
      return { contextId: id, grantId: grantKey, openedAt: now, closedAt: null }
    })
  }

  /** Close one open context. Returns false when it is unknown or already closed. */
  closeContext(contextId: string, now: number = this.now()): boolean {
    const id = requireName(contextId, 'contextId')
    const closedAt = requireTimestamp(now, 'now')
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE site_contexts SET closed_at=? WHERE context_id=? AND closed_at IS NULL')
        .run(closedAt, id)
      return Number(result.changes) > 0
    })
  }

  /**
   * Record use of an active grant in the caller's account/project/role scope. An unknown grant
   * is `grant_not_found`; a grant in another scope is `context_foreign`. Revoked or expired
   * grants are not touched.
   */
  touch(grantId: string, now: number, accountId: string, projectId: string, role: string): boolean {
    const id = requireName(grantId, 'grantId')
    const at = requireTimestamp(now, 'now')
    const account = requireName(accountId, 'accountId')
    const project = requireName(projectId, 'projectId')
    const projectRole = requireName(role, 'role')
    return this.transaction(() => {
      const grant = this.db.prepare(`SELECT expires_at, revoked_at FROM site_grants
        WHERE id=? AND account_id=? AND project_id=? AND role=?`)
        .get(id, account, project, projectRole) as
        { expires_at: number | null; revoked_at: number | null } | undefined
      if (!grant) {
        if (!this.db.prepare('SELECT 1 FROM site_grants WHERE id=?').get(id)) {
          throw new SiteGrantStoreError('grant_not_found', 'Site grant not found')
        }
        throw new SiteGrantStoreError('context_foreign', 'Site grant belongs to another account, project or role')
      }
      if (grant.revoked_at !== null) return false
      if (grant.expires_at !== null && grant.expires_at <= at) return false
      this.db.prepare('UPDATE site_grants SET last_used_at=? WHERE id=?').run(at, id)
      return true
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private now(): number {
    const value = this.clock()
    return requireTimestamp(value instanceof Date ? value.getTime() : value, 'clock()')
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      if (error instanceof SiteGrantStoreError) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new SiteGrantStoreError('write_failed', `Site-grant write failed: ${detail}`, { cause: error })
    }
  }
}

/**
 * Normalize a host to the exact lowercase host the user entered: punycode for IDN, no scheme,
 * port, path, userinfo or trailing dot. There is no registrable-domain widening: `www.example.com`
 * and `example.com` are different grants, and a context origin matches a grant only by exact host
 * equality. Wildcards, IP literals, single-label hosts and a bare public suffix are refused.
 */
export function normalizeSiteDomain(input: string): string {
  if (typeof input !== 'string') throw new SiteGrantStoreError('invalid_domain', 'Domain must be a string')
  const trimmed = input.trim().toLowerCase()
  if (trimmed === '') throw new SiteGrantStoreError('invalid_domain', 'Domain must not be empty')
  if (trimmed.includes('*')) {
    throw new SiteGrantStoreError('wildcard_domain_forbidden', 'Wildcard site grants are not allowed')
  }

  let candidate = trimmed
  if (trimmed.includes('://')) {
    // Accept a full URL as a convenience, but store only its http(s) hostname.
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new SiteGrantStoreError('invalid_domain', 'Domain URL is not valid')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SiteGrantStoreError('invalid_domain', 'Domain URL must be http or https')
    }
    candidate = parsed.hostname
  } else if (/[/?#@:\\%\s]/.test(trimmed)) {
    throw new SiteGrantStoreError('invalid_domain', 'Domain must not contain a port, path or userinfo')
  }
  const bare = candidate.replace(/\.+$/, '')
  if (bare === '') throw new SiteGrantStoreError('invalid_domain', 'Domain must not be empty')
  if (bare.includes('..')) throw new SiteGrantStoreError('invalid_domain', 'Domain contains an empty label')

  let host: string
  try {
    host = new URL(`http://${bare}`).hostname
  } catch {
    throw new SiteGrantStoreError('invalid_domain', 'Domain is not a valid host')
  }
  host = (host.startsWith('[') ? host : host.replace(/\.+$/, '')).toLowerCase()
  if (host === '' || host.startsWith('[') || isIpLiteral(host)) {
    throw new SiteGrantStoreError('invalid_domain', 'Domain must be a hostname, not an IP address')
  }

  const labels = host.split('.')
  if (labels.length < 2) {
    throw new SiteGrantStoreError('invalid_domain', 'Domain must have at least two labels')
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new SiteGrantStoreError('invalid_domain', 'Domain contains an invalid label')
    }
  }
  if (PUBLIC_SUFFIXES.has(host)) {
    throw new SiteGrantStoreError('invalid_domain', 'Domain must not be a public suffix')
  }
  return host
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

function requireUser(principal: Principal): string {
  if (principal.kind !== 'user') {
    throw new SiteGrantStoreError('invalid_actor', 'Only an authenticated user may manage site grants')
  }
  return requireName(principal.userId, 'userId')
}

function requireName(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SiteGrantStoreError('invalid_grant', `${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new SiteGrantStoreError('invalid_grant', `${field} must be a safe integer epoch millisecond`)
  }
  return value
}

function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) {
    throw new SiteGrantStoreError('invalid_grant', 'scopes must be an array of scope names')
  }
  return scopes.map((scope) => {
    if (typeof scope !== 'string' || !SCOPE_NAME.test(scope)) {
      throw new SiteGrantStoreError('invalid_grant', 'each scope must be a short name, not a value')
    }
    return scope
  })
}

/** Reject secret-shaped field names before any value is read, at any nesting depth. */
function rejectSecretFields(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) rejectSecretFields(entry, seen)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) {
      throw new SiteGrantStoreError(
        'secret_material_rejected',
        'Site grants accept metadata only; cookie, password, token and secret fields are refused',
      )
    }
    rejectSecretFields(entry, seen)
  }
}

function rowToGrant(row: SiteGrantRow): SiteGrant {
  let scopes: unknown
  try {
    scopes = JSON.parse(String(row.scopes))
  } catch {
    throw new SiteGrantStoreError('invalid_grant', 'Stored grant has invalid scopes JSON')
  }
  if (!Array.isArray(scopes) || !scopes.every(scope => typeof scope === 'string' && SCOPE_NAME.test(scope))) {
    throw new SiteGrantStoreError('invalid_grant', 'Stored grant scopes are not a string array')
  }
  if (!SITE_GRANT_SOURCES.includes(row.source) || !SITE_SYNC_MODES.includes(row.sync_mode)
    || !SITE_GRANT_ACCESS.includes(row.access)) {
    throw new SiteGrantStoreError('invalid_grant', 'Stored grant has invalid enum values')
  }
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    projectId: String(row.project_id),
    role: String(row.role),
    domain: String(row.domain),
    source: row.source,
    syncMode: row.sync_mode,
    scopes: scopes as string[],
    access: row.access,
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  }
}

function rowToContext(row: SiteContextRow): SiteContext {
  return {
    contextId: String(row.context_id),
    grantId: String(row.grant_id),
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at),
  }
}
