/** Adapts the node's catalog review routes (contract `ui-catalog.ts`) to the catalog's API. */
import { ReviewApiError, type ReviewApi } from '@guanxi/ui/catalog'
import { ApiRequestError, api } from '../../lib/api.ts'

function failure(error: unknown): ReviewApiError {
  if (error instanceof ApiRequestError) {
    if (error.code === 'review_conflict') return new ReviewApiError('conflict', error.message)
    if (error.code === 'approval_signer_unavailable') return new ReviewApiError('signer_unavailable', error.message)
    if (error.code === 'approvals_read_only') return new ReviewApiError('read_only', error.message)
  }
  return new ReviewApiError('failed', error instanceof Error ? error.message : String(error))
}

export function createReviewApi(): ReviewApi {
  return {
    capability: (signal) => api.uiCatalogReviewCapability(signal),
    get: (id, signal) => api.uiCatalogComponentReview(id, signal),
    async submit(id, body) {
      try {
        return await api.submitUiCatalogReview(id, body)
      } catch (error) {
        throw failure(error)
      }
    },
  }
}
