import type {
  ChatRetentionStore,
  RetentionEligibilityCursor,
} from '../store/chat-retention.ts'
import type {
  ReasoningArtifactStore,
  ReasoningExpiryCursor,
} from '../store/reasoning-artifacts.ts'

export const DEFAULT_RETENTION_MAINTENANCE_BATCH_SIZE = 50
export const DEFAULT_RETENTION_MAINTENANCE_MAX_BATCHES = 4
export const DEFAULT_RETENTION_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1_000

export interface RetentionMaintenanceReport {
  observedAt: string
  scanned: number
  tombstoned: number
  batches: number
  reasoningScanned: number
  reasoningDeleted: number
  reasoningBatches: number
}

export interface RetentionMaintenanceScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export interface RetentionMaintenanceOptions {
  clock?: () => Date
  batchSize?: number
  maxBatchesPerRun?: number
  intervalMs?: number
  scheduler?: RetentionMaintenanceScheduler
  reasoningArtifacts?: ReasoningArtifactStore
}

const defaultScheduler: RetentionMaintenanceScheduler = {
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs)
    timer.unref()
    return timer
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

/** One process-local owner for startup and periodic bounded TTL enforcement. */
export class RetentionMaintenanceOwner {
  private readonly store: ChatRetentionStore
  private readonly clock: () => Date
  private readonly batchSize: number
  private readonly maxBatchesPerRun: number
  private readonly intervalMs: number
  private readonly scheduler: RetentionMaintenanceScheduler
  private readonly reasoningArtifacts: ReasoningArtifactStore | null
  private timer: unknown | null = null
  private startPromise: Promise<RetentionMaintenanceReport> | null = null
  private running: Promise<RetentionMaintenanceReport> | null = null
  private closed = false
  private lastFailure: unknown = null

  constructor(store: ChatRetentionStore, options: RetentionMaintenanceOptions = {}) {
    this.store = store
    this.clock = options.clock ?? (() => new Date())
    this.batchSize = options.batchSize ?? DEFAULT_RETENTION_MAINTENANCE_BATCH_SIZE
    this.maxBatchesPerRun =
      options.maxBatchesPerRun ?? DEFAULT_RETENTION_MAINTENANCE_MAX_BATCHES
    this.intervalMs = options.intervalMs ?? DEFAULT_RETENTION_MAINTENANCE_INTERVAL_MS
    this.scheduler = options.scheduler ?? defaultScheduler
    this.reasoningArtifacts = options.reasoningArtifacts ?? null
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error('Retention Maintenance batchSize must be an integer from 1 to 1000')
    }
    if (
      !Number.isInteger(this.maxBatchesPerRun) ||
      this.maxBatchesPerRun < 1 ||
      this.maxBatchesPerRun > 100
    ) {
      throw new Error('Retention Maintenance maxBatchesPerRun must be an integer from 1 to 100')
    }
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new Error('Retention Maintenance intervalMs must be a positive safe integer')
    }
  }

  start(): Promise<RetentionMaintenanceReport> {
    if (this.closed) return Promise.reject(new Error('Retention Maintenance is closed'))
    if (this.startPromise) return this.startPromise
    this.startPromise = this.runOnce().then((report) => {
      if (!this.closed && this.timer === null) {
        this.timer = this.scheduler.setInterval(() => {
          void this.runOnce().catch((error) => {
            this.lastFailure = error
          })
        }, this.intervalMs)
      }
      return report
    })
    return this.startPromise
  }

  runOnce(): Promise<RetentionMaintenanceReport> {
    if (this.closed) return Promise.reject(new Error('Retention Maintenance is closed'))
    if (this.running) return this.running
    this.running = Promise.resolve().then(() => {
      const observedAt = this.clock().toISOString()
      let cursor: RetentionEligibilityCursor | null = null
      let scanned = 0
      let tombstoned = 0
      let batches = 0
      for (; batches < this.maxBatchesPerRun; batches += 1) {
        if (this.closed) break
        const candidates = this.store.eligiblePage(observedAt, cursor, this.batchSize)
        if (candidates.length === 0) break
        scanned += candidates.length
        tombstoned += this.store.tombstoneEligible(candidates, observedAt)
        const last = candidates.at(-1)!
        cursor = { activityAt: last.activityAt, chatId: last.chatId }
        if (candidates.length < this.batchSize) {
          batches += 1
          break
        }
      }
      let reasoningCursor: ReasoningExpiryCursor | null = null
      let reasoningScanned = 0
      let reasoningDeleted = 0
      let reasoningBatches = 0
      if (this.reasoningArtifacts) {
        for (; reasoningBatches < this.maxBatchesPerRun; reasoningBatches += 1) {
          if (this.closed) break
          const candidates = this.reasoningArtifacts.eligiblePage(
            observedAt,
            reasoningCursor,
            this.batchSize,
          )
          if (candidates.length === 0) break
          reasoningScanned += candidates.length
          reasoningDeleted += this.reasoningArtifacts.deleteEligible(candidates, observedAt)
          const last = candidates.at(-1)!
          reasoningCursor = {
            effectiveExpiresAt: last.effectiveExpiresAt,
            artifactId: last.artifactId,
          }
          if (candidates.length < this.batchSize) {
            reasoningBatches += 1
            break
          }
        }
      }
      this.lastFailure = null
      return {
        observedAt,
        scanned,
        tombstoned,
        batches,
        reasoningScanned,
        reasoningDeleted,
        reasoningBatches,
      }
    }).finally(() => {
      this.running = null
    })
    return this.running
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      this.scheduler.clearInterval(this.timer)
      this.timer = null
    }
    await this.running?.catch(() => undefined)
  }

  status(): { started: boolean; running: boolean; closed: boolean; lastFailure: unknown } {
    return {
      started: this.startPromise !== null,
      running: this.running !== null,
      closed: this.closed,
      lastFailure: this.lastFailure,
    }
  }
}
