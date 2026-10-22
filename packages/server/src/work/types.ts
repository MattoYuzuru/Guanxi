/**
 * Project work ledger vocabulary (WG1-a).
 *
 * This is the project-mode core next to the relay's run-mode ledger. A plan revision is
 * immutable; every state transition is evidence supplied by the harness, an executor, a
 * judge or a human. Nothing here writes files or talks to a tracker.
 */

export const WORK_MODES = ['off', 'run', 'project'] as const
export type WorkMode = (typeof WORK_MODES)[number]

export const OWNER_ROLES = ['lead', 'executor', 'reviewer'] as const
export type OwnerRole = (typeof OWNER_ROLES)[number]

export const PLAN_AUTHORS = ['user', 'lead'] as const
export type PlanAuthor = (typeof PLAN_AUTHORS)[number]

export interface ItemSpec {
  /** Stable within a plan revision; proposals reuse the same namespace. */
  id: string
  title: string
  /** Executable definition of done. `null` means only a human decision can close it. */
  acceptance: string | null
  dependsOn: string[]
  estimateMinutes: number | null
  ownerRole: OwnerRole | null
  protectedPaths: string[]
}

/** Immutable once stored by `WorkStore.addRevision`. */
export interface PlanRevision {
  projectId: string
  revision: number
  createdAt: string
  author: PlanAuthor
  items: ItemSpec[]
}

export interface RevisionInput {
  projectId: string
  author: PlanAuthor
  items: ItemSpec[]
}

export const DERIVED_STATUSES = [
  'proposed',
  'blocked',
  'ready',
  'in_progress',
  'verification_requested',
  'done',
  'failed',
  'canceled',
] as const
export type DerivedStatus = (typeof DERIVED_STATUSES)[number]

export type HumanDecision = 'done' | 'reopen' | 'cancel'
export type JudgeVerdict = 'pass' | 'fail' | 'escalate'

interface EvidenceBase {
  itemId: string
  /** ISO-8601 string or epoch milliseconds supplied by the producer. */
  at: string | number
  /** Producer identity, for example `agent`, `executor`, `lead`, `user`, `judge`, `harness`. */
  source: string
}

/** D-172: an agent proposes work; it is not part of the graph until `accepted`. */
export interface ProposedEvent extends EvidenceBase {
  type: 'proposed'
  item: ItemSpec
}
export interface AcceptedEvent extends EvidenceBase {
  type: 'accepted'
}
export interface RejectedEvent extends EvidenceBase {
  type: 'rejected'
}
export interface ClaimedEvent extends EvidenceBase {
  type: 'claimed'
}
export interface ReleasedEvent extends EvidenceBase {
  type: 'released'
}
/** An agent says "done". This never completes the item by itself. */
export interface VerificationRequestedEvent extends EvidenceBase {
  type: 'verification_requested'
}
export interface AcceptanceResultEvent extends EvidenceBase {
  type: 'acceptance_result'
  passed: boolean
  commit: string
  cleanCheckout: boolean
  command: string
}
export interface CommitAcceptedEvent extends EvidenceBase {
  type: 'commit_accepted'
  commit: string
}
export interface JudgeVerdictEvent extends EvidenceBase {
  type: 'judge_verdict'
  verdict: JudgeVerdict
}
export interface HumanDecisionEvent extends EvidenceBase {
  type: 'human_decision'
  decision: HumanDecision
}

export type EvidenceEvent =
  | ProposedEvent
  | AcceptedEvent
  | RejectedEvent
  | ClaimedEvent
  | ReleasedEvent
  | VerificationRequestedEvent
  | AcceptanceResultEvent
  | CommitAcceptedEvent
  | JudgeVerdictEvent
  | HumanDecisionEvent

export type EvidenceEventType = EvidenceEvent['type']

/** The append-only store adds its monotonic sequence to the stored payload. */
export type StoredEvidenceEvent = EvidenceEvent & { readonly seq: number }

export interface DerivedItem {
  status: DerivedStatus
  /** Stable code explaining the transition, for example `dependency_blocked`. */
  reason: string
  /** Events for this item in append order. */
  evidence: EvidenceEvent[]
}

export interface StatusWarning {
  itemId: string
  type: string
  reason: 'unknown_item' | 'invalid_proposal' | 'duplicate_proposal'
}

/**
 * A `Map` for the required signature with two additive views:
 * `warnings` is never thrown, and `items` is the graph order including accepted proposals.
 * Map values keep exactly `{ status, reason, evidence }`.
 */
export interface DerivedStatuses extends Map<string, DerivedItem> {
  warnings: StatusWarning[]
  items: ItemSpec[]
  /** Stable creation order parallel to `items`; rejected proposals leave gaps. */
  orders: number[]
}

export interface Activation {
  projectId: string
  mode: WorkMode
  reason: string
}

export interface ActivationInput {
  executors: number
  linkedTracker: boolean
  backlogOpened: boolean
}

export interface Capacity {
  freeWorktreeLeases: number
  governorPermits: number
  inProgress: number
  /** Currently open review items per person. D-176 caps each queue at three. */
  reviewQueueByPerson: Record<string, number>
}

