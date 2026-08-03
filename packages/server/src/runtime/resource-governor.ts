import { randomUUID } from 'node:crypto'

export const RESOURCE_GOVERNOR_CLOSE_REASON = 'resource_governor_shutdown'

export type ResourceOperation =
  | 'chat'
  | 'compaction'
  | 'model_warm'
  | 'model_prewarm'
  | 'model_probe'
export type AdmissionPriority = 'normal' | 'prewarm'

export type ResourceOwner =
  | Readonly<{ kind: 'job'; jobId: string }>
  | Readonly<{ kind: 'operation'; operationId: string }>

export interface ModelResourceRequest {
  readonly provider: 'ollama'
  readonly name: string
}

export interface AdmissionRequest {
  readonly owner: ResourceOwner
  readonly operation: ResourceOperation
  readonly model: ModelResourceRequest
  readonly requestedContext: number
  readonly priority: AdmissionPriority
  readonly enqueuedAt: string
}

export type AdmissionTicketState = 'queued' | 'active' | 'cancelled' | 'released'

export interface AdmissionTicket {
  readonly id: string
  readonly request: AdmissionRequest
  readonly state: AdmissionTicketState
}

export interface ResourceLease {
  readonly id: string
  readonly ticketId: string
  readonly owner: ResourceOwner
  readonly operation: ResourceOperation
  readonly model: ModelResourceRequest
  readonly requestedContext: number
  readonly priority: AdmissionPriority
  readonly acquiredAt: string
  readonly releasedAt: string | null
  readonly state: 'active' | 'released'
  /** Idempotent: duplicate cleanup cannot release a later owner. */
  release(): void
}

export type GovernorDecisionCode =
  | 'queued_fifo'
  | 'admitted_single_permit'
  | 'cancelled_waiting'
  | 'released'
  | 'admission_closed'
  | 'unload_active_model'
  | 'unload_conservative_active_owner'
  | 'prewarm_skipped_normal_work'
  | 'prewarm_preempted_by_normal'
  | 'unknown_ticket'

export interface AdmissionExplanation {
  readonly ticketId: string | null
  readonly decisionCode: GovernorDecisionCode
  readonly observedAt: string
  readonly policyBasis: typeof SINGLE_PERMIT_POLICY_BASIS
  readonly owner: ResourceOwner | null
  readonly operation: ResourceOperation | null
  readonly model: ModelResourceRequest | null
  readonly requestedContext: number | null
  readonly priority: AdmissionPriority | null
  readonly queuePosition: number | null
}

export interface ResourceGovernorSnapshot {
  readonly observedAt: string
  readonly accepting: boolean
  readonly policy: {
    readonly acceleratorPermits: 1
    readonly order: 'priority_fifo'
    readonly priorities: readonly ['normal', 'prewarm']
    readonly scope: 'application_process'
    readonly basis: typeof SINGLE_PERMIT_POLICY_BASIS
  }
  readonly queued: ReadonlyArray<{
    readonly ticketId: string
    readonly owner: ResourceOwner
    readonly operation: ResourceOperation
    readonly model: ModelResourceRequest
    readonly requestedContext: number
    readonly priority: AdmissionPriority
    readonly enqueuedAt: string
    readonly reason: 'single_permit_busy' | 'fifo_predecessor'
  }>
  readonly activeLease: {
    readonly leaseId: string
    readonly ticketId: string
    readonly owner: ResourceOwner
    readonly operation: ResourceOperation
    readonly model: ModelResourceRequest
    readonly requestedContext: number
    readonly priority: AdmissionPriority
    readonly acquiredAt: string
    readonly state: 'active'
  } | null
  readonly lastDecision: AdmissionExplanation | null
}

export interface AcquireOptions {
  readonly signal?: AbortSignal
  /** Execution-owner hook used only by graceful application shutdown. */
  readonly abortOwner?: () => void
  /** Exact low-priority owner hook used only when normal work preempts prewarm. */
  readonly preemptOwner?: () => void
}

export interface ResourceGovernorOptions {
  readonly now?: () => Date
  readonly createId?: () => string
}

export const SINGLE_PERMIT_POLICY_BASIS =
  'conservative_single_process_single_accelerator_permit_normal_before_prewarm_fifo' as const

export type ResourceGovernorErrorCode =
  | 'admission_closed'
  | 'invalid_admission_request'
  | 'invalid_admission_ticket'
  | 'unload_active_model'
  | 'unload_conservative_active_owner'
  | 'prewarm_normal_work_present'

export class ResourceGovernorError extends Error {
  readonly code: ResourceGovernorErrorCode

