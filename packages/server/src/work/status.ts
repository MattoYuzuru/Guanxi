import type {
  AcceptanceResultEvent, Capacity, DerivedItem, DerivedStatus, DerivedStatuses,
  EvidenceEvent, ItemSpec, JudgeVerdict, PlanRevision, StatusWarning, StripView,
} from './types.ts'
import { WorkError } from './types.ts'

const ACTIVE: readonly DerivedStatus[] = ['in_progress', 'verification_requested']

interface Decision {
  decision: 'accepted' | 'rejected'
  index: number
}

interface Runtime {
  claimed: boolean
  verification: boolean
  acceptance: { event: AcceptanceResultEvent; index: number } | null
  commits: Set<string>
  lastClaimIndex: number | null
  lastFailureIndex: number | null
  lastFailureKind: 'acceptance' | 'judge' | null
  lastPassIndex: number | null
  human: 'done' | 'reopen' | 'cancel' | null
}

function runtime(): Runtime {
  return {
    claimed: false,
    verification: false,
    acceptance: null,
    commits: new Set(),
    lastClaimIndex: null,
    lastFailureIndex: null,
    lastFailureKind: null,
    lastPassIndex: null,
    human: null,
  }
}

function reset(state: Runtime): void {
  state.claimed = false
  state.verification = false
  state.acceptance = null
  state.commits.clear()
  state.lastClaimIndex = null
  state.lastFailureIndex = null
  state.lastFailureKind = null
  state.lastPassIndex = null
  state.human = 'reopen'
}

function apply(state: Runtime, event: EvidenceEvent, index: number): void {
  // Cancel is terminal until a reopen; the append path enforces the same rule.
  if (state.human === 'cancel' && !(event.type === 'human_decision' && event.decision === 'reopen')) return
  switch (event.type) {
    case 'claimed':
      state.claimed = true
      state.lastClaimIndex = index
      return
    case 'released':
      state.claimed = false
      return
    case 'verification_requested':
      state.verification = true
      return
    case 'acceptance_result': {
      state.acceptance = { event, index }
      if (event.passed) {
        state.lastPassIndex = index
      } else if (state.lastClaimIndex !== null && state.lastClaimIndex < index) {
        state.lastFailureIndex = index
        state.lastFailureKind = 'acceptance'
      }
      return
    }
    case 'commit_accepted':
      state.commits.add(event.commit)
      return
    case 'judge_verdict': {
      const verdict: JudgeVerdict = event.verdict
      if (verdict === 'fail') {
        state.lastFailureIndex = index
        state.lastFailureKind = 'judge'
      } else if (verdict === 'pass') {
        state.lastPassIndex = index
      }
      return
    }
    case 'human_decision':
      if (event.decision === 'reopen') {
        reset(state)
      } else {
        state.human = event.decision
      }
      return
    case 'proposed':
    case 'accepted':
    case 'rejected':
      return
  }
}

function baseStatus(state: Runtime, item: ItemSpec): { status: DerivedStatus; reason: string } {
  if (state.human === 'done') return { status: 'done', reason: 'human_done' }
  if (state.human === 'cancel') return { status: 'canceled', reason: 'human_canceled' }
  const failed = state.lastFailureIndex !== null
    && (state.lastPassIndex === null || state.lastFailureIndex > state.lastPassIndex)
  if (failed) {
    return {
      status: 'failed',
      reason: state.lastFailureKind === 'judge' ? 'judge_failed' : 'acceptance_failed',
    }
  }
  const acceptance = state.acceptance
  if (acceptance !== null && item.acceptance !== null
    && acceptance.event.passed && acceptance.event.cleanCheckout
    && state.commits.has(acceptance.event.commit)) {
    return { status: 'done', reason: 'acceptance_passed_clean_commit' }
  }
  return { status: 'ready', reason: 'pending_dependency_state' }
}

/**
 * Derive status exclusively from evidence (ADR-0032 §2).
 *
 * Events are consumed in append order. `reopen` is a barrier: it discards the prior claim,
 * acceptance, commit and judge state so old evidence cannot immediately close the item again.
 * Dependency blocking is evaluated after terminal states, and uses only `done` dependencies.
 * Events for ids that were never planned or proposed are ignored and listed in `warnings`.
 */
