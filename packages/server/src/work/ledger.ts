/**
 * The ledger facade the REST routes and kernel callers share. It joins the WG1-a store to the
 * pure derivation, query and export functions, and it fixes the provenance of everything a human
 * appends so that no caller can supply a producer identity.
 */
import { exportMarkdown } from './export.ts'
import { query, type QueryOptions, type QueryPage } from './query.ts'
import { deriveStatuses } from './status.ts'
import type { WorkStore } from './store.ts'
import {
  WorkError,
  type Activation,
  type EvidenceEvent,
  type ItemSpec,
  type PlanRevision,
  type StatusWarning,
  type StoredEvidenceEvent,
  type WorkMode,
} from './types.ts'

/** Events a human may append over the wire (D-172). The rest enter through kernel services. */
export type HumanEventInput =
  | { type: 'accepted'; itemId: string }
  | { type: 'rejected'; itemId: string }
  | { type: 'human_decision'; itemId: string; decision: 'done' | 'reopen' | 'cancel' }

export interface WorkItemsPage extends QueryPage {
  revision: number | null
  warnings: StatusWarning[]
}

export class WorkLedger {
  readonly store: WorkStore
  private readonly now: () => number

  constructor(store: WorkStore, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  latest(projectId: string): PlanRevision | null {
    return this.store.latestRevision(projectId)
  }

  /** The author of a revision written by a person is always `user`. */
  addRevision(projectId: string, items: ItemSpec[]): PlanRevision {
    return this.store.addRevision({ projectId, author: 'user', items })
  }

  /**
   * Appends a human event under `user:<account>`, stamped with the node clock. The item must
   * exist in the derived graph (a pending proposal for accept/reject), so a typo or a replayed
   * request cannot leave unattributable evidence in an append-only table.
   */
  appendHumanEvent(accountId: string, projectId: string, input: HumanEventInput): StoredEvidenceEvent {
    const plan = this.store.latestRevision(projectId)
    if (plan === null) throw new WorkError('revision_not_found', 'no plan revision')
    const derived = deriveStatuses(plan, this.store.events(projectId))
    const current = derived.get(input.itemId)
    if (current === undefined) throw new WorkError('item_not_found', 'unknown item')
    if ((input.type === 'accepted' || input.type === 'rejected') && current.status !== 'proposed') {
      throw new WorkError('invalid_proposal', 'item is not a pending proposal')
    }
    const event: EvidenceEvent = {
      ...input,
      at: new Date(this.now()).toISOString(),
      source: `user:${accountId}`,
    }
    return this.store.appendEvent(projectId, event)
  }

  page(projectId: string, options: QueryOptions): WorkItemsPage {
    const plan = this.store.latestRevision(projectId)
    if (plan === null) return { revision: null, items: [], nextCursor: null, total: 0, warnings: [] }
    const derived = deriveStatuses(plan, this.store.events(projectId))
    return { revision: plan.revision, ...query(derived, plan, options), warnings: derived.warnings }
  }

  mode(projectId: string): Activation {
    return this.store.activation(projectId)
  }

  setMode(projectId: string, mode: WorkMode, reason: string): Activation {
    return this.store.setMode(projectId, mode, reason)
  }

  /** On-demand projection of the latest revision (D-174); nothing is written to disk. */
  exportMarkdown(projectId: string): { revision: number; markdown: string } {
    const plan = this.store.latestRevision(projectId)
    if (plan === null) throw new WorkError('revision_not_found', 'no plan revision')
    return { revision: plan.revision, markdown: exportMarkdown(plan, deriveStatuses(plan, this.store.events(projectId))) }
  }
}
