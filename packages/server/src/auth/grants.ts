/**
 * Grant storage for ADR-0027. Grants live in `<dataDir>/auth.sqlite`, a database separate from
 * the session store so U3 migrations stay independent of K2/K3 migration tables.
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { can } from './policy.ts'
import type { Action, Grant, Principal, Resource, ResourceType, SubjectType } from './types.ts'

/** The tuple that identifies one grant. */
export type GrantKey = Pick<Grant, 'resourceType' | 'resourceId' | 'relation' | 'subjectType' | 'subjectId'>

/** A clock may return epoch milliseconds directly or a `Date`, matching existing stores. */
export type GrantClock = () => number | Date

/** Stable failure codes for callers that translate grant errors. */
export type GrantStoreErrorCode =
  | 'invalid_actor'
  | 'resource_mismatch'
  | 'owner_grant_forbidden'
  | 'forbidden'
  | 'grant_exists'
  | 'resource_not_shareable'
  | 'invalid_expiry'
  | 'write_failed'

/** A typed grant-store failure. */
export class GrantStoreError extends Error {
  readonly code: GrantStoreErrorCode

  constructor(code: GrantStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GrantStoreError'
    this.code = code
  }
}

/**
 * The action that authorizes managing grants on a resource family. Runs and nodes have no such
 * action in this slice: runs inherit project grants and nodes are administered by the server.
 */
const SHARE_ACTION: Partial<Record<ResourceType, Action>> = {
  project: 'project.share',
  session: 'session.share',
  connection: 'connection.manage',
}

interface GrantRow {
  resource_type: ResourceType
  resource_id: string
  relation: Grant['relation']
  subject_type: SubjectType
  subject_id: string
  created_by: string
  created_at: number
  expires_at: number | null
}

function clockMillis(clock: GrantClock): number {
  const value = clock()
  return value instanceof Date ? value.getTime() : value
}

