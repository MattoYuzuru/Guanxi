import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getEventListeners } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  ATTACHMENT_VERSION,
  attachmentDisplayNameSchema,
  attachmentSchema,
  artifactTransferPolicySchema,
  listAttachmentsResponse,
} from '@guanxi/contract'
import {
  ArtifactTransferError,
  ArtifactTransferService,
} from '../src/artifacts/transfer-service.ts'
import { artifactsRoutes } from '../src/http/artifacts-routes.ts'
import {
  ArtifactStore,
  ArtifactStoreError,
  type ArtifactStoreHooks,
} from '../src/store/artifacts.ts'
import { openDb } from '../src/store/db.ts'
import { ProjectService } from '../src/projects/service.ts'
import { ProjectStore } from '../src/store/projects.ts'
import {
  downgradeAttachmentNameHardeningToV27,
  downgradeAttachmentStoreToV26,
} from './fixtures/artifact-store-migration.ts'

const AT = '2026-08-14T14:00:00.000Z'
const LEGACY_PROJECT = 'legacy-workspace-project'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(
  test: { after(fn: () => unknown): void },
  options: {
    maxBytes?: number
    maxActiveTransfers?: number
    maxQueuedTransfers?: number
    hooks?: ArtifactStoreHooks
    helperTimeoutMs?: number
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-attachment-route-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'guanxi.db'))
  test.after(() => db.close())
  db.prepare(
    `INSERT INTO projects (id, name, created_at, updated_at)
     VALUES (?, 'Legacy Project', ?, ?)`,
  ).run(LEGACY_PROJECT, AT, AT)
  const artifactRoot = join(root, 'artifacts')
  const store = new ArtifactStore({
    db,
    rootDir: artifactRoot,
    now: () => new Date(AT),
    hooks: options.hooks,
    helperTimeoutMs: options.helperTimeoutMs,
  })
  const service = new ArtifactTransferService({
    store,
    now: () => new Date(AT),
    policy: {
      state: 'enabled',
      source: 'test_override',
      maxBytes: options.maxBytes ?? 1_024,
      maxActiveTransfers: options.maxActiveTransfers ?? 1,
      maxQueuedTransfers: options.maxQueuedTransfers ?? 2,
    },
  })
  const app = new Hono()
  app.route('/api/artifacts', artifactsRoutes({
    artifactTransfers: service,
    projects: new ProjectService(new ProjectStore(db)),
  }))
  return { root, artifactRoot, db, store, service, app }
}

function uploadUrl(displayName: string, projectId?: string): string {
  const query = new URLSearchParams({
    attachmentVersion: String(ATTACHMENT_VERSION),
    scope: projectId === undefined ? 'projectless' : 'project',
    displayName,
  })
  if (projectId !== undefined) query.set('projectId', projectId)
  return `/api/artifacts?${query}`
}

function scopeQuery(projectId?: string, limit?: number): string {
  const query = new URLSearchParams({
    attachmentVersion: String(ATTACHMENT_VERSION),
    scope: projectId === undefined ? 'projectless' : 'project',
  })
  if (projectId !== undefined) query.set('projectId', projectId)
  if (limit !== undefined) query.set('limit', String(limit))
  return query.toString()
}

function uploadInit(bytes: Uint8Array, intent = randomUUID(), mediaType = 'application/octet-stream') {
  return {
    method: 'POST',
    headers: {
      'content-type': mediaType,
      'idempotency-key': intent,
    },
    body: bytes,
  }
}

