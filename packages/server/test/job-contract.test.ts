import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  jobEventSchema,
  jobSchema,
  jobStateSchema,
  jobTerminalStateSchema,
  safeJobMetadataSchema,
} from '@alamo/contract'

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
  })
})
