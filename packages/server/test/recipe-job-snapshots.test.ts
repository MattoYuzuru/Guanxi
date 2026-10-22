import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { Hono } from 'hono'
import {
  createRecipeJobSnapshotBody,
  createRecipeJobSnapshotResponse,
  getRecipeJobSnapshotResponse,
  recipeJobSnapshotQuery,
  type RecipeConfiguration,
} from '@guanxi/contract'
import { recipesRoutes } from '../src/http/recipes-routes.ts'
import { JobService } from '../src/jobs/service.ts'
import { ProjectService } from '../src/projects/service.ts'
import { openDb } from '../src/store/db.ts'
import {
  JobStore,
  JobStoreError,
  type CreateRecipeJobSnapshotInput,
  type CreateRecipeJobSnapshotResult,
} from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { RecipeStore } from '../src/store/recipes.ts'
import { downgradeContextCheckpointsToV23 } from './fixtures/context-checkpoint-migration.ts'
import { orderedRows } from './fixtures/table-rows.ts'
import { SESSION_LOG_TABLES } from './fixtures/session-log-migration.ts'

const AT = '2026-08-14T10:00:00.000Z'
const RECIPE_ID = '11111111-1111-4111-8111-111111111111'
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const configuration = (overrides: Partial<RecipeConfiguration> = {}): RecipeConfiguration => ({
  recipeRevisionVersion: 1,
  operation: 'complete',
  model: { state: 'none', reason: 'not_selected' },
  instructions: 'Private exact Recipe instructions.',
  defaultParameters: { temperature: 0.2, nested: { enabled: true } },
  retention: { mode: 'ttl', expiresAfterDays: 7 },
  ...overrides,
})

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string, where = '', ...parameters: string[]): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}" ${where}`).get(
    ...parameters,
  ) as { count: number }).count
}

function tablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>)
    .map(({ name }) => name)
    .filter((name) => !excluded.has(name)
      && name !== 'artifact_blobs'
      && name !== 'artifacts'
      && name !== 'artifact_attachments')
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    orderedRows(db, name),
  ])))
}

function downgradeToV22(db: DatabaseSync): void {
  downgradeContextCheckpointsToV23(db)
  db.exec(`
    DROP TRIGGER recipe_snapshot_job_identity_immutable;
    DROP TRIGGER recipe_job_snapshots_immutable_delete;
    DROP TRIGGER recipe_job_snapshots_immutable_update;
    DROP TRIGGER recipe_job_snapshots_exact_job;
    DROP TRIGGER recipe_job_snapshots_exact_source;
    DROP INDEX idx_recipe_job_snapshots_recipe;
    DROP TABLE recipe_job_snapshots;
    PRAGMA user_version = 22;
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

function json(body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

type WorkerResult =
  | { ok: true; result: CreateRecipeJobSnapshotResult }
  | { ok: false; error: string; code: string | null }

async function runConcurrent(
  dbPath: string,
  inputs: CreateRecipeJobSnapshotInput[],
): Promise<WorkerResult[]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  return Promise.all(inputs.map((input) => new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(new URL('./fixtures/job-store-worker.ts', import.meta.url), {
      workerData: {
        dbPath,
        gate,
        participants: inputs.length,
        task: { operation: 'createRecipeSnapshot', input },
      },
    })
    worker.once('message', (message: WorkerResult) => resolve(message))
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Recipe Job worker exited with code ${code}`))
    })
  })))
}

