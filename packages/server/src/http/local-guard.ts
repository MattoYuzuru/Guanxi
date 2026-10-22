/**
 * Shared boundary for the local-owner REST surfaces added in MS2 (notifications, voice glossary,
 * work ledger). It carries the guards of the connection and native-agent routes in one place:
 * loopback peer, same-origin or allowed dev origin, JSON on mutations, no-store and a transport
 * body budget. Failures answer `{ code }` only, never a message, id list or request content.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ZodError } from 'zod'
import { isLoopbackPeer } from '../session-log/routes.ts'

/** Local owner scope only; account authentication replaces this binding in the account stage. */
export const LOCAL_ACCOUNT_ID = 'local'
/** Transport budget for one JSON body. It is not a limit on any model, context or output size. */
export const LOCAL_BODY_MAX_BYTES = 2 * 1024 * 1024

/** The kernel service behind a route is not loaded (for example after unload). */
export class ServiceUnavailableError extends Error {
  constructor() {
    super('service unavailable')
    this.name = 'ServiceUnavailableError'
  }
}

export interface RouteFailure {
  readonly code: string
  readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 501 | 502 | 503
}

function sameOrigin(origin: string, url: string): boolean {
  try { return new URL(origin).origin === new URL(url).origin } catch { return false }
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

export function localGuard(devOrigins: readonly string[] = []): MiddlewareHandler {
  const limit = bodyLimit({
    maxSize: LOCAL_BODY_MAX_BYTES,
    onError: (c) => c.json({ code: 'body_too_large' }, 413),
  })
  return async (c, next) => {
    if (!isLoopbackPeer(c)) return c.json({ code: 'loopback_only' }, 403)
    c.header('Cache-Control', 'no-store')
    const origin = c.req.header('origin')
    if (origin !== undefined && !sameOrigin(origin, c.req.url) && !devOrigins.includes(origin)) {
      return c.json({ code: 'origin_denied' }, 403)
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!isJson(c.req.header('content-type'))) return c.json({ code: 'json_required' }, 415)
      return limit(c, next)
    }
    await next()
  }
}

/** Zod and JSON syntax failures are caller errors; everything unknown is an internal error. */
export function commonFailure(error: unknown): RouteFailure | null {
  if (error instanceof ZodError || error instanceof SyntaxError) return { code: 'validation_failed', status: 400 }
  return null
}

export function failureResponse(c: Context, failure: RouteFailure): Response {
  return c.json({ code: failure.code }, failure.status)
}
