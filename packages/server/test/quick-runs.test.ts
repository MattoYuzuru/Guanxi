import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  QUICK_RUN_VERSION,
  QUICK_RUN_OPERATIONS,
  RETENTION_DEFAULT_DAYS,
  createQuickRunBody,
  listQuickRunsResponse,
  quickRunSchema,
  quickRunScopeQuery,
  updateQuickRunRetentionBody,
  type QuickRun,
} from '@guanxi/contract'
import { quickRunsRoutes } from '../src/http/quick-runs-routes.ts'
import { ProjectService } from '../src/projects/service.ts'
import { openDb } from '../src/store/db.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { QuickRunStore } from '../src/store/quick-runs.ts'
import { downgradeContextCheckpointsToV23 } from './fixtures/context-checkpoint-migration.ts'
import { orderedRows } from './fixtures/table-rows.ts'
import { SESSION_LOG_TABLES } from './fixtures/session-log-migration.ts'

const CREATED_AT = '2026-08-13T10:00:00.000Z'
const UPDATED_AT = '2026-08-13T11:00:00.000Z'
const PROJECTLESS_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID_RUN = '22222222-2222-4222-8222-222222222222'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

function allTablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name)
    .filter((name) => !excluded.has(name)
      && name !== 'artifact_blobs'
      && name !== 'artifacts'
      && name !== 'artifact_attachments')
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    orderedRows(db, name),
  ])))
}

function downgradeToV20(db: DatabaseSync): void {
  downgradeContextCheckpointsToV23(db)
  db.exec(`
    DROP TRIGGER recipe_snapshot_job_identity_immutable;
    DROP TRIGGER recipe_job_snapshots_immutable_delete;
    DROP TRIGGER recipe_job_snapshots_immutable_update;
    DROP TRIGGER recipe_job_snapshots_exact_job;
    DROP TRIGGER recipe_job_snapshots_exact_source;
    DROP INDEX idx_recipe_job_snapshots_recipe;
    DROP TABLE recipe_job_snapshots;
    DROP TRIGGER recipes_current_revision_must_exist;
    DROP TRIGGER recipe_revisions_immutable_delete;
    DROP TRIGGER recipe_revisions_immutable_update;
    DROP TRIGGER recipes_identity_immutable;
    DROP INDEX idx_recipe_revisions_created;
    DROP TABLE recipe_revisions;
    DROP INDEX idx_recipes_scope_updated;
    DROP TABLE recipes;
    DROP TRIGGER quick_runs_identity_immutable;
    DROP INDEX idx_quick_runs_scope_updated;
    DROP TABLE quick_runs;
    PRAGMA user_version = 20;
  `)
}

function routeApp(db: DatabaseSync) {
  const app = new Hono()
  app.route('/api/quick-runs', quickRunsRoutes({
    db,
    projects: new ProjectService(new ProjectStore(db)),
  }))
  return app
}

