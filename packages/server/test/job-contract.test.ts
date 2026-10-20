import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ROUTES,
  cancelJobBody,
  createJobBody,
  createJobResponse,
  getJobResponse,
  chatJobInputSnapshotSchema,
  jobEventCursorText,
  jobEventSchema,
  jobEventsQuery,
  jobPathParams,
  jobSchema,
  jobStateSchema,
  jobStreamEventSchema,
  jobTerminalStateSchema,
  safeJobMetadataSchema,
  messageSchema,
  prewarmModelBody,
  prewarmModelResponse,
  runtimeGovernorSnapshotSchema,
  settingsSchema,
  updateSettingsBody,
  sendMessageBody,
} from '@guanxi/contract'

describe('durable Job contract', () => {
  it('keeps the accepted lifecycle and terminal state names exact', () => {
    assert.deepEqual(jobStateSchema.options, [
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
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ])
    assert.deepEqual(jobTerminalStateSchema.options, [
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ])
  })

  it('parses a durable record and persisted replay envelope', () => {
    const createdAt = '2026-08-03T00:00:00.000Z'
    const job = jobSchema.parse({
      id: 'job-1',
      kind: 'inference',
      operation: 'chat',
      status: 'queued',
      phase: null,
      idempotencyScope: 'chat:thread-1',
      idempotencyKey: 'submit-1',
      createdAt,
      startedAt: null,
      finishedAt: null,
      error: null,
      outcome: null,
      stopReason: null,
      lastEventSequence: 1,
    })
    const event = jobEventSchema.parse({
      id: 'event-1',
      jobId: job.id,
      sequence: 1,
      type: 'lifecycle',
      state: 'queued',
      phase: null,
      metadata: {},
      createdAt,
    })

    assert.equal(job.status, 'queued')
    assert.equal(event.sequence, 1)
  })

  it('rejects unknown states and nested or non-finite metadata', () => {
    assert.equal(jobStateSchema.safeParse('running').success, false)
    assert.equal(safeJobMetadataSchema.safeParse({ prompt: { private: true } }).success, false)
    assert.equal(safeJobMetadataSchema.safeParse({ durationMs: Number.POSITIVE_INFINITY }).success, false)
    assert.equal(
      jobSchema.safeParse({
        id: 'false-success',
        kind: 'inference',
        operation: 'chat',
        status: 'completed',
        phase: null,
        idempotencyScope: 'test',
        idempotencyKey: 'malformed',
        createdAt: '2026-08-03T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        error: null,
        outcome: null,
        stopReason: null,
        lastEventSequence: 1,
      }).success,
      false,
    )
  })

  it('round-trips public create, query and cancel shapes without exposing storage scope', () => {
    const body = createJobBody.parse({
      kind: 'inference',
      operation: ' chat ',
      idempotencyKey: ' submit-1 ',
    })
    const job = jobSchema.parse({
      id: 'job-1',
      kind: body.kind,
      operation: body.operation,
      status: 'queued',
      phase: null,
      idempotencyScope: 'local-api:v1',
      idempotencyKey: body.idempotencyKey,
      createdAt: '2026-08-03T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      error: null,
      outcome: null,
      stopReason: null,
      lastEventSequence: 1,
    })

    assert.deepEqual(body, {
      kind: 'inference',
      operation: 'chat',
      idempotencyKey: 'submit-1',
    })
    assert.equal(
      createJobResponse.parse({ created: true, job, eventsUrl: ROUTES.jobEvents(job.id) })
        .eventsUrl,
      '/api/jobs/job-1/events',
    )
    assert.equal(getJobResponse.parse({ job }).job.id, job.id)
    assert.deepEqual(cancelJobBody.parse({}), { reason: 'user_requested' })
    assert.equal(
      createJobBody.safeParse({ ...body, idempotencyScope: 'caller-controlled' }).success,
      false,
    )
  })

  it('validates Job path and replay cursors at the contract boundary', () => {
    assert.equal(
      jobPathParams.safeParse({ jobId: '00000000-0000-4000-8000-000000000000' }).success,
      true,
    )
    assert.equal(jobPathParams.safeParse({ jobId: '../private' }).success, false)
    assert.deepEqual(jobEventsQuery.parse({ after: '12' }), { after: 12 })
    assert.equal(jobEventCursorText.safeParse('0').success, true)

    for (const malformed of ['-1', '1.5', '1e3', '', '9007199254740992']) {
      assert.equal(jobEventCursorText.safeParse(malformed).success, false, malformed)
    }
    assert.equal(cancelJobBody.safeParse({ reason: 'private prompt or path' }).success, false)
  })

  it('keeps Chat idempotency and Message association additive for legacy clients', () => {
    assert.deepEqual(sendMessageBody.parse({ content: 'legacy' }), { content: 'legacy' })
    assert.equal(
      sendMessageBody.safeParse({
        content: 'new',
        idempotencyKey: '00000000-0000-4000-8000-000000000000',
      }).success,
      true,
    )
    assert.equal(sendMessageBody.safeParse({ content: 'bad', idempotencyKey: 'bad' }).success, false)
    assert.equal(
      messageSchema.parse({
        id: 'legacy-message',
        threadId: 'thread',
        role: 'assistant',
        content: '',
        thinking: null,
        toolCalls: [],
        usage: null,
        createdAt: '2026-08-03T00:00:00.000Z',
        isCompaction: false,
      }).jobId,
      null,
    )
    assert.deepEqual(
      chatJobInputSnapshotSchema.parse({ content: 'private', attachments: [], autoApprove: null }),
      { content: 'private', attachments: [], autoApprove: null },
    )
  })

  it('parses private Chat replay outside safe metadata and defaults legacy events to null', () => {
    const base = {
      id: 'event-private',
      jobId: '00000000-0000-4000-8000-000000000000',
      sequence: 2,
      type: 'output',
      state: 'generating',
      phase: 'generating',
      metadata: { channel: 'token' },
      createdAt: '2026-08-03T00:00:00.000Z',
    }
    assert.equal(jobStreamEventSchema.parse(base).output, null)
    const parsed = jobStreamEventSchema.parse({
      ...base,
      output: {
        privacyClassification: 'private_chat',
        event: { type: 'token', data: { delta: 'private output' } },
      },
    })
    assert.equal(parsed.output?.event.type, 'token')
    assert.equal(
      jobStreamEventSchema.safeParse({
        ...base,
        output: {
          privacyClassification: 'safe_metadata',
          event: { type: 'token', data: { delta: 'private output' } },
        },
      }).success,
      false,
    )
  })

  it('keeps legacy normal Runtime snapshots compatible and types prewarm priority/command', () => {
    const observedAt = '2026-08-03T00:00:00.000Z'
    const base = {
      observedAt,
      accepting: true,
      policy: {
        acceleratorPermits: 1,
        order: 'fifo',
        priorities: ['normal'],
        scope: 'application_process',
        basis: 'conservative_single_process_single_accelerator_permit_fifo',
      },
      queued: [],
      activeLease: {
        leaseId: 'legacy-lease',
        ticketId: 'legacy-ticket',
        owner: { kind: 'operation', operationId: 'legacy-warm' },
        operation: 'model_warm',
        model: { provider: 'ollama', name: 'fixture:latest' },
        requestedContext: 4_096,
        acquiredAt: observedAt,
        state: 'active',
      },
      lastDecision: null,
    } as const
    assert.equal(runtimeGovernorSnapshotSchema.parse(base).activeLease?.priority, 'normal')

    const current = structuredClone(base) as Record<string, unknown>
    current.policy = {
      acceleratorPermits: 1,
      order: 'priority_fifo',
      priorities: ['normal', 'prewarm'],
      scope: 'application_process',
      basis:
        'conservative_single_process_single_accelerator_permit_normal_before_prewarm_fifo',
    }
    current.activeLease = {
      ...base.activeLease,
      operation: 'model_prewarm',
      priority: 'prewarm',
    }
    assert.equal(runtimeGovernorSnapshotSchema.parse(current).activeLease?.priority, 'prewarm')
    assert.equal(
      runtimeGovernorSnapshotSchema.safeParse({
        ...current,
        activeLease: { ...(current.activeLease as object), priority: 'urgent' },
      }).success,
      false,
    )

    const body = prewarmModelBody.parse({
      operation: 'chat',
      contextLength: 8_192,
      selection: { digest: 'sha256:fixture', fitLevel: 'green', fitBasis: 'estimate' },
    })
    assert.equal(body.selection.digest, 'sha256:fixture')
    assert.equal(
      prewarmModelResponse.parse({
        status: 'warmed',
        reason: 'loaded',
        model: { name: 'fixture:latest', digest: 'sha256:fixture' },
        operation: 'chat',
        purpose: 'model_prewarm',
        priority: 'prewarm',
        keepAlive: '2m',
        observedAt,
      }).priority,
      'prewarm',
    )
    const legacySettings = settingsSchema.parse({
      ollamaHost: 'http://fixture.invalid',
      defaultModel: null,
      defaultNumCtx: 8_192,
      autoApproveTools: false,
      enableBash: false,
      webSearch: { provider: 'none', baseUrl: null, hasApiKey: false },
      theme: 'system',
    })
    assert.equal(legacySettings.prewarmEnabled, true)
    assert.equal(legacySettings.locale, 'en')
    assert.equal(legacySettings.localeSource, 'default')
    assert.equal(updateSettingsBody.parse({ locale: 'ru' }).locale, 'ru')
    assert.equal(updateSettingsBody.safeParse({ locale: 'future' }).success, false)
    assert.equal(updateSettingsBody.safeParse({ locale: 'en', future: true }).success, false)
  })
})
