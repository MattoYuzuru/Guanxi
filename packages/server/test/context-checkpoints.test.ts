import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import { contextCheckpointSchema } from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import { ContextCheckpointStoreError, ThreadStore } from '../src/store/threads.ts'
import { downgradeContextCheckpointsToV23 } from './fixtures/context-checkpoint-migration.ts'

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count
}

function tablesPayload(db: DatabaseSync, excluded: ReadonlySet<string>): string {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>)
    .map(({ name }) => name)
    .filter((name) => !excluded.has(name))
  return JSON.stringify(Object.fromEntries(tables.map((name) => [
    name,
    db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
  ])))
}

function createThread(threads: ThreadStore) {
  return threads.create({
    title: 'Checkpoint fixture',
    mode: 'chat',
    model: 'qwen',
    workspaceId: null,
    options: { numCtx: 4_096, temperature: 0, think: 'off' },
  })
}

function seed(threads: ThreadStore, threadId: string, start: number, end: number): void {
  for (let index = start; index <= end; index += 1) {
    threads.addMessage({
      threadId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `source-${index}`,
      thinking: index === 3 ? 'private diagnostic' : null,
      usage: index === 3
        ? {
            promptTokens: 30,
            evalTokens: 4,
            promptEvalDurationMs: 100,
            evalDurationMs: 20,
            loadDurationMs: 0,
            totalDurationMs: 120,
            tokensPerSecond: 200,
            cacheHit: false,
            cachedTokens: 0,
          }
        : null,
      turnStatus: index % 2 === 0 ? null : 'completed',
    })
  }
}

type WorkerResult =
  | { ok: true; result: { id: string } }
  | { ok: false; error: string; code: string | null }

