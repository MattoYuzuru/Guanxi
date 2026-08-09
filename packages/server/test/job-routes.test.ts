import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ROUTES,
  SSE_EVENT_NAME,
  apiErrorSchema,
  cancelJobResponse,
  createJobResponse,
  getJobResponse,
  jobStreamEventSchema,
  type HardwareInfo,
  type JobEvent,
} from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { UnsupportedHostTelemetry } from '../src/hardware/telemetry.ts'
import { JobService } from '../src/jobs/service.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
import { ModelService } from '../src/models/service.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { RuntimeReconciliationService } from '../src/runtime/reconciliation.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function fixture(): { app: ReturnType<typeof createApp>; context: AppContext } {
  const db = openDb(':memory:')
  const client = new OllamaClient({ host: 'http://fixture.invalid' })
  const settings = new SettingsStore(db, { ollamaHost: client.host })
  const calibration = new CalibrationStore(db)
  const models = new ModelService(client, calibration, HARDWARE)
  const jobs = new JobStore(db)
  const base = {
    db,
    jobs,
    jobService: new JobService(jobs, { replayPageSize: 2 }),
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration,
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    hardwareObservedAt: '2026-08-09T12:00:00.000Z',
    hostTelemetry: new UnsupportedHostTelemetry(HARDWARE),
    appVersion: 'job-route-fixture',
    activeTurns: new Map(),
    governor: new ResourceGovernor(),
    ollama: () => client,
    models: () => models,
  }
  const runtimeBase = {
    ...base,
    runtime: new RuntimeReconciliationService({
      governor: base.governor,
      hostTelemetry: base.hostTelemetry,
      models: base.models,
    }),
  }
  const context: AppContext = {
    ...runtimeBase,
    completionProbe: { execute: async () => { throw new Error('not invoked') } } as never,
    capabilityOverrides: {
      apply: async () => { throw new Error('not invoked') },
      clear: async () => { throw new Error('not invoked') },
    } as never,
    // P2-J discovery is unrelated to these flows: reaching it is a defect.
    huggingFace: {
      search: async () => { throw new Error('not invoked') },
      repository: async () => { throw new Error('not invoked') },
    } as never,
    huggingFaceDownloads: { download: async function* () {} } as never,
    huggingFaceImports: { import: async function* () {} } as never,
    chatExecution: new ChatJobExecutionOwner(runtimeBase),
  }
  return { app: createApp(context), context }
}

async function postJob(
  app: ReturnType<typeof createApp>,
  idempotencyKey: string,
): Promise<{ response: Response; body: ReturnType<typeof createJobResponse.parse> }> {
  const response = await app.request(ROUTES.jobs(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'inference', operation: 'fixture', idempotencyKey }),
  })
  return { response, body: createJobResponse.parse(await response.json()) }
}

function parseFrame(chunk: Uint8Array): JobEvent {
  const text = new TextDecoder().decode(chunk)
  const lines = text.trimEnd().split('\n')
  const id = lines.find((line) => line.startsWith('id: '))?.slice(4)
  const name = lines.find((line) => line.startsWith('event: '))?.slice(7)
  const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
  assert.equal(name, SSE_EVENT_NAME)
  assert.ok(data)
  const event = jobStreamEventSchema.parse(JSON.parse(data))
  assert.equal(id, String(event.sequence))
  return event
}

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<JobEvent> {
  const result = await reader.read()
  assert.equal(result.done, false)
  return parseFrame(result.value)
}

