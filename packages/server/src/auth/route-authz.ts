/**
 * The one authorization hook of the HTTP API (ADR-0027, U3 route wiring).
 *
 * `routeAuthz()` runs before every `/api/*` handler. It reads which endpoint route Hono matched
 * for the request, looks it up in the route policy map, resolves the principal and resource and
 * asks `can()`. Handlers carry no ad hoc checks; a route without a declared policy is refused.
 *
 * Local mode (no accounts adapter) makes the implicit owner the principal, so a single-owner
 * loopback node behaves as it did before the hook existed. Remote mode takes the principal, the
 * authoritative resource projection and the grants from an {@link AccountsAdapter}; Better Auth
 * is that adapter in the next slice.
 */
import type { Context, MiddlewareHandler, Next } from 'hono'
import { matchedRoutes } from 'hono/route'
import { TrieRouter } from 'hono/router/trie-router'
import { can } from './policy.ts'
import {
  ROOT_RESOURCE_ID,
  isGovernedEndpoint,
  policyFor,
  type RoutePolicy,
} from './route-policy.ts'
import type { Grant, Principal, Resource, ResourceType } from './types.ts'

/** The account whose data the single-account stores and sidecars hold until per-account stores. */
export const LOCAL_OWNER_ID = 'local'
/** Id of the local compute node as an authorization resource. */
export const LOCAL_NODE_ID = 'local-node'

/** The implicit principal of a single-owner loopback node. */
export const LOCAL_OWNER_PRINCIPAL: Principal = Object.freeze({
  kind: 'user',
  userId: LOCAL_OWNER_ID,
  role: 'admin',
  groups: Object.freeze([]) as unknown as string[],
})

/** What accounts must supply for remote mode. Better Auth implements this in the next slice. */
export interface AccountsAdapter {
  /** The account that owns this node, its single-account stores and the root resources. */
  readonly nodeOwnerId: string
  /** Authenticate the request. Return `{ kind: 'anonymous' }` when there is no valid credential. */
  principal(context: Context): Principal | Promise<Principal>
  /** Authoritative projection of a resource; the default is owned by `nodeOwnerId`. */
  resource?(type: ResourceType, id: string): Resource | Promise<Resource>
  /** Grants that apply to the resource, including those inherited from its project. Default none. */
  grants?(resource: Resource): readonly Grant[] | Promise<readonly Grant[]>
}

export interface RouteAuthzOptions {
  /** Absent means single-owner local mode. */
  accounts?: AccountsAdapter
  nodeId?: string
  now?: () => number
}

/** What the hook leaves on the request context for handlers. */
export interface AuthzContext {
  principal: Principal
}

const ERROR_MESSAGES = {
  unauthenticated: 'Authentication is required',
  forbidden: 'This account may not perform that operation',
  route_unmapped: 'This route has no authorization policy',
} as const

type Refusal = keyof typeof ERROR_MESSAGES
/** What a middleware may return; Hono awaits it, so a synchronous return is as valid as a promise. */
type Outcome = Response | void | Promise<Response | void>

function refuse(context: Context, code: Refusal): Response {
  const status = code === 'unauthenticated' ? 401 : 403
  return context.json({ code, message: ERROR_MESSAGES[code], details: null }, status)
}

const extractors = new Map<string, TrieRouter<true>>()

/**
 * Route parameters of one registered pattern, from Hono's own trie router and decoded the way
 * `c.req.param()` decodes them, so the hook and the handler never disagree about an id.
 */
function routeParams(pattern: string, path: string): Record<string, string> {
  let router = extractors.get(pattern)
  if (!router) {
    router = new TrieRouter<true>()
    router.add('ALL', pattern, true)
    extractors.set(pattern, router)
  }
  const found = router.match('GET', path)[0] as ReadonlyArray<readonly [true, Record<string, string>]>
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(found[0]?.[1] ?? {})) {
    if (!value.includes('%')) { params[key] = value; continue }
    try { params[key] = decodeURIComponent(value) } catch { params[key] = value }
  }
  return params
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function'
}

/** Apply `next` now when the value is plain, after it settles when it is a promise: no needless microtask. */
function andThen<T, R>(value: T | Promise<T>, next: (resolved: T) => R | Promise<R>): R | Promise<R> {
  return isPromise(value) ? value.then(next) : next(value)
}

export function routeAuthz(options: RouteAuthzOptions = {}): MiddlewareHandler {
  const accounts = options.accounts
  const nodeOwnerId = accounts?.nodeOwnerId ?? LOCAL_OWNER_ID
  const nodeId = options.nodeId ?? LOCAL_NODE_ID
  const now = options.now ?? Date.now

  /** The decision is synchronous unless the accounts adapter itself is asynchronous. */
  function decide(
    policy: RoutePolicy,
    principal: Principal,
    context: Context,
    pattern: string,
  ): Refusal | null | Promise<Refusal | null> {
    if (policy.kind === 'public' || policy.kind === 'node-signed') return null
    if (principal.kind === 'anonymous') return 'unauthenticated'
    if (policy.kind === 'authenticated') return principal.kind === 'user' ? null : 'forbidden'
    if (policy.kind === 'account') {
      return principal.kind === 'user' && principal.userId === nodeOwnerId ? null : 'forbidden'
    }
    const check = (resource: Resource, grants: readonly Grant[]): Refusal | null =>
      can(principal, policy.action, resource, [...grants], now()).allowed ? null : 'forbidden'

    if (policy.resource === 'node') return check({ type: 'node', id: nodeId, ownerUserId: nodeOwnerId }, [])
    if (policy.idParam === undefined) {
      // Roots never carry grants: collection and create routes stay owner-only.
      return check({ type: policy.resource, id: ROOT_RESOURCE_ID, ownerUserId: nodeOwnerId }, [])
    }
    const id = routeParams(pattern, context.req.path)[policy.idParam]
    if (id === undefined || id === '' || id === ROOT_RESOURCE_ID) return 'forbidden'
    const type = policy.resource
    return andThen(accounts?.resource?.(type, id), (projected) => {
      const resource = projected ?? { type, id, ownerUserId: nodeOwnerId }
      return andThen(accounts?.grants?.(resource), (grants) => check(resource, grants ?? []))
    })
  }

  const handler = (context: Context, next: Next): Outcome => {
    const method = context.req.method
    // Hono runs matched handlers in registration order and an endpoint handler answers without
    // calling `next()`, so the first matched endpoint is the one that will respond. A static route
    // registered before a parameterized one (`/threads/trash` before `/threads/:id`) shadows it.
    const route = matchedRoutes(context).find(
      (candidate) => isGovernedEndpoint(candidate) && (candidate.method === method || candidate.method === 'ALL'),
    )
    if (route === undefined) return next()

    const policy = policyFor(route.method, route.path)
    if (!policy) return refuse(context, 'route_unmapped')

    const finish = (refusal: Refusal | null, principal: Principal): Outcome => {
      if (refusal) return refuse(context, refusal)
      context.set('authz', { principal } satisfies AuthzContext)
      return next()
    }
    const needsPrincipal = policy.kind !== 'public' && policy.kind !== 'node-signed'
    const resolved: Principal | Promise<Principal> = !needsPrincipal
      ? { kind: 'anonymous' }
      : accounts
        ? accounts.principal(context)
        : LOCAL_OWNER_PRINCIPAL
    // No `await` before `next()` on the synchronous path: locally the hook adds no scheduling turn.
    return andThen(resolved, (principal) =>
      andThen(decide(policy, principal, context, route.path), (refusal) => finish(refusal, principal)))
  }
  return handler as MiddlewareHandler
}