describe('P3-O attachment migration and public transfer boundary', () => {
  it('migrates fresh/v26/v27/reopen/retry with exact rows and true late-DDL rollback', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-attachment-migration-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const freshPath = join(root, 'fresh.db')
    const fresh = openDb(freshPath)
    assert.equal(version(fresh), 32)
    assert.equal(count(fresh, 'artifact_attachments'), 0)
    fresh.close()
    const reopened = openDb(freshPath)
    assert.equal(version(reopened), 32)
    reopened.close()

    const upgradePath = join(root, 'upgrade.db')
    const seed = openDb(upgradePath)
    seed.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, 'Legacy', ?, ?)`,
    ).run(LEGACY_PROJECT, AT, AT)
    const generic = new ArtifactStore({
      db: seed,
      rootDir: join(root, 'blobs'),
      now: () => new Date(AT),
    })
    const genericArtifact = await generic.create({
      artifactVersion: 1,
      idempotencyKey: randomUUID(),
      kind: 'file',
      mediaType: 'text/plain',
      ownership: { scope: 'project', projectId: LEGACY_PROJECT },
      source: { jobId: null, parentArtifactId: null },
    }, Buffer.from('preserved'), { maxBytes: 9 })
    downgradeAttachmentStoreToV26(seed)
    const exactV26 = JSON.stringify({
      projects: seed.prepare('SELECT * FROM projects ORDER BY id').all(),
      blobs: seed.prepare('SELECT * FROM artifact_blobs ORDER BY checksum').all(),
      artifacts: seed.prepare('SELECT * FROM artifacts ORDER BY id').all(),
    })
    seed.close()

    const upgraded = openDb(upgradePath)
    assert.equal(version(upgraded), 32)
    assert.equal(JSON.stringify({
      projects: upgraded.prepare('SELECT * FROM projects ORDER BY id').all(),
      blobs: upgraded.prepare('SELECT * FROM artifact_blobs ORDER BY checksum').all(),
      artifacts: upgraded.prepare('SELECT * FROM artifacts ORDER BY id').all(),
    }), exactV26)
    downgradeAttachmentStoreToV26(upgraded)
    upgraded.exec(`
      CREATE TABLE migration_27_sentinel (value TEXT NOT NULL);
      INSERT INTO migration_27_sentinel VALUES ('keep');
      CREATE INDEX idx_artifact_attachments_created
        ON migration_27_sentinel(value);
    `)
    upgraded.close()

    assert.throws(() => openDb(upgradePath), /Миграция 27 не применилась/)
    const failed = new DatabaseSync(upgradePath)
    assert.equal(version(failed), 26)
    assert.equal(
      (failed.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'artifact_attachments'").get() as { count: number }).count,
      0,
    )
    assert.deepEqual(
      { ...failed.prepare('SELECT * FROM migration_27_sentinel').get() },
      { value: 'keep' },
    )
    failed.exec('DROP INDEX idx_artifact_attachments_created; DROP TABLE migration_27_sentinel')
    failed.close()
    const retried = openDb(upgradePath)
    assert.equal(version(retried), 32)
    downgradeAttachmentNameHardeningToV27(retried)
    const exactV27 = JSON.stringify({
      projects: retried.prepare('SELECT * FROM projects ORDER BY id').all(),
      blobs: retried.prepare('SELECT * FROM artifact_blobs ORDER BY checksum').all(),
      artifacts: retried.prepare('SELECT * FROM artifacts ORDER BY id').all(),
      attachments: retried.prepare('SELECT * FROM artifact_attachments ORDER BY artifact_id').all(),
    })
    retried.exec(`
      CREATE TABLE migration_28_sentinel (value TEXT NOT NULL);
      INSERT INTO migration_28_sentinel VALUES ('keep');
      CREATE TRIGGER artifact_attachments_safe_name_insert
        BEFORE INSERT ON migration_28_sentinel
        BEGIN SELECT RAISE(ABORT, 'collision'); END;
    `)
    retried.close()

    assert.throws(() => openDb(upgradePath), /Миграция 28 не применилась/)
    const failedHardening = new DatabaseSync(upgradePath)
    assert.equal(version(failedHardening), 27)
    assert.equal(
      (failedHardening.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'migration_28_attachment_name_guard'",
      ).get() as { count: number }).count,
      0,
    )
    assert.equal(JSON.stringify({
      projects: failedHardening.prepare('SELECT * FROM projects ORDER BY id').all(),
      blobs: failedHardening.prepare('SELECT * FROM artifact_blobs ORDER BY checksum').all(),
      artifacts: failedHardening.prepare('SELECT * FROM artifacts ORDER BY id').all(),
      attachments: failedHardening.prepare('SELECT * FROM artifact_attachments ORDER BY artifact_id').all(),
    }), exactV27)
    failedHardening.exec(
      'DROP TRIGGER artifact_attachments_safe_name_insert; DROP TABLE migration_28_sentinel;',
    )
    failedHardening.close()

    const hardened = openDb(upgradePath)
    assert.equal(version(hardened), 32)
    for (let codePoint = 1; codePoint <= 31; codePoint += 1) {
      assert.throws(
        () => hardened.prepare(
          `INSERT INTO artifact_attachments
             (artifact_id, attachment_version, display_name, created_at)
           VALUES (?, 1, ?, ?)`,
        ).run(genericArtifact.id, `bad${String.fromCharCode(codePoint)}`, AT),
        /control character|CHECK constraint failed/u,
        `U+${codePoint.toString(16).padStart(4, '0')}`,
      )
    }
    hardened.close()

    const corruptPath = join(root, 'corrupt-v27.db')
    const corrupt = openDb(corruptPath)
    const corruptArtifact = await new ArtifactStore({
      db: corrupt,
      rootDir: join(root, 'corrupt-blobs'),
      now: () => new Date(AT),
    }).create({
      artifactVersion: 1,
      idempotencyKey: randomUUID(),
      kind: 'file',
      mediaType: 'text/plain',
      ownership: { scope: 'projectless' },
      source: { jobId: null, parentArtifactId: null },
    }, Buffer.from('corrupt fixture'), { maxBytes: 15 })
    downgradeAttachmentNameHardeningToV27(corrupt)
    corrupt.prepare(
      `INSERT INTO artifact_attachments
         (artifact_id, attachment_version, display_name, created_at)
       VALUES (?, 1, ?, ?)`,
    ).run(corruptArtifact.id, `bad${String.fromCharCode(1)}`, AT)
    corrupt.close()
    assert.throws(() => openDb(corruptPath), /Миграция 28 не применилась/)
    const rejected = new DatabaseSync(corruptPath)
    assert.equal(version(rejected), 27)
    assert.equal(count(rejected, 'artifact_attachments'), 1)
    rejected.close()
  })

  it('keeps presentation strict, byte-bounded and immutable at contract and DB boundaries', async (test) => {
    const base = await fixture(test)
    for (const invalid of [
      '', ' leading.txt', 'trailing.txt ', '.', '..', '../private', 'a\\b',
      'line\nbreak', `control-${String.fromCharCode(0x85)}`, `bidi-${String.fromCharCode(0x202e)}`,
      '界'.repeat(120),
    ]) assert.equal(attachmentDisplayNameSchema.safeParse(invalid).success, false)

    const attachment = await base.store.createAttachment({
      attachmentVersion: 1,
      idempotencyKey: randomUUID(),
      displayName: 'отчёт 100%.txt',
      mediaType: 'text/plain; charset=utf-8',
      ownership: { scope: 'project', projectId: LEGACY_PROJECT },
    }, Buffer.from('exact'), { maxBytes: 5 })
    assert.equal(attachmentSchema.safeParse(attachment).success, true)
    assert.throws(
      () => base.db.prepare('UPDATE artifact_attachments SET display_name = ?').run('changed'),
      /immutable/,
    )
    assert.throws(() => base.db.prepare('DELETE FROM artifact_attachments').run(), /immutable/)
    assert.throws(
      () => base.db.prepare(
        `INSERT INTO artifact_attachments
           (artifact_id, attachment_version, display_name, created_at)
         VALUES (?, 1, ?, ?)`,
      ).run(attachment.artifact.id, `bad${String.fromCharCode(0x80)}`, AT),
      /CHECK constraint failed/,
    )
  })

  it('uploads exact bytes in legacy Project scope and replays one intent without duplicate rows', async (test) => {
    const { app, db } = await fixture(test, { maxBytes: 8 })
    const intent = randomUUID()
    const bytes = Buffer.from([0, 255, 1, 2])
    const first = await app.request(
      uploadUrl('точный %.bin', LEGACY_PROJECT),
      uploadInit(bytes, intent),
    )
    assert.equal(first.status, 201)
    const created = attachmentSchema.parse(await first.json())
    assert.equal(created.displayName, 'точный %.bin')
    assert.equal(created.artifact.byteSize, 4)
    assert.equal(created.artifact.ownership.scope, 'project')
    assert.equal(
      created.artifact.ownership.scope === 'project'
        ? created.artifact.ownership.projectId
        : null,
      LEGACY_PROJECT,
    )
    assert.equal(created.modelConsumption.state, 'not_connected')

    const replay = await app.request(
      uploadUrl('точный %.bin', LEGACY_PROJECT),
      uploadInit(bytes, intent),
    )
    assert.equal(replay.status, 201)
    assert.equal(attachmentSchema.parse(await replay.json()).artifact.id, created.artifact.id)
    assert.equal(count(db, 'artifacts'), 1)
    assert.equal(count(db, 'artifact_attachments'), 1)
    assert.equal(count(db, 'artifact_blobs'), 1)

    const changedBytes = await app.request(
      uploadUrl('точный %.bin', LEGACY_PROJECT),
      uploadInit(Buffer.from('changed'), intent),
    )
    assert.equal(changedBytes.status, 409)
    const changedName = await app.request(
      uploadUrl('other.bin', LEGACY_PROJECT),
      uploadInit(bytes, intent),
    )
    assert.equal(changedName.status, 409)
    assert.equal(count(db, 'artifacts'), 1)
  })

  it('converges concurrent same and distinct attachment intents without mutable side rows', async (test) => {
    const { db, service } = await fixture(test)
    const sameIntent = randomUUID()
    const metadata = {
      attachmentVersion: ATTACHMENT_VERSION,
      idempotencyKey: sameIntent,
      displayName: 'concurrent.bin',
      mediaType: 'application/octet-stream',
      ownership: { scope: 'projectless' as const },
    }
    const [first, replay] = await Promise.all([
      service.upload(metadata, Buffer.from('same bytes'), new AbortController().signal),
      service.upload(metadata, Buffer.from('same bytes'), new AbortController().signal),
    ])
    assert.equal(first.artifact.id, replay.artifact.id)
    assert.equal(count(db, 'artifacts'), 1)
    assert.equal(count(db, 'artifact_attachments'), 1)
    assert.equal(count(db, 'artifact_blobs'), 1)

    const [distinctA, distinctB] = await Promise.all([
      service.upload(
        { ...metadata, idempotencyKey: randomUUID(), displayName: 'distinct-a.bin' },
        Buffer.from('shared distinct bytes'),
        new AbortController().signal,
      ),
      service.upload(
        { ...metadata, idempotencyKey: randomUUID(), displayName: 'distinct-b.bin' },
        Buffer.from('shared distinct bytes'),
        new AbortController().signal,
      ),
    ])
    assert.notEqual(distinctA.artifact.id, distinctB.artifact.id)
    assert.equal(count(db, 'artifacts'), 3)
    assert.equal(count(db, 'artifact_attachments'), 3)
    assert.equal(count(db, 'artifact_blobs'), 2)
    assert.throws(
      () => db.prepare('UPDATE artifact_attachments SET display_name = ?').run('rewritten.bin'),
      /immutable/u,
    )
  })

  it('validates policy, query/header contracts, streamed size and bounded list truthfully', async (test) => {
    const { app, service } = await fixture(test, { maxBytes: 4 })
    const policyResponse = await app.request('/api/artifacts/policy')
    assert.equal(policyResponse.status, 200)
    const policy = artifactTransferPolicySchema.parse(await policyResponse.json())
    assert.equal(policy.state, 'enabled')
    assert.equal(policy.state === 'enabled' ? policy.maxBytes : null, 4)
    assert.equal(policy.source, 'test_override')
    assert.equal(policy.modelCapability, 'not_applicable')

    for (const path of [
      '/api/artifacts/policy?future=1',
      `/api/artifacts?${scopeQuery(undefined, 1)}&limit=2`,
      `/api/artifacts?attachmentVersion=2&scope=projectless&limit=1`,
      `/api/artifacts?attachmentVersion=1&scope=projectless&limit=101`,
    ]) assert.equal((await app.request(path)).status, 400)

    for (const [name, value] of [
      ['x-guanxi-path', '/private'],
      ['x-storage-key', 'sha256/private'],
      ['storage-key', 'sha256/private'],
      ['x-path', '/private'],
      ['x-artifact-path', '/private'],
      ['checksum', 'trusted-looking'],
      ['digest', 'sha-256=trusted-looking'],
      ['content-md5', 'trusted-looking'],
      ['x-checksum', 'trusted-looking'],
      ['x-future', 'future'],
    ] as const) {
      const input = uploadInit(Buffer.from('four'))
      const forbidden = await app.request(uploadUrl('safe.bin'), {
        ...input,
        headers: { ...input.headers, [name]: value },
      })
      assert.equal(forbidden.status, 400, name)
    }
    assert.equal(service.diagnostics().active, 0)
    assert.equal((await app.request(
      uploadUrl('safe.bin'),
      uploadInit(Buffer.from('four')),
    )).status, 201)
    assert.equal((await app.request(
      uploadUrl('over.bin'),
      uploadInit(Buffer.from('five!')),
    )).status, 413)

    const second = await app.request(
      uploadUrl('second.bin'),
      uploadInit(Buffer.from('two')),
    )
    assert.equal(second.status, 201)
    const list = listAttachmentsResponse.parse(await (
      await app.request(`/api/artifacts?${scopeQuery(undefined, 1)}`)
    ).json())
    assert.equal(list.attachments.length, 1)
    assert.equal(list.limit, 1)
    assert.equal(list.truncated, true)
    assert.deepEqual(service.diagnostics(), {
      active: 0, queued: 0, maxActive: 1, maxQueued: 2,
    })
  })

  it('isolates scope and exports verified bytes with injection-safe exact headers', async (test) => {
    const { app } = await fixture(test)
    const createdResponse = await app.request(
      uploadUrl('отчёт 100% "Q".txt', LEGACY_PROJECT),
      uploadInit(Buffer.from('download me'), randomUUID(), 'text/plain; charset=utf-8'),
    )
    const created = attachmentSchema.parse(await createdResponse.json())
    const projectQuery = scopeQuery(LEGACY_PROJECT)
    const projectlessQuery = scopeQuery()
    assert.equal((await app.request(
      `/api/artifacts/${created.artifact.id}?${projectlessQuery}`,
    )).status, 404)
    assert.equal((await app.request(
      `/api/artifacts/${randomUUID()}?${projectQuery}`,
    )).status, 404)

    const ranged = await app.request(
      `/api/artifacts/${created.artifact.id}/content?${projectQuery}`,
      { headers: { Range: 'bytes=0-1' } },
    )
    assert.equal(ranged.status, 416)
    assert.equal(ranged.headers.get('accept-ranges'), 'none')

    const response = await app.request(
      `/api/artifacts/${created.artifact.id}/content?${projectQuery}`,
    )
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('download me'))
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(response.headers.get('content-length'), '11')
    assert.match(response.headers.get('digest') ?? '', /^sha-256=/u)
    assert.equal(response.headers.get('etag'), `"${created.artifact.checksum}"`)
    const disposition = response.headers.get('content-disposition') ?? ''
    assert.equal(
      disposition.startsWith(
        `attachment; filename="attachment-${created.artifact.id}"; filename*=UTF-8''`,
      ),
      true,
    )
    assert.equal(disposition.includes('\r'), false)
    assert.equal(disposition.includes('\n'), false)
    assert.equal(disposition.includes('отчёт'), false)
    assert.match(disposition, /%D0%BE/u)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  })

  it('bounds FIFO admission and releases queued/active aborts without false metadata or temp growth', async (test) => {
    const firstHelper = deferred()
    let helperCalls = 0
    const base = await fixture(test, {
      maxActiveTransfers: 1,
      maxQueuedTransfers: 1,
      hooks: {
        beforePublish: async () => {
          helperCalls += 1
          if (helperCalls === 1) await firstHelper.promise
        },
      },
    })
    const firstAbort = new AbortController()
    const first = base.service.upload({
      attachmentVersion: 1,
      idempotencyKey: randomUUID(),
      displayName: 'first.bin',
      mediaType: 'application/octet-stream',
      ownership: { scope: 'projectless' },
    }, Buffer.from('first'), firstAbort.signal)
    while (helperCalls === 0) await new Promise((resolve) => setImmediate(resolve))

    const queuedAbort = new AbortController()
    const queued = base.service.upload({
      attachmentVersion: 1,
      idempotencyKey: randomUUID(),
      displayName: 'queued.bin',
      mediaType: 'application/octet-stream',
      ownership: { scope: 'projectless' },
    }, Buffer.from('queued'), queuedAbort.signal)
    assert.deepEqual(base.service.diagnostics(), {
      active: 1, queued: 1, maxActive: 1, maxQueued: 1,
    })
    await assert.rejects(
      base.service.upload({
        attachmentVersion: 1,
        idempotencyKey: randomUUID(),
        displayName: 'full.bin',
        mediaType: 'application/octet-stream',
        ownership: { scope: 'projectless' },
      }, Buffer.from('full'), new AbortController().signal),
      (cause: unknown) => cause instanceof ArtifactTransferError && cause.code === 'admission_full',
    )
    assert.equal(helperCalls, 1)
    queuedAbort.abort()
    await assert.rejects(queued, /cancelled/u)
    assert.equal(base.service.diagnostics().queued, 0)
    firstAbort.abort()
    firstHelper.resolve()
    await assert.rejects(
      first,
      (cause: unknown) => cause instanceof ArtifactStoreError && cause.code === 'aborted',
    )
    assert.equal(count(base.db, 'artifacts'), 0)
    assert.equal(count(base.db, 'artifact_attachments'), 0)
    assert.deepEqual(await readdir(join(base.artifactRoot, 'tmp')), [])
    assert.equal(base.service.diagnostics().active, 0)

    const recovered = await base.service.upload({
      attachmentVersion: 1,
      idempotencyKey: randomUUID(),
      displayName: 'recovered.bin',
      mediaType: 'application/octet-stream',
      ownership: { scope: 'projectless' },
    }, Buffer.from('ok'), new AbortController().signal)
    assert.equal(recovered.displayName, 'recovered.bin')
    assert.equal(base.service.diagnostics().active, 0)
    assert.equal(getEventListeners(firstAbort.signal, 'abort').length, 0)
    assert.equal(getEventListeners(queuedAbort.signal, 'abort').length, 0)
  })

  it('propagates HTTP disconnect and helper watchdog through cleanup and admission', async (test) => {
    const routeReady = deferred()
    const releaseRoute = deferred()
    const routeBase = await fixture(test, {
      hooks: {
        beforePublish: async () => {
          routeReady.resolve()
          await releaseRoute.promise
        },
      },
    })
    const disconnect = new AbortController()
    const request = routeBase.app.request(uploadUrl('disconnect.bin'), {
      ...uploadInit(Buffer.from('disconnect')),
      signal: disconnect.signal,
    })
    await routeReady.promise
    disconnect.abort()
    releaseRoute.resolve()
    const disconnected = await request
    assert.equal(disconnected.status, 400)
    assert.equal(routeBase.service.diagnostics().active, 0)
    assert.equal(count(routeBase.db, 'artifacts'), 0)
    assert.equal(count(routeBase.db, 'artifact_attachments'), 0)
    assert.deepEqual(await readdir(join(routeBase.artifactRoot, 'tmp')), [])
    assert.equal(getEventListeners(disconnect.signal, 'abort').length, 0)

    let watchdogCalls = 0
    const never = new Promise<void>(() => undefined)
    const watchdogBase = await fixture(test, {
      helperTimeoutMs: 500,
      hooks: {
        beforePublish: () => {
          watchdogCalls += 1
          return watchdogCalls === 1 ? never : undefined
        },
      },
    })
    const watchdogSignal = new AbortController()
    await assert.rejects(
      watchdogBase.service.upload({
        attachmentVersion: 1,
        idempotencyKey: randomUUID(),
        displayName: 'watchdog.bin',
        mediaType: 'application/octet-stream',
        ownership: { scope: 'projectless' },
      }, Buffer.from('watchdog'), watchdogSignal.signal),
      (cause: unknown) => cause instanceof ArtifactStoreError
        && cause.code === 'storage_failure'
        && /timed out/u.test(cause.message),
    )
    assert.equal(watchdogBase.service.diagnostics().active, 0)
    assert.equal(count(watchdogBase.db, 'artifacts'), 0)
    assert.equal(count(watchdogBase.db, 'artifact_attachments'), 0)
    assert.deepEqual(await readdir(join(watchdogBase.artifactRoot, 'tmp')), [])
    assert.equal(getEventListeners(watchdogSignal.signal, 'abort').length, 0)
    const recovered = await watchdogBase.service.upload({
      attachmentVersion: 1,
      idempotencyKey: randomUUID(),
      displayName: 'after-watchdog.bin',
      mediaType: 'application/octet-stream',
      ownership: { scope: 'projectless' },
    }, Buffer.from('recovered'), new AbortController().signal)
    assert.equal(recovered.displayName, 'after-watchdog.bin')
    assert.equal(watchdogBase.service.diagnostics().active, 0)
  })
})