  constructor(
    code: ResourceGovernorErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ResourceGovernorError'
    this.code = code
  }
}

interface TicketRecord {
  ticket: AdmissionTicket
  request: AdmissionRequest
  state: AdmissionTicketState
  resolve: ((lease: ResourceLease) => void) | null
  reject: ((error: Error) => void) | null
  signal: AbortSignal | undefined
  onAbort: (() => void) | null
  abortOwner: (() => void) | null
  preemptOwner: (() => void) | null
  preemptionRequested: boolean
}

interface LeaseRecord {
  lease: ResourceLease
  ticket: TicketRecord
  state: 'active' | 'released'
  releasedAt: string | null
}

function admissionCancelledError(): Error {
  const error = new Error('Resource admission was cancelled before lease acquisition')
  error.name = 'AbortError'
  return error
}

function freezeOwner(owner: ResourceOwner): ResourceOwner {
  return owner.kind === 'job'
    ? Object.freeze({ kind: 'job', jobId: owner.jobId })
    : Object.freeze({ kind: 'operation', operationId: owner.operationId })
}

function freezeRequest(request: AdmissionRequest): AdmissionRequest {
  return Object.freeze({
    owner: freezeOwner(request.owner),
    operation: request.operation,
    model: Object.freeze({ provider: request.model.provider, name: request.model.name }),
    requestedContext: request.requestedContext,
    priority: request.priority,
    enqueuedAt: request.enqueuedAt,
  })
}

function validateRequest(request: AdmissionRequest): void {
  const ownerId = request.owner.kind === 'job' ? request.owner.jobId : request.owner.operationId
  if (
    ownerId.trim().length === 0 ||
    request.model.provider !== 'ollama' ||
    request.model.name.trim().length === 0 ||
    !Number.isSafeInteger(request.requestedContext) ||
    request.requestedContext <= 0 ||
    (request.priority !== 'normal' && request.priority !== 'prewarm') ||
    Number.isNaN(Date.parse(request.enqueuedAt))
  ) {
    throw new ResourceGovernorError(
      'invalid_admission_request',
      'The resource admission request is invalid',
    )
  }
}

/**
 * Canonical process-local owner for every current model-affecting operation.
 *
 * One conservative accelerator lane with deterministic normal-before-prewarm
 * ordering. Normal work never gets preempted; it cancels queued prewarm or asks
 * the exact active prewarm owner to abort and waits for its release.
 */
export class ResourceGovernor {
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly tickets = new Map<string, TicketRecord>()
  private readonly queue: TicketRecord[] = []
  private activeLease: LeaseRecord | null = null
  private accepting = true
  private lastDecision: AdmissionExplanation | null = null
  private closePromise: Promise<void> | null = null
  private resolveClose: (() => void) | null = null

  constructor(options: ResourceGovernorOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
  }

  get active(): boolean {
    return this.activeLease !== null
  }

  get waiting(): number {
    return this.queue.length
  }

  enqueue(input: AdmissionRequest): AdmissionTicket {
    if (!this.accepting) {
      this.recordDecision('admission_closed', null)
      throw new ResourceGovernorError(
        'admission_closed',
        'Resource admission is closed during application shutdown',
      )
    }
    validateRequest(input)
    const request = freezeRequest(input)
    if (request.priority === 'prewarm' && this.hasNormalWork()) {
      this.recordRequestDecision('prewarm_skipped_normal_work', request)
      throw new ResourceGovernorError(
        'prewarm_normal_work_present',
        'Prewarm was skipped because normal resource work is present',
      )
    }
    const record = {} as TicketRecord
    const ticket: AdmissionTicket = Object.freeze({
      id: this.createId(),
      request,
      get state() {
        return record.state
      },
    })
    Object.assign(record, {
      ticket,
      request,
      state: 'queued' as const,
      resolve: null,
      reject: null,
      signal: undefined,
      onAbort: null,
      abortOwner: null,
      preemptOwner: null,
      preemptionRequested: false,
    })
    this.tickets.set(ticket.id, record)
    this.queue.push(record)
    this.recordDecision('queued_fifo', record)
    if (request.priority === 'normal') this.preemptPrewarmForNormal()
    return ticket
  }

