import { randomUUID } from 'node:crypto'
import {
  QUICK_RUN_VERSION,
  RETENTION_DEFAULT_DAYS,
  RETENTION_POLICY_VERSION,
  quickRunOperationSchema,
  quickRunSchema,
  retentionPolicySchema,
  type QuickRun,
  type QuickRunOperation,
  type QuickRunScope,
  type RetentionPolicy,
} from '@alamo/contract'
import type { Db } from './db.ts'

interface QuickRunRow {
  id: string
  quick_run_version: number
  operation: string
  project_id: string | null
  created_at: string
  updated_at: string
  retention_policy: string
  retention_policy_source: string
  retention_policy_updated_at: string
}

export type QuickRunStoreResult =
  | { status: 'ok'; quickRun: QuickRun }
  | { status: 'not_found' }
  | { status: 'scope_mismatch' }

function projectId(scope: QuickRunScope): string | null {
  return scope.scope === 'project' ? scope.projectId : null
}

function matchesScope(row: QuickRunRow, scope: QuickRunScope): boolean {
  return row.project_id === projectId(scope)
}

function rowPolicy(row: QuickRunRow): RetentionPolicy {
  const candidate = row.retention_policy === 'ttl'
    ? { mode: 'ttl', expiresAfterDays: RETENTION_DEFAULT_DAYS }
    : { mode: row.retention_policy }
  return retentionPolicySchema.parse(candidate)
}

function toQuickRun(row: QuickRunRow): QuickRun {
  const policy = rowPolicy(row)
  const expiresAt = policy.mode === 'ttl'
    ? new Date(
        Date.parse(row.retention_policy_updated_at) +
          RETENTION_DEFAULT_DAYS * 24 * 60 * 60 * 1_000,
      ).toISOString()
    : null
  return quickRunSchema.parse({
    quickRunVersion: row.quick_run_version,
    id: row.id,
    operation: row.operation,
    scope: row.project_id === null ? 'projectless' : 'project',
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retention: {
      retentionVersion: RETENTION_POLICY_VERSION,
      policy,
      policySource: row.retention_policy_source,
      policyUpdatedAt: row.retention_policy_updated_at,
      expiresAt,
      expirySource: policy.mode === 'ttl'
        ? 'server_calculated_from_policy_update'
        : 'policy_without_time_expiry',
      automaticCleanup: 'not_implemented',
      sessionEnforcement: 'not_implemented',
    },
    execution: { state: 'not_implemented', jobId: null, artifactCount: 0 },
  })
}

export class QuickRunStore {
  private readonly db: Db
  private readonly clock: () => string
  private readonly createId: () => string

  constructor(
    db: Db,
    options: { clock?: () => string; createId?: () => string } = {},
  ) {
    this.db = db
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.createId = options.createId ?? randomUUID
  }

  create(input: { operation: QuickRunOperation; scope: QuickRunScope }): QuickRun {
    const operation = quickRunOperationSchema.parse(input.operation)
    const now = this.clock()
    const id = this.createId()
    this.db.prepare(
      `INSERT INTO quick_runs (
         id, quick_run_version, operation, project_id, created_at, updated_at,
         retention_policy, retention_policy_source, retention_policy_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'ttl', 'default', ?)`,
    ).run(id, QUICK_RUN_VERSION, operation, projectId(input.scope), now, now, now)
    return this.requireRow(id)
  }

  list(scope: QuickRunScope): QuickRun[] {
    const rows = scope.scope === 'project'
      ? this.db.prepare(
          'SELECT * FROM quick_runs WHERE project_id = ? ORDER BY updated_at DESC, id',
        ).all(scope.projectId)
      : this.db.prepare(
          'SELECT * FROM quick_runs WHERE project_id IS NULL ORDER BY updated_at DESC, id',
        ).all()
    return (rows as unknown as QuickRunRow[]).map(toQuickRun)
  }

  get(id: string, scope: QuickRunScope): QuickRunStoreResult {
    const row = this.readRow(id)
    if (!row) return { status: 'not_found' }
    if (!matchesScope(row, scope)) return { status: 'scope_mismatch' }
    return { status: 'ok', quickRun: toQuickRun(row) }
  }

  updateRetention(
    id: string,
    scope: QuickRunScope,
    policyInput: RetentionPolicy,
  ): QuickRunStoreResult {
    const policy = retentionPolicySchema.parse(policyInput)
    const now = this.clock()
    const mutation = this.db.prepare(
      `UPDATE quick_runs
       SET retention_policy = ?, retention_policy_source = 'user',
           retention_policy_updated_at = ?, updated_at = ?
       WHERE id = ? AND project_id IS ?`,
    ).run(policy.mode, now, now, id, projectId(scope))
    if (mutation.changes === 1) return { status: 'ok', quickRun: this.requireRow(id) }
    const existing = this.readRow(id)
    return existing ? { status: 'scope_mismatch' } : { status: 'not_found' }
  }

  private readRow(id: string): QuickRunRow | null {
    return (this.db.prepare('SELECT * FROM quick_runs WHERE id = ?').get(id) as
      | QuickRunRow
      | undefined) ?? null
  }

  private requireRow(id: string): QuickRun {
    const row = this.readRow(id)
    if (!row) throw new Error(`Quick Run ${id} was not persisted`)
    return toQuickRun(row)
  }
}
