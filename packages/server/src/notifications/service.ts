import { evaluateQuota } from './rules.ts'
import { NotificationStoreError, type NotificationStore, type StoredNotification } from './store.ts'
import type { AlertConfig, DependentRun, QuotaFact } from './types.ts'

const INGEST_ATTEMPTS = 3

export interface IngestQuotaFactOptions {
  dependentRuns?: DependentRun[]
  refusal?: boolean
  config?: AlertConfig
}

export interface NotificationServiceDeps {
  /** Caller clock in milliseconds. The service, like the rule engine, never reads the clock. */
  now(): number
}

/**
 * Joins the pure quota rules to the durable inbox. Each call loads the previous window state,
 * evaluates deterministically and persists state plus alerts in one store transaction.
 */
export class NotificationService {
  readonly store: NotificationStore
  private readonly deps: NotificationServiceDeps

  constructor(store: NotificationStore, deps: NotificationServiceDeps) {
    this.store = store
    this.deps = deps
  }

  ingestQuotaFact(
    accountId: string,
    fact: QuotaFact,
    options: IngestQuotaFactOptions = {},
  ): StoredNotification[] {
    const nowMs = this.deps.now()
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      throw new TypeError('now() must return a finite millisecond timestamp')
    }
    const previous = this.store.windowState(fact.connectionId, fact.window, accountId)
    const evaluation = evaluateQuota({
      fact,
      previous,
      config: options.config,
      dependentRuns: options.dependentRuns,
      refusal: options.refusal,
      now: new Date(nowMs).toISOString(),
    })
    for (let attempt = 0; attempt < INGEST_ATTEMPTS; attempt += 1) {
      const current = attempt === 0
        ? previous
        : this.store.windowState(fact.connectionId, fact.window, accountId)
      const result = attempt === 0
        ? evaluation
        : evaluateQuota({
            fact,
            previous: current,
            config: options.config,
            dependentRuns: options.dependentRuns,
            refusal: options.refusal,
            now: new Date(nowMs).toISOString(),
          })
      try {
        return this.store.recordEvaluation(
          accountId,
          result.state,
          result.alerts,
          { type: 'connection', id: fact.connectionId },
          { expectedObservedAt: current?.lastObservedAt ?? null },
        )
      } catch (error) {
        if (error instanceof NotificationStoreError && error.code === 'state_conflict') continue
        throw error
      }
    }
    throw new NotificationStoreError('state_conflict', 'Quota window kept changing during evaluation')
  }
}
