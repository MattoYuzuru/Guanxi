import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  REASONING_ARTIFACT_VERSION,
  getReasoningArtifactResponse,
  listReasoningArtifactsQuery,
  listReasoningArtifactsResponse,
  reasoningArtifactWithContentSchema,
  type JobTerminalState,
  type TurnTerminalOutcome,
} from '@guanxi/contract'
import { createApp } from '../src/app.ts'
import { createAppContext } from '../src/context.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ReasoningArtifactStore } from '../src/store/reasoning-artifacts.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { downgradeSessionLifecycleToV17 } from './fixtures/retention-lifecycle-migration.ts'

const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'high' as const }

function downgradeToV15(db: DatabaseSync): void {
  downgradeSessionLifecycleToV17(db)
  db.exec(`
    DROP INDEX idx_reasoning_artifact_deletion_audit_chat;
    DROP TABLE reasoning_artifact_deletion_audit;
    DROP TRIGGER reasoning_artifacts_immutable;
    DROP TRIGGER reasoning_artifacts_source_insert_valid;
    DROP INDEX idx_reasoning_artifacts_chat;
    DROP TABLE reasoning_artifacts;
    PRAGMA user_version = 15;
  `)
}

function createChat(db: DatabaseSync, projectId: string | null = null) {
  const threads = new ThreadStore(db)
  const chat = projectId
    ? threads.createWithOwnership({ title: 'Artifact Chat', model: 'fixture', projectId, options: OPTIONS })
    : threads.create({
        title: 'Artifact Chat',
        mode: 'chat',
        model: 'fixture',
        workspaceId: null,
        options: OPTIONS,
      })
  return { chat, threads }
}

function createChatJob(db: DatabaseSync, chatId: string, key: string, jobs = new JobStore(db)) {
  return jobs.createChat({
    threadId: chatId,
    idempotencyScope: `chat:${chatId}:send:v1`,
    idempotencyKey: key,
    requestFingerprint: `fingerprint-${key}`,
    input: { content: `prompt-${key}`, attachments: [], autoApprove: null },
    derivedTitle: 'Prompt',
  })
}

function terminalize(
  jobs: JobStore,
  association: ReturnType<typeof createChatJob>,
  input: {
    status?: JobTerminalState
    outcome?: TurnTerminalOutcome
    content?: string
    thinking?: string | null
  } = {},
) {
  const status = input.status ?? 'completed'
  const outcome = input.outcome ?? (status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'completed' : 'failed')
  return jobs.terminalizeChat({
    jobId: association.job.id,
    expectedStatus: 'queued',
    status,
    messageId: association.assistantMessageId,
    message: {
      outcome,
      error: outcome === 'failed' ? { code: 'internal_error', message: 'safe failure' } : null,
      stopReason: outcome === 'completed' ? 'stop' : outcome === 'cancelled' ? 'stopped_by_user' : 'internal_error',
      content: input.content ?? 'final answer',
      thinking: input.thinking ?? null,
      toolCalls: [],
      usage: null,
    },
    error: status === 'failed' || status === 'interrupted'
      ? { category: 'internal', code: 'fixture', message: 'safe failure', retryable: false }
      : null,
    outcome: status === 'failed' ? null : { code: `chat_${status}`, metadata: {} },
    stopReason: status,
  })
}