async function concurrentCheckpoints(
  dbPath: string,
  input: Parameters<ThreadStore['createContextCheckpoint']>[0],
): Promise<WorkerResult[]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  return Promise.all([0, 1].map(() => new Promise<WorkerResult>((resolve, reject) => {
    const worker = new Worker(new URL('./fixtures/context-checkpoint-worker.ts', import.meta.url), {
      workerData: { dbPath, gate, participants: 2, input },
    })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Context checkpoint worker exited with code ${code}`))
    })
  })))
}

describe('P3-M non-destructive context checkpoints', () => {
  it('keeps the public contract strict and state-dependent', () => {
    const valid = {
      contextCheckpointVersion: 1,
      id: 'checkpoint',
      threadId: 'thread',
      previousCheckpointId: null,
      source: { state: 'source_preserved', upToSeq: 4, messageCount: 5 },
      summary: {
        format: 'text_utf8_v1',
        content: 'summary',
        byteSize: 7,
        sha256: 'a'.repeat(64),
      },
      createdAt: '2026-08-14T10:00:00.000Z',
    }
    assert.equal(contextCheckpointSchema.safeParse(valid).success, true)
    assert.equal(contextCheckpointSchema.safeParse({ ...valid, future: true }).success, false)
    assert.equal(contextCheckpointSchema.safeParse({
      ...valid,
      source: { state: 'source_preserved', upToSeq: 4, messageCount: null },
    }).success, false)
    assert.equal(contextCheckpointSchema.safeParse({
      ...valid,
      source: { state: 'legacy_source_unavailable', upToSeq: 4, messageCount: 5 },
    }).success, false)
  })

  it('applies migrations 24-25 on fresh/v23/reopen/retry and rolls back exact v23 bytes', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-context-v25-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const seeded = openDb(path)
    assert.equal(version(seeded), 25)
    const threads = new ThreadStore(seeded)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 2)
    downgradeContextCheckpointsToV23(seeded)
    const exactV23 = tablesPayload(seeded, new Set())
    seeded.exec('CREATE TABLE context_checkpoints (blocker TEXT NOT NULL)')
    seeded.prepare('INSERT INTO context_checkpoints VALUES (?)').run('preserve me')
    seeded.close()

    assert.throws(() => openDb(path), /Миграция 24 не применилась/u)
    const rolledBack = new DatabaseSync(path)
    assert.equal(version(rolledBack), 23)
    assert.equal(count(rolledBack, 'context_checkpoints'), 1)
    assert.equal(
      tablesPayload(rolledBack, new Set(['context_checkpoints'])),
      exactV23,
    )
    rolledBack.exec('DROP TABLE context_checkpoints')
    rolledBack.close()

    const retried = openDb(path)
    assert.equal(version(retried), 25)
    assert.equal(count(retried, 'context_checkpoints'), 0)
    assert.equal(tablesPayload(retried, new Set(['context_checkpoints'])), exactV23)
    retried.close()
    const reopened = openDb(path)
    assert.equal(version(reopened), 25)
    assert.equal(tablesPayload(reopened, new Set(['context_checkpoints'])), exactV23)
    reopened.close()
  })

  it('preserves every Message byte and composes repeat checkpoints from summary plus new tail', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 8)
    const before = JSON.stringify(db.prepare(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY seq',
    ).all(thread.id))

    const firstSelection = threads.compactionCandidates(thread.id, 4)!
    assert.equal(firstSelection.upToSeq, 4)
    const first = threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: firstSelection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'summary-1',
    })
    assert.equal(
      JSON.stringify(db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(thread.id)),
      before,
    )
    assert.equal(first.source.messageCount, 5)
    assert.equal(first.summary.byteSize, Buffer.byteLength('summary-1'))
    assert.equal(first.summary.sha256, '87feb6a997ac21b2ea41714775583b5605166b0ace5f59b1e97edb8000a40553')
    assert.deepEqual(
      threads.activeContextMessages(thread.id).map((message) => message.content),
      ['summary-1', 'source-5', 'source-6', 'source-7', 'source-8'],
    )

    seed(threads, thread.id, 9, 14)
    const secondSelection = threads.compactionCandidates(thread.id, 4)!
    assert.equal(secondSelection.upToSeq, 10)
    assert.deepEqual(
      secondSelection.messages.map((message) => message.content),
      ['summary-1', 'source-5', 'source-6', 'source-7', 'source-8', 'source-9', 'source-10'],
    )
    const second = threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: secondSelection.upToSeq,
      expectedPreviousCheckpointId: first.id,
      summary: 'summary-2',
    })
    assert.equal(second.previousCheckpointId, first.id)
    assert.equal(threads.messages(thread.id).length, 15)
    assert.deepEqual(
      threads.activeContextMessages(thread.id).map((message) => message.content),
      ['summary-2', 'source-11', 'source-12', 'source-13', 'source-14'],
    )
    assert.equal(threads.contextCheckpoints(thread.id).length, 2)
    assert.throws(
      () => threads.createContextCheckpoint({
        threadId: thread.id,
        upToSeq: 14,
        expectedPreviousCheckpointId: first.id,
        summary: 'stale',
      }),
      (error) => error instanceof ContextCheckpointStoreError && error.code === 'stale_checkpoint',
    )
    assert.throws(
      () => db.prepare('UPDATE context_checkpoints SET summary_text = ? WHERE id = ?').run('rewrite', second.id),
      /immutable/u,
    )
    assert.throws(
      () => db.prepare('DELETE FROM context_checkpoints WHERE id = ?').run(second.id),
      /immutable/u,
    )
    assert.throws(
      () => db.prepare('DELETE FROM messages WHERE thread_id = ? AND seq = ?').run(thread.id, 10),
      /Checkpointed Messages are immutable/u,
    )
    assert.throws(
      () => db.prepare('UPDATE messages SET content = ? WHERE thread_id = ? AND seq = 0')
        .run('rewrite source', thread.id),
      /Checkpointed Messages are immutable/u,
    )
    assert.throws(
      () => db.prepare('DELETE FROM messages WHERE thread_id = ? AND seq = 0').run(thread.id),
      /Checkpointed Messages are immutable/u,
    )
    db.close()
  })

  it('rejects forged source evidence, rolls back injected writes and fails closed on corruption', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 5)
    assert.throws(() => db.prepare(
      `INSERT INTO context_checkpoints (
         id, checkpoint_version, thread_id, previous_checkpoint_id, up_to_seq,
         source_state, source_message_count, summary_text, summary_byte_size,
         summary_sha256, created_at
       ) VALUES ('forged', 1, ?, NULL, 1, 'source_preserved', 99, 'x', 1, ?, ?)`,
    ).run(thread.id, 'a'.repeat(64), '2026-08-14T10:00:00.000Z'), /source mismatch/u)

    db.exec(`
      CREATE TRIGGER fail_context_checkpoint
      BEFORE INSERT ON context_checkpoints
      BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END;
    `)
    const selection = threads.compactionCandidates(thread.id, 4)!
    assert.throws(() => threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: selection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'rollback',
    }), /injected checkpoint failure/u)
    assert.equal(count(db, 'context_checkpoints'), 0)
    assert.equal(threads.messages(thread.id).length, 6)
    db.exec('DROP TRIGGER fail_context_checkpoint')
    const checkpoint = threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: selection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'integrity',
    })
    seed(threads, thread.id, 6, 11)
    const secondSelection = threads.compactionCandidates(thread.id, 4)!
    const second = threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: secondSelection.upToSeq,
      expectedPreviousCheckpointId: checkpoint.id,
      summary: 'integrity-2',
    })
    db.exec('DROP TRIGGER context_checkpoints_immutable_update')
    db.prepare('UPDATE context_checkpoints SET previous_checkpoint_id = NULL WHERE id = ?')
      .run(second.id)
    assert.throws(
      () => threads.activeContextMessages(thread.id),
      (error) => error instanceof ContextCheckpointStoreError && error.code === 'stored_data_invalid',
    )
    db.prepare('UPDATE context_checkpoints SET previous_checkpoint_id = ? WHERE id = ?')
      .run(checkpoint.id, second.id)
    db.prepare('UPDATE context_checkpoints SET source_message_count = source_message_count + 1 WHERE id = ?')
      .run(second.id)
    assert.throws(
      () => threads.compactionCandidates(thread.id, 4),
      (error) => error instanceof ContextCheckpointStoreError && error.code === 'stored_data_invalid',
    )
    db.prepare('UPDATE context_checkpoints SET source_message_count = source_message_count - 1 WHERE id = ?')
      .run(second.id)
    db.prepare('UPDATE context_checkpoints SET up_to_seq = up_to_seq - 1 WHERE id = ?')
      .run(second.id)
    assert.throws(
      () => threads.contextCheckpoints(thread.id),
      (error) => error instanceof ContextCheckpointStoreError && error.code === 'stored_data_invalid',
    )
    db.prepare('UPDATE context_checkpoints SET up_to_seq = up_to_seq + 1 WHERE id = ?')
      .run(second.id)
    db.prepare('UPDATE context_checkpoints SET summary_sha256 = ? WHERE id = ?')
      .run('b'.repeat(64), second.id)
    assert.throws(
      () => threads.contextCheckpoints(thread.id),
      (error) => error instanceof ContextCheckpointStoreError && error.code === 'stored_data_invalid',
    )
    db.close()
  })

  it('deduplicates one explicit checkpoint intent without creating another row', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 5)
    const selection = threads.compactionCandidates(thread.id, 4)!
    const input = {
      checkpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      threadId: thread.id,
      upToSeq: selection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'stable intent',
    }
    const first = threads.createContextCheckpoint(input)
    const repeated = threads.createContextCheckpoint(input)
    assert.equal(repeated.id, first.id)
    assert.equal(count(db, 'context_checkpoints'), 1)
    db.close()
  })

  it('serializes two connections so exactly one first checkpoint wins', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-context-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 5)
    const selection = threads.compactionCandidates(thread.id, 4)!
    db.close()

    const results = await concurrentCheckpoints(path, {
      threadId: thread.id,
      upToSeq: selection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'one winner',
    })
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.deepEqual(
      results.filter((result) => !result.ok).map((result) => result.code),
      ['stale_checkpoint'],
    )
    const reopened = openDb(path)
    assert.equal(count(reopened, 'context_checkpoints'), 1)
    assert.equal(new ThreadStore(reopened).messages(thread.id).length, 6)
    reopened.close()
  })

  it('projects legacy destructive summaries explicitly without claiming preserved source', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    const legacy = threads.addMessage({
      threadId: thread.id,
      role: 'system',
      content: 'legacy summary',
      isCompaction: true,
    })
    seed(threads, thread.id, 1, 4)
    const projected = threads.contextCheckpoints(thread.id)
    assert.equal(projected.length, 1)
    assert.equal(projected[0]!.id, legacy.id)
    assert.deepEqual(projected[0]!.source, {
      state: 'legacy_source_unavailable',
      upToSeq: 0,
      messageCount: null,
    })
    assert.equal(threads.activeContextMessages(thread.id)[0]!.id, legacy.id)
    db.close()
  })

  it('allows explicit Thread lifecycle deletion to cascade a checkpoint chain', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    seed(threads, thread.id, 0, 14)
    const firstSelection = threads.compactionCandidates(thread.id, 4)!
    const first = threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: firstSelection.upToSeq,
      expectedPreviousCheckpointId: null,
      summary: 'first',
    })
    seed(threads, thread.id, 15, 20)
    const secondSelection = threads.compactionCandidates(thread.id, 4)!
    threads.createContextCheckpoint({
      threadId: thread.id,
      upToSeq: secondSelection.upToSeq,
      expectedPreviousCheckpointId: first.id,
      summary: 'second',
    })
    assert.equal(threads.delete(thread.id), true)
    assert.equal(count(db, 'messages'), 0)
    assert.equal(count(db, 'context_checkpoints'), 0)
    db.close()
  })

  it('never checkpoints a pending assistant projection that can still terminalize', () => {
    const db = openDb(':memory:')
    const threads = new ThreadStore(db)
    const thread = createThread(threads)
    threads.addMessage({ threadId: thread.id, role: 'assistant', content: 'pending' })
    seed(threads, thread.id, 1, 6)
    assert.equal(threads.compactionCandidates(thread.id, 4), null)
    assert.equal(count(db, 'context_checkpoints'), 0)
    db.close()
  })
})