function parseAllFrames(text: string): JobEvent[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => parseFrame(new TextEncoder().encode(`${frame}\n\n`)))
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('public Job command and query routes', () => {
  it('creates once in the server-owned scope and returns a stable canonical query', async () => {
    const { app, context } = fixture()
    try {
      const first = await postJob(app, 'same-submit')
      const duplicate = await postJob(app, 'same-submit')

      assert.equal(first.response.status, 202)
      assert.equal(duplicate.response.status, 200)
      assert.equal(first.body.created, true)
      assert.equal(duplicate.body.created, false)
      assert.equal(duplicate.body.job.id, first.body.job.id)
      assert.equal(first.body.job.status, 'queued')
      assert.equal(first.body.job.idempotencyScope, 'local-api:v1')
      assert.equal(first.body.eventsUrl, ROUTES.jobEvents(first.body.job.id))
      assert.equal(
        (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
        1,
      )
      assert.equal(
        (
          context.db.prepare('SELECT COUNT(*) AS count FROM job_events').get() as {
            count: number
          }
        ).count,
        1,
      )

      const response = await app.request(ROUTES.job(first.body.job.id))
      const queried = getJobResponse.parse(await response.json())
      assert.equal(response.status, 200)
      assert.deepEqual(queried.job, first.body.job)
    } finally {
      context.db.close()
    }
  })

  it('rejects malformed bodies and IDs before mutation and returns controlled not-found', async () => {
    const { app, context } = fixture()
    try {
      for (const body of [
        null,
        { kind: 'inference', operation: '', idempotencyKey: 'key' },
        { kind: 'unknown', operation: 'fixture', idempotencyKey: 'key' },
        {
          kind: 'inference',
          operation: 'fixture',
          idempotencyKey: 'key',
          idempotencyScope: 'caller-scope',
        },
      ]) {
        const response = await app.request(ROUTES.jobs(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        assert.equal(response.status, 400)
        assert.equal(apiErrorSchema.parse(await response.json()).code, 'validation_failed')
      }
      assert.equal(
        (context.db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
        0,
      )

      const malformed = await app.request('/api/jobs/not-a-uuid')
      assert.equal(malformed.status, 400)
      const missing = await app.request('/api/jobs/00000000-0000-4000-8000-000000000000')
      assert.equal(missing.status, 404)
      assert.equal(apiErrorSchema.parse(await missing.json()).code, 'job_not_found')
    } finally {
      context.db.close()
    }
  })

  it('maps queued cancellation, repeated commands and invalid edges without extra events', async () => {
    const { app, context } = fixture()
    try {
      const created = (await postJob(app, 'cancel-route')).body.job
      const cancel = () => app.request(ROUTES.jobCancel(created.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const first = await cancel()
      const cancelled = cancelJobResponse.parse(await first.json()).job
      const repeated = cancelJobResponse.parse(await (await cancel()).json()).job
      assert.equal(first.status, 200)
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(repeated.lastEventSequence, 3)
      assert.deepEqual(
        context.jobs.eventsAfter(created.id, 0).map((event) => event.state),
        ['queued', 'cancelling', 'cancelled'],
      )

      const conflicting = (await postJob(app, 'cancel-conflict-route')).body.job
      let state = context.jobService.transition({
        jobId: conflicting.id,
        expectedStatus: 'queued',
        status: 'reserving',
      }).job
      state = context.jobService.transition({
        jobId: state.id,
        expectedStatus: state.status,
        status: 'loading',
      }).job
      state = context.jobService.transition({
        jobId: state.id,
        expectedStatus: state.status,
        status: 'prefill',
      }).job
      state = context.jobService.transition({
        jobId: state.id,
        expectedStatus: state.status,
        status: 'generating',
      }).job
      state = context.jobService.transition({
        jobId: state.id,
        expectedStatus: state.status,
        status: 'finalizing',
      }).job
      const before = state.lastEventSequence
      const conflict = await app.request(ROUTES.jobCancel(state.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(conflict.status, 409)
      assert.equal(apiErrorSchema.parse(await conflict.json()).code, 'job_conflict')
      assert.equal(context.jobService.get(state.id)?.lastEventSequence, before)

      const malformed = await app.request(ROUTES.jobCancel(state.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'prompt=/private/workspace' }),
      })
      assert.equal(malformed.status, 400)
    } finally {
      context.db.close()
    }
  })
})

describe('public Job replayable SSE route', () => {
  it('rejects malformed and conflicting cursors before subscription', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'cursor-validation')).body.job
      const cases: Array<{ url: string; headers?: Record<string, string> }> = [
        { url: `${ROUTES.jobEvents(job.id)}?after=-1` },
        { url: `${ROUTES.jobEvents(job.id)}?after=1.5` },
        { url: `${ROUTES.jobEvents(job.id)}?after=9007199254740992` },
        { url: `${ROUTES.jobEvents(job.id)}?after=1&after=1` },
        { url: `${ROUTES.jobEvents(job.id)}?unknown=1` },
        { url: ROUTES.jobEvents(job.id), headers: { 'Last-Event-ID': '-1' } },
        { url: `${ROUTES.jobEvents(job.id)}?after=1`, headers: { 'Last-Event-ID': '0' } },
      ]
      for (const testCase of cases) {
        const response = await app.request(testCase.url, { headers: testCase.headers })
        assert.equal(response.status, 400, testCase.url)
        assert.equal(apiErrorSchema.parse(await response.json()).code, 'validation_failed')
        assert.equal(context.jobService.subscriberCount(job.id), 0)
      }
      assert.equal(context.jobService.get(job.id)?.lastEventSequence, 1)

      const equal = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`, {
        headers: { 'Last-Event-ID': '1' },
      })
      assert.equal(equal.status, 200)
      await equal.body?.cancel()
      assert.equal(context.jobService.get(job.id)?.lastEventSequence, 1)
    } finally {
      context.db.close()
    }
  })

  it('replays after N, hands off to committed live events and hides rollback gaps', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'replay-live-route')).body.job
      context.jobService.transition({
        jobId: job.id,
        expectedStatus: 'queued',
        status: 'reserving',
      })
      const response = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`)
      const reader = response.body!.getReader()
      const seen = [await readEvent(reader)]

      const duringHandoff = readEvent(reader)
      context.jobService.appendSafeEvent({
        jobId: job.id,
        expectedNextSequence: 3,
        type: 'resource',
        metadata: { observation: 'committed-during-handoff' },
      })
      seen.push(await duringHandoff)

      const afterRollback = readEvent(reader)
      context.db.exec(`
        CREATE TRIGGER fail_public_warning_event
        BEFORE INSERT ON job_events
        WHEN NEW.type = 'warning'
        BEGIN
          SELECT RAISE(ABORT, 'private prompt /Users/private/workspace');
        END;
      `)
      assert.throws(() =>
        context.jobService.appendSafeEvent({
          jobId: job.id,
          expectedNextSequence: 4,
          type: 'warning',
          metadata: { code: 'must_rollback' },
        }),
      )
      context.db.exec('DROP TRIGGER fail_public_warning_event')
      context.jobService.appendSafeEvent({
        jobId: job.id,
        expectedNextSequence: 4,
        type: 'output',
        metadata: { chunk: 1 },
      })
      seen.push(await afterRollback)

      assert.deepEqual(seen.map((event) => event.sequence), [2, 3, 4])
      assert.equal(new Set(seen.map((event) => event.id)).size, 3)
      assert.equal(seen.some((event) => event.metadata['code'] === 'must_rollback'), false)
      await reader.cancel()
      assert.equal(context.jobService.get(job.id)?.status, 'reserving')
    } finally {
      context.db.close()
    }
  })

  it('resumes with Last-Event-ID and gives two clients one canonical order', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'reconnect-two-clients')).body.job
      context.jobService.transition({
        jobId: job.id,
        expectedStatus: 'queued',
        status: 'reserving',
      })
      context.jobService.appendSafeEvent({
        jobId: job.id,
        expectedNextSequence: 3,
        type: 'resource',
        metadata: { queuePosition: 1 },
      })

      const reconnect = await app.request(ROUTES.jobEvents(job.id), {
        headers: { 'Last-Event-ID': '2' },
      })
      const reconnectReader = reconnect.body!.getReader()
      assert.equal((await readEvent(reconnectReader)).sequence, 3)
      await reconnectReader.cancel()

      const first = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`)
      const second = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`)
      const firstReader = first.body!.getReader()
      const secondReader = second.body!.getReader()
      const firstSeen = [await readEvent(firstReader), await readEvent(firstReader)]
      const secondSeen = [await readEvent(secondReader), await readEvent(secondReader)]
      const firstLive = readEvent(firstReader)
      const secondLive = readEvent(secondReader)
      context.jobService.appendSafeEvent({
        jobId: job.id,
        expectedNextSequence: 4,
        type: 'output',
        metadata: { chunk: 1 },
      })
      firstSeen.push(await firstLive)
      secondSeen.push(await secondLive)

      assert.deepEqual(firstSeen.map((event) => event.sequence), [2, 3, 4])
      assert.deepEqual(firstSeen, secondSeen)
      await firstReader.cancel()
      await secondReader.cancel()
    } finally {
      context.db.close()
    }
  })

  it('delivers the terminal frame then closes, including reconnect after terminal tail', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'terminal-http')).body.job
      const response = await app.request(ROUTES.jobEvents(job.id))
      const cancel = await app.request(ROUTES.jobCancel(job.id), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(cancel.status, 200)

      const events = parseAllFrames(await response.text())
      assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3])
      assert.equal(events.at(-1)?.state, 'cancelled')
      assert.equal(context.jobService.subscriberCount(job.id), 0)

      const tail = await app.request(ROUTES.jobEvents(job.id), {
        headers: { 'Last-Event-ID': '3' },
      })
      assert.equal(tail.status, 200)
      assert.equal(await tail.text(), '')
      assert.equal(context.jobService.subscriberCount(job.id), 0)
    } finally {
      context.db.close()
    }
  })

  it('cleans up disconnect without changing Job state', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'disconnect-http')).body.job
      const response = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`)
      const reader = response.body!.getReader()
      const pending = reader.read()
      await nextTurn()
      assert.equal(context.jobService.subscriberCount(job.id), 1)

      await reader.cancel()
      assert.equal((await pending).done, true)
      await nextTurn()
      assert.equal(context.jobService.subscriberCount(job.id), 0)
      assert.equal(context.jobService.get(job.id)?.status, 'queued')
      assert.equal(context.jobService.get(job.id)?.lastEventSequence, 1)
    } finally {
      context.db.close()
    }
  })

  it('keeps slow HTTP readers bounded while the producer catches up from SQLite', async () => {
    const { app, context } = fixture()
    try {
      const job = (await postJob(app, 'slow-http-reader')).body.job
      const response = await app.request(`${ROUTES.jobEvents(job.id)}?after=1`)
      const reader = response.body!.getReader()
      const first = readEvent(reader)
      await nextTurn()

      for (let sequence = 2; sequence <= 21; sequence += 1) {
        context.jobService.appendSafeEvent({
          jobId: job.id,
          expectedNextSequence: sequence,
          type: 'output',
          metadata: { chunk: sequence },
        })
      }
      assert.equal(context.jobService.get(job.id)?.lastEventSequence, 21)

      const seen = [(await first).sequence]
      while (seen.length < 20) seen.push((await readEvent(reader)).sequence)
      assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => index + 2))
      await reader.cancel()
    } finally {
      context.db.close()
    }
  })

  it('returns safe storage failures without SQL, prompt, secret or filesystem content', async () => {
    const { app, context } = fixture()
    try {
      context.db.exec(`
        CREATE TRIGGER fail_public_job_create
        BEFORE INSERT ON jobs
        BEGIN
          SELECT RAISE(ABORT, 'SELECT secret prompt /Users/private/workspace api_key=hidden');
        END;
      `)
      const failedCreate = await app.request(ROUTES.jobs(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'inference',
          operation: 'fixture',
          idempotencyKey: 'storage-failure',
        }),
      })
      const failedCreateText = await failedCreate.text()
      assert.equal(failedCreate.status, 500)
      assert.equal(apiErrorSchema.parse(JSON.parse(failedCreateText)).code, 'storage_error')
      assert.doesNotMatch(failedCreateText, /SELECT|secret|prompt|\/Users|api_key/i)
      context.db.exec('DROP TRIGGER fail_public_job_create')

      const job = (await postJob(app, 'malformed-event')).body.job
      context.db.exec('PRAGMA ignore_check_constraints = ON')
      context.db.prepare("UPDATE job_events SET metadata = '{' WHERE job_id = ?").run(job.id)
      context.db.exec('PRAGMA ignore_check_constraints = OFF')
      const failedReplay = await app.request(ROUTES.jobEvents(job.id))
      const failedReplayText = await failedReplay.text()
      assert.equal(failedReplay.status, 500)
      assert.equal(apiErrorSchema.parse(JSON.parse(failedReplayText)).code, 'storage_error')
      assert.doesNotMatch(failedReplayText, /SQL|metadata|job_events|\/Users/i)

      const second = (await postJob(app, 'malformed-job')).body.job
      context.db.exec('PRAGMA ignore_check_constraints = ON')
      context.db.prepare("UPDATE jobs SET kind = 'secret /Users/private' WHERE id = ?").run(second.id)
      context.db.exec('PRAGMA ignore_check_constraints = OFF')
      const failedQuery = await app.request(ROUTES.job(second.id))
      const failedQueryText = await failedQuery.text()
      assert.equal(failedQuery.status, 500)
      assert.equal(apiErrorSchema.parse(JSON.parse(failedQueryText)).code, 'storage_error')
      assert.doesNotMatch(failedQueryText, /secret|\/Users|jobs/i)
    } finally {
      context.db.close()
    }
  })
})
