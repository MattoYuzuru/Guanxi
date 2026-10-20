/**
 * Catalog review routes (D-138). Writes happen only through the review service, which owns
 * the source checkout, release and signing checks. The POST also refuses requests that did
 * not come from this node's own UI: a page on another origin must not be able to trigger an
 * owner keychain prompt.
 */
import { Hono, type Context } from 'hono'
import type { ApiError } from '@guanxi/contract'
import { uiComponentReviewBody } from '@guanxi/contract'
import { UiCatalogError, type UiCatalogReviewService } from '../ui-catalog/service.ts'

const STATUS: Record<UiCatalogError['code'], 403 | 404 | 409 | 503> = {
  component_not_found: 404,
  approvals_read_only: 403,
  review_conflict: 409,
  approval_signer_unavailable: 503,
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function fail(context: Context, error: unknown) {
  if (error instanceof UiCatalogError) {
    const body: ApiError = { code: error.code, message: error.message, details: { reason: error.reason } }
    return context.json(body, STATUS[error.code])
  }
  throw error
}

/** Same-origin, loopback-host, JSON-only: blocks cross-site form posts and DNS rebinding. */
function rejectForeignWrite(context: Context, allowedOrigins: readonly string[]) {
  const deny = (reason: string) =>
    context.json({ code: 'approvals_read_only', message: 'This request cannot write reviews', details: { reason } } satisfies ApiError, 403)
  const url = new URL(context.req.url)
  const host = context.req.header('host') ?? url.host
  const hostname = host.replace(/:\d+$/, '')
  if (!LOOPBACK_HOSTS.has(hostname)) return deny('non_loopback_host')
  const site = context.req.header('sec-fetch-site')
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    const origin = context.req.header('origin')
    if (!(site === 'same-site' && origin !== undefined && allowedOrigins.includes(origin))) {
      return deny('cross_site_request')
    }
  }
  const origin = context.req.header('origin')
  if (origin !== undefined) {
    const sameOrigin = origin === `${url.protocol}//${host}`
    if (!sameOrigin && !allowedOrigins.includes(origin)) return deny('foreign_origin')
  }
  const type = context.req.header('content-type') ?? ''
  if (!/^application\/json\b/i.test(type)) return deny('json_required')
  return null
}

export function uiCatalogRoutes(service: UiCatalogReviewService, allowedOrigins: readonly string[] = []): Hono {
  const routes = new Hono()

  routes.get('/review-capability', async (context) => context.json(await service.capability()))

  routes.get('/components/:id/review', (context) => {
    try {
      return context.json(service.get(context.req.param('id')))
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.post('/components/:id/review', async (context) => {
    const denied = rejectForeignWrite(context, allowedOrigins)
    if (denied) return denied
    const parsed = uiComponentReviewBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid review body', details: parsed.error.flatten() } satisfies ApiError,
        400,
      )
    }
    try {
      return context.json(await service.submit(context.req.param('id'), parsed.data))
    } catch (error) {
      return fail(context, error)
    }
  })

  return routes
}