function requireUser(actor: Principal): string {
  if (actor.kind !== 'user') throw new GrantStoreError('invalid_actor', 'Only an authenticated user may change grants')
  return actor.userId
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

/** Keep policy and uniqueness errors typed; wrap SQLite/storage failures in a stable code. */
function asWriteFailure(error: unknown): GrantStoreError {
  if (error instanceof GrantStoreError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new GrantStoreError('write_failed', `Grant write failed: ${detail}`, { cause: error })
}

function rowToGrant(row: GrantRow): Grant {
  return {
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    relation: row.relation,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
  }
}

export class GrantStore {
  readonly db: DatabaseSync
  private readonly clock: GrantClock

  constructor(path: string, clock: GrantClock) {
    this.clock = clock
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS u3_migrations(version INTEGER PRIMARY KEY);
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT version FROM u3_migrations WHERE version=1').get()) {
        this.db.exec(`
          CREATE TABLE grants(
            resource_type TEXT NOT NULL CHECK(resource_type IN ('project','session','connection','run','node')),
            resource_id TEXT NOT NULL,
            relation TEXT NOT NULL CHECK(relation IN ('owner','editor','viewer')),
            subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group','link')),
            subject_id TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            UNIQUE(resource_type, resource_id, relation, subject_type, subject_id)
          );
          CREATE INDEX grants_resource ON grants(resource_type, resource_id);
          CREATE INDEX grants_subject ON grants(subject_type, subject_id);
          INSERT INTO u3_migrations VALUES(1);
        `)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the original migration failure */ }
      this.db.close()
      throw error
    }
    if (path !== ':memory:') {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try { chmodSync(file, 0o600) } catch { /* WAL/SHM files appear lazily */ }
      }
    }
  }

  /**
   * Create a grant. The actor must be allowed to share the resource (`project.share`,
   * `session.share` or `connection.manage`). Provenance is set from the actor and clock, never
   * trusted from the input. Ownership transfer is not supported: `owner` grants are rejected.
   */
  grant(actor: Principal, input: Grant, resource: Resource): Grant {
    const createdBy = requireUser(actor)
    if (input.resourceType !== resource.type || input.resourceId !== resource.id) {
      throw new GrantStoreError('resource_mismatch', 'Grant target does not match the supplied resource')
    }
    if (input.relation === 'owner') {
      throw new GrantStoreError('owner_grant_forbidden', 'Ownership transfer is not supported in this slice')
    }
    const now = clockMillis(this.clock)
    if (input.expiresAt !== null && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)) {
      throw new GrantStoreError('invalid_expiry', 'expiresAt must be null or a safe integer after now')
    }
    const grant: Grant = { ...input, createdBy, createdAt: now }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertCanShare(actor, resource, now)
      try {
        this.db.prepare(`INSERT INTO grants
          (resource_type, resource_id, relation, subject_type, subject_id, created_by, created_at, expires_at)
          VALUES(?,?,?,?,?,?,?,?)`)
          .run(grant.resourceType, grant.resourceId, grant.relation, grant.subjectType,
            grant.subjectId, grant.createdBy, grant.createdAt, grant.expiresAt)
      } catch (error) {
        if (isUniqueViolation(error)) throw new GrantStoreError('grant_exists', 'Grant already exists')
        throw error
      }
      this.db.exec('COMMIT')
      return grant
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw asWriteFailure(error)
    }
  }

  /** Revoke one grant tuple. The same share permission as `grant` applies. */
  revoke(actor: Principal, key: GrantKey, resource: Resource): boolean {
    requireUser(actor)
    if (key.resourceType !== resource.type || key.resourceId !== resource.id) {
      throw new GrantStoreError('resource_mismatch', 'Grant target does not match the supplied resource')
    }
    const now = clockMillis(this.clock)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertCanShare(actor, resource, now)
      const result = this.db.prepare(`DELETE FROM grants
        WHERE resource_type=? AND resource_id=? AND relation=? AND subject_type=? AND subject_id=?`)
        .run(key.resourceType, key.resourceId, key.relation, key.subjectType, key.subjectId)
      this.db.exec('COMMIT')
      return Number(result.changes) > 0
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw asWriteFailure(error)
    }
  }

  /** All grants made directly on one resource, including expired ones. */
  forResource(resourceType: ResourceType, resourceId: string): Grant[] {
    const rows = this.db.prepare(`SELECT resource_type, resource_id, relation, subject_type,
      subject_id, created_by, created_at, expires_at FROM grants
      WHERE resource_type=? AND resource_id=? ORDER BY rowid`).all(resourceType, resourceId) as unknown as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** All grants addressed to one subject, across resources, including expired ones. */
  forSubject(subjectType: SubjectType, subjectId: string): Grant[] {
    const rows = this.db.prepare(`SELECT resource_type, resource_id, relation, subject_type,
      subject_id, created_by, created_at, expires_at FROM grants
      WHERE subject_type=? AND subject_id=? ORDER BY rowid`).all(subjectType, subjectId) as unknown as GrantRow[]
    return rows.map(rowToGrant)
  }

  /** Delete every grant whose expiry is at or before `now`. Returns the number removed. */
  purgeExpired(now: number): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare('DELETE FROM grants WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now)
      this.db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw asWriteFailure(error)
    }
  }

  close(): void {
    this.db.close()
  }

  private assertCanShare(actor: Principal, resource: Resource, now: number): void {
    const action = SHARE_ACTION[resource.type]
    if (action === undefined) {
      throw new GrantStoreError('resource_not_shareable', `Grants on ${resource.type} resources are not supported`)
    }
    const decision = can(actor, action, resource, this.forResource(resource.type, resource.id), now)
    if (!decision.allowed) {
      throw new GrantStoreError('forbidden', `Not allowed to share ${resource.type} resource (${decision.reason})`)
    }
  }
}
