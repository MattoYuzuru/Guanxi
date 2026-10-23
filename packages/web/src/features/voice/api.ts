import {
  createGlossaryEntryBodySchema,
  glossaryEntryIdSchema,
  glossaryErrorSchema,
  glossaryHistoryResponseSchema,
  glossaryPreviewBodySchema,
  glossaryPreviewResponseSchema,
  listGlossaryResponseSchema,
  storedGlossaryEntrySchema,
  updateGlossaryEntryBodySchema,
  type CreateGlossaryEntryBody,
  type GlossaryErrorCode,
  type GlossaryPreviewBody,
  type UpdateGlossaryEntryBody,
} from '@guanxi/contract'
import { LocalApiError, localRequest } from '../../lib/local-api.ts'

const BASE = '/api/voice/glossary'
const call = <S extends Parameters<typeof localRequest>[1]>(path: string, schema: S, init?: Parameters<typeof localRequest>[3]) =>
  localRequest(`${BASE}${path}`, schema, glossaryErrorSchema, init)

export type GlossaryRequestError = LocalApiError<GlossaryErrorCode>

const id = (value: string) => encodeURIComponent(glossaryEntryIdSchema.parse(value))
const command = (entryId: string, name: 'deactivate' | 'reactivate' | 'revert') =>
  call(`/${id(entryId)}/${name}`, storedGlossaryEntrySchema, { method: 'POST', body: {} })

export const glossaryApi = {
  /** Without `projectId`, every entry the account owns; with it, account entries plus that project's. */
  list: (params: { projectId?: string; includeInactive?: boolean } = {}, signal?: AbortSignal) =>
    call('', listGlossaryResponseSchema, {
      query: { projectId: params.projectId, includeInactive: params.includeInactive },
      signal,
    }),
  create: (body: CreateGlossaryEntryBody) =>
    call('', storedGlossaryEntrySchema, { method: 'POST', body: createGlossaryEntryBodySchema.parse(body) }),
  update: (entryId: string, body: UpdateGlossaryEntryBody) =>
    call(`/${id(entryId)}`, storedGlossaryEntrySchema, { method: 'PUT', body: updateGlossaryEntryBodySchema.parse(body) }),
  deactivate: (entryId: string) => command(entryId, 'deactivate'),
  reactivate: (entryId: string) => command(entryId, 'reactivate'),
  revert: (entryId: string) => command(entryId, 'revert'),
  history: (entryId: string, signal?: AbortSignal) =>
    call(`/${id(entryId)}/history`, glossaryHistoryResponseSchema, { signal }),
  /** Read-only: applies the effective glossary to `text` and stores nothing. */
  preview: (body: GlossaryPreviewBody, signal?: AbortSignal) =>
    call('/apply-preview', glossaryPreviewResponseSchema, { method: 'POST', body: glossaryPreviewBodySchema.parse(body), signal }),
}
