import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ARTIFACT_VERSION,
  artifactContentSchema,
  artifactCreateMetadataSchema,
  artifactSchema,
  type ArtifactCreateMetadata,
  type ArtifactScope,
} from '@alamo/contract'
import {
  ArtifactStore,
  ArtifactStoreError,
  type ArtifactStoreHooks,
} from '../src/store/artifacts.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeArtifactStoreToV25 } from './fixtures/artifact-store-migration.ts'

const AT = '2026-08-14T12:00:00.000Z'
const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'off' as const }

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

function metadata(
  overrides: Partial<ArtifactCreateMetadata> = {},
): ArtifactCreateMetadata {
  return {
    artifactVersion: ARTIFACT_VERSION,
    idempotencyKey: randomUUID(),
    kind: 'file',
    mediaType: 'application/octet-stream',
    ownership: { scope: 'projectless' },
    source: { jobId: null, parentArtifactId: null },
    ...overrides,
  }
}

function checksum(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function fixture(
  test: { after(fn: () => unknown): void },
  label: string,
  hooks: ArtifactStoreHooks = {},
) {
  const root = await mkdtemp(join(tmpdir(), `alamo-artifact-${label}-`))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'alamo.db'))
  test.after(() => db.close())
  const artifactRoot = join(root, 'managed-artifacts')
  return {
    root,
    artifactRoot,
    db,
    store: new ArtifactStore({
      db,
      rootDir: artifactRoot,
      now: () => new Date(AT),
      hooks,
    }),
  }
}

function storedV25Payload(db: DatabaseSync): string {
  return JSON.stringify({
    settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
    events: db.prepare('SELECT * FROM job_events ORDER BY id').all(),
  })
}