export function deriveStatuses(plan: PlanRevision, events: EvidenceEvent[]): DerivedStatuses {
  const planned = new Map(plan.items.map(item => [item.id, item]))
  const proposals = new Set<string>()
  const decisions = new Map<string, Decision>()
  const warnings: StatusWarning[] = []
  const graph: Array<{ spec: ItemSpec; proposed: boolean; order: number }> =
    plan.items.map((spec, order) => ({ spec, proposed: false, order }))
  const evidenceByItem = new Map<string, EvidenceEvent[]>()

  // First pass: discovery. Forward references are legal because the store appends proposals
  // as ordinary events; a later accept/reject never changes the item spec.
  events.forEach((event, index) => {
    if (event.type === 'proposed') {
      if (planned.has(event.itemId) || proposals.has(event.itemId)) {
        warnings.push({ itemId: event.itemId, type: event.type, reason: 'duplicate_proposal' })
        return
      }
      proposals.add(event.itemId)
      graph.push({ spec: event.item, proposed: true, order: graph.length })
      return
    }
    if (event.type === 'accepted' || event.type === 'rejected') {
      if (proposals.has(event.itemId)) decisions.set(event.itemId, { decision: event.type, index })
    }
  })

  const known = new Set<string>([...planned.keys(), ...proposals])
  events.forEach(event => {
    if (!known.has(event.itemId)) {
      warnings.push({ itemId: event.itemId, type: event.type, reason: 'unknown_item' })
      return
    }
    const list = evidenceByItem.get(event.itemId)
    if (list) list.push(event)
    else evidenceByItem.set(event.itemId, [event])
  })

  const result = new Map<string, DerivedItem>() as DerivedStatuses
  result.warnings = warnings
  const base = new Map<string, { status: DerivedStatus; reason: string }>()
  const states = new Map<string, Runtime>()

  for (const entry of graph) {
    if (entry.proposed) {
      const decision = decisions.get(entry.spec.id)
      if (decision?.decision === 'rejected') continue
      if (!decision) {
        base.set(entry.spec.id, { status: 'proposed', reason: 'proposed' })
        continue
      }
    }
    const state = runtime()
    const start = entry.proposed ? (decisions.get(entry.spec.id)?.index ?? -1) + 1 : 0
    for (let index = start; index < events.length; index++) {
      const event = events[index]!
      if (event.itemId !== entry.spec.id) continue
      apply(state, event, index)
    }
    states.set(entry.spec.id, state)
    base.set(entry.spec.id, baseStatus(state, entry.spec))
  }

  const done = new Set([...base].filter(([, value]) => value.status === 'done').map(([id]) => id))
  const retained = graph.filter(entry => base.has(entry.spec.id))
  result.items = retained.map(entry => entry.spec)
  result.orders = retained.map(entry => entry.order)
  for (const entry of graph) {
    const pre = base.get(entry.spec.id)
    if (!pre) continue
    let status = pre.status
    let reason = pre.reason
    if (status === 'ready') {
      const missing = entry.spec.dependsOn.filter(id => !done.has(id))
      if (missing.length > 0) {
        status = 'blocked'
        reason = 'dependency_blocked'
      } else {
        // `ready` is the base placeholder for every non-terminal state.
        const state = states.get(entry.spec.id)!
        if (state.verification) {
          status = 'verification_requested'
          reason = 'verification_requested'
        } else if (state.claimed) {
          status = 'in_progress'
          reason = 'claimed'
        } else {
          status = 'ready'
          reason = 'ready'
        }
      }
    }
    result.set(entry.spec.id, {
      status,
      reason,
      evidence: evidenceByItem.get(entry.spec.id) ?? [],
    })
  }
  return result
}

/**
 * Pull the ready graph items under derived capacity (D-176): plan order, then accepted
 * proposals. Free slots are `min(freeWorktreeLeases, governorPermits) - inProgress`, never
 * negative. Reviewer-owned items draw from the aggregate remaining review slots
 * `sum(max(0, 3 - queue))`; the item model has no assignee, so the aggregate is the only
 * non-arbitrary per-person interpretation. No other numeric caps are applied.
 */
export function nextReady(
  statuses: ReadonlyMap<string, Pick<DerivedItem, 'status'>>,
  plan: PlanRevision,
  capacity: Capacity,
): ItemSpec[] {
  for (const [name, value] of Object.entries(capacity)) {
    if (name === 'reviewQueueByPerson') continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new WorkError('invalid_capacity', `capacity.${name} must be a non-negative number`)
    }
  }
  const free = Math.max(0, Math.min(capacity.freeWorktreeLeases, capacity.governorPermits) - capacity.inProgress)
  let reviewSlots = 0
  for (const value of Object.values(capacity.reviewQueueByPerson)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new WorkError('invalid_capacity', 'reviewQueueByPerson values must be finite numbers')
    }
    reviewSlots += Math.max(0, 3 - Math.max(0, Math.floor(value)))
  }
  const graph = (statuses as Partial<DerivedStatuses>).items ?? plan.items
  const result: ItemSpec[] = []
  for (const item of graph) {
    if (result.length >= free) break
    if (statuses.get(item.id)?.status !== 'ready') continue
    if (item.ownerRole === 'reviewer') {
      if (reviewSlots <= 0) continue
      reviewSlots--
    }
    result.push(item)
  }
  return result
}

/** Build the compact projection used by the strip. */
export function workView(
  plan: PlanRevision,
  statuses: ReadonlyMap<string, DerivedItem>,
): StripView {
  const graph = (statuses as Partial<DerivedStatuses>).items
  const items = graph && graph.length > 0 ? graph : plan.items
  const statusOf = (id: string): DerivedStatus | null => statuses.get(id)?.status ?? null
  const ordered = items
    .map(item => ({ item, status: statusOf(item.id) }))
    .filter((entry): entry is { item: ItemSpec; status: DerivedStatus } => entry.status !== null)
  const current = ordered.find(entry => ACTIVE.includes(entry.status))
    ?? ordered.find(entry => entry.status === 'blocked')
    ?? ordered.find(entry => entry.status === 'ready')
    ?? null
  const next = ordered.find(entry => entry.status === 'ready' && entry.item.id !== current?.item.id) ?? null
  const blocking = ordered
    .filter(entry => entry.status === 'blocked')
    .map(entry => ({
      id: entry.item.id,
      title: entry.item.title,
      blockedBy: entry.item.dependsOn.filter(id => statusOf(id) !== 'done'),
    }))
  const project = (entry: { item: ItemSpec; status: DerivedStatus } | null) => entry === null ? null : {
    id: entry.item.id,
    title: entry.item.title,
    acceptance: entry.item.acceptance,
    status: entry.status,
  }
  return { current: project(current), next: project(next), blocking }
}
