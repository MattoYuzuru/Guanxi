import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { RetentionMaintenanceOwner } from '../src/retention/maintenance.ts'
import { ChatRetentionStore } from '../src/store/chat-retention.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ReasoningArtifactStore } from '../src/store/reasoning-artifacts.ts'
import { ThreadStore } from '../src/store/threads.ts'

const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'high' as const }
const NOW = '2026-08-12T12:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1_000
const NON_TERMINAL = [
  'queued',
  'reserving',
  'loading',
  'prefill',
  'thinking',
  'generating',
  'waiting_tool',
  'waiting_approval',
  'finalizing',
  'cancelling',
] as const

function createChat(db: DatabaseSync, title = 'Expiry', projectId: string | null = null) {
  const threads = new ThreadStore(db)
  return projectId
    ? threads.createWithOwnership({ title, model: 'fixture', projectId, options: OPTIONS })
    : threads.create({
        title,
        mode: 'chat',
        model: 'fixture',
        workspaceId: null,
        options: OPTIONS,
      })
}

function createArtifact(
  db: DatabaseSync,
  chatId: string,
  key: string,
  content = `final-${key}`,
  reasoning = `reasoning-${key}`,
) {
  const jobs = new JobStore(db)
  const association = jobs.createChat({
    threadId: chatId,
    idempotencyScope: `chat:${chatId}:send:v1`,
    idempotencyKey: key,
    requestFingerprint: `fingerprint-${key}`,
    input: { content: `prompt-${key}`, attachments: [], autoApprove: null },
    derivedTitle: 'Prompt',
  })
  jobs.terminalizeChat({
    jobId: association.job.id,
    expectedStatus: 'queued',
    status: 'completed',
    messageId: association.assistantMessageId,
    message: {
      outcome: 'completed',
      error: null,
      stopReason: 'stop',
      content,
      thinking: reasoning,
      toolCalls: [],
      usage: null,
    },
    error: null,
    outcome: { code: 'chat_completed', metadata: {} },
    stopReason: 'completed',
  })
  const artifact = db.prepare(
    'SELECT id FROM reasoning_artifacts WHERE source_job_id = ?',
  ).get(association.job.id) as { id: string }
  return { ...association, artifactId: artifact.id, content, reasoning }
}

function allowArtifactUpdate(db: DatabaseSync, operation: () => void): void {
  db.exec('DROP TRIGGER reasoning_artifacts_immutable')
  try {
    operation()
  } finally {
    db.exec(`
      CREATE TRIGGER reasoning_artifacts_immutable
      BEFORE UPDATE ON reasoning_artifacts
      BEGIN SELECT RAISE(ABORT, 'reasoning Artifact is immutable'); END;
    `)
  }
}

function setArtifactExpiry(db: DatabaseSync, artifactId: string, expiresAt: string): void {
  allowArtifactUpdate(db, () => {
    db.prepare(
      `UPDATE reasoning_artifacts
       SET artifact_expires_at = ?, effective_expires_at = ?,
           parent_retention_mode = 'keep', parent_retention_expires_at = NULL
       WHERE id = ?`,
    ).run(expiresAt, expiresAt, artifactId)
  })
}

function setPolicy(
  db: DatabaseSync,
  chatId: string,
  policy: 'keep' | 'ttl' | 'session',
  activityAt = NOW,
): void {
  db.prepare(
    `UPDATE threads
     SET retention_policy = ?, last_user_activity_at = ?,
         retention_policy_updated_at = ?, last_user_activity_source = 'user_message'
     WHERE id = ?`,
  ).run(policy, activityAt, activityAt, chatId)
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
}

