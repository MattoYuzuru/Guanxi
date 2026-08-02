import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import type { Job, JobState } from '@alamo/contract'
import { openDb } from '../src/store/db.ts'
import {
  JobStore,
  JobStoreError,
  type AppendJobEventInput,
  type CreateJobInput,
  type TerminalizeJobInput,
  type TransitionJobInput,
} from '../src/store/jobs.ts'

type WorkerTask =
  | { operation: 'create'; input: CreateJobInput }
  | { operation: 'append'; input: AppendJobEventInput }
  | { operation: 'transition'; input: TransitionJobInput }
  | { operation: 'terminalize'; input: TerminalizeJobInput }

interface WorkerSuccess<T> {
  ok: true
  result: T
}

interface WorkerFailure {
  ok: false
  error: string
  code: string | null
}

type WorkerResult<T> = WorkerSuccess<T> | WorkerFailure

async function runConcurrent<T>(dbPath: string, tasks: WorkerTask[]): Promise<WorkerResult<T>[]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  return Promise.all(
    tasks.map(
      (task) =>
        new Promise<WorkerResult<T>>((resolve, reject) => {
          const worker = new Worker(new URL('./fixtures/job-store-worker.ts', import.meta.url), {
            workerData: { dbPath, gate, participants: tasks.length, task },
          })
          worker.once('message', (message: WorkerResult<T>) => resolve(message))
          worker.once('error', reject)
          worker.once('exit', (code) => {
            if (code !== 0) reject(new Error(`Job store worker exited with code ${code}`))
          })
        }),
    ),
  )
}

function assertStoreError(code: JobStoreError['code']): (error: unknown) => boolean {
  return (error) => error instanceof JobStoreError && error.code === code
}

const PATHS_TO_STATE: Partial<Record<JobState, JobState[]>> = {
  queued: [],
  reserving: ['reserving'],
  loading: ['reserving', 'loading'],
  prefill: ['reserving', 'loading', 'prefill'],
  thinking: ['reserving', 'loading', 'prefill', 'thinking'],
  generating: ['reserving', 'loading', 'prefill', 'generating'],
  waiting_tool: ['reserving', 'loading', 'prefill', 'generating', 'waiting_tool'],
  waiting_approval: [
    'reserving',
    'loading',
    'prefill',
    'generating',
    'waiting_tool',
    'waiting_approval',
  ],
  finalizing: ['reserving', 'loading', 'prefill', 'generating', 'finalizing'],
  cancelling: ['cancelling'],
}

function advanceTo(jobs: JobStore, job: Job, target: JobState): Job {
  let current = job
  for (const status of PATHS_TO_STATE[target] ?? []) {
    const result = jobs.transition({
      jobId: job.id,
      expectedStatus: current.status,
      status,
    })
    assert.equal(result.applied, true)
    current = result.job
  }
  assert.equal(current.status, target)
  return current
}

