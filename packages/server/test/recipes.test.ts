import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  RECIPE_OPERATIONS,
  RECIPE_REVISION_VERSION,
  RECIPE_VERSION,
  createRecipeBody,
  recipeConfigurationSchema,
  recipeSchema,
  recipeScopeQuery,
  reviseRecipeBody,
  type RecipeConfiguration,
} from '@alamo/contract'
import { recipesRoutes } from '../src/http/recipes-routes.ts'
import { JobService } from '../src/jobs/service.ts'
import { ProjectService } from '../src/projects/service.ts'
import { openDb } from '../src/store/db.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { JobStore } from '../src/store/jobs.ts'
import { RecipeStore } from '../src/store/recipes.ts'
import { downgradeContextCheckpointsToV23 } from './fixtures/context-checkpoint-migration.ts'

const CREATED_AT = '2026-08-13T12:00:00.000Z'
const UPDATED_AT = '2026-08-13T13:00:00.000Z'
const RECIPE_ID = '11111111-1111-4111-8111-111111111111'
const OWNED_RECIPE_ID = '22222222-2222-4222-8222-222222222222'

const configuration = (overrides: Partial<RecipeConfiguration> = {}): RecipeConfiguration => ({
  recipeRevisionVersion: RECIPE_REVISION_VERSION,
  operation: 'complete',
  model: { state: 'none', reason: 'not_selected' },
  instructions: 'Answer with sourced facts.',
  defaultParameters: { temperature: 0.2, nested: { enabled: true } },
  retention: { mode: 'ttl', expiresAfterDays: 7 },
  ...overrides,
})

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

function tablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map(({ name }) => name)
    .filter((name) => !excluded.has(name)
      && name !== 'artifact_blobs'
      && name !== 'artifacts'
      && name !== 'artifact_attachments')
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ])))
}

