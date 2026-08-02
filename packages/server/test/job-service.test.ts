import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { Job, JobEvent, JobState, JobTerminalState } from '@alamo/contract'
import { JobService, JobServiceError } from '../src/jobs/service.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore, JobStoreError } from '../src/store/jobs.ts'

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

function createJob(service: JobService, key: string): Job {
  return service.create({
    kind: 'inference',
    operation: 'service-fixture',
    idempotencyScope: 'job-service',
    idempotencyKey: key,
  }).job
}

function advanceTo(service: JobService, job: Job, target: JobState): Job {
  let current = job
  for (const status of PATHS_TO_STATE[target] ?? []) {
    const result = service.transition({
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

function terminalInput(job: Job, status: JobTerminalState) {
  return {
    jobId: job.id,
    expectedStatus: job.status,
    status,
    error:
      status === 'failed'
        ? {
            category: 'runtime_protocol' as const,
            code: 'fixture_failure',
            message: 'safe fixture failure',
            retryable: true,
          }
        : undefined,
    outcome:
      status === 'completed'
        ? { code: 'ok', metadata: { artifactCount: 1 } }
        : undefined,
    stopReason: status === 'cancelled' ? 'stopped_by_user' : undefined,
  }
}

async function nextEvent(iterator: AsyncIterator<JobEvent>): Promise<JobEvent> {
  const result = await iterator.next()
  assert.equal(result.done, false)
  return result.value
}

function assertServiceError(code: JobServiceError['code']): (error: unknown) => boolean {
  return (error) => error instanceof JobServiceError && error.code === code
}

describe('JobService lifecycle', () => {
  it('owns create/get, transition and safe event append over one store', () => {
    const db = openDb(':memory:')
    const service = new JobService(new JobStore(db))
    const created = createJob(service, 'commands')
    const transitioned = service.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
      metadata: { reason: 'admission' },
    })
    const appended = service.appendSafeEvent({
      jobId: created.id,
      expectedNextSequence: 3,
      type: 'resource',
      metadata: { queuePosition: 1 },
    })

    assert.equal(transitioned.applied, true)
    assert.equal(service.get(created.id)?.status, 'reserving')
    assert.equal(appended.sequence, 3)
    assert.equal(appended.state, 'reserving')
    db.close()
  })

  it('allows every and only canonical terminal edge from the state diagram', () => {
    const canonicalEdges: Array<readonly [JobState, JobTerminalState]> = [
      ['reserving', 'failed'],
      ['loading', 'failed'],
      ['loading', 'interrupted'],
      ['prefill', 'failed'],
      ['prefill', 'interrupted'],
      ['thinking', 'failed'],
      ['thinking', 'interrupted'],
      ['generating', 'failed'],
      ['generating', 'interrupted'],
      ['waiting_tool', 'failed'],
      ['waiting_tool', 'interrupted'],
      ['finalizing', 'completed'],
      ['finalizing', 'failed'],
      ['cancelling', 'cancelled'],
    ]
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store)

    canonicalEdges.forEach(([from, status], index) => {
      const source = advanceTo(service, createJob(service, `terminal-${index}`), from)
      const result = service.terminalize(terminalInput(source, status))
      assert.equal(result.applied, true)
      assert.equal(result.job.status, status)
      assert.equal(result.job.lastEventSequence, source.lastEventSequence + 1)
      assert.deepEqual(
        store.eventsAfter(source.id, source.lastEventSequence).map((event) => event.state),
        [status],
      )
    })

    for (const [from, status] of [
      ['queued', 'completed'],
      ['waiting_approval', 'failed'],
      ['cancelling', 'interrupted'],
    ] as Array<readonly [JobState, JobTerminalState]>) {
      const source = advanceTo(service, createJob(service, `invalid-${from}-${status}`), from)
      assert.throws(
        () => service.terminalize(terminalInput(source, status)),
        assertServiceError('invalid_transition'),
      )
      assert.deepEqual(service.get(source.id), source)
      assert.equal(store.eventsAfter(source.id, 0).length, source.lastEventSequence)
    }
    db.close()
  })
})

describe('JobService persisted-first subscription', () => {
  it('replays after N and hands off to live commits without gaps or duplicates', async () => {
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store, { replayPageSize: 1 })
    const created = createJob(service, 'replay-live')
    service.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    })
    service.appendSafeEvent({
      jobId: created.id,
      expectedNextSequence: 3,
      type: 'resource',
      metadata: { queuePosition: 1 },
    })
    const controller = new AbortController()
    const iterator = service
      .subscribe(created.id, 1, controller.signal)
      [Symbol.asyncIterator]()

    const seen = [await nextEvent(iterator)]
    service.appendSafeEvent({
      jobId: created.id,
      expectedNextSequence: 4,
      type: 'warning',
      metadata: { code: 'during_replay' },
    })
    seen.push(await nextEvent(iterator), await nextEvent(iterator))

    const live = iterator.next()
    service.transition({
      jobId: created.id,
      expectedStatus: 'reserving',
      status: 'loading',
    })
    const liveResult = await live
    assert.equal(liveResult.done, false)
    seen.push(liveResult.value)

    assert.deepEqual(seen.map((event) => event.sequence), [2, 3, 4, 5])
    assert.equal(new Set(seen.map((event) => event.id)).size, 4)
    controller.abort()
    assert.equal((await iterator.next()).done, true)
    db.close()
  })

  it('never exposes a rolled-back mutation and wakes only after a committed event exists', async () => {
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store)
    const created = createJob(service, 'failed-mutation')
    const controller = new AbortController()
    const iterator = service
      .subscribe(created.id, 1, controller.signal)
      [Symbol.asyncIterator]()
    const pending = iterator.next()
    db.exec(`
      CREATE TRIGGER fail_service_transition_event
      BEFORE INSERT ON job_events
      WHEN NEW.state = 'reserving'
      BEGIN
        SELECT RAISE(ABORT, 'injected service transition failure');
      END;
    `)

    assert.throws(
      () =>
        service.transition({
          jobId: created.id,
          expectedStatus: 'queued',
          status: 'reserving',
        }),
      /injected service transition failure/,
    )
    assert.deepEqual(service.get(created.id), created)
    assert.deepEqual(store.eventsAfter(created.id, 0).map((event) => event.sequence), [1])

    db.exec('DROP TRIGGER fail_service_transition_event')
    service.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    })
    const event = await pending
    assert.equal(event.done, false)
    assert.equal(event.value.sequence, 2)
    controller.abort()
    assert.equal((await iterator.next()).done, true)
    db.close()
  })

  it('delivers one ordered sequence and one terminal event to multiple subscribers', async () => {
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store)
    const created = createJob(service, 'multiple-subscribers')
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = service
      .subscribe(created.id, 0, firstController.signal)
      [Symbol.asyncIterator]()
    const second = service
      .subscribe(created.id, 0, secondController.signal)
      [Symbol.asyncIterator]()

    const firstSeen = [await nextEvent(first)]
    const secondSeen = [await nextEvent(second)]
    const firstTransition = first.next()
    const secondTransition = second.next()
    service.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    })
    firstSeen.push((await firstTransition).value)
    secondSeen.push((await secondTransition).value)

    const firstTerminal = first.next()
    const secondTerminal = second.next()
    const terminal = service.terminalize({
      jobId: created.id,
      expectedStatus: 'reserving',
      status: 'failed',
      error: {
        category: 'runtime_protocol',
        code: 'fixture_failure',
        message: 'safe fixture failure',
        retryable: true,
      },
    })
    firstSeen.push((await firstTerminal).value)
    secondSeen.push((await secondTerminal).value)
    const late = service.terminalize({
      jobId: created.id,
      expectedStatus: 'reserving',
      status: 'failed',
      error: {
        category: 'internal',
        code: 'late_failure',
        message: 'safe late failure',
        retryable: false,
      },
    })

    assert.equal(terminal.applied, true)
    assert.equal(late.applied, false)
    assert.deepEqual(firstSeen.map((event) => event.sequence), [1, 2, 3])
    assert.deepEqual(secondSeen.map((event) => event.sequence), [1, 2, 3])
    assert.deepEqual(firstSeen.map((event) => event.id), secondSeen.map((event) => event.id))
    assert.equal(store.eventsAfter(created.id, 0).filter((event) => event.state === 'failed').length, 1)

    firstController.abort()
    secondController.abort()
    assert.equal((await first.next()).done, true)
    assert.equal((await second.next()).done, true)
    db.close()
  })

  it('removes an aborted subscriber without changing the Job', async () => {
    const db = openDb(':memory:')
    const service = new JobService(new JobStore(db))
    const created = createJob(service, 'abort-cleanup')
    const controller = new AbortController()
    const iterator = service
      .subscribe(created.id, 1, controller.signal)
      [Symbol.asyncIterator]()
    const pending = iterator.next()

    assert.equal(service.subscriberCount(created.id), 1)
    controller.abort()
    assert.equal((await pending).done, true)
    assert.equal(service.subscriberCount(created.id), 0)
    assert.deepEqual(service.get(created.id), created)
    db.close()
  })

  it('keeps producer writes independent from a slow subscriber and catches up from SQLite pages', async () => {
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store, { replayPageSize: 2 })
    const created = createJob(service, 'slow-subscriber')
    const controller = new AbortController()
    const iterator = service
      .subscribe(created.id, 1, controller.signal)
      [Symbol.asyncIterator]()
    const first = iterator.next()

    for (let sequence = 2; sequence <= 21; sequence += 1) {
      service.appendSafeEvent({
        jobId: created.id,
        expectedNextSequence: sequence,
        type: 'output',
        metadata: { chunk: sequence },
      })
    }
    assert.equal(service.get(created.id)?.lastEventSequence, 21)

    const seen = [(await first).value.sequence]
    while (seen.length < 20) seen.push((await iterator.next()).value.sequence)
    assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => index + 2))
    assert.deepEqual(
      store.eventsAfter(created.id, 1, 1_000).map((event) => event.sequence),
      seen,
    )
    controller.abort()
    assert.equal((await iterator.next()).done, true)
    db.close()
  })

  it('replays the persisted tail from a new service instance after restart', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'alamo-job-service-restart-'))
    test.after(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'alamo.db')
    const firstDb = openDb(path)
    const firstService = new JobService(new JobStore(firstDb))
    const created = createJob(firstService, 'restart-replay')
    firstService.transition({
      jobId: created.id,
      expectedStatus: 'queued',
      status: 'reserving',
    })
    firstService.appendSafeEvent({
      jobId: created.id,
      expectedNextSequence: 3,
      type: 'resource',
      metadata: { observation: 'persisted-before-restart' },
    })
    firstDb.close()

    const restartedDb = openDb(path)
    const restarted = new JobService(new JobStore(restartedDb), { replayPageSize: 1 })
    const controller = new AbortController()
    const iterator = restarted
      .subscribe(created.id, 1, controller.signal)
      [Symbol.asyncIterator]()
    const replayed = [await nextEvent(iterator), await nextEvent(iterator)]
    const live = iterator.next()
    restarted.transition({
      jobId: created.id,
      expectedStatus: 'reserving',
      status: 'loading',
    })
    replayed.push((await live).value)

    assert.deepEqual(replayed.map((event) => event.sequence), [2, 3, 4])
    controller.abort()
    assert.equal((await iterator.next()).done, true)
    restartedDb.close()
  })

  it('surfaces malformed persisted events as a controlled subscription failure', async () => {
    const db = openDb(':memory:')
    const store = new JobStore(db)
    const service = new JobService(store)
    const created = createJob(service, 'malformed-replay')
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.prepare("UPDATE job_events SET metadata = '{' WHERE job_id = ?").run(created.id)
    db.exec('PRAGMA ignore_check_constraints = OFF')
    const iterator = service
      .subscribe(created.id, 0, new AbortController().signal)
      [Symbol.asyncIterator]()

    await assert.rejects(
      iterator.next(),
      (error) => error instanceof JobStoreError && error.code === 'stored_data_invalid',
    )
    assert.equal(service.subscriberCount(created.id), 0)
    db.close()
  })
})