  acquire(ticket: AdmissionTicket, options: AcquireOptions = {}): Promise<ResourceLease> {
    if (!this.accepting) {
      return Promise.reject(
        new ResourceGovernorError(
          'admission_closed',
          'Resource admission is closed during application shutdown',
        ),
      )
    }
    const record = this.tickets.get(ticket.id)
    if (!record || record.ticket !== ticket) {
      return Promise.reject(
        new ResourceGovernorError(
          'invalid_admission_ticket',
          'The resource admission ticket is not owned by this governor',
        ),
      )
    }
    if (record.state === 'active' && this.activeLease?.ticket === record) {
      return Promise.resolve(this.activeLease.lease)
    }
    if (record.state !== 'queued' || record.resolve) {
      return Promise.reject(
        new ResourceGovernorError(
          'invalid_admission_ticket',
          'The resource admission ticket cannot be acquired again',
        ),
      )
    }
    if (options.signal?.aborted) {
      this.cancelRecord(record, admissionCancelledError())
      return Promise.reject(admissionCancelledError())
    }

    return new Promise<ResourceLease>((resolve, reject) => {
      record.resolve = resolve
      record.reject = reject
      record.signal = options.signal
      record.abortOwner = options.abortOwner ?? null
      record.preemptOwner = options.preemptOwner ?? null
      if (options.signal) {
        record.onAbort = () => this.cancelRecord(record, admissionCancelledError())
        options.signal.addEventListener('abort', record.onAbort, { once: true })
      }
      this.admitNext()
    })
  }

  cancel(ticket: AdmissionTicket): boolean {
    const record = this.tickets.get(ticket.id)
    if (!record || record.ticket !== ticket || record.state !== 'queued') return false
    this.cancelRecord(record, admissionCancelledError())
    return true
  }

  snapshot(observedAt = this.timestamp()): ResourceGovernorSnapshot {
    const active = this.activeLease
    return {
      observedAt,
      accepting: this.accepting,
      policy: {
        acceleratorPermits: 1,
        order: 'priority_fifo',
        priorities: ['normal', 'prewarm'],
        scope: 'application_process',
        basis: SINGLE_PERMIT_POLICY_BASIS,
      },
      queued: this.queue.map((record, index) => ({
        ticketId: record.ticket.id,
        owner: record.request.owner,
        operation: record.request.operation,
        model: record.request.model,
        requestedContext: record.request.requestedContext,
        priority: record.request.priority,
        enqueuedAt: record.request.enqueuedAt,
        reason: active || index > 0 ? 'single_permit_busy' : 'fifo_predecessor',
      })),
      activeLease: active
        ? {
            leaseId: active.lease.id,
            ticketId: active.ticket.ticket.id,
            owner: active.ticket.request.owner,
            operation: active.ticket.request.operation,
            model: active.ticket.request.model,
            requestedContext: active.ticket.request.requestedContext,
            priority: active.ticket.request.priority,
            acquiredAt: active.lease.acquiredAt,
            state: 'active',
          }
        : null,
      lastDecision: this.lastDecision,
    }
  }

  explain(ticketId: string): AdmissionExplanation {
    const record = this.tickets.get(ticketId)
    if (record) {
      const index = this.queue.indexOf(record)
      return this.explanation(
        record.state === 'active' ? 'admitted_single_permit' : 'queued_fifo',
        record,
        index === -1 ? null : index + 1,
      )
    }
    if (this.lastDecision?.ticketId === ticketId) return this.lastDecision
    return this.explanation('unknown_ticket', null, null, ticketId)
  }