describe('P3-J canonical Quick Run retention foundation', () => {
  it('keeps the shared policy, operation and scoped v1 boundaries strict', () => {
    const ttl = {
      quickRunVersion: QUICK_RUN_VERSION,
      id: PROJECTLESS_ID,
      operation: 'complete',
      scope: 'projectless',
      projectId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      retention: {
        retentionVersion: 1,
        policy: { mode: 'ttl', expiresAfterDays: RETENTION_DEFAULT_DAYS },
        policySource: 'default',
        policyUpdatedAt: CREATED_AT,
        expiryCalculation: 'not_implemented',
        automaticCleanup: 'not_implemented',
        sessionEnforcement: 'not_implemented',
      },
      execution: { state: 'not_implemented', jobId: null, artifactCount: 0 },
    }
    assert.equal(quickRunSchema.safeParse(ttl).success, true)
    for (const policy of [{ mode: 'keep' }, { mode: 'session' }] as const) {
      assert.equal(quickRunSchema.safeParse({
        ...ttl,
        retention: {
          ...ttl.retention,
          policy,
          policySource: 'user',
        },
      }).success, true)
    }
    for (const invalid of [
      { quickRunVersion: 2, operation: 'complete', scope: 'projectless' },
      { quickRunVersion: 1, operation: 'chat', scope: 'projectless' },
      { quickRunVersion: 1, operation: 'complete', scope: 'projectless', projectId: 'leak' },
      { quickRunVersion: 1, operation: 'complete', scope: 'project', projectId: ' project ' },
      { quickRunVersion: 1, operation: 'complete', scope: 'projectless', future: true },
    ]) assert.equal(createQuickRunBody.safeParse(invalid).success, false)
    for (const operation of QUICK_RUN_OPERATIONS) {
      assert.equal(createQuickRunBody.safeParse({
        quickRunVersion: 1,
        operation,
        scope: 'projectless',
      }).success, true)
    }
    for (const invalid of [
      { quickRunVersion: 2, scope: 'projectless' },
      { quickRunVersion: 1, scope: 'project', projectId: 'project', extra: true },
      { quickRunVersion: 1, scope: 'future' },
    ]) assert.equal(quickRunScopeQuery.safeParse(invalid).success, false)
    for (const invalid of [
      { quickRunVersion: 1, retentionVersion: 2, scope: 'projectless', policy: { mode: 'keep' } },
      { quickRunVersion: 1, retentionVersion: 1, scope: 'projectless', policy: { mode: 'ttl', expiresAfterDays: 30 } },
      { quickRunVersion: 1, retentionVersion: 1, scope: 'projectless', policy: { mode: 'session', future: true } },
      { quickRunVersion: 1, retentionVersion: 1, scope: 'projectless', policy: { mode: 'keep' }, save: true },
    ]) assert.equal(updateQuickRunRetentionBody.safeParse(invalid).success, false)
    assert.equal(quickRunSchema.safeParse({ ...ttl, future: true }).success, false)
    assert.equal(quickRunSchema.safeParse({
      ...ttl,
      retention: { ...ttl.retention, expiresAt: '2026-08-20T10:00:00.000Z' },
    }).success, false)
    assert.equal(quickRunSchema.safeParse({
      ...ttl,
      retention: { ...ttl.retention, expiryCalculation: 'server_calculated' },
    }).success, false)
    assert.equal(listQuickRunsResponse.safeParse({
      quickRunVersion: 1,
      scope: 'projectless',
      projectId: null,
      quickRuns: [ttl, ttl],
    }).success, false)
    assert.equal(listQuickRunsResponse.safeParse({
      quickRunVersion: 1,
      scope: 'project',
      projectId: 'project-1',
      quickRuns: [ttl],
    }).success, false)
  })

  it('applies migration 21 on fresh/v20/reopen/retry and truly rolls back exact v20 bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-quick-run-v21-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    assert.equal(version(seed), 29)
    const project = new ProjectStore(seed).create('Exact v20 Project', CREATED_AT)
    seed.prepare(
      `INSERT INTO workspaces (id, name, root_path, created_at, last_used_at)
       VALUES ('workspace-v20', 'Exact v20 Workspace', '/exact/v20', ?, NULL)`,
    ).run(CREATED_AT)
    downgradeToV20(seed)
    const exactV20 = allTablesPayload(seed, new Set())
    seed.exec(`
      CREATE TABLE migration_21_midpoint_sentinel (collision TEXT NOT NULL);
      CREATE INDEX idx_quick_runs_scope_updated
        ON migration_21_midpoint_sentinel(collision);
    `)
    seed.prepare('INSERT INTO migration_21_midpoint_sentinel VALUES (?)').run('exact blocker')
    seed.close()

    assert.throws(() => openDb(path), /Миграция 21 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 20)
    assert.equal(
      (rolledBack.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'quick_runs'",
      ).get() as { count: number }).count,
      0,
    )
    assert.equal(
      allTablesPayload(rolledBack, new Set(['migration_21_midpoint_sentinel'])),
      exactV20,
    )
    assert.equal((rolledBack.prepare(
      'SELECT collision FROM migration_21_midpoint_sentinel',
    ).get() as { collision: string }).collision, 'exact blocker')
    rolledBack.exec(`
      DROP INDEX idx_quick_runs_scope_updated;
      DROP TABLE migration_21_midpoint_sentinel;
    `)
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 29)
    assert.equal(count(retried, 'quick_runs'), 0)
    assert.equal(new ProjectStore(retried).get(project.id)?.name, 'Exact v20 Project')
    assert.equal(allTablesPayload(retried, new Set([
      'quick_runs', 'recipes', 'recipe_revisions', 'recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES,
    ])), exactV20)
    retried.close()

    const reopened = openDb(path)
    assert.equal(version(reopened), 29)
    assert.equal(count(reopened, 'quick_runs'), 0)
    assert.equal(allTablesPayload(reopened, new Set([
      'quick_runs', 'recipes', 'recipe_revisions', 'recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES,
    ])), exactV20)
    reopened.close()

    const fresh = openDb(':memory:')
    assert.equal(version(fresh), 29)
    assert.equal(count(fresh, 'quick_runs'), 0)
    fresh.close()
  })

  it('keeps Quick Run separate from Thread with immutable restrictive ownership and one default', () => {
    const db = openDb(':memory:')
    const projects = new ProjectStore(db)
    const project = projects.create('Logical only', CREATED_AT)
    const ids = [PROJECTLESS_ID, PROJECT_ID_RUN]
    let clock = CREATED_AT
    const store = new QuickRunStore(db, {
      clock: () => clock,
      createId: () => ids.shift()!,
    })
    const projectless = store.create({ operation: 'complete', scope: { scope: 'projectless' } })
    const owned = store.create({
      operation: 'embed',
      scope: { scope: 'project', projectId: project.id },
    })

    for (const quickRun of [projectless, owned]) {
      assert.deepEqual(quickRun.retention.policy, { mode: 'ttl', expiresAfterDays: 7 })
      assert.equal(quickRun.retention.policySource, 'default')
      assert.equal(quickRun.retention.automaticCleanup, 'not_implemented')
      assert.equal(quickRun.retention.sessionEnforcement, 'not_implemented')
      assert.deepEqual(quickRun.execution, { state: 'not_implemented', jobId: null, artifactCount: 0 })
    }
    assert.deepEqual(store.list({ scope: 'projectless' }).map(({ id }) => id), [PROJECTLESS_ID])
    assert.deepEqual(store.list({ scope: 'project', projectId: project.id }).map(({ id }) => id), [PROJECT_ID_RUN])
    assert.equal(count(db, 'threads'), 0)
    assert.equal(count(db, 'messages'), 0)
    assert.equal(count(db, 'jobs'), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 0)
    assert.equal(count(db, 'workspaces'), 0)

    for (const sql of [
      "UPDATE quick_runs SET operation = 'ocr' WHERE id = ?",
      'UPDATE quick_runs SET project_id = NULL WHERE id = ?',
      "UPDATE quick_runs SET id = '33333333-3333-4333-8333-333333333333' WHERE id = ?",
    ]) assert.throws(() => db.prepare(sql).run(PROJECT_ID_RUN), /Quick Run identity is immutable/u)
    assert.throws(() => db.prepare('DELETE FROM projects WHERE id = ?').run(project.id), /FOREIGN KEY/u)
    assert.equal(store.get(PROJECT_ID_RUN, { scope: 'projectless' }).status, 'scope_mismatch')
    assert.equal(store.get(PROJECTLESS_ID, { scope: 'project', projectId: project.id }).status, 'scope_mismatch')

    clock = UPDATED_AT
    const before = db.prepare('SELECT total_changes() AS value').get() as { value: number }
    const updated = store.updateRetention(PROJECT_ID_RUN, { scope: 'project', projectId: project.id }, { mode: 'session' })
    const after = db.prepare('SELECT total_changes() AS value').get() as { value: number }
    assert.equal(after.value - before.value, 1)
    assert.equal(updated.status, 'ok')
    if (updated.status === 'ok') {
      assert.equal(updated.quickRun.id, owned.id)
      assert.equal(updated.quickRun.operation, owned.operation)
      assert.equal(updated.quickRun.projectId, owned.projectId)
      assert.equal(updated.quickRun.createdAt, owned.createdAt)
      assert.deepEqual(updated.quickRun.retention.policy, { mode: 'session' })
      assert.equal(updated.quickRun.retention.policySource, 'user')
      assert.equal(updated.quickRun.retention.sessionEnforcement, 'not_implemented')
    }
    assert.equal(count(db, 'threads'), 0)
    assert.equal(count(db, 'jobs'), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 0)
    db.close()
  })

  it('round-trips Keep/TTL/Session through exact scoped routes and rejects malformed/future/cross-scope input', async () => {
    const db = openDb(':memory:')
    const project = new ProjectStore(db).create('Route Project', CREATED_AT)
    const app = routeApp(db)
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const projectlessRuns: QuickRun[] = []
    for (const operation of QUICK_RUN_OPERATIONS) {
      const response = await app.request('/api/quick-runs', json({
        quickRunVersion: 1,
        operation,
        scope: 'projectless',
      }))
      assert.equal(response.status, 201)
      const created = quickRunSchema.parse(await response.json())
      assert.equal(created.operation, operation)
      projectlessRuns.push(created)
    }
    const projectless = projectlessRuns.find(({ operation }) => operation === 'complete')!
    const createOwned = await app.request('/api/quick-runs', json({
      quickRunVersion: 1,
      operation: 'ocr',
      scope: 'project',
      projectId: project.id,
    }))
    assert.equal(createOwned.status, 201)
    const owned = quickRunSchema.parse(await createOwned.json())

    const listProjectless = await app.request(
      '/api/quick-runs?quickRunVersion=1&scope=projectless',
    )
    const listedProjectless = (await listProjectless.json() as { quickRuns: QuickRun[] }).quickRuns
    assert.equal(listedProjectless.length, QUICK_RUN_OPERATIONS.length)
    assert.deepEqual(
      new Set(listedProjectless.map(({ operation }) => operation)),
      new Set(QUICK_RUN_OPERATIONS),
    )
    const listOwned = await app.request(
      `/api/quick-runs?quickRunVersion=1&scope=project&projectId=${project.id}`,
    )
    assert.deepEqual((await listOwned.json() as { quickRuns: QuickRun[] }).quickRuns.map(({ id }) => id), [owned.id])
    assert.equal((await app.request(
      `/api/quick-runs/${owned.id}?quickRunVersion=1&scope=projectless`,
    )).status, 404)
    assert.equal((await app.request(
      `/api/quick-runs/${projectless.id}?quickRunVersion=1&scope=project&projectId=${project.id}`,
    )).status, 404)

    for (const policy of [
      { mode: 'keep' },
      { mode: 'ttl', expiresAfterDays: 7 },
      { mode: 'session' },
    ] as const) {
      const response = await app.request(`/api/quick-runs/${owned.id}/retention`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quickRunVersion: 1,
          retentionVersion: 1,
          scope: 'project',
          projectId: project.id,
          policy,
        }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(quickRunSchema.parse(await response.json()).retention.policy, policy)
    }
    for (const request of [
      '/api/quick-runs?quickRunVersion=2&scope=projectless',
      '/api/quick-runs?quickRunVersion=1&scope=projectless&future=1',
      '/api/quick-runs?quickRunVersion=1&quickRunVersion=1&scope=projectless',
      `/api/quick-runs/${owned.id}?quickRunVersion=1&scope=project`,
    ]) assert.equal((await app.request(request)).status, 400)
    assert.equal((await app.request('/api/quick-runs', json({
      quickRunVersion: 1,
      operation: 'complete',
      scope: 'project',
      projectId: 'missing-project',
    }))).status, 404)
    assert.equal((await app.request(`/api/quick-runs/${owned.id}/retention`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quickRunVersion: 1,
        retentionVersion: 1,
        scope: 'projectless',
        policy: { mode: 'keep' },
      }),
    })).status, 404)
    assert.equal(count(db, 'threads'), 0)
    assert.equal(count(db, 'jobs'), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 0)
    db.close()
  })
})
