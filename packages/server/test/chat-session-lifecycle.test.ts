import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  SESSION_LEAVE_VERSION,
  chatTrashItemSchema,
  leaveSessionChatBody,
  leaveSessionChatResponse,
} from '@guanxi/contract'
import { createApp } from '../src/app.ts'
import { createAppContext } from '../src/context.ts'
import {
  RetentionMaintenanceOwner,
  type RetentionMaintenanceScheduler,
} from '../src/retention/maintenance.ts'
import { ChatRetentionStore } from '../src/store/chat-retention.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { ProjectStore } from '../src/store/projects.ts'
import { ThreadStore } from '../src/store/threads.ts'
import {
  downgradeSessionLifecycleHardeningToV18,
  downgradeSessionLifecycleToV17,
} from './fixtures/retention-lifecycle-migration.ts'

const NOW = '2030-01-02T12:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1_000
const OPTIONS = { numCtx: 8_192, temperature: 0.7, think: 'off' as const }
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
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted'] as const

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function createChat(threads: ThreadStore, title: string, projectId: string | null = null) {
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

function makeSession(store: ChatRetentionStore, chatId: string): void {
  assert.equal(store.update(chatId, { mode: 'session' }).status, 'ok')
}

function createChatJob(db: DatabaseSync, chatId: string, key: string, state: string): string {
  const created = new JobStore(db).createChat({
    threadId: chatId,
    idempotencyScope: `chat:${chatId}:send:v1`,
    idempotencyKey: key,
    requestFingerprint: `fingerprint-${key}`,
    input: { content: key, attachments: [], autoApprove: null },
    derivedTitle: key,
  })
  db.prepare('UPDATE jobs SET status = ?, phase = ?, finished_at = ? WHERE id = ?')
    .run(state, state, TERMINAL.includes(state as never) ? NOW : null, created.job.id)
  return created.job.id
}

function row(db: DatabaseSync, chatId: string) {
  return db.prepare(
    `SELECT retention_policy, chat_lifecycle_state, chat_lifecycle_reason,
            chat_tombstoned_at, chat_tombstone_activity_at,
            session_leave_at, session_leave_source
     FROM threads WHERE id = ?`,
  ).get(chatId) as {
    retention_policy: string
    chat_lifecycle_state: string
    chat_lifecycle_reason: string | null
    chat_tombstoned_at: string | null
    chat_tombstone_activity_at: string | null
    session_leave_at: string | null
    session_leave_source: string | null
  }
}

function exactPayload(db: DatabaseSync): string {
  return JSON.stringify({
    threads: db.prepare(
      `SELECT id, title, mode, model, workspace_id, project_id, num_ctx, temperature,
              think, created_at, updated_at, retention_policy, retention_policy_source,
              retention_policy_updated_at, last_user_activity_at,
              last_user_activity_source, last_user_restore_at,
              chat_lifecycle_state, chat_tombstoned_at, chat_tombstone_reason,
              chat_tombstone_activity_at
       FROM threads ORDER BY id`,
    ).all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
    inputs: db.prepare('SELECT * FROM chat_job_inputs ORDER BY job_id').all(),
    reasoning: db.prepare('SELECT * FROM reasoning_artifacts ORDER BY id').all(),
    reasoningAudit: db.prepare('SELECT * FROM reasoning_artifact_deletion_audit ORDER BY id').all(),
    lifecycleAudit: db.prepare('SELECT * FROM chat_lifecycle_audit ORDER BY id').all(),
  })
}

class FakeScheduler implements RetentionMaintenanceScheduler {
  readonly callbacks: Array<() => void> = []
  readonly cleared: unknown[] = []

  setInterval(callback: () => void): unknown {
    this.callbacks.push(callback)
    return this.callbacks.length - 1
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle)
  }
}

