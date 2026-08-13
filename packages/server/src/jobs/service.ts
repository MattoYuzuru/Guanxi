import {
  jobTerminalStateSchema,
  type Job,
  type JobCancelReason,
  type JobStreamEvent,
} from '@alamo/contract'
import {
  isCanonicalNonTerminalTransition,
  isCanonicalRecoveryTerminalTransition,
  isCanonicalTerminalTransition,
} from './lifecycle.ts'
import {
  JobStore,
  JobStoreError,
  type AppendJobEventInput,
  type CreateChatJobInput,
  type CreateChatJobResult,
  type CreateJobInput,
  type CreateJobResult,
  type CreateRecipeJobSnapshotInput,
  type CreateRecipeJobSnapshotResult,
  type RecipeJobSnapshotAssociation,
  type TerminalizeJobInput,
  type TerminalizeChatJobInput,
  type TerminalizeJobResult,
  type TransitionJobInput,
  type TransitionJobResult,
} from '../store/jobs.ts'

const DEFAULT_REPLAY_PAGE_SIZE = 100
const TERMINAL_STATES = new Set<Job['status']>(jobTerminalStateSchema.options)

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
  private closing = false

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

  createChat(input: CreateChatJobInput): CreateChatJobResult {
    const result = this.store.createChat(input)
    if (result.created) this.publish(result.job.id)
    return result
  }

  createRecipeSnapshot(
    input: CreateRecipeJobSnapshotInput,
  ): CreateRecipeJobSnapshotResult {
    const result = this.store.createRecipeSnapshot(input)
    if (result.created) this.publish(result.job.id)
    return result
  }

  recipeSnapshot(jobId: string): RecipeJobSnapshotAssociation | null {
    return this.store.recipeSnapshot(jobId)
  }

  get(jobId: string): Job | null {
    return this.store.get(jobId)
  }

  /**
   * Owns the public cancellation state change without owning execution itself.
   * A queued Job has no started side effect, so this service can confirm its
   * cancellation immediately. Active execution remains cancelling until its
   * typed execution owner confirms that the side effect stopped.
   */
  cancel(jobId: string, reason: JobCancelReason): Job {
    let current = this.store.get(jobId)
    if (!current) throw new JobStoreError('job_not_found', `Job ${jobId} was not found`)

    while (true) {
      if (TERMINAL_STATES.has(current.status) || current.status === 'cancelling') {
        return current
      }
      if (!isCanonicalNonTerminalTransition(current.status, 'cancelling')) {
        throw new JobServiceError(
          'invalid_transition',
          `Job transition ${current.status} -> cancelling is not canonical`,
        )
      }

      const transitioned = this.transition({
        jobId,
        expectedStatus: current.status,
        status: 'cancelling',
        metadata: { stopReason: reason },
      })
      if (!transitioned.applied) {
        current = transitioned.job
        continue
      }
      if (current.status !== 'queued') return transitioned.job

      return this.terminalize({
        jobId,
        expectedStatus: 'cancelling',
        status: 'cancelled',
        stopReason: reason,
      }).job
    }
  }

  transition(input: TransitionJobInput): TransitionJobResult {
    const result = this.store.transition(input)
    if (result.applied) this.publish(input.jobId)
    return result
  }

  appendSafeEvent(input: AppendJobEventInput): JobStreamEvent {
    const event = this.store.appendEvent(input)
    this.publish(input.jobId)
    return event
  }

  /** Validate the first bounded replay page before HTTP commits SSE headers. */
  validateSubscription(jobId: string, afterSequence: number): void {
    this.store.eventsAfter(jobId, afterSequence, this.replayPageSize)
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

  terminalizeChat(input: TerminalizeChatJobInput): TerminalizeJobResult {
    if (!isCanonicalTerminalTransition(input.expectedStatus, input.status)) {
      throw new JobServiceError(
        'invalid_transition',
        `Job transition ${input.expectedStatus} -> ${input.status} is not canonical`,
      )
    }
    const result = this.store.terminalizeChat(input)
    if (result.applied) this.publish(input.jobId)
    return result
  }

  terminalizeRecoveredChat(input: TerminalizeChatJobInput): TerminalizeJobResult {
    if (!isCanonicalRecoveryTerminalTransition(input.expectedStatus, input.status)) {
      throw new JobServiceError(
        'invalid_transition',
        `Job recovery transition ${input.expectedStatus} -> ${input.status} is not canonical`,
      )
    }
    const result = this.store.terminalizeChat(input)
    if (result.applied) this.publish(input.jobId)
    return result
  }

  async *subscribe(
    jobId: string,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<JobStreamEvent> {
    const wake = new SubscriptionWake()
    const jobSubscribers = this.subscribers.get(jobId) ?? new Set<SubscriptionWake>()
    jobSubscribers.add(wake)
    this.subscribers.set(jobId, jobSubscribers)
    let cursor = afterSequence

    try {
      while (!signal.aborted && !this.closing) {
        const observedVersion = wake.version
        const page = this.store.eventsAfter(jobId, cursor, this.replayPageSize)
        if (page.length === 0) {
          const job = this.store.get(jobId)
          if (job && TERMINAL_STATES.has(job.status) && cursor >= job.lastEventSequence) return
          await wake.waitForChange(observedVersion, signal)
          continue
        }

        for (const event of page) {
          if (signal.aborted) return
          if (event.sequence <= cursor) continue
          cursor = event.sequence
          yield event
          if (TERMINAL_STATES.has(event.state)) return
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

  closeSubscriptions(): void {
    this.closing = true
    for (const subscribers of this.subscribers.values()) {
      for (const subscriber of subscribers) subscriber.notify()
    }
  }

  private publish(jobId: string): void {
    for (const subscriber of this.subscribers.get(jobId) ?? []) subscriber.notify()
  }
}
