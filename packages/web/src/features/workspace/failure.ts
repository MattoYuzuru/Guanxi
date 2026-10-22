import { ROUTES } from '@guanxi/contract'
import { ApiRequestError, ApiShapeError } from '../../lib/api.ts'

const sources = {
  'kernel-ready': 'kernel-ready',
  'layout-context': `layout-context: GET ${ROUTES.layoutContext()}`,
  'load-developer-layouts': `load-developer-layouts: GET ${ROUTES.layouts()}`,
  'load-visual-layouts': `load-visual-layouts: GET ${ROUTES.layouts()}`,
  'resolve-layout': 'resolve-layout',
  'load-layout-geometry': `load-layout-geometry: GET ${ROUTES.layoutGeometry()}`,
  'snapshot-layout': 'snapshot-layout',
  'prepare-layout-save': 'prepare-layout-save',
  'activate-layout': `activate-layout: PUT ${ROUTES.layouts()}`,
  'activate-layout-geometry': `activate-layout-geometry: GET ${ROUTES.layoutGeometry()}`,
  'save-layout': `save-layout: PUT ${ROUTES.layouts()}`,
  'save-layout-geometry': `save-layout-geometry: PUT ${ROUTES.layoutGeometry()}`,
  'recover-layout-geometry': `recover-layout-geometry: GET ${ROUTES.layoutGeometry()}`,
  'load-workspace': 'load-workspace',
  'save-workspace': 'save-workspace',
} as const

export type WorkspaceOperation = keyof typeof sources
export interface WorkspaceFailure {
  operation: WorkspaceOperation
  source: string
  observedAt: string
  details: string
}

class ObservedFailure extends Error {
  constructor(readonly failure: WorkspaceFailure) { super('Workspace operation failed') }
}

/** Only static operation facts and typed status/code cross into the disclosure, never raw errors. */
export function workspaceFailure(error: unknown, operation: WorkspaceOperation): WorkspaceFailure {
  if (error instanceof ObservedFailure) return error.failure
  const source = sources[operation], observedAt = new Date().toISOString()
  const kind = error instanceof ApiRequestError ? 'http' : error instanceof ApiShapeError ? 'response-shape'
    : error instanceof TypeError ? 'type-error' : 'unexpected'
  const details = [`source=${source}`, `observedAt=${observedAt}`, `kind=${kind}`]
  if (error instanceof ApiRequestError) {
    details.push(`status=${error.status}`, `code=${error.code}`)
  }
  return { operation, source, observedAt, details: details.join('\n') }
}

/** Each concurrent request has its own observation boundary; sync local failures use it too. */
export async function workspaceStep<T>(operation: WorkspaceOperation, action: () => T | Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) { throw new ObservedFailure(workspaceFailure(error, operation)) }
}