describe('P3-L exact Recipe revision to queued Job snapshot', () => {
  it('keeps create/read version, UUID key, paths and scopes strict', () => {
    assert.equal(createRecipeJobSnapshotBody.safeParse({
      recipeJobSnapshotVersion: 1,
      scope: 'projectless',
      idempotencyKey: KEY,
    }).success, true)
    assert.equal(recipeJobSnapshotQuery.safeParse({
      recipeJobSnapshotVersion: '1',
      scope: 'projectless',
    }).success, true)
    for (const invalid of [
      { recipeJobSnapshotVersion: 2, scope: 'projectless', idempotencyKey: KEY },
      { recipeJobSnapshotVersion: 1, scope: 'projectless', projectId: 'leak', idempotencyKey: KEY },
      { recipeJobSnapshotVersion: 1, scope: 'projectless', idempotencyKey: 'not-a-uuid' },
      { recipeJobSnapshotVersion: 1, scope: 'projectless', idempotencyKey: KEY, future: true },
    ]) assert.equal(createRecipeJobSnapshotBody.safeParse(invalid).success, false)
    assert.equal(recipeJobSnapshotQuery.safeParse({
      recipeJobSnapshotVersion: 1,
      scope: 'projectless',
      future: true,
    }).success, false)
  })

  it('applies migration 23 on fresh/v22/reopen/retry and truly rolls back exact v22 bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-recipe-job-v23-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seeded = openDb(path)
    assert.equal(version(seeded), 33)
    const project = new ProjectStore(seeded).create('Exact v22 Project', AT)
    new RecipeStore(seeded, { clock: () => AT, createId: () => RECIPE_ID }).create({
      name: 'Exact v22 Recipe',
      scope: { scope: 'project', projectId: project.id },
      configuration: configuration(),
    })
    downgradeToV22(seeded)
    const exactV22 = tablesPayload(seeded, new Set())
    seeded.exec(`
      CREATE TABLE migration_23_midpoint_sentinel (collision TEXT NOT NULL);
      CREATE INDEX idx_recipe_job_snapshots_recipe
        ON migration_23_midpoint_sentinel(collision);
    `)
    seeded.prepare('INSERT INTO migration_23_midpoint_sentinel VALUES (?)').run('block')
    seeded.close()

    assert.throws(() => openDb(path), /Миграция 23 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 22)
    assert.equal(count(rolledBack, 'migration_23_midpoint_sentinel'), 1)
    assert.equal(
      tablesPayload(rolledBack, new Set(['migration_23_midpoint_sentinel'])),
      exactV22,
    )
    rolledBack.exec(
      'DROP INDEX idx_recipe_job_snapshots_recipe; DROP TABLE migration_23_midpoint_sentinel;',
    )
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 33)
    assert.equal(count(retried, 'recipe_job_snapshots'), 0)
    assert.equal(
      tablesPayload(retried, new Set(['recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES])),
      exactV22,
    )
    retried.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 33)
    assert.equal(
      tablesPayload(reopened, new Set(['recipe_job_snapshots', 'context_checkpoints', ...SESSION_LOG_TABLES])),
      exactV22,
    )
    reopened.close()
    const fresh = openDb(':memory:')
    assert.equal(version(fresh), 33)
    fresh.close()
  })

  it('atomically creates one private immutable historical snapshot and stays queued', () => {
    const db = openDb(':memory:')
    const project = new ProjectStore(db).create('Snapshot Project', AT)
    let now = AT
    const recipes = new RecipeStore(db, { clock: () => now, createId: () => RECIPE_ID })
    const createdRecipe = recipes.create({
      name: 'Snapshot Recipe',
      scope: { scope: 'project', projectId: project.id },
      configuration: configuration({
        model: { state: 'explicit', provider: 'ollama', reference: 'qwen3:8b' },
      }),
    })
    const jobs = new JobStore(db)
    const input: CreateRecipeJobSnapshotInput = {
      recipeId: RECIPE_ID,
      recipeRevision: 1,
      scope: { scope: 'project', projectId: project.id },
      idempotencyKey: KEY,
    }

    db.exec(`
      CREATE TRIGGER recipe_snapshot_injected_failure
      BEFORE INSERT ON recipe_job_snapshots
      BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END;
    `)
    assert.throws(() => jobs.createRecipeSnapshot(input), /injected snapshot failure/u)
    assert.equal(count(db, 'jobs'), 0)
    assert.equal(count(db, 'job_events'), 0)
    assert.equal(count(db, 'recipe_job_snapshots'), 0)
    db.exec('DROP TRIGGER recipe_snapshot_injected_failure')

    const first = jobs.createRecipeSnapshot(input)
    const duplicate = jobs.createRecipeSnapshot(input)
    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, first.job.id)
    assert.deepEqual(duplicate.snapshot, first.snapshot)
    assert.equal(first.job.kind, 'inference')
    assert.equal(first.job.operation, 'complete')
    assert.equal(first.job.status, 'queued')
    assert.equal(first.job.phase, null)
    assert.equal(first.job.lastEventSequence, 1)
    assert.equal(first.snapshot.execution, 'not_implemented')
    assert.equal(first.snapshot.recipeRevision, 1)
    assert.equal(first.snapshot.projectId, project.id)
    assert.deepEqual(first.snapshot.model, {
      state: 'explicit',
      provider: 'ollama',
      reference: 'qwen3:8b',
    })
    assert.equal(first.snapshot.canonical.sha256, createdRecipe.currentRevision.canonical.sha256)
    assert.equal(count(db, 'jobs'), 1)
    assert.equal(count(db, 'job_events'), 1)
    assert.equal(count(db, 'recipe_job_snapshots'), 1)
    assert.equal(count(db, 'chat_job_inputs'), 0)
    assert.deepEqual(jobs.eventsAfter(first.job.id, 0).map((event) => ({
      sequence: event.sequence,
      type: event.type,
      state: event.state,
      phase: event.phase,
      metadata: event.metadata,
      output: event.output,
    })), [{
      sequence: 1,
      type: 'lifecycle',
      state: 'queued',
      phase: null,
      metadata: {},
      output: null,
    }])
    assert.equal(JSON.stringify(first.job).includes('Private exact Recipe'), false)
    assert.equal(JSON.stringify(jobs.eventsAfter(first.job.id, 0)).includes('Private exact Recipe'), false)

    const originalSnapshot = JSON.stringify(first.snapshot)
    now = '2026-08-14T11:00:00.000Z'
    assert.equal(
      recipes.rename(RECIPE_ID, { scope: 'project', projectId: project.id }, 'Renamed later').status,
      'ok',
    )
    assert.equal(recipes.revise(
      RECIPE_ID,
      { scope: 'project', projectId: project.id },
      1,
      configuration({ operation: 'ocr', instructions: 'New revision instructions.' }),
    ).status, 'ok')
    assert.equal(JSON.stringify(jobs.recipeSnapshot(first.job.id)?.snapshot), originalSnapshot)
    assert.throws(
      () => jobs.createRecipeSnapshot({ ...input, recipeRevision: 2 }),
      (error: unknown) => error instanceof JobStoreError && error.code === 'idempotency_conflict',
    )
    assert.throws(
      () => jobs.createRecipeSnapshot({ ...input, scope: { scope: 'projectless' } }),
      (error: unknown) => error instanceof JobStoreError && error.code === 'invalid_input',
    )
    assert.equal(count(db, 'jobs'), 1)
    assert.throws(
      () => db.prepare('UPDATE recipe_job_snapshots SET operation = ? WHERE job_id = ?')
        .run('ocr', first.job.id),
      /immutable/u,
    )
    for (const [column, value] of [
      ['id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['kind', 'tool'],
      ['operation', 'ocr'],
      ['idempotency_scope', 'different:v1'],
      ['idempotency_key', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['created_at', '2026-08-14T12:00:00.000Z'],
    ] as const) {
      assert.throws(
        () => db.prepare(`UPDATE jobs SET ${column} = ? WHERE id = ?`).run(value, first.job.id),
        /identity is immutable/u,
      )
    }
    assert.throws(
      () => db.prepare('DELETE FROM recipe_revisions WHERE recipe_id = ? AND revision_number = 1')
        .run(RECIPE_ID),
      /immutable|constraint/u,
    )
    assert.throws(() => db.prepare('DELETE FROM jobs WHERE id = ?').run(first.job.id))
    assert.throws(() => db.prepare('DELETE FROM projects WHERE id = ?').run(project.id))
    db.close()
  })

  it('rejects raw snapshot rows unless source, Job, event and restrictive ownership are exact', () => {
    const db = openDb(':memory:')
    new RecipeStore(db, { clock: () => AT, createId: () => RECIPE_ID }).create({
      name: 'Guarded Recipe',
      scope: { scope: 'projectless' },
      configuration: configuration(),
    })
    const revision = db.prepare(
      `SELECT operation, model_state, model_provider, model_reference,
              configuration_json, configuration_byte_size, configuration_sha256
       FROM recipe_revisions WHERE recipe_id = ? AND revision_number = 1`,
    ).get(RECIPE_ID) as {
      operation: string
      model_state: string
      model_provider: string | null
      model_reference: string | null
      configuration_json: string
      configuration_byte_size: number
      configuration_sha256: string
    }
    const insertJob = (
      id: string,
      options: { event?: boolean; idempotencyScope?: string; operation?: string } = {},
    ) => {
      const operation = options.operation ?? revision.operation
      db.prepare(
        `INSERT INTO jobs (
           id, kind, operation, status, phase, idempotency_scope, idempotency_key,
           created_at, started_at, finished_at, error, outcome, stop_reason,
           last_event_sequence
         ) VALUES (?, 'inference', ?, 'queued', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, 1)`,
      ).run(
        id,
        operation,
        options.idempotencyScope ?? 'recipe_job_snapshot:v1',
        id,
        AT,
      )
      if (options.event !== false) {
        db.prepare(
          `INSERT INTO job_events (
             id, job_id, sequence, type, state, phase, metadata, output,
             output_privacy, created_at
           ) VALUES (?, ?, 1, 'lifecycle', 'queued', NULL, '{}', NULL, NULL, ?)`,
        ).run(`event-${id}`, id, AT)
      }
    }
    const insertSnapshot = (jobId: string, operation = revision.operation) => db.prepare(
      `INSERT INTO recipe_job_snapshots (
         job_id, snapshot_version, recipe_id, recipe_revision, scope, project_id,
         job_kind, operation, model_state, model_provider, model_reference,
         configuration_json, configuration_byte_size, configuration_sha256,
         request_fingerprint, created_at
       ) VALUES (?, 1, ?, 1, 'projectless', NULL, 'inference', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      RECIPE_ID,
      operation,
      revision.model_state,
      revision.model_provider,
      revision.model_reference,
      revision.configuration_json,
      revision.configuration_byte_size,
      revision.configuration_sha256,
      'a'.repeat(64),
      AT,
    )

    const missingEventJob = '33333333-3333-4333-8333-333333333333'
    insertJob(missingEventJob, { event: false })
    assert.throws(() => insertSnapshot(missingEventJob), /Job mismatch/u)

    const malformedEventJob = '66666666-6666-4666-8666-666666666666'
    insertJob(malformedEventJob)
    db.prepare('UPDATE job_events SET metadata = ? WHERE job_id = ?')
      .run('{"unexpected":"private"}', malformedEventJob)
    assert.throws(() => insertSnapshot(malformedEventJob), /Job mismatch/u)

    const wrongIdentityJob = '44444444-4444-4444-8444-444444444444'
    insertJob(wrongIdentityJob, { idempotencyScope: 'public:v1' })
    assert.throws(() => insertSnapshot(wrongIdentityJob), /Job mismatch/u)

    const wrongSourceJob = '55555555-5555-4555-8555-555555555555'
    insertJob(wrongSourceJob, { operation: 'ocr' })
    assert.throws(() => insertSnapshot(wrongSourceJob, 'ocr'), /source mismatch/u)
    assert.equal(count(db, 'recipe_job_snapshots'), 0)

    assert.deepEqual(
      (db.prepare("PRAGMA foreign_key_list('recipe_job_snapshots')").all() as Array<{
        id: number
        seq: number
        table: string
        from: string
        to: string
        on_delete: string
      }>).map(({ id, seq, table, from, to, on_delete: onDelete }) => ({
        id, seq, table, from, to, onDelete,
      })),
      [
        { id: 0, seq: 0, table: 'recipe_revisions', from: 'recipe_id', to: 'recipe_id', onDelete: 'RESTRICT' },
        { id: 0, seq: 1, table: 'recipe_revisions', from: 'recipe_revision', to: 'revision_number', onDelete: 'RESTRICT' },
        { id: 1, seq: 0, table: 'projects', from: 'project_id', to: 'id', onDelete: 'RESTRICT' },
        { id: 2, seq: 0, table: 'jobs', from: 'job_id', to: 'id', onDelete: 'RESTRICT' },
      ],
    )
    db.close()
  })

  it('serializes a true two-connection duplicate into one Job/event/snapshot', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-recipe-job-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const db = openDb(path)
    const recipe = new RecipeStore(db, { clock: () => AT, createId: () => RECIPE_ID }).create({
      name: 'Race Recipe',
      scope: { scope: 'projectless' },
      configuration: configuration(),
    })
    assert.equal(recipe.id, RECIPE_ID)
    db.close()

    const input: CreateRecipeJobSnapshotInput = {
      recipeId: RECIPE_ID,
      recipeRevision: 1,
      scope: { scope: 'projectless' },
      idempotencyKey: KEY,
    }
    const results = await runConcurrent(path, [input, input])
    assert.equal(results.every((result) => result.ok), true)
    const successful = results.filter((result): result is Extract<WorkerResult, { ok: true }> => result.ok)
    assert.equal(successful.length, 2)
    assert.equal(successful.filter(({ result }) => result.created).length, 1)
    assert.equal(new Set(successful.map(({ result }) => result.job.id)).size, 1)
    const verified = openDb(path)
    assert.equal(count(verified, 'jobs'), 1)
    assert.equal(count(verified, 'job_events'), 1)
    assert.equal(count(verified, 'recipe_job_snapshots'), 1)
    verified.close()
  })

  it('round-trips strict scoped create/repeat/read and rejects malformed or cross-scope input', async () => {
    const db = openDb(':memory:')
    new RecipeStore(db, { clock: () => AT, createId: () => RECIPE_ID }).create({
      name: 'HTTP Recipe',
      scope: { scope: 'projectless' },
      configuration: configuration(),
    })
    const app = routeApp(db)
    const url = `/api/recipes/${RECIPE_ID}/revisions/1/jobs`
    const body = {
      recipeJobSnapshotVersion: 1,
      scope: 'projectless',
      idempotencyKey: KEY,
    }
    const created = await app.request(url, json(body))
    assert.equal(created.status, 202)
    const response = createRecipeJobSnapshotResponse.parse(await created.json())
    assert.equal(response.created, true)
    assert.equal(response.snapshot.recipeId, RECIPE_ID)
    assert.equal(response.snapshot.execution, 'not_implemented')
    assert.deepEqual(response.snapshot.model, { state: 'none', reason: 'not_selected' })
    assert.deepEqual(response.snapshot.configuration.model, {
      state: 'none', reason: 'not_selected',
    })
    assert.equal(response.eventsUrl, `/api/jobs/${response.job.id}/events`)
    const repeat = await app.request(url, json(body))
    assert.equal(repeat.status, 200)
    const repeated = createRecipeJobSnapshotResponse.parse(await repeat.json())
    assert.equal(repeated.created, false)
    assert.equal(repeated.job.id, response.job.id)

    const read = await app.request(
      `${url}/${response.job.id}?recipeJobSnapshotVersion=1&scope=projectless`,
    )
    assert.equal(read.status, 200, await read.clone().text())
    assert.deepEqual(
      getRecipeJobSnapshotResponse.parse(await read.json()).snapshot,
      response.snapshot,
    )
    for (const request of [
      app.request(`/api/recipes/not-a-uuid/revisions/1/jobs`, json(body)),
      app.request(`/api/recipes/${RECIPE_ID}/revisions/0/jobs`, json(body)),
      app.request(url, json({ ...body, recipeJobSnapshotVersion: 2 })),
      app.request(url, json({ ...body, future: true })),
      app.request(url, json({ ...body, idempotencyKey: 'invalid' })),
      app.request(`${url}/${response.job.id}?recipeJobSnapshotVersion=2&scope=projectless`),
      app.request(`${url}/${response.job.id}?recipeJobSnapshotVersion=1&scope=projectless&future=1`),
    ]) assert.equal((await request).status, 400)
    assert.equal((await app.request(url, json({
      recipeJobSnapshotVersion: 1,
      scope: 'project',
      projectId: 'missing-project',
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }))).status, 404)
    assert.equal((await app.request(
      `${url}/${response.job.id}?recipeJobSnapshotVersion=1&scope=project&projectId=missing-project`,
    )).status, 404)
    assert.equal(count(db, 'jobs'), 1)
    assert.equal(count(db, 'job_events'), 1)
    assert.equal(count(db, 'recipe_job_snapshots'), 1)
    assert.equal(count(db, 'threads'), 0)
    assert.equal(count(db, 'messages'), 0)
    assert.equal(count(db, 'quick_runs'), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 0)
    db.close()
  })
})