function downgradeToV21(db: DatabaseSync): void {
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
    PRAGMA user_version = 21;
  `)
}

function routeApp(db: DatabaseSync): Hono {
  const app = new Hono()
  app.route('/api/recipes', recipesRoutes({
    db,
    projects: new ProjectService(new ProjectStore(db)),
    jobService: new JobService(new JobStore(db)),
  }))
  return app
}

function json(method: 'POST' | 'PATCH', body: unknown) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('P3-K canonical Recipe revision foundation', () => {
  it('keeps version, operation, model, defaults, retention and scopes strict', () => {
    for (const operation of RECIPE_OPERATIONS) {
      assert.equal(createRecipeBody.safeParse({
        recipeVersion: 1,
        name: 'Strict Recipe',
        scope: 'projectless',
        configuration: configuration({ operation }),
      }).success, true)
    }
    for (const model of [
      { state: 'none', reason: 'not_selected' },
      { state: 'explicit', provider: 'ollama', reference: 'qwen3:8b' },
    ] as const) {
      assert.equal(recipeConfigurationSchema.safeParse(configuration({ model })).success, true)
    }
    for (const invalid of [
      { recipeVersion: 2, name: 'Future', scope: 'projectless', configuration: configuration() },
      { recipeVersion: 1, name: 'Unknown', scope: 'projectless', configuration: configuration({ operation: 'chat' as never }) },
      { recipeVersion: 1, name: 'Extra', scope: 'projectless', configuration: configuration(), future: true },
      { recipeVersion: 1, name: 'Cross', scope: 'projectless', projectId: 'leak', configuration: configuration() },
      { recipeVersion: 1, name: 'Model', scope: 'projectless', configuration: configuration({ model: { state: 'explicit', provider: 'ollama', reference: ' qwen ' } }) },
      { recipeVersion: 1, name: 'Defaults', scope: 'projectless', configuration: { ...configuration(), defaultParameters: { bad: Number.POSITIVE_INFINITY } } },
      { recipeVersion: 1, name: 'Retention', scope: 'projectless', configuration: { ...configuration(), retention: { mode: 'ttl', expiresAfterDays: 30 } } },
      { recipeVersion: 1, name: 'Configuration extra', scope: 'projectless', configuration: { ...configuration(), routing: 'automatic' } },
    ]) assert.equal(createRecipeBody.safeParse(invalid).success, false)
    assert.equal(recipeScopeQuery.safeParse({ recipeVersion: 1, scope: 'projectless', extra: true }).success, false)
    assert.equal(reviseRecipeBody.safeParse({
      recipeVersion: 1,
      scope: 'projectless',
      expectedRevision: 0,
      configuration: configuration(),
    }).success, false)
  })

  it('applies migration 22 on fresh/v21/reopen/retry and truly rolls back exact v21 bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-recipe-v22-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const seed = openDb(path)
    assert.equal(version(seed), 28)
    const project = new ProjectStore(seed).create('Exact v21 Project', CREATED_AT)
    seed.prepare(
      `INSERT INTO quick_runs (
         id, quick_run_version, operation, project_id, created_at, updated_at,
         retention_policy, retention_policy_source, retention_policy_updated_at
       ) VALUES ('v21-run', 1, 'complete', ?, ?, ?, 'ttl', 'default', ?)`,
    ).run(project.id, CREATED_AT, CREATED_AT, CREATED_AT)
    downgradeToV21(seed)
    const exactV21 = tablesPayload(seed, new Set())
    seed.exec(`
      CREATE TABLE migration_22_midpoint_sentinel (collision TEXT NOT NULL);
      CREATE INDEX idx_recipes_scope_updated ON migration_22_midpoint_sentinel(collision);
    `)
    seed.prepare('INSERT INTO migration_22_midpoint_sentinel VALUES (?)').run('block')
    seed.close()

    assert.throws(() => openDb(path), /Миграция 22 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 21)
    assert.equal(count(rolledBack, 'migration_22_midpoint_sentinel'), 1)
    assert.equal(tablesPayload(rolledBack, new Set(['migration_22_midpoint_sentinel'])), exactV21)
    rolledBack.exec('DROP INDEX idx_recipes_scope_updated; DROP TABLE migration_22_midpoint_sentinel;')
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 28)
    assert.equal(count(retried, 'recipes'), 0)
    assert.equal(count(retried, 'recipe_revisions'), 0)
    assert.equal(tablesPayload(retried, new Set([
      'recipes', 'recipe_revisions', 'recipe_job_snapshots', 'context_checkpoints',
    ])), exactV21)
    retried.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 28)
    assert.equal(tablesPayload(reopened, new Set([
      'recipes', 'recipe_revisions', 'recipe_job_snapshots', 'context_checkpoints',
    ])), exactV21)
    reopened.close()
    const fresh = openDb(':memory:')
    assert.equal(version(fresh), 28)
    fresh.close()
  })

  it('atomically creates revision 1, keeps history exact, separates rename and fails stale CAS closed', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-recipe-cas-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const project = new ProjectStore(db).create('Logical Project', CREATED_AT)
    let clock = CREATED_AT
    const ids = ['33333333-3333-4333-8333-333333333333', RECIPE_ID, OWNED_RECIPE_ID]
    const store = new RecipeStore(db, { clock: () => clock, createId: () => ids.shift()! })

    db.exec("CREATE TRIGGER recipe_create_failure BEFORE INSERT ON recipe_revisions WHEN NEW.recipe_id = '33333333-3333-4333-8333-333333333333' BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END;")
    assert.throws(() => store.create({ name: 'Atomic failure', scope: { scope: 'projectless' }, configuration: configuration() }), /injected revision failure/u)
    assert.equal(count(db, 'recipes'), 0)
    assert.equal(count(db, 'recipe_revisions'), 0)
    db.exec('DROP TRIGGER recipe_create_failure')

    assert.throws(() => store.create({
      name: 'x'.repeat(256),
      scope: { scope: 'projectless' },
      configuration: configuration(),
    }))
    assert.equal(count(db, 'recipes'), 0)
    assert.equal(count(db, 'recipe_revisions'), 0)

    const projectless = store.create({ name: 'Projectless Recipe', scope: { scope: 'projectless' }, configuration: configuration() })
    const owned = store.create({
      name: 'Owned Recipe',
      scope: { scope: 'project', projectId: project.id },
      configuration: configuration({
        model: { state: 'explicit', provider: 'ollama', reference: 'qwen3:8b' },
        defaultParameters: { z: 1, a: { y: true, x: false } },
      }),
    })
    assert.equal(projectless.currentRevision.revision, 1)
    assert.equal(owned.currentRevision.revision, 1)
    assert.equal(count(db, 'recipe_revisions'), 2)
    assert.deepEqual(store.list({ scope: 'projectless' }).map(({ id }) => id), [RECIPE_ID])
    assert.deepEqual(store.list({ scope: 'project', projectId: project.id }).map(({ id }) => id), [OWNED_RECIPE_ID])
    assert.equal(store.get(OWNED_RECIPE_ID, { scope: 'projectless' }).status, 'scope_mismatch')
    assert.equal(store.get(RECIPE_ID, { scope: 'project', projectId: project.id }).status, 'scope_mismatch')

    const revision1Bytes = (db.prepare(
      'SELECT configuration_json FROM recipe_revisions WHERE recipe_id = ? AND revision_number = 1',
    ).get(OWNED_RECIPE_ID) as { configuration_json: string }).configuration_json
    clock = UPDATED_AT
    const renamed = store.rename(OWNED_RECIPE_ID, { scope: 'project', projectId: project.id }, 'Renamed Recipe')
    assert.equal(renamed.status, 'ok')
    assert.equal(count(db, 'recipe_revisions'), 2)
    assert.equal(store.getRevision(OWNED_RECIPE_ID, 1, { scope: 'project', projectId: project.id }).status, 'ok')
    assert.throws(() => store.rename(
      OWNED_RECIPE_ID,
      { scope: 'project', projectId: project.id },
      'x'.repeat(256),
    ))
    const afterRejectedRename = store.get(OWNED_RECIPE_ID, { scope: 'project', projectId: project.id })
    assert.equal(afterRejectedRename.status, 'ok')
    if (afterRejectedRename.status === 'ok') {
      assert.equal(afterRejectedRename.recipe.name, 'Renamed Recipe')
    }

    const second = configuration({ operation: 'ocr', instructions: 'Extract exact text.', retention: { mode: 'keep' } })
    const revised = store.revise(OWNED_RECIPE_ID, { scope: 'project', projectId: project.id }, 1, second)
    assert.equal(revised.status, 'ok')
    if (revised.status === 'ok') {
      assert.equal(revised.recipe.currentRevision.revision, 2)
      assert.equal(revised.recipe.name, 'Renamed Recipe')
      assert.equal(revised.recipe.projectId, project.id)
    }
    const stale = store.revise(OWNED_RECIPE_ID, { scope: 'project', projectId: project.id }, 1, configuration({ operation: 'embed' }))
    assert.deepEqual(stale, { status: 'conflict', currentRevision: 2 })
    assert.equal(count(db, 'recipe_revisions'), 3)
    assert.equal((db.prepare(
      'SELECT configuration_json FROM recipe_revisions WHERE recipe_id = ? AND revision_number = 1',
    ).get(OWNED_RECIPE_ID) as { configuration_json: string }).configuration_json, revision1Bytes)
    const historical = store.getRevision(OWNED_RECIPE_ID, 1, { scope: 'project', projectId: project.id })
    assert.equal(historical.status, 'ok')
    if (historical.status === 'ok') assert.equal(historical.revision.canonical.byteSize, Buffer.byteLength(revision1Bytes))
    assert.throws(() => db.prepare('UPDATE recipes SET project_id = NULL WHERE id = ?').run(OWNED_RECIPE_ID), /immutable/u)
    assert.throws(() => db.prepare('UPDATE recipe_revisions SET instructions = ? WHERE recipe_id = ? AND revision_number = 1').run('mutated', OWNED_RECIPE_ID), /immutable/u)
    assert.throws(() => db.prepare('DELETE FROM projects WHERE id = ?').run(project.id), /FOREIGN KEY/u)
    db.close()

    // A second application connection observes revision 2 and loses the same stale expectation.
    const otherDb = openDb(path)
    const other = new RecipeStore(otherDb)
    assert.deepEqual(
      other.revise(OWNED_RECIPE_ID, { scope: 'project', projectId: project.id }, 1, configuration()),
      { status: 'conflict', currentRevision: 2 },
    )
    assert.equal(count(otherDb, 'recipe_revisions'), 3)
    otherDb.close()
  })

  it('round-trips create/list/read/historical/rename/revise and rejects future/cross-scope requests', async () => {
    const db = openDb(':memory:')
    const project = new ProjectStore(db).create('Route Project', CREATED_AT)
    const app = routeApp(db)
    const create = await app.request('/api/recipes', json('POST', {
      recipeVersion: RECIPE_VERSION,
      name: 'HTTP Recipe',
      scope: 'project',
      projectId: project.id,
      configuration: configuration({ model: { state: 'explicit', provider: 'ollama', reference: 'qwen3:8b' } }),
    }))
    assert.equal(create.status, 201)
    const recipe = recipeSchema.parse(await create.json())
    assert.equal(recipe.currentRevision.revision, 1)
    assert.equal((await app.request(`/api/recipes?recipeVersion=1&scope=project&projectId=${project.id}`)).status, 200)
    assert.equal((await app.request(`/api/recipes/${recipe.id}?recipeVersion=1&scope=projectless`)).status, 404)
    const exact = await app.request(`/api/recipes/${recipe.id}/revisions/1?recipeVersion=1&scope=project&projectId=${project.id}`)
    assert.equal(exact.status, 200)

    const rename = await app.request(`/api/recipes/${recipe.id}/name`, json('PATCH', {
      recipeVersion: 1,
      scope: 'project',
      projectId: project.id,
      name: 'Renamed over HTTP',
    }))
    assert.equal(rename.status, 200)
    assert.equal(recipeSchema.parse(await rename.json()).currentRevision.revision, 1)

    const revise = await app.request(`/api/recipes/${recipe.id}/revisions`, json('POST', {
      recipeVersion: 1,
      scope: 'project',
      projectId: project.id,
      expectedRevision: 1,
      configuration: configuration({ operation: 'transcribe', model: { state: 'none', reason: 'not_selected' } }),
    }))
    assert.equal(revise.status, 200)
    assert.equal(recipeSchema.parse(await revise.json()).currentRevision.revision, 2)
    const stale = await app.request(`/api/recipes/${recipe.id}/revisions`, json('POST', {
      recipeVersion: 1,
      scope: 'project',
      projectId: project.id,
      expectedRevision: 1,
      configuration: configuration(),
    }))
    assert.equal(stale.status, 409)
    assert.equal((await stale.json() as { code: string }).code, 'recipe_revision_conflict')

    for (const url of [
      '/api/recipes?recipeVersion=2&scope=projectless',
      '/api/recipes?recipeVersion=1&scope=projectless&future=1',
      '/api/recipes?recipeVersion=1&recipeVersion=1&scope=projectless',
      '/api/recipes/not-a-uuid?recipeVersion=1&scope=projectless',
      `/api/recipes/${recipe.id}/revisions/future?recipeVersion=1&scope=project&projectId=${project.id}`,
    ]) assert.equal((await app.request(url)).status, 400)
    assert.equal((await app.request('/api/recipes', json('POST', {
      recipeVersion: 1,
      name: 'Missing Project',
      scope: 'project',
      projectId: 'missing',
      configuration: configuration(),
    }))).status, 404)
    assert.equal(count(db, 'jobs'), 0)
    assert.equal(count(db, 'job_events'), 0)
    assert.equal(count(db, 'threads'), 0)
    assert.equal(count(db, 'messages'), 0)
    assert.equal(count(db, 'quick_runs'), 0)
    assert.equal(count(db, 'workspaces'), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 0)
    db.close()
  })
})
