/** Maps ledger values and failures to the `@guanxi/contract` wire shapes. */
import {
  appendWorkEventResponseSchema,
  latestWorkRevisionResponseSchema,
  workItemsPageSchema,
  workModeSnapshotSchema,
  workPlanRevisionSchema,
  type AppendWorkEventResponse,
  type WorkErrorCode,
  type WorkItemsPage as WorkItemsPageWire,
} from '@guanxi/contract'
import { commonFailure, type RouteFailure } from '../http/local-guard.ts'
import type { WorkItemsPage } from './ledger.ts'
import { WorkError, type Activation, type PlanRevision, type StoredEvidenceEvent } from './types.ts'

export const toPlanRevisionWire = (plan: PlanRevision) => workPlanRevisionSchema.parse(plan)
export const toLatestRevisionWire = (plan: PlanRevision | null) =>
  latestWorkRevisionResponseSchema.parse({ revision: plan === null ? null : toPlanRevisionWire(plan) })
export const toModeWire = (activation: Activation) => workModeSnapshotSchema.parse(activation)

export function toEventWire(stored: StoredEvidenceEvent): AppendWorkEventResponse {
  const { seq, ...event } = stored
  return appendWorkEventResponseSchema.parse({ seq, event })
}

export function toItemsPageWire(page: WorkItemsPage): WorkItemsPageWire {
  return workItemsPageSchema.parse(page)
}

const FAILURES: Record<string, RouteFailure> = {
  revision_not_found: { code: 'revision_not_found', status: 404 },
  item_not_found: { code: 'item_not_found', status: 404 },
  duplicate_item: { code: 'duplicate_item', status: 422 },
  missing_dependency: { code: 'missing_dependency', status: 422 },
  dependency_cycle: { code: 'dependency_cycle', status: 422 },
  invalid_proposal: { code: 'invalid_proposal', status: 422 },
  canceled: { code: 'item_canceled', status: 409 },
  invalid_cursor: { code: 'invalid_cursor', status: 400 },
  cursor_mismatch: { code: 'cursor_mismatch', status: 400 },
  invalid_paging: { code: 'validation_failed', status: 400 },
  invalid_shape: { code: 'validation_failed', status: 400 },
  invalid_revision: { code: 'validation_failed', status: 400 },
  invalid_event: { code: 'validation_failed', status: 400 },
  invalid_source: { code: 'validation_failed', status: 400 },
  invalid_activation: { code: 'validation_failed', status: 400 },
  schema_version: { code: 'work_unavailable', status: 503 },
}

/**
 * Codes only. `WorkError` messages quote item ids, dependency paths and commands, so none is
 * copied into a response.
 */
export function workFailure(error: unknown): RouteFailure {
  const common = commonFailure(error)
  if (common !== null) return common
  if (error instanceof WorkError) {
    return FAILURES[error.code] ?? { code: 'internal_error' satisfies WorkErrorCode, status: 500 }
  }
  return { code: 'internal_error', status: 500 }
}