export interface StripWorkItem {
  id: string
  title: string
  acceptance: string | null
  status: DerivedStatus
}

export interface StripBlockingIssue {
  id: string
  title: string
  blockedBy: string[]
}

/** The bounded context projection. `workView` derives one from a plan and its statuses. */
export interface StripView {
  current: StripWorkItem | null
  next: StripWorkItem | null
  blocking: StripBlockingIssue[]
}

export class WorkError extends Error {
  readonly code: string
  readonly cycle?: string[]
  readonly details?: unknown
  constructor(code: string, message: string, options: { cycle?: string[]; details?: unknown } = {}) {
    super(`${code}: ${message}`)
    this.name = 'WorkError'
    this.code = code
    this.cycle = options.cycle
    this.details = options.details
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkError('invalid_shape', `${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, what: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string' || (!options.allowEmpty && value.trim() === '')) {
    throw new WorkError('invalid_shape', `${what} must be ${options.allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new WorkError('invalid_shape', `${what} must be an array of strings`)
  }
  return [...value] as string[]
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new WorkError('invalid_shape', `${what} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

/** Validate and normalise an item. Unknown fields are dropped so stored JSON is canonical. */
export function parseItemSpec(value: unknown, what = 'item'): ItemSpec {
  const input = record(value, what)
  const id = text(input.id, `${what}.id`)
  const title = text(input.title, `${what}.title`)
  const acceptance = input.acceptance === null || input.acceptance === undefined
    ? null
    : text(input.acceptance, `${what}.acceptance`, { allowEmpty: true })
  const dependsOn = stringList(input.dependsOn ?? [], `${what}.dependsOn`)
  let estimateMinutes: number | null = null
  if (input.estimateMinutes !== null && input.estimateMinutes !== undefined) {
    if (typeof input.estimateMinutes !== 'number' || !Number.isFinite(input.estimateMinutes) || input.estimateMinutes < 0) {
      throw new WorkError('invalid_shape', `${what}.estimateMinutes must be null or a non-negative number`)
    }
    estimateMinutes = input.estimateMinutes
  }
  const ownerRole = input.ownerRole === null || input.ownerRole === undefined
    ? null
    : oneOf(input.ownerRole, OWNER_ROLES, `${what}.ownerRole`)
  const protectedPaths = stringList(input.protectedPaths ?? [], `${what}.protectedPaths`)
  return { id, title, acceptance, dependsOn, estimateMinutes, ownerRole, protectedPaths }
}

function timestamp(value: unknown, what: string): string | number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkError('invalid_shape', `${what} must be a finite timestamp`)
    return value
  }
  const at = text(value, what)
  if (!Number.isFinite(Date.parse(at))) throw new WorkError('invalid_shape', `${what} must be an ISO-8601 timestamp or epoch milliseconds`)
  return at
}

/** Validate shape for an append. Unknown fields and timestamps are not trusted as state. */
export function parseEvidenceEvent(value: unknown): EvidenceEvent {
  const input = record(value, 'event')
  const type = oneOf(input.type, [
    'proposed', 'accepted', 'rejected', 'claimed', 'released', 'verification_requested',
    'acceptance_result', 'commit_accepted', 'judge_verdict', 'human_decision',
  ] as const, 'event.type')
  const itemId = text(input.itemId, 'event.itemId')
  const at = timestamp(input.at, 'event.at')
  const source = text(input.source, 'event.source')
  const base = { itemId, at, source }
  switch (type) {
    case 'proposed': {
      const item = parseItemSpec(input.item, 'event.item')
      if (item.id !== itemId) throw new WorkError('invalid_shape', 'event.item.id must equal event.itemId')
      return { ...base, type, item }
    }
    case 'accepted':
    case 'rejected':
    case 'claimed':
    case 'released':
    case 'verification_requested':
      return { ...base, type }
    case 'acceptance_result':
      if (typeof input.passed !== 'boolean' || typeof input.cleanCheckout !== 'boolean') {
        throw new WorkError('invalid_shape', 'acceptance_result passed/cleanCheckout must be booleans')
      }
      return {
        ...base, type,
        passed: input.passed,
        cleanCheckout: input.cleanCheckout,
        commit: text(input.commit, 'event.commit'),
        command: text(input.command, 'event.command', { allowEmpty: true }),
      }
    case 'commit_accepted':
      return { ...base, type, commit: text(input.commit, 'event.commit') }
    case 'judge_verdict':
      return { ...base, type, verdict: oneOf(input.verdict, ['pass', 'fail', 'escalate'] as const, 'event.verdict') }
    case 'human_decision':
      return { ...base, type, decision: oneOf(input.decision, ['done', 'reopen', 'cancel'] as const, 'event.decision') }
  }
}

export function parsePlanAuthor(value: unknown): PlanAuthor {
  return oneOf(value, PLAN_AUTHORS, 'author')
}

export function parseWorkMode(value: unknown): WorkMode {
  return oneOf(value, WORK_MODES, 'mode')
}

export function parseDerivedStatus(value: unknown): DerivedStatus {
  return oneOf(value, DERIVED_STATUSES, 'status')
}