describe('P3-F reasoning Artifact persistence', () => {
  it('defines a strict versioned sourced contract and rejects future/cross-Chat shapes', () => {
    assert.equal(listReasoningArtifactsQuery.safeParse({
      artifactVersion: 1,
      enforcementVersion: 1,
      scope: 'projectless',
    }).success, true)
    for (const invalid of [
      { enforcementVersion: 1, scope: 'projectless' },
      { artifactVersion: 'malformed', enforcementVersion: 1, scope: 'projectless' },
      { artifactVersion: 2, enforcementVersion: 1, scope: 'projectless' },
      { artifactVersion: 1, scope: 'projectless' },
      { artifactVersion: 1, enforcementVersion: 'malformed', scope: 'projectless' },
      { artifactVersion: 1, enforcementVersion: 2, scope: 'projectless' },
      { artifactVersion: 1, enforcementVersion: 1, scope: 'projectless', projectId: 'leak' },
      { artifactVersion: 1, enforcementVersion: 1, scope: 'project' },
      { artifactVersion: 1, enforcementVersion: 1, scope: 'future' },
    ]) assert.equal(listReasoningArtifactsQuery.safeParse(invalid).success, false)

    const artifact = {
      artifactVersion: REASONING_ARTIFACT_VERSION,
      id: '11111111-1111-4111-8111-111111111111',
      type: 'reasoning',
      mediaType: 'text/markdown; charset=utf-8',
      storageKind: 'sqlite_text',
      byteSize: 3,
      checksum: `sha256:${'a'.repeat(64)}`,
      createdAt: '2026-08-11T12:00:00.000Z',
      source: {
        chatId: 'chat-a',
        messageId: 'message-a',
        jobId: '22222222-2222-4222-8222-222222222222',
      },
      ownership: { scope: 'projectless', projectId: null },
      retention: {
        basis: 'diagnostic_7_days',
        expiresAfterDays: 7,
        artifactExpiresAt: '2026-08-18T12:00:00.000Z',
        parentMode: 'keep',
        parentExpiresAt: null,
        effectiveExpiresAt: '2026-08-18T12:00:00.000Z',
        relationship: 'shorter_parent_retention_wins',
        automaticDeletion: 'server_maintenance_active',
      },
    } as const
    assert.equal(reasoningArtifactWithContentSchema.safeParse({ ...artifact, content: 'abc' }).success, true)
    assert.equal(reasoningArtifactWithContentSchema.safeParse({ ...artifact, content: 'абв' }).success, false)
    assert.equal(getReasoningArtifactResponse.safeParse({ ...artifact, content: 'abc', prompt: 'secret' }).success, false)
    const response = {
      artifactVersion: 1,
      enforcementVersion: 1,
      enforcement: {
        state: 'active',
        owner: 'server_maintenance',
        boundary: 'reasoning_artifacts_only',
        inclusiveDueBoundary: true,
      },
      chatId: 'chat-a',
      scope: 'projectless',
      projectId: null,
      generatedAnswers: [],
      artifacts: [artifact],
    } as const
    assert.equal(listReasoningArtifactsResponse.safeParse(response).success, true)
    for (const invalid of [
      { ...response, artifactVersion: undefined },
      { ...response, artifactVersion: 'malformed' },
      { ...response, artifactVersion: 2 },
      { ...response, enforcementVersion: undefined },
      { ...response, enforcementVersion: 'malformed' },
      { ...response, enforcementVersion: 2 },
      { ...response, chatId: 'chat-b' },
    ]) assert.equal(listReasoningArtifactsResponse.safeParse(invalid).success, false)
  })

  it('creates v16 once on fresh, v15 upgrade, reopen and retry while preserving legacy bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-reasoning-migration-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const fresh = openDb(path)
    assert.equal((fresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
    const { chat } = createChat(fresh)
    fresh.prepare(
      `INSERT INTO messages (
         id, thread_id, seq, role, content, thinking, tool_calls, usage,
         is_compaction, created_at, turn_status, turn_error, stop_reason, job_id
       ) VALUES ('legacy-message', ?, 0, 'assistant', 'legacy-final', ?, '[]', NULL,
         0, '2026-08-01T00:00:00.000Z', 'completed', NULL, 'stop', NULL)`,
    ).run(chat.id, 'legacy thinking — literal')
    downgradeToV15(fresh)
    fresh.close()

    const upgraded = openDb(path)
    assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
    assert.deepEqual(
      new ThreadStore(upgraded).messages(chat.id).map(({ content, thinking }) => ({ content, thinking })),
      [{ content: 'legacy-final', thinking: 'legacy thinking — literal' }],
    )
    assert.equal((upgraded.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 0)
    upgraded.close()
    const reopened = openDb(path)
    assert.equal((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
    assert.equal((reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'reasoning_artifacts'").get() as { count: number }).count, 1)
    downgradeToV15(reopened)
    reopened.exec('CREATE TABLE migration_sentinel (legacy_payload TEXT NOT NULL)')
    reopened.exec('CREATE INDEX idx_reasoning_artifacts_chat ON migration_sentinel(legacy_payload)')
    reopened.prepare('INSERT INTO migration_sentinel VALUES (?)').run('exact legacy payload')
    reopened.close()

    assert.throws(() => openDb(path), /Миграция 16 не применилась/)
    const afterFailure = new DatabaseSync(path)
    assert.equal((afterFailure.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 15)
    assert.equal((afterFailure.prepare('SELECT legacy_payload FROM migration_sentinel').get() as { legacy_payload: string }).legacy_payload, 'exact legacy payload')
    assert.equal((afterFailure.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'reasoning_artifacts'").get() as { count: number }).count, 0)
    afterFailure.exec('DROP INDEX idx_reasoning_artifacts_chat; DROP TABLE migration_sentinel')
    afterFailure.close()
    const retried = openDb(path)
    assert.equal((retried.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
    retried.close()
  })

  it('atomically separates exact UTF-8 reasoning from final answer without duplicates', () => {
    const db = openDb(':memory:')
    const { chat, threads } = createChat(db)
    const jobs = new JobStore(db)
    const association = createChatJob(db, chat.id, 'unicode', jobs)
    const reasoning = `ASCII → Привет 🧠\n${'long'.repeat(20_000)}`
    const result = terminalize(jobs, association, { content: 'only final answer', thinking: reasoning })
    assert.equal(result.applied, true)

    const row = db.prepare(
      `SELECT content, thinking, byte_size, checksum, source_job_id, source_message_id
       FROM messages m JOIN reasoning_artifacts a ON a.source_message_id = m.id
       WHERE m.id = ?`,
    ).get(association.assistantMessageId) as {
      content: string
      thinking: string | null
      byte_size: number
      checksum: string
      source_job_id: string
      source_message_id: string
    }
    assert.equal(row.content, 'only final answer')
    assert.equal(row.thinking, null)
    assert.equal(row.byte_size, Buffer.byteLength(reasoning, 'utf8'))
    assert.equal(row.checksum, `sha256:${createHash('sha256').update(Buffer.from(reasoning, 'utf8')).digest('hex')}`)
    assert.equal(row.source_job_id, association.job.id)
    assert.equal(row.source_message_id, association.assistantMessageId)
    assert.equal(threads.getMessage(association.assistantMessageId)?.thinking, reasoning)
    const canonicalBeforeDuplicate = db.prepare(
      `SELECT checksum, created_at, artifact_expires_at
       FROM reasoning_artifacts WHERE source_job_id = ?`,
    ).get(association.job.id)
    assert.throws(
      () => db.prepare(
        `INSERT INTO reasoning_artifacts
         SELECT '33333333-3333-4333-8333-333333333333', artifact_version, chat_id,
                project_id, source_message_id, source_job_id, media_type, storage_kind,
                content_text, byte_size, checksum, created_at, artifact_expires_at,
                parent_retention_mode, parent_retention_expires_at, effective_expires_at
         FROM reasoning_artifacts WHERE source_job_id = ?`,
      ).run(association.job.id),
      /UNIQUE constraint failed/,
    )

    const duplicate = terminalize(jobs, association, { content: 'swapped reasoning', thinking: 'only final answer' })
    assert.equal(duplicate.applied, false)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 1)
    assert.equal(threads.getMessage(association.assistantMessageId)?.content, 'only final answer')
    assert.equal(threads.getMessage(association.assistantMessageId)?.thinking, reasoning)
    assert.deepEqual(
      db.prepare(
        `SELECT checksum, created_at, artifact_expires_at
         FROM reasoning_artifacts WHERE source_job_id = ?`,
      ).get(association.job.id),
      canonicalBeforeDuplicate,
    )
    db.close()
  })

  it('does not create empty Artifacts and persists partial reasoning for every terminal policy', () => {
    const db = openDb(':memory:')
    const { chat } = createChat(db)
    const jobs = new JobStore(db)
    const zero = createChatJob(db, chat.id, 'zero', jobs)
    terminalize(jobs, zero, { thinking: '' })

    for (const [status, outcome] of [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'cancelled'],
      ['interrupted', 'failed'],
    ] as Array<[JobTerminalState, TurnTerminalOutcome]>) {
      const association = createChatJob(db, chat.id, status, jobs)
      terminalize(jobs, association, { status, outcome, thinking: `partial-${status}` })
    }
    const rows = db.prepare(
      `SELECT j.status, a.content_text
       FROM reasoning_artifacts a JOIN jobs j ON j.id = a.source_job_id
       ORDER BY j.status`,
    ).all() as Array<{ status: string; content_text: string }>
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { status: 'cancelled', content_text: 'partial-cancelled' },
      { status: 'completed', content_text: 'partial-completed' },
      { status: 'failed', content_text: 'partial-failed' },
      { status: 'interrupted', content_text: 'partial-interrupted' },
    ])
    assert.equal((db.prepare('SELECT thinking FROM messages WHERE id = ?').get(zero.assistantMessageId) as { thinking: string | null }).thinking, null)
    db.close()
  })

  it('rolls back Message/Job/Artifact on checksum or write failure and retries canonically', () => {
    const db = openDb(':memory:')
    const { chat } = createChat(db)
    const broken = new JobStore(db, { reasoningChecksum: () => { throw new Error('injected checksum failure') } })
    const checksumJob = createChatJob(db, chat.id, 'checksum-failure', broken)
    assert.throws(() => terminalize(broken, checksumJob, { thinking: 'must rollback' }), /injected checksum failure/)
    assert.equal(broken.get(checksumJob.job.id)?.status, 'queued')
    assert.equal((db.prepare('SELECT turn_status FROM messages WHERE id = ?').get(checksumJob.assistantMessageId) as { turn_status: string }).turn_status, 'pending')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 0)

    const mismatched = new JobStore(db, { reasoningChecksum: () => `sha256:${'a'.repeat(64)}` })
    assert.throws(
      () => terminalize(mismatched, checksumJob, { thinking: 'must rollback' }),
      /checksum mismatch/,
    )
    assert.equal(mismatched.get(checksumJob.job.id)?.status, 'queued')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 0)

    const jobs = new JobStore(db)
    terminalize(jobs, checksumJob, { thinking: 'must rollback' })
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 1)

    const writeJob = createChatJob(db, chat.id, 'write-failure', jobs)
    db.exec(`
      CREATE TRIGGER fail_reasoning_write BEFORE INSERT ON reasoning_artifacts
      BEGIN SELECT RAISE(ABORT, 'injected Artifact write failure'); END;
    `)
    assert.throws(() => terminalize(jobs, writeJob, { thinking: 'write rollback' }), /injected Artifact write failure/)
    assert.equal(jobs.get(writeJob.job.id)?.status, 'queued')
    assert.equal((db.prepare('SELECT turn_status FROM messages WHERE id = ?').get(writeJob.assistantMessageId) as { turn_status: string }).turn_status, 'pending')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 1)
    db.exec('DROP TRIGGER fail_reasoning_write')
    terminalize(jobs, writeJob, { thinking: 'write rollback' })
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 2)
    db.close()
  })

  it('keeps final-answer compaction input independent from missing or malformed Artifact data', () => {
    const db = openDb(':memory:')
    const { chat, threads } = createChat(db)
    const jobs = new JobStore(db)
    const withArtifact = createChatJob(db, chat.id, 'compaction-artifact', jobs)
    terminalize(jobs, withArtifact, { content: 'final with reasoning', thinking: 'diagnostic' })
    const withoutArtifact = createChatJob(db, chat.id, 'compaction-no-artifact', jobs)
    terminalize(jobs, withoutArtifact, { content: 'final without reasoning', thinking: null })
    threads.addMessage({ threadId: chat.id, role: 'user', content: 'tail one' })
    threads.addMessage({ threadId: chat.id, role: 'assistant', content: 'tail two', turnStatus: 'completed' })

    db.exec('DROP TRIGGER reasoning_artifacts_immutable')
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare('UPDATE reasoning_artifacts SET artifact_version = 2 WHERE source_job_id = ?')
      .run(withArtifact.job.id)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    assert.throws(() => threads.messages(chat.id), /unsupported reasoning Artifact version/)
    db.prepare("UPDATE reasoning_artifacts SET artifact_version = 1, checksum = ? WHERE source_job_id = ?")
      .run(`sha256:${'a'.repeat(64)}`, withArtifact.job.id)
    assert.throws(
      () => new ReasoningArtifactStore(db).list(chat.id, { scope: 'projectless', projectId: null }),
      /failed content integrity validation/,
    )
    const candidates = threads.compactionCandidates(chat.id, 2)!
    assert.deepEqual(
      candidates.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
      ['final with reasoning', 'final without reasoning'],
    )
    db.close()
  })

  it('lists/reads exact active Chat scope and hides Trash without deleting Artifacts', () => {
    const db = openDb(':memory:')
    const projectA = new ProjectStore(db).create('A')
    const projectB = new ProjectStore(db).create('B')
    const projectless = createChat(db)
    const inA = createChat(db, projectA.id)
    const inB = createChat(db, projectB.id)
    const jobs = new JobStore(db)
    const rows = [projectless, inA, inB].map(({ chat }, index) => {
      const association = createChatJob(db, chat.id, `scope-${index}`, jobs)
      terminalize(jobs, association, { thinking: `reasoning-${index}` })
      return association
    })
    const store = new ReasoningArtifactStore(db)
    const projectlessSecond = createChatJob(db, projectless.chat.id, 'scope-projectless-second', jobs)
    terminalize(jobs, projectlessSecond, { thinking: 'reasoning-projectless-second' })
    const expectedProjectlessOrder = db.prepare(
      `SELECT id FROM reasoning_artifacts WHERE chat_id = ? ORDER BY created_at, id`,
    ).all(projectless.chat.id).map((row) => (row as { id: string }).id)
    const projectlessList = store.list(projectless.chat.id, {
      scope: 'projectless',
      projectId: null,
    }).artifacts!
    assert.equal(projectlessList.length, 2)
    assert.deepEqual(projectlessList.map((artifact) => artifact.id), expectedProjectlessOrder)
    assert.equal(store.list(inA.chat.id, { scope: 'project', projectId: projectA.id }).artifacts?.length, 1)
    assert.equal(store.list(inA.chat.id, { scope: 'project', projectId: projectB.id }).status, 'scope_mismatch')
    assert.equal(store.list(inB.chat.id, { scope: 'projectless', projectId: null }).status, 'scope_mismatch')

    const artifactA = store.list(inA.chat.id, { scope: 'project', projectId: projectA.id }).artifacts![0]!
    assert.equal(store.get(inA.chat.id, artifactA.id, { scope: 'project', projectId: projectA.id }).status, 'ok')
    assert.equal(store.get(inB.chat.id, artifactA.id, { scope: 'project', projectId: projectB.id }).status, 'not_found')
    db.prepare("UPDATE threads SET retention_policy = 'keep' WHERE id = ?").run(inA.chat.id)
    const kept = store.list(inA.chat.id, {
      scope: 'project',
      projectId: projectA.id,
    }).artifacts![0]!
    assert.equal(kept.retention.parentMode, 'keep')
    assert.equal(kept.retention.parentExpiresAt, null)
    assert.equal(kept.retention.effectiveExpiresAt, kept.retention.artifactExpiresAt)
    db.prepare("UPDATE threads SET retention_policy = 'session' WHERE id = ?").run(inA.chat.id)
    const session = store.list(inA.chat.id, {
      scope: 'project',
      projectId: projectA.id,
    }).artifacts![0]!
    assert.equal(session.retention.parentMode, 'session')
    assert.equal(session.retention.parentExpiresAt, null)
    assert.equal(session.retention.effectiveExpiresAt, session.retention.artifactExpiresAt)
    db.prepare(
      `UPDATE threads SET retention_policy = 'ttl',
         last_user_activity_at = '2026-08-10T12:00:00.000Z'
       WHERE id = ?`,
    ).run(inA.chat.id)
    const shortened = store.list(inA.chat.id, {
      scope: 'project',
      projectId: projectA.id,
    }).artifacts![0]!
    assert.equal(shortened.retention.parentMode, 'ttl')
    assert.equal(shortened.retention.parentExpiresAt, '2026-08-17T12:00:00.000Z')
    assert.equal(shortened.retention.effectiveExpiresAt, '2026-08-17T12:00:00.000Z')
    db.prepare(
      `UPDATE threads SET chat_lifecycle_state = 'trash',
         chat_tombstoned_at = '2026-08-11T12:00:00.000Z',
         chat_tombstone_reason = 'ttl_expired',
         chat_tombstone_activity_at = last_user_activity_at
       WHERE id = ?`,
    ).run(inA.chat.id)
    assert.equal(store.list(inA.chat.id, { scope: 'project', projectId: projectA.id }).status, 'in_trash')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts WHERE chat_id = ?').get(inA.chat.id) as { count: number }).count, 1)
    assert.equal(rows.length, 3)
    db.close()
  })

  it('serves strict read-only list/read routes and legacy projection without runtime effects', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-reasoning-routes-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const context = await createAppContext({ dbPath: join(root, 'guanxi.db'), appVersion: 'test' })
    test.after(async () => {
      await context.maintenance?.close()
      await context.chatExecution.shutdown()
      context.jobService.closeSubscriptions()
      context.db.close()
    })
    const { chat } = createChat(context.db)
    const association = createChatJob(context.db, chat.id, 'route', context.jobs)
    terminalize(context.jobs, association, { content: 'route final', thinking: 'route reasoning' })
    const artifact = new ReasoningArtifactStore(context.db)
      .list(chat.id, { scope: 'projectless', projectId: null }).artifacts![0]!
    let ollamaCalls = 0
    let modelCalls = 0
    context.ollama = () => {
      ollamaCalls += 1
      throw new Error('Artifact read must not call Ollama')
    }
    context.models = () => {
      modelCalls += 1
      throw new Error('Artifact read must not call model services')
    }
    const governorObservedAt = '2026-08-11T12:00:00.000Z'
    const governorBefore = JSON.stringify(context.governor.snapshot(governorObservedAt))
    const app = createApp(context)
    const query = '?artifactVersion=1&enforcementVersion=1&scope=projectless'
    const listResponse = await app.request(`/api/threads/${chat.id}/reasoning-artifacts${query}`)
    assert.equal(listResponse.status, 200)
    const listed = listReasoningArtifactsResponse.parse(await listResponse.json())
    assert.deepEqual(listed.enforcement, {
      state: 'active',
      owner: 'server_maintenance',
      boundary: 'reasoning_artifacts_only',
      inclusiveDueBoundary: true,
    })
    assert.equal(listed.generatedAnswers.length, 1)
    assert.equal(listed.artifacts.length, 1)
    assert.equal(listed.artifacts[0]?.id, artifact.id)
    const readResponse = await app.request(
      `/api/threads/${chat.id}/reasoning-artifacts/${artifact.id}${query}`,
    )
    assert.equal(readResponse.status, 200)
    const read = getReasoningArtifactResponse.parse(await readResponse.json())
    assert.equal(read.content, 'route reasoning')
    assert.equal(Object.hasOwn(read, 'prompt'), false)
    assert.equal(Object.hasOwn(read, 'toolCalls'), false)
    const raw = await (await app.request(`/api/threads/${chat.id}`)).json() as {
      messages: Array<{ id: string; content: string; thinking: string | null }>
    }
    assert.deepEqual(raw.messages.at(-1), {
      ...raw.messages.at(-1),
      id: association.assistantMessageId,
      content: 'route final',
      thinking: 'route reasoning',
    })

    for (const invalid of [
      '?enforcementVersion=1&scope=projectless',
      '?artifactVersion=malformed&enforcementVersion=1&scope=projectless',
      '?artifactVersion=2&enforcementVersion=1&scope=projectless',
      '?artifactVersion=1&scope=projectless',
      '?artifactVersion=1&enforcementVersion=malformed&scope=projectless',
      '?artifactVersion=1&enforcementVersion=2&scope=projectless',
      '?artifactVersion=1&enforcementVersion=1&scope=projectless&projectId=leak',
      '?artifactVersion=1&enforcementVersion=1&scope=projectless&scope=projectless',
      '?artifactVersion=1&enforcementVersion=1&scope=project&projectId=other',
    ]) {
      assert.equal((await app.request(`/api/threads/${chat.id}/reasoning-artifacts${invalid}`)).status, 400)
      assert.equal((await app.request(
        `/api/threads/${chat.id}/reasoning-artifacts/${artifact.id}${invalid}`,
      )).status, 400)
    }
    const other = createChat(context.db)
    assert.equal((await app.request(
      `/api/threads/${other.chat.id}/reasoning-artifacts/${artifact.id}${query}`,
    )).status, 404)
    context.db.prepare(
      `UPDATE threads SET chat_lifecycle_state = 'trash',
         chat_tombstoned_at = '2026-08-11T12:00:00.000Z',
         chat_tombstone_reason = 'ttl_expired',
         chat_tombstone_activity_at = last_user_activity_at
       WHERE id = ?`,
    ).run(chat.id)
    assert.equal((await app.request(`/api/threads/${chat.id}/reasoning-artifacts${query}`)).status, 404)
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM reasoning_artifacts').get() as { count: number }).count, 1)
    assert.deepEqual({ ollamaCalls, modelCalls }, { ollamaCalls: 0, modelCalls: 0 })
    assert.equal(JSON.stringify(context.governor.snapshot(governorObservedAt)), governorBefore)
  })

  it('keeps the Artifact store and scoped routes outside external effect owners', async () => {
    const storeSource = await readFile(
      new URL('../src/store/reasoning-artifacts.ts', import.meta.url),
      'utf8',
    )
    assert.doesNotMatch(
      storeSource,
      /node:fs|fetch\(|Ollama|Governor|tool|workspace|analytics|generic.cleanup/i,
    )
    const routesSource = await readFile(
      new URL('../src/http/threads-routes.ts', import.meta.url),
      'utf8',
    )
    const start = routesSource.indexOf("routes.get('/:id/reasoning-artifacts'")
    const artifactRoutes = routesSource.slice(
      start,
      routesSource.indexOf("routes.get('/:id'", start),
    )
    assert.ok(artifactRoutes.length > 0)
    assert.doesNotMatch(
      artifactRoutes,
      /app\.(ollama|models|governor|workspaces|approvals|maintenance)|fetch\(|analytics|cleanup/i,
    )
  })
})
