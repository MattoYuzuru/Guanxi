import {
  addWorkRevisionBodySchema,
  appendWorkEventBodySchema,
  appendWorkEventResponseSchema,
  latestWorkRevisionResponseSchema,
  setWorkModeBodySchema,
  workErrorSchema,
  workExportResponseSchema,
  workItemsPageSchema,
  workModeSnapshotSchema,
  workPlanRevisionSchema,
  workProjectIdSchema,
  type AddWorkRevisionBody,
  type AppendWorkEventBody,
  type ListWorkItemsQuery,
  type SetWorkModeBody,
  type WorkErrorCode,
} from '@guanxi/contract'
import { LocalApiError, localRequest } from '../../lib/local-api.ts'

export type WorkRequestError = LocalApiError<WorkErrorCode>

const call = <S extends Parameters<typeof localRequest>[1]>(projectId: string, path: string, schema: S, init?: Parameters<typeof localRequest>[3]) =>
  localRequest(`/api/work/projects/${encodeURIComponent(workProjectIdSchema.parse(projectId))}${path}`, schema, workErrorSchema, init)

export const workApi = {
  latestRevision: (projectId: string, signal?: AbortSignal) =>
    call(projectId, '/revision', latestWorkRevisionResponseSchema, { signal }),
  /** Plan revisions written here are authored by the user; the node assigns the number. */
  addRevision: (projectId: string, body: AddWorkRevisionBody) =>
    call(projectId, '/revisions', workPlanRevisionSchema, { method: 'POST', body: addWorkRevisionBodySchema.parse(body) }),
  /** Human decisions only. Provenance and time are supplied by the node, never by the client. */
  appendEvent: (projectId: string, body: AppendWorkEventBody) =>
    call(projectId, '/events', appendWorkEventResponseSchema, { method: 'POST', body: appendWorkEventBodySchema.parse(body) }),
  /** Derived statuses with evidence, paged over the whole graph; no `limit` returns everything. */
  items: (projectId: string, query: ListWorkItemsQuery = {}, signal?: AbortSignal) =>
    call(projectId, '/items', workItemsPageSchema, { query: { status: query.status, cursor: query.cursor, limit: query.limit }, signal }),
  mode: (projectId: string, signal?: AbortSignal) => call(projectId, '/mode', workModeSnapshotSchema, { signal }),
  setMode: (projectId: string, body: SetWorkModeBody) =>
    call(projectId, '/mode', workModeSnapshotSchema, { method: 'PUT', body: setWorkModeBodySchema.parse(body) }),
  /** On-demand Markdown projection; the node writes nothing to disk. */
  exportMarkdown: (projectId: string, signal?: AbortSignal) => call(projectId, '/export', workExportResponseSchema, { signal }),
}