describe('P3-G automatic Reasoning Artifact expiry enforcement', () => {
  it('adds v17 once, preserves exact v16/legacy bytes and rolls a failed migration back for retry', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-reasoning-expiry-migration-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const seed = openDb(path)
    assert.equal((seed.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17)
    const chat = createChat(seed)
    const artifact = createArtifact(seed, chat.id, 'migration', 'exact final', 'exact diagnostic')
    seed.prepare(
      `INSERT INTO messages (
         id, thread_id, seq, role, content, thinking, tool_calls, usage,
         is_compaction, created_at, turn_status, turn_error, stop_reason, job_id
       ) VALUES ('legacy-expiry-message', ?, 99, 'assistant', 'legacy final',
         'legacy thinking', '[]', NULL, 0, ?, 'completed', NULL, 'stop', NULL)`,
    ).run(chat.id, NOW)
    const v16Payload = JSON.stringify({
      artifacts: seed.prepare('SELECT * FROM reasoning_artifacts ORDER BY id').all(),
      messages: seed.prepare('SELECT * FROM messages ORDER BY id').all(),
      jobs: seed.prepare('SELECT * FROM jobs ORDER BY id').all(),
    })
    seed.exec(`
      DROP INDEX idx_reasoning_artifact_deletion_audit_chat;
      DROP TABLE reasoning_artifact_deletion_audit;
      PRAGMA user_version = 16;
      CREATE TABLE reasoning_artifact_deletion_audit (collision TEXT NOT NULL);
    `)
    seed.close()

    assert.throws(() => openDb(path), /Миграция 17 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal((rolledBack.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 16)
    assert.equal(JSON.stringify({
      artifacts: rolledBack.prepare('SELECT * FROM reasoning_artifacts ORDER BY id').all(),
      messages: rolledBack.prepare('SELECT * FROM messages ORDER BY id').all(),
      jobs: rolledBack.prepare('SELECT * FROM jobs ORDER BY id').all(),
    }), v16Payload)
    assert.equal((rolledBack.prepare(
      'SELECT content_text FROM reasoning_artifacts WHERE id = ?',
    ).get(artifact.artifactId) as { content_text: string }).content_text, 'exact diagnostic')
    rolledBack.exec('DROP TABLE reasoning_artifact_deletion_audit')
    rolledBack.close()

    const retried = openDb(path)
    assert.equal((retried.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17)
    assert.equal(count(retried, 'reasoning_artifact_deletion_audit'), 0)
    retried.close()
    const reopened = openDb(path)
    assert.equal((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17)
    assert.equal((reopened.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'reasoning_artifact_deletion_audit'",
    ).get() as { count: number }).count, 1)
    reopened.close()
  })

  it('uses an injected inclusive clock at -1ms/at/+1ms and current Keep/Session/shorter TTL policy', () => {
    const db = openDb(':memory:')
    const store = new ReasoningArtifactStore(db)
    const before = createChat(db, 'Before')
    const at = createChat(db, 'At')
    const after = createChat(db, 'After')
    const session = createChat(db, 'Session')
    const shorter = createChat(db, 'Shorter TTL')
    const stale = createChat(db, 'Stale parent')
    const rows = [before, at, after, session, shorter, stale].map((chat, index) =>
      createArtifact(db, chat.id, `boundary-${index}`),
    )
    for (const chat of [before, at, after, stale]) setPolicy(db, chat.id, 'keep')
    setPolicy(db, session.id, 'session')
    setArtifactExpiry(db, rows[0]!.artifactId, new Date(Date.parse(NOW) - 1).toISOString())
    setArtifactExpiry(db, rows[1]!.artifactId, NOW)
    setArtifactExpiry(db, rows[2]!.artifactId, new Date(Date.parse(NOW) + 1).toISOString())
    setArtifactExpiry(db, rows[3]!.artifactId, NOW)
    setArtifactExpiry(db, rows[4]!.artifactId, new Date(Date.parse(NOW) + DAY_MS).toISOString())
    setPolicy(db, shorter.id, 'ttl', new Date(Date.parse(NOW) - 7 * DAY_MS).toISOString())
    setArtifactExpiry(db, rows[5]!.artifactId, new Date(Date.parse(NOW) + DAY_MS).toISOString())
    allowArtifactUpdate(db, () => {
      db.prepare(
        `UPDATE reasoning_artifacts
         SET parent_retention_mode = 'ttl', parent_retention_expires_at = ?, effective_expires_at = ?
         WHERE id = ?`,
      ).run(NOW, NOW, rows[5]!.artifactId)
    })

    const eligible = store.eligiblePage(NOW, null, 20)
    assert.deepEqual(
      eligible.map(({ artifactId }) => artifactId).toSorted(),
      [rows[0]!.artifactId, rows[1]!.artifactId, rows[3]!.artifactId, rows[4]!.artifactId].toSorted(),
    )
    assert.equal(store.deleteEligible(eligible, NOW), 4)
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM reasoning_artifacts WHERE id = ?',
    ).get(rows[2]!.artifactId)?.count, 1)
    assert.equal(db.prepare(
      'SELECT COUNT(*) AS count FROM reasoning_artifacts WHERE id = ?',
    ).get(rows[5]!.artifactId)?.count, 1)
    assert.deepEqual(store.deletionAudit().map(({ reason }) => reason).toSorted(), [
      'diagnostic_ttl_expired',
      'diagnostic_ttl_expired',
      'diagnostic_ttl_expired',
      'shorter_parent_ttl_expired',
    ])
    db.close()
  })

  it('rechecks current user activity/policy and blocks every canonical non-terminal Job until retry', () => {
    for (const state of NON_TERMINAL) {
      const db = openDb(':memory:')
      const chat = createChat(db, state)
      const artifact = createArtifact(db, chat.id, `guard-artifact-${state}`)
      setPolicy(db, chat.id, 'keep')
      setArtifactExpiry(db, artifact.artifactId, NOW)
      const blocker = new JobStore(db).createChat({
        threadId: chat.id,
        idempotencyScope: `chat:${chat.id}:send:v1`,
        idempotencyKey: `guard-${state}`,
        requestFingerprint: `guard-${state}`,
        input: { content: 'blocked prompt', attachments: [], autoApprove: null },
        derivedTitle: 'Blocked',
      })
      if (state !== 'queued') {
        db.prepare('UPDATE jobs SET status = ?, phase = ?, started_at = ? WHERE id = ?')
          .run(state, state, NOW, blocker.job.id)
      }
      const store = new ReasoningArtifactStore(db)
      assert.deepEqual(store.eligiblePage(NOW, null, 10), [], state)
      db.prepare(
        "UPDATE jobs SET status = 'completed', phase = NULL, finished_at = ? WHERE id = ?",
      ).run(NOW, blocker.job.id)
      const retry = store.eligiblePage(NOW, null, 10)
      assert.equal(retry.length, 1, state)
      assert.equal(store.deleteEligible(retry, NOW), 1, state)
      assert.equal(store.deleteEligible(retry, NOW), 0, state)
      assert.equal(store.deletionAudit().length, 1, state)
      db.close()
    }

    const db = openDb(':memory:')
    const chat = createChat(db, 'Policy race')
    const artifact = createArtifact(db, chat.id, 'policy-race')
    setArtifactExpiry(db, artifact.artifactId, new Date(Date.parse(NOW) + DAY_MS).toISOString())
    setPolicy(db, chat.id, 'ttl', new Date(Date.parse(NOW) - 7 * DAY_MS).toISOString())
    const store = new ReasoningArtifactStore(db)
    const staleCandidates = store.eligiblePage(NOW, null, 10)
    assert.equal(staleCandidates.length, 1)
    setPolicy(db, chat.id, 'ttl', NOW)
    assert.equal(store.deleteEligible(staleCandidates, NOW), 0)
    setPolicy(db, chat.id, 'keep', NOW)
    assert.equal(store.deleteEligible(staleCandidates, NOW), 0)
    setPolicy(db, chat.id, 'session', NOW)
    assert.equal(store.deleteEligible(staleCandidates, NOW), 0)
    assert.equal(count(db, 'reasoning_artifacts'), 1)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit'), 0)
    db.close()
  })

  it('keeps exact bounded order, coalesces ticks and converges across batches and owner restart', async () => {
    const db = openDb(':memory:')
    const reasoning = new ReasoningArtifactStore(db)
    const artifactIds: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const chat = createChat(db, `Batch ${index}`)
      setPolicy(db, chat.id, 'keep')
      const artifact = createArtifact(db, chat.id, `batch-${index}`)
      setArtifactExpiry(db, artifact.artifactId, NOW)
      artifactIds.push(artifact.artifactId)
    }
    const firstPage = reasoning.eligiblePage(NOW, null, 2)
    const secondPage = reasoning.eligiblePage(NOW, firstPage.at(-1)!, 2)
    const thirdPage = reasoning.eligiblePage(NOW, secondPage.at(-1)!, 2)
    assert.deepEqual(
      [...firstPage, ...secondPage, ...thirdPage].map(({ artifactId }) => artifactId),
      artifactIds.toSorted(),
    )
    const owner = new RetentionMaintenanceOwner(new ChatRetentionStore(db), {
      reasoningArtifacts: reasoning,
      clock: () => new Date(NOW),
      batchSize: 2,
      maxBatchesPerRun: 1,
    })
    const concurrentA = owner.runOnce()
    const concurrentB = owner.runOnce()
    assert.equal(concurrentA, concurrentB)
    assert.deepEqual(await concurrentA, {
      observedAt: NOW,
      scanned: 0,
      tombstoned: 0,
      batches: 0,
      reasoningScanned: 2,
      reasoningDeleted: 2,
      reasoningBatches: 1,
    })
    await owner.close()
    assert.equal(count(db, 'reasoning_artifacts'), 3)

    const restarted = new RetentionMaintenanceOwner(new ChatRetentionStore(db), {
      reasoningArtifacts: new ReasoningArtifactStore(db),
      clock: () => new Date(NOW),
      batchSize: 2,
      maxBatchesPerRun: 1,
    })
    assert.equal((await restarted.runOnce()).reasoningDeleted, 2)
    assert.equal((await restarted.runOnce()).reasoningDeleted, 1)
    assert.equal((await restarted.runOnce()).reasoningDeleted, 0)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit'), 5)
    await restarted.close()
    db.close()
  })

  it('rolls delete/audit back together, retries once and preserves final answer, Job, compaction and legacy bytes', () => {
    const db = openDb(':memory:')
    const chat = createChat(db, 'Atomic')
    setPolicy(db, chat.id, 'keep')
    const artifact = createArtifact(db, chat.id, 'atomic', 'generated answer survives', 'secret diagnostic')
    setArtifactExpiry(db, artifact.artifactId, NOW)
    const threads = new ThreadStore(db)
    threads.addMessage({ threadId: chat.id, role: 'assistant', content: 'legacy final', thinking: 'legacy thinking' })
    threads.addMessage({ threadId: chat.id, role: 'user', content: 'tail one' })
    threads.addMessage({ threadId: chat.id, role: 'assistant', content: 'tail two', turnStatus: 'completed' })
    const storedBefore = JSON.stringify({
      message: db.prepare('SELECT * FROM messages WHERE id = ?').get(artifact.assistantMessageId),
      job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(artifact.job.id),
    })
    const store = new ReasoningArtifactStore(db)
    const eligible = store.eligiblePage(NOW, null, 10)
    db.exec(`
      CREATE TRIGGER fail_reasoning_deletion_audit
      BEFORE INSERT ON reasoning_artifact_deletion_audit
      BEGIN SELECT RAISE(ABORT, 'injected deletion audit failure'); END;
    `)
    assert.throws(() => store.deleteEligible(eligible, NOW), /injected deletion audit failure/u)
    assert.equal(count(db, 'reasoning_artifacts'), 1)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit'), 0)
    db.exec('DROP TRIGGER fail_reasoning_deletion_audit')
    assert.equal(store.deleteEligible(eligible, NOW), 1)
    assert.equal(store.deleteEligible(eligible, NOW), 0)
    assert.equal(count(db, 'reasoning_artifact_deletion_audit'), 1)
    assert.equal(JSON.stringify({
      message: db.prepare('SELECT * FROM messages WHERE id = ?').get(artifact.assistantMessageId),
      job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(artifact.job.id),
    }), storedBefore)
    const messages = threads.messages(chat.id)
    const generated = messages.find(({ id }) => id === artifact.assistantMessageId)!
    assert.equal(generated.content, 'generated answer survives')
    assert.equal(generated.thinking, null)
    assert.equal(messages.find(({ content }) => content === 'legacy final')?.thinking, 'legacy thinking')
    assert.deepEqual(
      threads.compactionCandidates(chat.id, 2)!.messages
        .filter(({ role }) => role === 'assistant')
        .map(({ content }) => content),
      ['generated answer survives', 'legacy final'],
    )
    const projection = store.list(chat.id, { scope: 'projectless', projectId: null })
    assert.equal(projection.generatedAnswers?.length, 1)
    assert.equal(projection.artifacts?.length, 0)
    const auditJson = JSON.stringify(store.deletionAudit())
    for (const secret of [
      'secret diagnostic',
      'generated answer survives',
      'prompt-atomic',
      'legacy thinking',
      '/private/path',
      'credential',
      'tool',
      'provider error',
    ]) assert.equal(auditJson.includes(secret), false, secret)
    db.close()
  })

  it('deletes due active/Trash project/projectless Artifacts without cross-Chat effects and Restore cannot recover bytes', () => {
    const db = openDb(':memory:')
    const project = new ProjectStore(db).create('Expiry project', NOW)
    const active = createChat(db, 'Active projectless')
    const trash = createChat(db, 'Trash project', project.id)
    const neighbor = createChat(db, 'Neighbor project', project.id)
    for (const chat of [active, trash, neighbor]) setPolicy(db, chat.id, 'keep')
    const activeArtifact = createArtifact(db, active.id, 'scope-active')
    const trashArtifact = createArtifact(db, trash.id, 'scope-trash')
    const neighborArtifact = createArtifact(db, neighbor.id, 'scope-neighbor')
    setArtifactExpiry(db, activeArtifact.artifactId, NOW)
    setArtifactExpiry(db, trashArtifact.artifactId, NOW)
    setArtifactExpiry(db, neighborArtifact.artifactId, new Date(Date.parse(NOW) + 1).toISOString())
    db.prepare(
      `UPDATE threads SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
         chat_tombstone_reason = 'ttl_expired', chat_tombstone_activity_at = last_user_activity_at
       WHERE id = ?`,
    ).run(NOW, trash.id)
    const store = new ReasoningArtifactStore(db)
    const candidates = store.eligiblePage(NOW, null, 10)
    assert.deepEqual(
      candidates.map(({ artifactId }) => artifactId).toSorted(),
      [activeArtifact.artifactId, trashArtifact.artifactId].toSorted(),
    )
    assert.equal(store.deleteEligible(candidates, NOW), 2)
    assert.equal(count(db, 'reasoning_artifacts'), 1)
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS count FROM reasoning_artifacts WHERE chat_id = ?',
    ).get(neighbor.id) as { count: number }).count, 1)
    assert.equal(new ChatRetentionStore(db).restore(trash.id).status, 'ok')
    assert.equal(store.list(trash.id, { scope: 'project', projectId: project.id }).artifacts?.length, 0)
    assert.equal(store.list(active.id, { scope: 'projectless', projectId: null }).artifacts?.length, 0)
    assert.equal(store.list(neighbor.id, { scope: 'project', projectId: project.id }).artifacts?.length, 1)
    assert.deepEqual(store.deletionAudit().map(({ chat_id }) => chat_id).toSorted(), [active.id, trash.id].toSorted())
    db.close()
  })

  it('keeps the enforcement owner free of runtime, tool, filesystem, network, analytics and generic cleanup effects', async () => {
    const maintenanceSource = await readFile(
      new URL('../src/retention/maintenance.ts', import.meta.url),
      'utf8',
    )
    const storeSource = await readFile(
      new URL('../src/store/reasoning-artifacts.ts', import.meta.url),
      'utf8',
    )
    for (const source of [maintenanceSource, storeSource]) {
      assert.doesNotMatch(
        source,
        /node:fs|fetch\(|Ollama|Governor|tool_runs|workspace|provider|analytics|generic.cleanup/iu,
      )
    }
  })
})