describe('P3-H explicit Session leave and 24-hour recovery', () => {
  it('keeps leave and Session Trash contracts strict, sourced and fail-closed', () => {
    const valid = {
      leaveVersion: SESSION_LEAVE_VERSION,
      chatId: 'chat-1',
      scope: 'projectless',
    }
    assert.equal(leaveSessionChatBody.safeParse(valid).success, true)
    assert.equal(leaveSessionChatBody.safeParse({
      ...valid,
      scope: 'project',
      projectId: 'project-1',
    }).success, true)
    for (const invalid of [
      {},
      { ...valid, leaveVersion: 2 },
      { ...valid, future: true },
      { ...valid, scope: 'project' },
      { ...valid, projectId: 'scope-leak' },
      { ...valid, scope: 'future' },
    ]) assert.equal(leaveSessionChatBody.safeParse(invalid).success, false)

    const response = {
      leaveVersion: 1,
      chatId: 'chat-1',
      projectId: null,
      state: 'trash',
      leaveBasis: { at: NOW, source: 'explicit_user_action' },
      activeJobCount: 0,
      recoveryDeadline: new Date(Date.parse(NOW) + DAY_MS).toISOString(),
      hardDeletion: 'session_metadata_after_recovery',
    }
    assert.equal(leaveSessionChatResponse.safeParse(response).success, true)
    assert.equal(leaveSessionChatResponse.safeParse({
      ...response,
      state: 'blocked_active_job',
      recoveryDeadline: null,
    }).success, false)
    assert.equal(chatTrashItemSchema.safeParse({
      lifecycleVersion: 1,
      chatId: 'chat-1',
      title: 'Session',
      projectId: null,
      state: 'trash',
      reason: 'session_left',
      tombstonedAt: NOW,
      activityBasis: { at: NOW, source: 'session_leave' },
      source: 'server_maintenance',
      hardDeletion: {
        state: 'scheduled_after_recovery',
        eligibleAt: new Date(Date.parse(NOW) + DAY_MS).toISOString(),
        source: 'server_maintenance',
        blobGc: 'not_applicable',
      },
      recovery: {
        deadline: new Date(Date.parse(NOW) + DAY_MS).toISOString(),
        state: 'available',
        source: 'server_calculated_24_hours',
      },
    }).success, true)
    assert.equal(chatTrashItemSchema.safeParse({
      lifecycleVersion: 1,
      chatId: 'chat-1',
      title: 'Session',
      projectId: null,
      state: 'trash',
      reason: 'session_left',
      tombstonedAt: NOW,
      activityBasis: { at: NOW, source: 'session_leave' },
      source: 'server_maintenance',
      hardDeletion: {
        state: 'scheduled_after_recovery',
        eligibleAt: new Date(Date.parse(NOW) + DAY_MS - 1).toISOString(),
        source: 'server_maintenance',
        blobGc: 'not_applicable',
      },
      recovery: {
        deadline: new Date(Date.parse(NOW) + DAY_MS - 1).toISOString(),
        state: 'available',
        source: 'server_calculated_24_hours',
      },
    }).success, false)
  })

  it('applies append-only v18/v19 and rolls true late failures back byte-exact for retry', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-session-v18-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    const chat = createChat(new ThreadStore(seed), 'Migration history')
    const jobId = createChatJob(seed, chat.id, 'migration', 'completed')
    seed.prepare('UPDATE messages SET content = ?, thinking = ? WHERE job_id = ? AND role = ?')
      .run('exact final', 'legacy thinking', jobId, 'assistant')
    downgradeSessionLifecycleToV17(seed)
    const before = exactPayload(seed)
    seed.exec('CREATE INDEX idx_threads_chat_session_eligibility ON threads(id)')
    seed.close()

    assert.throws(() => openDb(path), /Миграция 18 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 17)
    assert.equal((rolledBack.prepare(
      `SELECT COUNT(*) AS count FROM pragma_table_info('threads')
       WHERE name IN ('session_leave_at','session_leave_source','chat_lifecycle_reason')`,
    ).get() as { count: number }).count, 0)
    assert.equal(exactPayload(rolledBack), before)
    rolledBack.exec('DROP INDEX idx_threads_chat_session_eligibility')
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 29)
    assert.deepEqual({ ...row(retried, chat.id) }, {
      retention_policy: 'ttl',
      chat_lifecycle_state: 'active',
      chat_lifecycle_reason: null,
      chat_tombstoned_at: null,
      chat_tombstone_activity_at: null,
      session_leave_at: null,
      session_leave_source: null,
    })
    assert.equal(exactPayload(retried), before)
    downgradeSessionLifecycleHardeningToV18(retried)
    const beforeHardening = exactPayload(retried)
    retried.prepare(
      `UPDATE threads
       SET retention_policy = 'session', chat_lifecycle_state = 'trash',
           chat_tombstoned_at = ?, chat_tombstone_reason = NULL,
           chat_tombstone_activity_at = ?, chat_lifecycle_reason = 'session_left'
       WHERE id = ?`,
    ).run(NOW, NOW, chat.id)
    retried.close()

    assert.throws(() => openDb(path), /Миграция 19 не применилась/u)
    const corruptV18 = new DatabaseSync(path)
    assert.equal(version(corruptV18), 18)
    assert.equal(row(corruptV18, chat.id).session_leave_at, null)
    corruptV18.prepare(
      `UPDATE threads
       SET retention_policy = 'ttl', chat_lifecycle_state = 'active',
           chat_tombstoned_at = NULL, chat_tombstone_reason = NULL,
           chat_tombstone_activity_at = NULL, chat_lifecycle_reason = NULL
       WHERE id = ?`,
    ).run(chat.id)
    assert.equal(exactPayload(corruptV18), beforeHardening)
    corruptV18.exec('CREATE INDEX idx_threads_chat_session_integrity ON threads(id)')
    corruptV18.close()

    assert.throws(() => openDb(path), /Миграция 19 не применилась/u)
    const hardeningRolledBack = new DatabaseSync(path)
    assert.equal(version(hardeningRolledBack), 18)
    assert.equal(exactPayload(hardeningRolledBack), beforeHardening)
    const weakTrigger = (hardeningRolledBack.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'threads_chat_lifecycle_update_valid'",
    ).get() as { sql: string }).sql
    assert.equal(weakTrigger.includes('chat_tombstone_activity_at = NEW.session_leave_at'), false)
    hardeningRolledBack.exec('DROP INDEX idx_threads_chat_session_integrity')
    hardeningRolledBack.close()

    const hardened = openDb(path)
    assert.equal(version(hardened), 29)
    assert.equal(exactPayload(hardened), beforeHardening)
    assert.throws(() => hardened.prepare(
      `UPDATE threads
       SET retention_policy = 'session', chat_lifecycle_state = 'trash',
           chat_tombstoned_at = ?, chat_tombstone_reason = NULL,
           chat_tombstone_activity_at = ?, chat_lifecycle_reason = 'session_left'
       WHERE id = ?`,
    ).run(NOW, NOW, chat.id), /invalid Chat lifecycle state/)
    hardened.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 29)
    assert.equal(exactPayload(reopened), before)
    reopened.close()
  })

  it('records exactly one server-time leave basis with exact scope and no implicit lifecycle guesses', async (test) => {
    let clock = new Date(NOW)
    const root = await mkdtemp(join(tmpdir(), 'guanxi-session-basis-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    let db = openDb(path)
    const threads = new ThreadStore(db)
    const projects = new ProjectStore(db)
    const project = projects.create('Owner', NOW)
    const projectless = createChat(threads, 'Projectless')
    const owned = createChat(threads, 'Owned', project.id)
    const neighbor = createChat(threads, 'Neighbor')
    let store = new ChatRetentionStore(db, { clock: () => clock })
    makeSession(store, projectless.id)
    makeSession(store, owned.id)
    makeSession(store, neighbor.id)

    assert.equal(store.leaveSession(projectless.id, { scope: 'project', projectId: project.id }).status, 'scope_mismatch')
    assert.equal(store.leaveSession(owned.id, { scope: 'projectless' }).status, 'scope_mismatch')
    assert.equal(store.leaveSession(owned.id, { scope: 'project', projectId: 'other' }).status, 'scope_mismatch')
    assert.equal(row(db, projectless.id).session_leave_at, null)
    assert.equal(row(db, owned.id).session_leave_at, null)
    assert.throws(() => db.prepare(
      `UPDATE threads
       SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
           chat_tombstone_reason = NULL, chat_tombstone_activity_at = ?,
           chat_lifecycle_reason = 'session_left'
       WHERE id = ?`,
    ).run(NOW, NOW, projectless.id), /invalid Chat lifecycle state/)

    // Reads and a real database close/reopen have no leave write path.
    assert.equal(store.get(projectless.id).status, 'ok')
    assert.equal(store.get(projectless.id).status, 'ok')
    assert.equal(row(db, projectless.id).session_leave_at, null)
    db.close()
    db = openDb(path)
    store = new ChatRetentionStore(db, { clock: () => clock })
    assert.equal(store.get(projectless.id).status, 'ok')
    assert.equal(row(db, projectless.id).session_leave_at, null)
    const first = store.leaveSession(projectless.id, { scope: 'projectless' })
    assert.equal(first.status, 'ok')
    if (first.status !== 'ok') return
    assert.equal(first.lifecycle.leaveBasis.at, NOW)
    assert.equal(first.lifecycle.leaveBasis.source, 'explicit_user_action')
    assert.throws(() => db.prepare(
      `UPDATE threads
       SET chat_lifecycle_state = 'trash', chat_tombstoned_at = ?,
           chat_tombstone_reason = NULL, chat_tombstone_activity_at = ?,
           chat_lifecycle_reason = 'session_left'
       WHERE id = ?`,
    ).run(NOW, new Date(Date.parse(NOW) + 1).toISOString(), projectless.id),
    /invalid Chat lifecycle state/)
    clock = new Date(Date.parse(NOW) + 10_000)
    const repeated = store.leaveSession(projectless.id, { scope: 'projectless' })
    assert.equal(repeated.status, 'ok')
    if (repeated.status === 'ok') assert.deepEqual(repeated.lifecycle, first.lifecycle)
    assert.equal(row(db, neighbor.id).session_leave_at, null)

    db.close()
    db = openDb(path)
    const reopenedStore = new ChatRetentionStore(db, { clock: () => clock })
    const persisted = reopenedStore.get(projectless.id)
    assert.equal(persisted.status, 'ok')
    if (persisted.status === 'ok') {
      assert.equal(persisted.retention.sessionLeave?.at, first.lifecycle.leaveBasis.at)
      assert.equal(persisted.retention.sessionLeave?.state, 'pending_maintenance')
    }
    db.close()
  })

  it('blocks every canonical active Job and admits every terminal state exactly once', async () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const store = new ChatRetentionStore(db, { clock: () => new Date(NOW) })
    const blocked: Array<{ chatId: string; jobId: string }> = []
    for (const [index, state] of NON_TERMINAL.entries()) {
      const chat = createChat(threads, `Blocked ${state}`)
      makeSession(store, chat.id)
      const jobId = createChatJob(db, chat.id, `blocked-${index}`, state)
      const leave = store.leaveSession(chat.id, { scope: 'projectless' })
      assert.equal(leave.status, 'ok')
      if (leave.status === 'ok') {
        assert.equal(leave.lifecycle.state, 'blocked_active_job')
        assert.equal(leave.lifecycle.activeJobCount, 1)
      }
      blocked.push({ chatId: chat.id, jobId })
    }
    const terminalIds: string[] = []
    for (const [index, state] of TERMINAL.entries()) {
      const chat = createChat(threads, `Terminal ${state}`)
      makeSession(store, chat.id)
      createChatJob(db, chat.id, `terminal-${index}`, state)
      assert.equal(store.leaveSession(chat.id, { scope: 'projectless' }).status, 'ok')
      terminalIds.push(chat.id)
    }
    assert.deepEqual(
      store.eligiblePage(NOW, null, 100).map(({ chatId }) => chatId).sort(),
      [...terminalIds].sort(),
    )

    const raced = createChat(threads, 'Job starts after eligibility')
    makeSession(store, raced.id)
    store.leaveSession(raced.id, { scope: 'projectless' })
    const racedCandidate = store.eligiblePage(NOW, null, 100)
      .filter(({ chatId }) => chatId === raced.id)
    assert.equal(racedCandidate.length, 1)
    const racedJobId = createChatJob(db, raced.id, 'raced-active-job', 'queued')
    assert.equal(store.tombstoneEligible(racedCandidate, NOW), 0)
    assert.equal(row(db, raced.id).chat_lifecycle_state, 'active')
    db.prepare("UPDATE jobs SET status = 'completed', phase = 'completed', finished_at = ? WHERE id = ?")
      .run(NOW, racedJobId)
    assert.equal(store.tombstoneEligible(racedCandidate, NOW), 1)
    assert.equal(store.tombstoneEligible(racedCandidate, NOW), 0)

    const owner = new RetentionMaintenanceOwner(store, {
      clock: () => new Date(NOW),
      batchSize: 100,
      maxBatchesPerRun: 1,
    })
    const first = await owner.runOnce()
    assert.equal(first.tombstoned, TERMINAL.length)
    assert.deepEqual(terminalIds.map((chatId) => row(db, chatId).chat_lifecycle_state), TERMINAL.map(() => 'trash'))
    assert.deepEqual(blocked.map(({ chatId }) => row(db, chatId).chat_lifecycle_state), NON_TERMINAL.map(() => 'active'))

    for (const [{ jobId }, terminal] of blocked.map((item, index) => [item, TERMINAL[index % TERMINAL.length]!] as const)) {
      db.prepare('UPDATE jobs SET status = ?, phase = ?, finished_at = ? WHERE id = ?')
        .run(terminal, terminal, NOW, jobId)
    }
    const second = await owner.runOnce()
    const third = await owner.runOnce()
    assert.equal(second.tombstoned, NON_TERMINAL.length)
    assert.equal(third.tombstoned, 0)
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE reason = 'session_left'",
    ).get() as { count: number }).count, NON_TERMINAL.length + TERMINAL.length + 1)
    await owner.close()
    db.close()
  })

  it('uses the existing owner for stable bounded Session order, coalescing, startup, periodic and shutdown', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'guanxi-session-owner-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'guanxi.db')
    const seed = openDb(path)
    const seedStore = new ChatRetentionStore(seed, { clock: () => new Date(NOW) })
    const startup = createChat(new ThreadStore(seed), 'Startup pending')
    makeSession(seedStore, startup.id)
    seedStore.leaveSession(startup.id, { scope: 'projectless' })
    seed.close()

    const scheduler = new FakeScheduler()
    const context = await createAppContext({
      dbPath: path,
      appVersion: 'test',
      retentionMaintenance: {
        clock: () => new Date(NOW),
        scheduler,
        intervalMs: 10,
        batchSize: 2,
        maxBatchesPerRun: 1,
      },
    })
    test.after(async () => {
      await context.maintenance?.close()
      await context.chatExecution.shutdown()
      context.jobService.closeSubscriptions()
      context.db.close()
    })
    assert.equal(row(context.db, startup.id).chat_lifecycle_state, 'trash')
    assert.equal(scheduler.callbacks.length, 1)

    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const chat = createChat(context.threads, `Periodic ${index}`)
      makeSession(new ChatRetentionStore(context.db, { clock: () => new Date(NOW) }), chat.id)
      new ChatRetentionStore(context.db, { clock: () => new Date(NOW) })
        .leaveSession(chat.id, { scope: 'projectless' })
      ids.push(chat.id)
    }
    const paging = new ChatRetentionStore(context.db, { clock: () => new Date(NOW) })
    const firstPage = paging.eligiblePage(NOW, null, 2)
    const secondPage = paging.eligiblePage(NOW, firstPage.at(-1)!, 2)
    const thirdPage = paging.eligiblePage(NOW, secondPage.at(-1)!, 2)
    assert.deepEqual(
      [...firstPage, ...secondPage, ...thirdPage].map(({ chatId }) => chatId),
      ids.toSorted(),
    )
    const coalesced = await Promise.all([
      context.maintenance!.runOnce(),
      context.maintenance!.runOnce(),
    ])
    assert.equal(coalesced[0], coalesced[1])
    assert.equal(coalesced[0]!.tombstoned, 2)
    scheduler.callbacks[0]!()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal((context.db.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE chat_lifecycle_reason = 'session_left'",
    ).get() as { count: number }).count, 5)
    await context.maintenance!.runOnce()
    assert.equal((context.db.prepare(
      "SELECT COUNT(*) AS count FROM threads WHERE chat_lifecycle_reason = 'session_left'",
    ).get() as { count: number }).count, 6)
    await context.maintenance!.close()
    assert.equal(scheduler.cleared.length, 1)
  })

  it('enforces -1ms/at/+1ms recovery, clears stale leave on Restore or Keep/TTL and never duplicates audit', async () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const initial = new ChatRetentionStore(db, { clock: () => new Date(NOW) })
    const restoreBefore = createChat(threads, 'Restore before')
    const policyBefore = createChat(threads, 'Policy before')
    const ttlPolicyBefore = createChat(threads, 'TTL policy before')
    const exact = createChat(threads, 'Exact deadline')
    const after = createChat(threads, 'After deadline')
    for (const chat of [restoreBefore, policyBefore, ttlPolicyBefore, exact, after]) {
      makeSession(initial, chat.id)
      initial.leaveSession(chat.id, { scope: 'projectless' })
    }
    const pendingCandidates = initial.eligiblePage(NOW, null, 20)
    const staleCandidate = (chatId: string) => pendingCandidates.filter(
      (candidate) => candidate.chatId === chatId,
    )
    assert.equal(pendingCandidates.length, 5)
    const owner = new RetentionMaintenanceOwner(initial, {
      clock: () => new Date(NOW),
      batchSize: 10,
      maxBatchesPerRun: 1,
    })
    assert.equal((await owner.runOnce()).tombstoned, 5)
    const deadline = Date.parse(NOW) + DAY_MS
    const beforeStore = new ChatRetentionStore(db, { clock: () => new Date(deadline - 1) })
    const beforeItem = beforeStore.listTrash({ scope: 'projectless' }, 20).chats
      .find(({ chatId }) => chatId === restoreBefore.id)!
    assert.equal(beforeItem.reason, 'session_left')
    if (beforeItem.reason === 'session_left') {
      assert.equal(beforeItem.recovery.deadline, new Date(deadline).toISOString())
      assert.equal(beforeItem.recovery.state, 'available')
    }
    const restored = beforeStore.restore(restoreBefore.id)
    assert.equal(restored.status, 'ok')
    if (restored.status === 'ok') {
      assert.equal(restored.lifecycle.hardDeletion, 'not_implemented')
    }
    assert.equal(beforeStore.restore(restoreBefore.id).status, 'ok')
    assert.equal(row(db, restoreBefore.id).session_leave_at, null)
    assert.equal(initial.tombstoneEligible(staleCandidate(restoreBefore.id), NOW), 0)

    const policy = beforeStore.update(policyBefore.id, { mode: 'keep' })
    assert.equal(policy.status, 'ok')
    assert.equal(beforeStore.update(policyBefore.id, { mode: 'keep' }).status, 'ok')
    assert.equal(row(db, policyBefore.id).session_leave_at, null)
    assert.equal(initial.tombstoneEligible(staleCandidate(policyBefore.id), NOW), 0)
    const ttlPolicy = beforeStore.update(ttlPolicyBefore.id, { mode: 'ttl', expiresAfterDays: 7 })
    assert.equal(ttlPolicy.status, 'ok')
    if (ttlPolicy.status === 'ok') assert.deepEqual(ttlPolicy.retention.policy, { mode: 'ttl', expiresAfterDays: 7 })
    assert.equal(row(db, ttlPolicyBefore.id).session_leave_at, null)
    assert.equal(initial.tombstoneEligible(staleCandidate(ttlPolicyBefore.id), NOW), 0)

    const exactStore = new ChatRetentionStore(db, { clock: () => new Date(deadline) })
    const exactItem = exactStore.listTrash({ scope: 'projectless' }, 20).chats
      .find(({ chatId }) => chatId === exact.id)!
    assert.equal(exactItem.reason, 'session_left')
    if (exactItem.reason === 'session_left') assert.equal(exactItem.recovery.state, 'grace_elapsed')
    assert.equal(exactStore.restore(exact.id).status, 'recovery_expired')
    assert.equal(exactStore.update(exact.id, { mode: 'ttl', expiresAfterDays: 7 }).status, 'recovery_expired')

    const afterStore = new ChatRetentionStore(db, { clock: () => new Date(deadline + 1) })
    const afterItem = afterStore.listTrash({ scope: 'projectless' }, 20).chats
      .find(({ chatId }) => chatId === after.id)!
    assert.equal(afterItem.reason, 'session_left')
    if (afterItem.reason === 'session_left') assert.equal(afterItem.recovery.state, 'grace_elapsed')
    assert.equal(afterStore.restore(after.id).status, 'recovery_expired')
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE event_type = 'restored'",
    ).get() as { count: number }).count, 3)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count, 5)
    await owner.close()
    db.close()
  })

  it('preserves Messages, Jobs, legacy thinking, reasoning, compaction and neighboring tables exactly', async () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const target = createChat(threads, 'Preserved Session')
    const neighbor = createChat(threads, 'Neighbor')
    const jobId = createChatJob(db, target.id, 'preserve', 'completed')
    const association = db.prepare(
      "SELECT id FROM messages WHERE job_id = ? AND role = 'assistant'",
    ).get(jobId) as { id: string }
    db.prepare(
      `UPDATE messages
       SET content = 'exact final', thinking = 'legacy thinking', is_compaction = 1
       WHERE id = ?`,
    ).run(association.id)
    const reasoning = 'exact diagnostic'
    db.prepare(
      `INSERT INTO reasoning_artifacts (
         id, artifact_version, chat_id, project_id, source_message_id, source_job_id,
         media_type, storage_kind, content_text, byte_size, checksum, created_at,
         artifact_expires_at, parent_retention_mode, parent_retention_expires_at,
         effective_expires_at
       ) VALUES (?, 1, ?, NULL, ?, ?, 'text/markdown; charset=utf-8', 'sqlite_text',
         ?, ?, ?, ?, ?, 'session', NULL, ?)`,
    ).run(
      'artifact-preserved',
      target.id,
      association.id,
      jobId,
      reasoning,
      Buffer.byteLength(reasoning),
      `sha256:${createHash('sha256').update(reasoning).digest('hex')}`,
      NOW,
      '2040-01-01T00:00:00.000Z',
      '2040-01-01T00:00:00.000Z',
    )
    const store = new ChatRetentionStore(db, { clock: () => new Date(NOW) })
    makeSession(store, target.id)
    assert.equal(store.update(neighbor.id, { mode: 'keep' }).status, 'ok')
    const before = JSON.stringify({
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      inputs: db.prepare('SELECT * FROM chat_job_inputs ORDER BY job_id').all(),
      reasoning: db.prepare('SELECT * FROM reasoning_artifacts ORDER BY id').all(),
      reasoningAudit: db.prepare('SELECT * FROM reasoning_artifact_deletion_audit ORDER BY id').all(),
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    })
    store.leaveSession(target.id, { scope: 'projectless' })
    const owner = new RetentionMaintenanceOwner(store, {
      clock: () => new Date(NOW),
      batchSize: 10,
      maxBatchesPerRun: 1,
    })
    assert.equal((await owner.runOnce()).tombstoned, 1)
    assert.equal(JSON.stringify({
      messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      inputs: db.prepare('SELECT * FROM chat_job_inputs ORDER BY job_id').all(),
      reasoning: db.prepare('SELECT * FROM reasoning_artifacts ORDER BY id').all(),
      reasoningAudit: db.prepare('SELECT * FROM reasoning_artifact_deletion_audit ORDER BY id').all(),
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all(),
    }), before)
    assert.equal(row(db, neighbor.id).chat_lifecycle_state, 'active')
    assert.equal(threads.get(target.id), null)
    assert.equal(threads.get(neighbor.id)?.id, neighbor.id)
    assert.equal((db.prepare('SELECT content FROM messages WHERE id = ?').get(
      association.id,
    ) as { content: string }).content, 'exact final')
    await owner.close()
    db.close()
  })

  it('serves strict leave/restore routes through one owner without runtime or provider effects', async (test) => {
    const context = await createAppContext({
      dbPath: ':memory:',
      appVersion: 'test',
      retentionMaintenance: { clock: () => new Date(NOW) },
    })
    test.after(async () => {
      await context.maintenance?.close()
      await context.chatExecution.shutdown()
      context.jobService.closeSubscriptions()
      context.db.close()
    })
    const project = new ProjectStore(context.db).create('Exact owner', NOW)
    const projectless = createChat(context.threads, 'Route projectless')
    const owned = createChat(context.threads, 'Route owned', project.id)
    const notSession = createChat(context.threads, 'Not Session')
    const store = new ChatRetentionStore(context.db, { clock: () => new Date(NOW) })
    makeSession(store, projectless.id)
    makeSession(store, owned.id)
    assert.equal(store.update(notSession.id, { mode: 'keep' }).status, 'ok')
    const reasoningJobId = createChatJob(context.db, owned.id, 'route-reasoning', 'completed')
    const reasoningMessageId = (context.db.prepare(
      "SELECT id FROM messages WHERE job_id = ? AND role = 'assistant'",
    ).get(reasoningJobId) as { id: string }).id
    const reasoningContent = 'route diagnostic remains until owner pass'
    context.db.prepare(
      `INSERT INTO reasoning_artifacts (
         id, artifact_version, chat_id, project_id, source_message_id, source_job_id,
         media_type, storage_kind, content_text, byte_size, checksum, created_at,
         artifact_expires_at, parent_retention_mode, parent_retention_expires_at,
         effective_expires_at
       ) VALUES (?, 1, ?, ?, ?, ?, 'text/markdown; charset=utf-8', 'sqlite_text',
                 ?, ?, ?, ?, ?, 'session', NULL, ?)`,
    ).run(
      '99999999-9999-4999-8999-999999999999',
      owned.id,
      project.id,
      reasoningMessageId,
      reasoningJobId,
      reasoningContent,
      Buffer.byteLength(reasoningContent, 'utf8'),
      `sha256:${createHash('sha256').update(reasoningContent).digest('hex')}`,
      new Date(Date.parse(NOW) - 8 * DAY_MS).toISOString(),
      NOW,
      NOW,
    )
    let ollamaCalls = 0
    let modelCalls = 0
    let workspaceCalls = 0
    let maintenanceCalls = 0
    context.ollama = () => {
      ollamaCalls += 1
      throw new Error('Session lifecycle must not call Ollama')
    }
    context.models = () => {
      modelCalls += 1
      throw new Error('Session lifecycle must not call model services')
    }
    const workspaceGet = context.workspaces.get.bind(context.workspaces)
    context.workspaces.get = (id) => {
      workspaceCalls += 1
      return workspaceGet(id)
    }
    const runMaintenance = context.maintenance!.runOnce.bind(context.maintenance)
    context.maintenance!.runOnce = () => {
      maintenanceCalls += 1
      return runMaintenance()
    }
    const governorBefore = JSON.stringify(context.governor.snapshot(NOW))
    const app = createApp(context)
    const legacyNeighborBefore = await (await app.request(`/api/threads/${notSession.id}`)).text()
    const request = (id: string, body: unknown) => app.request(`/api/threads/${id}/session-leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal((await request(projectless.id, {})).status, 400)
    assert.equal((await request(projectless.id, {
      leaveVersion: 2,
      chatId: projectless.id,
      scope: 'projectless',
    })).status, 400)
    assert.equal((await request(projectless.id, {
      leaveVersion: 1,
      chatId: 'other',
      scope: 'projectless',
    })).status, 400)
    assert.equal((await request(projectless.id, {
      leaveVersion: 1,
      chatId: projectless.id,
      scope: 'project',
      projectId: project.id,
    })).status, 400)
    assert.equal((await request(owned.id, {
      leaveVersion: 1,
      chatId: owned.id,
      scope: 'project',
      projectId: ` ${project.id}`,
    })).status, 400)
    assert.equal((await request(notSession.id, {
      leaveVersion: 1,
      chatId: notSession.id,
      scope: 'projectless',
    })).status, 409)
    const response = await request(owned.id, {
      leaveVersion: 1,
      chatId: owned.id,
      scope: 'project',
      projectId: project.id,
    })
    assert.equal(response.status, 200)
    const lifecycle = leaveSessionChatResponse.parse(await response.json())
    assert.equal(lifecycle.state, 'pending_maintenance')
    assert.equal(lifecycle.recoveryDeadline, null)
    assert.equal(row(context.db, owned.id).chat_lifecycle_state, 'active')
    assert.equal(maintenanceCalls, 0)
    assert.equal((context.db.prepare(
      'SELECT COUNT(*) AS count FROM reasoning_artifacts WHERE chat_id = ?',
    ).get(owned.id) as { count: number }).count, 1)
    assert.equal((context.db.prepare(
      'SELECT COUNT(*) AS count FROM reasoning_artifact_deletion_audit WHERE chat_id = ?',
    ).get(owned.id) as { count: number }).count, 0)
    const maintenance = await context.maintenance!.runOnce()
    assert.equal(maintenanceCalls, 1)
    assert.equal(maintenance.tombstoned, 1)
    assert.equal(maintenance.reasoningDeleted, 1)
    const repeated = leaveSessionChatResponse.parse(await (await request(owned.id, {
      leaveVersion: 1,
      chatId: owned.id,
      scope: 'project',
      projectId: project.id,
    })).json())
    assert.equal(repeated.state, 'trash')
    assert.equal(repeated.leaveBasis.at, lifecycle.leaveBasis.at)
    assert.equal(repeated.recoveryDeadline, new Date(Date.parse(NOW) + DAY_MS).toISOString())
    assert.equal((context.db.prepare(
      "SELECT COUNT(*) AS count FROM chat_lifecycle_audit WHERE chat_id = ? AND reason = 'session_left'",
    ).get(owned.id) as { count: number }).count, 1)
    const projectTrash = await (await app.request(
      `/api/threads/trash?lifecycleVersion=1&deletionVersion=1&scope=project&projectId=${project.id}&limit=20`,
    )).json() as { chats: Array<{ chatId: string; projectId: string | null }> }
    const projectlessTrash = await (await app.request(
      '/api/threads/trash?lifecycleVersion=1&deletionVersion=1&scope=projectless&limit=20',
    )).json() as { chats: Array<{ chatId: string; projectId: string | null }> }
    assert.deepEqual(projectTrash.chats.map(({ chatId, projectId }) => ({ chatId, projectId })), [
      { chatId: owned.id, projectId: project.id },
    ])
    assert.equal(projectlessTrash.chats.some(({ chatId }) => chatId === owned.id), false)
    assert.equal(context.threads.listByProject(project.id).some(({ id }) => id === owned.id), false)
    assert.equal(context.threads.listProjectless().some(({ id }) => id === projectless.id), true)
    assert.equal(await (await app.request(`/api/threads/${notSession.id}`)).text(), legacyNeighborBefore)
    assert.deepEqual(
      { ollamaCalls, modelCalls, workspaceCalls },
      { ollamaCalls: 0, modelCalls: 0, workspaceCalls: 0 },
    )
    assert.equal(JSON.stringify(context.governor.snapshot(NOW)), governorBefore)
  })
})
