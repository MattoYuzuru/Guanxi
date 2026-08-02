import type { Job, JobEvent } from '@alamo/contract'
import { isCanonicalTerminalTransition } from './lifecycle.ts'
import {
  JobStore,
  type AppendJobEventInput,
  type CreateJobInput,
  type CreateJobResult,
  type TerminalizeJobInput,
  type TerminalizeJobResult,
  type TransitionJobInput,
  type TransitionJobResult,
} from '../store/jobs.ts'

const DEFAULT_REPLAY_PAGE_SIZE = 100

export type JobServiceErrorCode = 'invalid_transition'

export class JobServiceError extends Error {
  readonly code: JobServiceErrorCode

  constructor(code: JobServiceErrorCode, message: string) {
    super(message)
    this.name = 'JobServiceError'
    this.code = code
  }
}

class SubscriptionWake {
  version = 0
  private resolveWait: (() => void) | null = null

  notify(): void {
    this.version += 1
    this.resolveWait?.()
  }

  waitForChange(observedVersion: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.version !== observedVersion) return Promise.resolve()

    return new Promise((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish)
        if (this.resolveWait === finish) this.resolveWait = null
        resolve()
      }
      this.resolveWait = finish
      signal.addEventListener('abort', finish, { once: true })

      // Re-check after installing the waiter so a synchronous notification cannot be lost.
      if (signal.aborted || this.version !== observedVersion) finish()
    })
  }

  close(): void {
    this.resolveWait?.()
  }
}

export interface JobServiceOptions {
  replayPageSize?: number
}

/**
 * In-process application boundary over durable Job mutations and replay.
 * Live publication is only a wake-up signal; SQLite remains the ordered event source.
 */
export class JobService {
  private readonly subscribers = new Map<string, Set<SubscriptionWake>>()
  private readonly replayPageSize: number
  private readonly store: JobStore

  constructor(store: JobStore, options: JobServiceOptions = {}) {
    this.store = store
    const replayPageSize = options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE
    if (!Number.isInteger(replayPageSize) || replayPageSize < 1 || replayPageSize > 1_000) {
      throw new RangeError('replayPageSize must be an integer from 1 to 1000')
    }
    this.replayPageSize = replayPageSize
  }

  create(input: CreateJobInput): CreateJobResult {
    const result = this.store.create(input)
    if (result.created) this.publish(result.job.id)
    return result
  }

  get(jobId: string): Job | null {
    return this.store.get(jobId)
  }

  transition(input: TransitionJobInput): TransitionJobResult {
    const result = this.store.transition(input)
    if (result.applied) this.publish(input.jobId)
    return result
  }

  appendSafeEvent(input: AppendJobEventInput): JobEvent {
    const event = this.store.appendEvent(input)
    this.publish(input.jobId)
    return event
  }

  terminalize(input: TerminalizeJobInput): TerminalizeJobResult {
    if (!isCanonicalTerminalTransition(input.expectedStatus, input.status)) {
      throw new JobServiceError(
        'invalid_transition',
        `Job transition ${input.expectedStatus} -> ${input.status} is not canonical`,
      )
    }
    const result = this.store.terminalize(input)
    if (result.applied) this.publish(input.jobId)
    return result
  }

  async *subscribe(
    jobId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<JobEvent> {
    const wake = new SubscriptionWake()
    const jobSubscribers = this.subscribers.get(jobId) ?? new Set<SubscriptionWake>()
    jobSubscribers.add(wake)
    this.subscribers.set(jobId, jobSubscribers)
    let cursor = afterSequence

    try {
      while (!signal.aborted) {
        const observedVersion = wake.version
        const page = this.store.eventsAfter(jobId, cursor, this.replayPageSize)
        if (page.length === 0) {
          await wake.waitForChange(observedVersion, signal)
          continue
        }

        for (const event of page) {
          if (signal.aborted) return
          if (event.sequence <= cursor) continue
          cursor = event.sequence
          yield event
        }
      }
    } finally {
      wake.close()
      jobSubscribers.delete(wake)
      if (jobSubscribers.size === 0) this.subscribers.delete(jobId)
    }
  }

  subscriberCount(jobId?: string): number {
    if (jobId !== undefined) return this.subscribers.get(jobId)?.size ?? 0
    let count = 0
    for (const subscribers of this.subscribers.values()) count += subscribers.size
    return count
  }

  private publish(jobId: string): void {
    for (const subscriber of this.subscribers.get(jobId) ?? []) subscriber.notify()
  }
}