describe('P3-N generic Artifact contract and migration 26', () => {
  it('keeps create/output/content contracts strict and path-free', () => {
    const create = metadata({ kind: 'reasoning', mediaType: 'text/plain; charset=utf-8' })
    assert.equal(artifactCreateMetadataSchema.safeParse(create).success, true)
    for (const invalid of [
      { ...create, future: true },
      { ...create, artifactVersion: 2 },
      { ...create, kind: 'unknown' },
      { ...create, mediaType: 'Text/Plain' },
      { ...create, mediaType: 'text/plain\r\nx-leak: yes' },
      { ...create, storageKey: '../../private' },
      { ...create, ownership: { scope: 'project', projectId: 'not-a-uuid' } },
      { ...create, source: { jobId: null, parentArtifactId: null, path: '/tmp/raw' } },
    ]) assert.equal(artifactCreateMetadataSchema.safeParse(invalid).success, false)

    const artifact = {
      artifactVersion: 1,
      id: randomUUID(),
      kind: 'transcript',
      mediaType: 'text/plain; charset=utf-8',
      byteSize: 0,
      checksum: `sha256:${'0'.repeat(64)}`,
      ownership: { scope: 'projectless' },
      source: { jobId: null, parentArtifactId: null },
      retention: { mode: 'keep' },
      reference: { state: 'referenced' },
      gc: { state: 'not_implemented' },
      createdAt: AT,
    }
    assert.equal(artifactSchema.safeParse(artifact).success, true)
    assert.equal(artifactSchema.safeParse({ ...artifact, byteSize: Number.MAX_SAFE_INTEGER + 1 }).success, false)
    assert.equal(artifactSchema.safeParse({ ...artifact, checksum: `sha256:${'A'.repeat(64)}` }).success, false)
    assert.equal(artifactSchema.safeParse({ ...artifact, storageKey: 'sha256/private' }).success, false)
    assert.equal(artifactContentSchema.safeParse({ artifact, content: new Uint8Array() }).success, true)
    assert.equal(artifactContentSchema.safeParse({ artifact, content: Uint8Array.of(1) }).success, false)
  })

  it('migrates fresh/v25 databases, reopens, rolls back a late collision, and retries exactly', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-artifact-migration-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const freshPath = join(root, 'fresh.db')
    const fresh = openDb(freshPath)
    assert.equal(version(fresh), 26)
    assert.equal(count(fresh, 'artifact_blobs'), 0)
    assert.equal(count(fresh, 'artifacts'), 0)
    fresh.close()
    const reopened = openDb(freshPath)
    assert.equal(version(reopened), 26)
    reopened.close()

    const upgradePath = join(root, 'upgrade.db')
    const seed = openDb(upgradePath)
    seed.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('migration-26', 'exact-v25')
    new ProjectStore(seed).create('Preserved Project', AT)
    new JobStore(seed).create({
      kind: 'tool',
      operation: 'preserved',
      idempotencyScope: 'migration-26',
      idempotencyKey: 'preserved',
    })
    downgradeArtifactStoreToV25(seed)
    const before = storedV25Payload(seed)
    seed.close()

    const upgraded = openDb(upgradePath)
    assert.equal(version(upgraded), 26)
    assert.equal(storedV25Payload(upgraded), before)
    assert.equal(count(upgraded, 'artifact_blobs'), 0)
    downgradeArtifactStoreToV25(upgraded)
    upgraded.exec(`
      CREATE TABLE migration_26_sentinel (value TEXT NOT NULL);
      INSERT INTO migration_26_sentinel VALUES ('keep');
      CREATE INDEX idx_artifacts_job ON migration_26_sentinel(value);
    `)
    upgraded.close()

    assert.throws(() => openDb(upgradePath), /Миграция 26 не применилась/)
    const failed = new DatabaseSync(upgradePath)
    assert.equal(version(failed), 25)
    assert.equal(storedV25Payload(failed), before)
    assert.equal(
      (failed.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'artifacts'").get() as { count: number }).count,
      0,
    )
    assert.deepEqual(
      { ...failed.prepare('SELECT * FROM migration_26_sentinel').get() },
      { value: 'keep' },
    )
    failed.exec('DROP INDEX idx_artifacts_job; DROP TABLE migration_26_sentinel')
    failed.close()

    const retried = openDb(upgradePath)
    assert.equal(version(retried), 26)
    assert.equal(storedV25Payload(retried), before)
    retried.close()
  })

  it('enforces safe sizes, deterministic keys, immutable metadata and referenced blobs in SQLite', () => {
    const db = openDb(':memory:')
    const digest = `sha256:${'a'.repeat(64)}`
    assert.throws(
      () => db.prepare(
        'INSERT INTO artifact_blobs (checksum, byte_size, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ).run(digest, Number.MAX_SAFE_INTEGER + 1, `sha256/aa/${'a'.repeat(64)}`, AT),
      /CHECK constraint failed/,
    )
    assert.throws(
      () => db.prepare(
        'INSERT INTO artifact_blobs (checksum, byte_size, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ).run(digest, 1, 'sha256/aa/not-the-digest', AT),
      /CHECK constraint failed/,
    )
    db.prepare(
      'INSERT INTO artifact_blobs (checksum, byte_size, storage_key, created_at) VALUES (?, ?, ?, ?)',
    ).run(digest, 1, `sha256/aa/${'a'.repeat(64)}`, AT)
    db.prepare(
      `INSERT INTO artifacts (
         id, artifact_version, write_intent_key, kind, media_type, blob_checksum,
         project_id, source_job_id, parent_artifact_id, retention_mode, reference_state, created_at
       ) VALUES (?, 1, ?, 'file', 'application/octet-stream', ?, NULL, NULL, NULL, 'keep', 'referenced', ?)`,
    ).run(randomUUID(), randomUUID(), digest, AT)
    assert.throws(() => db.prepare("UPDATE artifacts SET media_type = 'text/plain'").run(), /immutable/)
    assert.throws(() => db.prepare('DELETE FROM artifacts').run(), /cannot be deleted/)
    assert.throws(() => db.prepare('UPDATE artifact_blobs SET byte_size = 2').run(), /immutable/)
    assert.throws(() => db.prepare('DELETE FROM artifact_blobs').run(), /cannot be deleted/)
    db.close()
  })
})

describe('P3-N content-addressed ArtifactStore', () => {
  it('hashes exact empty/Unicode/binary/maximum-boundary bytes and deduplicates blobs only', async (test) => {
    const { db, store } = await fixture(test, 'content')
    const empty = await store.create(metadata({ kind: 'text', mediaType: 'text/plain' }), new Uint8Array(), { maxBytes: 0 })
    assert.equal(empty.byteSize, 0)
    assert.equal(empty.checksum, checksum(new Uint8Array()))

    const unicode = Buffer.from('Привет, Artifact 🌋', 'utf8')
    const unicodeArtifact = await store.create(
      metadata({ kind: 'text', mediaType: 'text/plain; charset=utf-8' }),
      (async function* () {
        yield unicode.subarray(0, 5)
        yield unicode.subarray(5)
      })(),
      { maxBytes: unicode.byteLength },
    )
    assert.equal(unicodeArtifact.byteSize, unicode.byteLength)
    assert.equal(unicodeArtifact.checksum, checksum(unicode))

    const binary = Uint8Array.of(0, 255, 1, 254, 128)
    const first = await store.create(metadata(), binary, { maxBytes: binary.byteLength })
    const second = await store.create(metadata({ kind: 'document' }), binary, { maxBytes: binary.byteLength })
    assert.notEqual(first.id, second.id)
    assert.equal(first.checksum, second.checksum)
    assert.equal(count(db, 'artifact_blobs'), 3)
    assert.equal(count(db, 'artifacts'), 4)
    assert.equal(count(db, 'jobs'), 0)

    await assert.rejects(
      store.create(metadata(), Uint8Array.of(1, 2, 3, 4, 5), { maxBytes: 4 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'size_limit_exceeded',
    )
    assert.equal(count(db, 'artifacts'), 4)
  })

  it('is deterministic for retries and concurrent same-content/same-intent writes', async (test) => {
    const { db, store } = await fixture(test, 'concurrency')
    const bytes = Buffer.from('shared exact bytes')
    const firstIntent = metadata({ kind: 'report', mediaType: 'text/plain' })
    const [first, replay] = await Promise.all([
      store.create(firstIntent, bytes, { maxBytes: bytes.byteLength }),
      store.create(firstIntent, bytes, { maxBytes: bytes.byteLength }),
    ])
    assert.equal(replay.id, first.id)
    assert.equal(count(db, 'artifacts'), 1)
    assert.equal(count(db, 'artifact_blobs'), 1)

    const [second, third] = await Promise.all([
      store.create(metadata({ kind: 'text', mediaType: 'text/plain' }), bytes, { maxBytes: bytes.byteLength }),
      store.create(metadata({ kind: 'document', mediaType: 'text/plain' }), bytes, { maxBytes: bytes.byteLength }),
    ])
    assert.notEqual(second.id, third.id)
    assert.equal(count(db, 'artifacts'), 3)
    assert.equal(count(db, 'artifact_blobs'), 1)

    await assert.rejects(
      store.create(firstIntent, Buffer.from('changed'), { maxBytes: 7 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'idempotency_conflict',
    )
    await assert.rejects(
      store.create({ ...firstIntent, kind: 'audio' }, bytes, { maxBytes: bytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'idempotency_conflict',
    )
    assert.equal(count(db, 'artifacts'), 3)
  })

  it('reads only exact scope with verified content and path-free download headers', async (test) => {
    const { artifactRoot, db, store } = await fixture(test, 'read')
    const project = new ProjectStore(db).create('Scoped', AT)
    const bytes = Buffer.from('scoped content')
    const artifact = await store.create(metadata({
      kind: 'document',
      mediaType: 'application/pdf',
      ownership: { scope: 'project', projectId: project.id },
    }), bytes, { maxBytes: bytes.byteLength })
    assert.equal(store.get(artifact.id, { scope: 'projectless' }), null)
    assert.equal(store.get(randomUUID(), { scope: 'project', projectId: project.id }), null)
    assert.equal(store.get(artifact.id, { scope: 'project', projectId: project.id })?.id, artifact.id)
    assert.throws(
      () => store.get('../../private', { scope: 'projectless' }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_input',
    )

    await assert.rejects(
      store.read(artifact.id, { scope: 'projectless' }, { maxBytes: bytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'not_found',
    )
    const read = await store.read(
      artifact.id,
      { scope: 'project', projectId: project.id },
      { maxBytes: bytes.byteLength },
    )
    assert.deepEqual(read.content, bytes)
    assert.deepEqual(read.headers, {
      contentType: 'application/pdf',
      contentLength: String(bytes.byteLength),
      digest: `sha-256=${Buffer.from(artifact.checksum.slice(7), 'hex').toString('base64')}`,
      etag: `"${artifact.checksum}"`,
    })
    assert.equal(JSON.stringify({ artifact: read.artifact, headers: read.headers }).includes(artifactRoot), false)
    await assert.rejects(
      store.read(artifact.id, { scope: 'project', projectId: project.id }, { maxBytes: bytes.byteLength - 1 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'size_limit_exceeded',
    )
  })

  it('fails closed for unscoped/cross-scope Jobs and parent derivation', async (test) => {
    const { db, store } = await fixture(test, 'ownership')
    const projects = new ProjectStore(db)
    const projectA = projects.create('A', AT)
    const projectB = projects.create('B', AT)
    const parent = await store.create(metadata({
      ownership: { scope: 'project', projectId: projectA.id },
    }), Buffer.from('parent'), { maxBytes: 6 })
    const child = await store.create(metadata({
      ownership: { scope: 'project', projectId: projectA.id },
      source: { jobId: null, parentArtifactId: parent.id },
    }), Buffer.from('child'), { maxBytes: 5 })
    assert.equal(child.source.parentArtifactId, parent.id)
    await assert.rejects(
      store.create(metadata({
        ownership: { scope: 'project', projectId: projectB.id },
        source: { jobId: null, parentArtifactId: parent.id },
      }), Buffer.from('cross-parent'), { maxBytes: 12 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_reference',
    )

    const jobs = new JobStore(db)
    const unscoped = jobs.create({
      kind: 'tool', operation: 'fixture', idempotencyScope: 'artifact', idempotencyKey: 'unscoped',
    }).job
    await assert.rejects(
      store.create(metadata({ source: { jobId: unscoped.id, parentArtifactId: null } }), Buffer.from('unknown'), { maxBytes: 7 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_reference',
    )

    const thread = new ThreadStore(db).createWithOwnership({
      title: 'Scoped Job', model: 'fixture', projectId: projectA.id, options: OPTIONS,
    })
    const chatJob = jobs.createChat({
      threadId: thread.id,
      idempotencyScope: `chat:${thread.id}:send:v1`,
      idempotencyKey: randomUUID(),
      requestFingerprint: 'artifact-scope-fixture',
      input: { content: 'prompt', attachments: [], autoApprove: null },
      derivedTitle: 'Prompt',
    }).job
    const sourced = await store.create(metadata({
      ownership: { scope: 'project', projectId: projectA.id },
      source: { jobId: chatJob.id, parentArtifactId: null },
    }), Buffer.from('result'), { maxBytes: 6 })
    assert.equal(sourced.source.jobId, chatJob.id)
    await assert.rejects(
      store.create(metadata({
        ownership: { scope: 'project', projectId: projectB.id },
        source: { jobId: chatJob.id, parentArtifactId: null },
      }), Buffer.from('cross-job'), { maxBytes: 9 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_reference',
    )
    assert.throws(() => db.prepare('DELETE FROM projects WHERE id = ?').run(projectA.id), /FOREIGN KEY/)
  })

  it('keeps partials private, inventories the promotion/DB crash window, and converges on retry', async (test) => {
    const tempFailure = await fixture(test, 'temp-failure', {
      afterTempWrite: () => { throw new Error('injected temp failure') },
    })
    const bytes = Buffer.from('failure bytes')
    await assert.rejects(
      tempFailure.store.create(metadata(), bytes, { maxBytes: bytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'storage_failure',
    )
    assert.equal(count(tempFailure.db, 'artifacts'), 0)
    assert.deepEqual(await readdir(join(tempFailure.artifactRoot, 'tmp')), [])

    const promoted = await fixture(test, 'post-publish', {
      afterPublish: () => { throw new Error('injected post-publish failure') },
    })
    const intent = metadata()
    await assert.rejects(
      promoted.store.create(intent, bytes, { maxBytes: bytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'storage_failure',
    )
    assert.equal(count(promoted.db, 'artifacts'), 0)
    assert.equal(count(promoted.db, 'artifact_blobs'), 0)
    const inventory = await promoted.store.inspectOrphans({ limit: 1, scanLimit: 10 })
    assert.equal(inventory.state, 'inventory_only_gc_not_implemented')
    assert.equal(inventory.storageKeys.length, 1)
    assert.equal(inventory.storageKeys[0]?.includes(promoted.artifactRoot), false)
    const hiddenId = randomUUID()
    assert.equal(promoted.store.get(hiddenId, { scope: 'projectless' }), null)

    const retry = new ArtifactStore({ db: promoted.db, rootDir: promoted.artifactRoot, now: () => new Date(AT) })
    const artifact = await retry.create(intent, bytes, { maxBytes: bytes.byteLength })
    assert.equal(artifact.checksum, checksum(bytes))
    assert.equal((await retry.inspectOrphans({ limit: 1, scanLimit: 10 })).storageKeys.length, 0)

    promoted.db.exec(`
      CREATE TRIGGER fail_artifact_insert BEFORE INSERT ON artifacts
      BEGIN SELECT RAISE(ABORT, 'injected DB metadata failure'); END;
    `)
    const dbFailureIntent = metadata()
    const dbFailureBytes = Buffer.from('different DB failure bytes')
    await assert.rejects(
      retry.create(dbFailureIntent, dbFailureBytes, { maxBytes: dbFailureBytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_reference',
    )
    assert.equal(count(promoted.db, 'artifacts'), 1)
    assert.equal(count(promoted.db, 'artifact_blobs'), 1)
    promoted.db.exec('DROP TRIGGER fail_artifact_insert')
    const recovered = await retry.create(dbFailureIntent, dbFailureBytes, { maxBytes: dbFailureBytes.byteLength })
    assert.equal(recovered.checksum, checksum(dbFailureBytes))
    assert.equal(count(promoted.db, 'artifacts'), 2)
  })

  it('rejects symlink redirects and corrupt/pre-existing checksum targets without overwrite or path disclosure', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-artifact-symlink-root-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const db = openDb(join(root, 'alamo.db'))
    test.after(() => db.close())
    const outside = join(root, 'outside')
    await mkdir(outside)
    const linkedRoot = join(root, 'linked-artifacts')
    await symlink(outside, linkedRoot)
    const unsafeStore = new ArtifactStore({ db, rootDir: linkedRoot })
    await assert.rejects(
      unsafeStore.create(metadata(), Buffer.from('unsafe'), { maxBytes: 6 }),
      (error: unknown) => (
        error instanceof ArtifactStoreError
        && error.code === 'unsafe_storage'
        && !error.message.includes(root)
      ),
    )
    assert.deepEqual(await readdir(outside), [])

    const injectedIdStore = new ArtifactStore({
      db,
      rootDir: join(root, 'generated-id-boundary'),
      randomId: () => '../../outside',
    })
    await assert.rejects(
      injectedIdStore.create(metadata(), Buffer.from('unsafe id'), { maxBytes: 9 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'unsafe_storage',
    )

    const artifactRoot = join(root, 'safe-artifacts')
    const safeStore = new ArtifactStore({ db, rootDir: artifactRoot, now: () => new Date(AT) })
    const bytes = Buffer.from('immutable target')
    const artifact = await safeStore.create(metadata(), bytes, { maxBytes: bytes.byteLength })
    const digest = artifact.checksum.slice(7)
    const path = join(artifactRoot, 'blobs', 'sha256', digest.slice(0, 2), digest)
    await writeFile(path, Buffer.from('corrupt target'))
    await assert.rejects(
      safeStore.read(artifact.id, { scope: 'projectless' }, { maxBytes: 1_000 }),
      (error: unknown) => (
        error instanceof ArtifactStoreError
        && error.code === 'integrity_mismatch'
        && !error.message.includes(artifactRoot)
      ),
    )
    await assert.rejects(
      safeStore.create(metadata({ idempotencyKey: randomUUID() }), bytes, { maxBytes: bytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'integrity_mismatch',
    )
    assert.deepEqual(await readFile(path), Buffer.from('corrupt target'))

    const symlinkBytes = Buffer.from('preexisting symlink')
    const symlinkDigest = checksum(symlinkBytes).slice(7)
    const prefix = join(artifactRoot, 'blobs', 'sha256', symlinkDigest.slice(0, 2))
    await mkdir(prefix, { recursive: true })
    const external = join(root, 'external-blob')
    await writeFile(external, symlinkBytes)
    await symlink(external, join(prefix, symlinkDigest))
    await assert.rejects(
      safeStore.create(metadata(), symlinkBytes, { maxBytes: symlinkBytes.byteLength }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'unsafe_storage',
    )
    assert.deepEqual(await readFile(external), symlinkBytes)
  })

  it('bounds orphan scans and translates injected read failures without leaking roots', async (test) => {
    const base = await fixture(test, 'read-failure')
    const bytes = Buffer.from('read once')
    const artifact = await base.store.create(metadata(), bytes, { maxBytes: bytes.byteLength })
    const failing = new ArtifactStore({
      db: base.db,
      rootDir: base.artifactRoot,
      hooks: { beforeRead: () => { throw new Error(`do not expose ${base.artifactRoot}`) } },
    })
    await assert.rejects(
      failing.read(artifact.id, { scope: 'projectless' }, { maxBytes: bytes.byteLength }),
      (error: unknown) => (
        error instanceof ArtifactStoreError
        && error.code === 'storage_failure'
        && !error.message.includes(base.artifactRoot)
      ),
    )
    await assert.rejects(
      base.store.inspectOrphans({ limit: 2, scanLimit: 1 }),
      (error: unknown) => error instanceof ArtifactStoreError && error.code === 'invalid_input',
    )
    const bounded = await base.store.inspectOrphans({ limit: 0, scanLimit: 1 })
    assert.equal(bounded.scannedEntries <= 1, true)
    assert.equal(bounded.storageKeys.length, 0)
  })
})