describe('durable Job store', () => {
  it('creates one Job and initial event per scoped idempotency key', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const input: CreateJobInput = {
      kind: 'inference',
      operation: 'chat',
      idempotencyScope: 'chat:thread-1',
      idempotencyKey: 'submit-1',
    }

    const first = jobs.create(input)
    const duplicate = jobs.create(input)
    const differentKey = jobs.create({ ...input, idempotencyKey: 'submit-2' })
    const differentScope = jobs.create({ ...input, idempotencyScope: 'chat:thread-2' })

    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.job.id, first.job.id)
    assert.equal(first.job.status, 'queued')
    assert.equal(first.job.lastEventSequence, 1)
    assert.deepEqual(jobs.eventsAfter(first.job.id, 0), [
      {
        id: jobs.eventsAfter(first.job.id, 0)[0]!.id,
        jobId: first.job.id,
        sequence: 1,
        type: 'lifecycle',
        state: 'queued',
        phase: null,
        metadata: {},
        output: null,
        createdAt: first.job.createdAt,
      },
    ])
    assert.notEqual(differentKey.job.id, first.job.id)
    assert.notEqual(differentScope.job.id, first.job.id)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 3)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM job_events').get() as { count: number }).count,
      3,
    )
    db.close()
  })

  it('rolls back create when the initial event insert fails', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    db.exec(`
      CREATE TRIGGER fail_initial_job_event
      BEFORE INSERT ON job_events
      WHEN NEW.sequence = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected initial event failure');
      END;
    `)

    assert.throws(
      () =>
        jobs.create({
          kind: 'tool',
          operation: 'fixture',
          idempotencyScope: 'test',
          idempotencyKey: 'atomic-create',
        }),
      /injected initial event failure/,
    )
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 0)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM job_events').get() as { count: number }).count,
      0,
    )
    db.close()
  })

  it('owns monotonic event sequence and returns strictly ordered replay pages', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'agent',
      operation: 'fixture',
      idempotencyScope: 'project:1',
      idempotencyKey: 'events',
    }).job

    jobs.appendEvent({
      jobId: created.id,
      expectedNextSequence: 2,
      type: 'output',
      metadata: { artifactId: 'artifact-1' },
    })
    jobs.appendEvent({
      jobId: created.id,
      expectedNextSequence: 3,
      type: 'usage',
      metadata: { tokenCount: 12 },
    })
    jobs.appendEvent({
      jobId: created.id,
      expectedNextSequence: 4,
      type: 'checkpoint',
      metadata: { checkpointId: 'checkpoint-1' },
    })

    assert.deepEqual(
      jobs.eventsAfter(created.id, 1, 2).map((event) => event.sequence),
      [2, 3],
    )
    assert.deepEqual(
      jobs.eventsAfter(created.id, 2).map((event) => event.sequence),
      [3, 4],
    )
    assert.throws(
      () =>
        jobs.appendEvent({
          jobId: created.id,
          expectedNextSequence: 4,
          type: 'warning',
        }),
      assertStoreError('sequence_conflict'),
    )
    assert.equal(jobs.get(created.id)?.lastEventSequence, 4)
    db.close()
  })

  it('commits every canonical non-terminal state edge with one lifecycle event', () => {
    const edges: Array<readonly [JobState, JobState]> = [
      ['queued', 'reserving'],
      ['queued', 'cancelling'],
      ['reserving', 'loading'],
      ['reserving', 'cancelling'],
      ['loading', 'prefill'],
      ['loading', 'cancelling'],
      ['prefill', 'thinking'],
      ['prefill', 'generating'],
      ['prefill', 'cancelling'],
      ['thinking', 'generating'],
      ['thinking', 'cancelling'],
      ['generating', 'waiting_tool'],
      ['generating', 'finalizing'],
      ['generating', 'cancelling'],
      ['waiting_tool', 'waiting_approval'],
      ['waiting_tool', 'prefill'],
      ['waiting_tool', 'cancelling'],
      ['waiting_approval', 'waiting_tool'],
      ['waiting_approval', 'cancelling'],
    ]
    const db = openDb(':memory:')
    const jobs = new JobStore(db)

    edges.forEach(([from, status], index) => {
      const created = jobs.create({
        kind: 'inference',
        operation: 'canonical-transition',
        idempotencyScope: 'transition-matrix',
        idempotencyKey: String(index),
      }).job
      const source = advanceTo(jobs, created, from)
      const result = jobs.transition({
        jobId: created.id,
        expectedStatus: from,
        status,
        phase: `phase-${index}`,
        metadata: { edge: `${from}->${status}` },
      })

      assert.equal(result.applied, true)
      assert.equal(result.job.status, status)
      assert.equal(result.job.phase, `phase-${index}`)
      assert.equal(result.job.lastEventSequence, source.lastEventSequence + 1)
      assert.deepEqual(jobs.eventsAfter(created.id, source.lastEventSequence), [
        {
          id: jobs.eventsAfter(created.id, source.lastEventSequence)[0]!.id,
          jobId: created.id,
          sequence: source.lastEventSequence + 1,
          type: 'lifecycle',
          state: status,
          phase: `phase-${index}`,
          metadata: { edge: `${from}->${status}` },
          output: null,
          createdAt: jobs.eventsAfter(created.id, source.lastEventSequence)[0]!.createdAt,
        },
      ])
    })

    db.close()
  })

  it('rejects invalid edges and stale state without changing state, sequence or events', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'inference',
      operation: 'invalid-transition',
      idempotencyScope: 'transition',
      idempotencyKey: 'invalid-and-stale',
    }).job

    for (const [from, status] of [
      ['queued', 'loading'],
      ['reserving', 'queued'],
      ['generating', 'prefill'],
    ] as Array<readonly [JobState, JobState]>) {
      assert.throws(
        () => jobs.transition({ jobId: created.id, expectedStatus: from, status }),
        assertStoreError('invalid_transition'),
      )
    }
    assert.deepEqual(jobs.get(created.id), created)
    assert.deepEqual(jobs.eventsAfter(created.id, 0).map((event) => event.sequence), [1])

    const reserving = jobs.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    }).job
    const stale = jobs.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'cancelling',
    })
    assert.equal(stale.applied, false)
    assert.deepEqual(stale.job, reserving)
    assert.deepEqual(jobs.eventsAfter(created.id, 0).map((event) => event.sequence), [1, 2])
    db.close()
  })

  it('sets startedAt once on the first successful exit from queued', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'inference',
      operation: 'started-at',
      idempotencyScope: 'transition',
      idempotencyKey: 'started-at',
    }).job

    const reserving = jobs.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    }).job
    assert.notEqual(reserving.startedAt, null)
    const loading = jobs.transition({
      jobId: created.id,
      expectedStatus: 'reserving',
      status: 'loading',
    }).job
    assert.equal(loading.startedAt, reserving.startedAt)
    db.close()
  })

  it('rolls back transition state, startedAt and sequence when its event insert fails', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'inference',
      operation: 'atomic-transition',
      idempotencyScope: 'transition',
      idempotencyKey: 'event-failure',
    }).job
    db.exec(`
      CREATE TRIGGER fail_transition_job_event
      BEFORE INSERT ON job_events
      WHEN NEW.state = 'reserving'
      BEGIN
        SELECT RAISE(ABORT, 'injected transition event failure');
      END;
    `)

    assert.throws(
      () =>
        jobs.transition({
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'reserving',
        }),
      /injected transition event failure/,
    )
    assert.deepEqual(jobs.get(created.id), created)
    assert.equal(jobs.get(created.id)?.startedAt, null)
    assert.deepEqual(jobs.eventsAfter(created.id, 0).map((event) => event.sequence), [1])
    db.close()
  })

  it('rejects non-terminal transitions after the Job is terminal', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'inference',
      operation: 'terminal-transition',
      idempotencyScope: 'transition',
      idempotencyKey: 'terminal',
    }).job
    jobs.terminalize({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'failed',
      error: {
        category: 'internal',
        code: 'fixture_failure',
        message: 'safe fixture failure',
        retryable: false,
      },
    })

    assert.throws(
      () =>
        jobs.transition({
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'reserving',
        }),
      assertStoreError('job_terminal'),
    )
    assert.equal(jobs.eventsAfter(created.id, 0).length, 2)
    db.close()
  })

  it('terminalizes state and one terminal event atomically and rejects later events', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'pipeline',
      operation: 'fixture',
      idempotencyScope: 'pipeline:1',
      idempotencyKey: 'terminal',
    }).job
    jobs.appendEvent({
      jobId: created.id,
      expectedNextSequence: 2,
      type: 'resource',
      metadata: { queuePosition: 1 },
    })

    const terminal = jobs.terminalize({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'completed',
      outcome: { code: 'ok', metadata: { artifactCount: 1 } },
      stopReason: 'completed',
    })
    const late = jobs.terminalize({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'failed',
      error: {
        category: 'internal',
        code: 'late_failure',
        message: 'safe late failure',
        retryable: false,
      },
    })

    assert.equal(terminal.applied, true)
    assert.equal(terminal.job.status, 'completed')
    assert.equal(terminal.job.lastEventSequence, 3)
    assert.equal(late.applied, false)
    assert.equal(late.job.status, 'completed')
    assert.deepEqual(
      jobs.eventsAfter(created.id, 0).map((event) => [event.sequence, event.state]),
      [
        [1, 'queued'],
        [2, 'queued'],
        [3, 'completed'],
      ],
    )
    assert.throws(
      () =>
        jobs.appendEvent({
          jobId: created.id,
          expectedNextSequence: 4,
          type: 'warning',
        }),
      assertStoreError('job_terminal'),
    )
    db.close()
  })

  it('rolls back terminal state when the terminal event insert fails', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'inference',
      operation: 'fixture',
      idempotencyScope: 'test',
      idempotencyKey: 'atomic-terminal',
    }).job
    db.exec(`
      CREATE TRIGGER fail_terminal_job_event
      BEFORE INSERT ON job_events
      WHEN NEW.state IN ('completed','failed','cancelled','interrupted')
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal event failure');
      END;
    `)

    assert.throws(
      () =>
        jobs.terminalize({
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'failed',
          error: {
            category: 'storage',
            code: 'fixture_storage_failure',
            message: 'safe fixture failure',
            retryable: true,
          },
        }),
      /injected terminal event failure/,
    )
    assert.deepEqual(jobs.get(created.id), created)
    assert.deepEqual(
      jobs.eventsAfter(created.id, 0).map((event) => event.sequence),
      [1],
    )
    db.close()
  })

  it('turns malformed stored records and event metadata into controlled failures', () => {
    const db = openDb(':memory:')
    const jobs = new JobStore(db)
    const created = jobs.create({
      kind: 'tool',
      operation: 'fixture',
      idempotencyScope: 'test',
      idempotencyKey: 'malformed',
    }).job

    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.id)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    assert.throws(() => jobs.get(created.id), assertStoreError('stored_data_invalid'))

    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(created.id)
    db.prepare("UPDATE job_events SET metadata = '{' WHERE job_id = ?").run(created.id)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    assert.throws(
      () => jobs.eventsAfter(created.id, 0),
      assertStoreError('stored_data_invalid'),
    )
    db.close()
  })

  it('deduplicates concurrent create calls across SQLite connections', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-create-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    openDb(path).close()
    const input: CreateJobInput = {
      kind: 'inference',
      operation: 'chat',
      idempotencyScope: 'chat:race',
      idempotencyKey: 'same-submit',
    }

    const results = await runConcurrent<{ created: boolean; job: Job }>(path, [
      { operation: 'create', input },
      { operation: 'create', input },
    ])
    assert.equal(results.every((result) => result.ok), true)
    const successes = results.filter((result): result is WorkerSuccess<{ created: boolean; job: Job }> => result.ok)
    assert.deepEqual(
      successes.map((result) => result.result.created).sort(),
      [false, true],
    )
    assert.equal(new Set(successes.map((result) => result.result.job.id)).size, 1)

    const db = openDb(path)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 1)
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM job_events').get() as { count: number }).count,
      1,
    )
    db.close()
  })

  it('serializes concurrent event append and preserves one next sequence owner', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-event-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const created = new JobStore(db).create({
      kind: 'agent',
      operation: 'fixture',
      idempotencyScope: 'project:race',
      idempotencyKey: 'event-submit',
    }).job
    db.close()

    const results = await runConcurrent(path, [
      {
        operation: 'append',
        input: {
          jobId: created.id,
          expectedNextSequence: 2,
          type: 'checkpoint',
          metadata: { checkpointId: 'checkpoint-a' },
        },
      },
      {
        operation: 'append',
        input: {
          jobId: created.id,
          expectedNextSequence: 2,
          type: 'checkpoint',
          metadata: { checkpointId: 'checkpoint-b' },
        },
      },
    ])
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.deepEqual(
      results.filter((result): result is WorkerFailure => !result.ok).map((result) => result.code),
      ['sequence_conflict'],
    )

    const verified = openDb(path)
    const jobs = new JobStore(verified)
    assert.equal(jobs.get(created.id)?.lastEventSequence, 2)
    assert.deepEqual(
      jobs.eventsAfter(created.id, 0).map((event) => event.sequence),
      [1, 2],
    )
    verified.close()
  })

  it('allows exactly one concurrent terminal compare-and-set outcome', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-terminal-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const created = new JobStore(db).create({
      kind: 'inference',
      operation: 'chat',
      idempotencyScope: 'chat:race',
      idempotencyKey: 'terminal-submit',
    }).job
    db.close()

    const results = await runConcurrent<{ applied: boolean; job: Job }>(path, [
      {
        operation: 'terminalize',
        input: {
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'completed',
          outcome: { code: 'ok', metadata: { artifactCount: 1 } },
        },
      },
      {
        operation: 'terminalize',
        input: {
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'failed',
          error: {
            category: 'runtime_protocol',
            code: 'provider_eof',
            message: 'safe provider failure',
            retryable: true,
          },
        },
      },
    ])
    assert.equal(results.every((result) => result.ok), true)
    const successes = results.filter((result): result is WorkerSuccess<{ applied: boolean; job: Job }> => result.ok)
    assert.deepEqual(
      successes.map((result) => result.result.applied).sort(),
      [false, true],
    )
    assert.equal(new Set(successes.map((result) => result.result.job.status)).size, 1)

    const verified = openDb(path)
    const row = verified
      .prepare('SELECT status, last_event_sequence FROM jobs WHERE id = ?')
      .get(created.id) as { status: string; last_event_sequence: number }
    assert.equal(row.last_event_sequence, 2)
    assert.equal(
      (
        verified
          .prepare(
            `SELECT COUNT(*) AS count FROM job_events
             WHERE job_id = ? AND state IN ('completed','failed','cancelled','interrupted')`,
          )
          .get(created.id) as { count: number }
      ).count,
      1,
    )
    verified.close()
  })

  it('allows exactly one concurrent non-terminal compare-and-set transition', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-transition-race-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const db = openDb(path)
    const created = new JobStore(db).create({
      kind: 'inference',
      operation: 'chat',
      idempotencyScope: 'chat:race',
      idempotencyKey: 'transition-submit',
    }).job
    db.close()

    const results = await runConcurrent<{ applied: boolean; job: Job }>(path, [
      {
        operation: 'transition',
        input: {
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'reserving',
        },
      },
      {
        operation: 'transition',
        input: {
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'cancelling',
        },
      },
    ])
    assert.equal(results.every((result) => result.ok), true)
    const successes = results.filter(
      (result): result is WorkerSuccess<{ applied: boolean; job: Job }> => result.ok,
    )
    assert.deepEqual(
      successes.map((result) => result.result.applied).sort(),
      [false, true],
    )
    assert.equal(new Set(successes.map((result) => result.result.job.status)).size, 1)

    const verified = openDb(path)
    const jobs = new JobStore(verified)
    assert.equal(jobs.get(created.id)?.lastEventSequence, 2)
    assert.deepEqual(jobs.eventsAfter(created.id, 0).map((event) => event.sequence), [1, 2])
    verified.close()
  })
})