  assertCanUnload(model: ModelResourceRequest): void {
    const active = this.activeLease
    if (!active) return
    const exact =
      active.ticket.request.model.provider === model.provider &&
      active.ticket.request.model.name === model.name
    const code = exact ? 'unload_active_model' : 'unload_conservative_active_owner'
    this.recordDecision(code, active.ticket)
    throw new ResourceGovernorError(
      code,
      exact
        ? 'The model cannot be unloaded while it has an active resource lease'
        : 'Model unload is blocked while the conservative accelerator lane has an active owner',
    )
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.accepting = false
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve
    })

    for (const record of [...this.queue]) {
      const abortOwner = record.abortOwner
      this.cancelRecord(
        record,
        new ResourceGovernorError(
          'admission_closed',
          'Resource admission is closed during application shutdown',
        ),
      )
      abortOwner?.()
    }
    this.activeLease?.ticket.abortOwner?.()
    this.finishCloseIfIdle()
    return this.closePromise
  }

  private admitNext(): void {
    if (!this.accepting || this.activeLease) return
    while (true) {
      const record = this.queue[0]
      if (!record || !record.resolve) return
      if (record.signal?.aborted) {
        this.cancelRecord(record, admissionCancelledError())
        continue
      }

      this.queue.shift()
      this.removeAbortListener(record)
      record.state = 'active'
      const leaseRecord = {} as LeaseRecord
      const acquiredAt = this.timestamp()
      const lease: ResourceLease = Object.freeze({
        id: this.createId(),
        ticketId: record.ticket.id,
        owner: record.request.owner,
        operation: record.request.operation,
        model: record.request.model,
        requestedContext: record.request.requestedContext,
        priority: record.request.priority,
        acquiredAt,
        get releasedAt() {
          return leaseRecord.releasedAt
        },
        get state() {
          return leaseRecord.state
        },
        release: () => this.releaseLease(leaseRecord),
      })
      Object.assign(leaseRecord, {
        lease,
        ticket: record,
        state: 'active' as const,
        releasedAt: null,
      })
      this.activeLease = leaseRecord
      const resolve = record.resolve
      record.resolve = null
      record.reject = null
      this.recordDecision('admitted_single_permit', record)
      resolve(lease)
      return
    }
  }

  private releaseLease(record: LeaseRecord): void {
    if (record.state === 'released') return
    record.state = 'released'
    record.releasedAt = this.timestamp()
    record.ticket.state = 'released'
    record.ticket.abortOwner = null
    record.ticket.preemptOwner = null
    record.ticket.signal = undefined
    if (this.activeLease === record) this.activeLease = null
    this.tickets.delete(record.ticket.ticket.id)
    this.recordDecision('released', record.ticket)
    this.admitNext()
    this.finishCloseIfIdle()
  }

  private cancelRecord(
    record: TicketRecord,
    error: Error,
    decisionCode?: GovernorDecisionCode,
  ): void {
    if (record.state !== 'queued') return
    const index = this.queue.indexOf(record)
    if (index !== -1) this.queue.splice(index, 1)
    this.removeAbortListener(record)
    record.state = 'cancelled'
    this.tickets.delete(record.ticket.id)
    const reject = record.reject
    record.resolve = null
    record.reject = null
    record.abortOwner = null
    record.preemptOwner = null
    record.signal = undefined
    this.recordDecision(
      decisionCode ??
        (error instanceof ResourceGovernorError && error.code === 'admission_closed'
          ? 'admission_closed'
          : 'cancelled_waiting'),
      record,
    )
    reject?.(error)
    this.admitNext()
    this.finishCloseIfIdle()
  }

  private removeAbortListener(record: TicketRecord): void {
    if (record.signal && record.onAbort) {
      record.signal.removeEventListener('abort', record.onAbort)
    }
    record.onAbort = null
  }

  private recordDecision(code: GovernorDecisionCode, record: TicketRecord | null): void {
    this.lastDecision = this.explanation(code, record, null)
  }

  private explanation(
    decisionCode: GovernorDecisionCode,
    record: TicketRecord | null,
    queuePosition: number | null,
    ticketId = record?.ticket.id ?? null,
  ): AdmissionExplanation {
    return Object.freeze({
      ticketId,
      decisionCode,
      observedAt: this.timestamp(),
      policyBasis: SINGLE_PERMIT_POLICY_BASIS,
      owner: record?.request.owner ?? null,
      operation: record?.request.operation ?? null,
      model: record?.request.model ?? null,
      requestedContext: record?.request.requestedContext ?? null,
      priority: record?.request.priority ?? null,
      queuePosition,
    })
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private hasNormalWork(): boolean {
    return Boolean(
      this.activeLease?.ticket.request.priority === 'normal' ||
        this.queue.some((record) => record.request.priority === 'normal'),
    )
  }

  private preemptPrewarmForNormal(): void {
    for (const record of [...this.queue]) {
      if (record.request.priority !== 'prewarm') continue
      this.cancelRecord(record, admissionCancelledError(), 'prewarm_preempted_by_normal')
    }

    const active = this.activeLease?.ticket
    if (!active || active.request.priority !== 'prewarm' || active.preemptionRequested) return
    active.preemptionRequested = true
    this.recordDecision('prewarm_preempted_by_normal', active)
    active.preemptOwner?.()
  }

  private recordRequestDecision(
    decisionCode: GovernorDecisionCode,
    request: AdmissionRequest,
  ): void {
    this.lastDecision = Object.freeze({
      ticketId: null,
      decisionCode,
      observedAt: this.timestamp(),
      policyBasis: SINGLE_PERMIT_POLICY_BASIS,
      owner: request.owner,
      operation: request.operation,
      model: request.model,
      requestedContext: request.requestedContext,
      priority: request.priority,
      queuePosition: null,
    })
  }

  private finishCloseIfIdle(): void {
    if (!this.accepting && !this.activeLease && this.queue.length === 0 && this.resolveClose) {
      const resolve = this.resolveClose
      this.resolveClose = null
      resolve()
    }
  }
}

export function operationOwner(operation: ResourceOperation): ResourceOwner {
  return Object.freeze({ kind: 'operation', operationId: `${operation}:${randomUUID()}` })
}
