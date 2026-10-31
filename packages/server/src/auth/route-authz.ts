/**
 * The one authorization hook of the HTTP API (ADR-0027, U3 route wiring).
 *
 * `routeAuthz()` runs before every `/api/*` handler. It reads which endpoint route Hono matched
 * for the request, looks it up in the route policy map, resolves the principal and resource and
 * asks `can()`. Handlers carry no ad hoc checks; a route without a declared policy is refused.
 *
 * Local mode (no accounts adapter) makes the implicit owner the principal, but only for a request
 * whose socket peer is loopback and that carries no proxy headers, so a single-owner loopback node
 * behaves as it did before the hook existed and a same-host reverse proxy cannot turn internet
 * traffic into the owner (see the auth README, "Trust boundary"). Remote mode takes the principal,
 * the authoritative resource projection and the grants from an {@link AccountsAdapter}; Better
 * Auth is that adapter in the next slice.
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler, Next } from 'hono'
import { matchedRoutes } from 'hono/route'
import { TrieRouter } from 'hono/router/trie-router'
import { can } from './policy.ts'
import {
  ROOT_RESOURCE_ID,
  ROUTE_POLICIES,
  isGovernedEndpoint,
  policyFor,
  sealRoutePolicies,
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
  /** Test seam: the policy table. Defaults to the sealed {@link ROUTE_POLICIES}; a supplied map is copied. */
  policies?: ReadonlyMap<string, RoutePolicy>
  /**
   * Local mode only: treat a request with no socket at all (an in-process `app.request()`) as the
   * owner. Default `false`: an address-less request is refused. Test helpers and embedding hosts that
   * never expose a listener opt in; `start()` never does.
   */
  trustInProcess?: boolean
}

/** What the hook leaves on the request context for handlers. */
export interface AuthzContext {
  principal: Principal
  /** True for a `user` principal that is the node owner or has the server `admin` role. */
  operator: boolean
  /**
   * True when the matched policy named a resource and the principal owns it. Handlers use it to
   * withhold person-audience content (reasoning) from grantees; see `canSeeReasoning`.
   */
  resourceOwner: boolean
}

/**
 * Headers a reverse proxy or CDN adds. A local-mode node refuses any request that carries one:
 * `x-forwarded-*` (all), `forwarded`, `via`, `x-real-ip`, `x-client-ip`, `true-client-ip`,
 * `x-original-forwarded-for` and Cloudflare's `cf-*`. A proxy that adds none cannot be detected.
 */
export const PROXY_HEADER_NAMES: ReadonlySet<string> = new Set([
  'forwarded', 'via', 'x-real-ip', 'x-client-ip', 'true-client-ip', 'x-original-forwarded-for',
])
export const PROXY_HEADER_PREFIXES = ['x-forwarded-', 'cf-'] as const

/** True when the request carries any proxy or CDN header. */
export function hasProxyHeader(context: Context): boolean {
  for (const name of context.req.raw.headers.keys()) {
    const lower = name.toLowerCase()
    if (PROXY_HEADER_NAMES.has(lower) || PROXY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  }
  return false
}

/** The body of an unknown API path, as the fallback route answers it. */
export const API_NOT_FOUND_BODY = { code: 'internal_error', message: 'API-маршрут не найден', details: null } as const

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

type Peer = 'loopback' | 'remote' | 'none'

/**
 * The socket peer of the request. `none` means there is no socket at all (an in-process
 * `app.request()` call by the embedding host); a socket without an address is `remote`.
 */
function peerOf(context: Context): Peer {
  let address: string | undefined
  try {
    address = getConnInfo(context).remote.address
  } catch {
    return 'none'
  }
  if (!address) return 'remote'
  const plain = address.toLowerCase().replace(/^::ffff:/u, '')
  return plain === '::1' || /^127(\.\d{1,3}){3}$/u.test(plain) ? 'loopback' : 'remote'
}

/** Local mode only: the refusal for a non-loopback peer, an address-less request or a proxied request, or `null`. */
function localRefusal(context: Context, trustInProcess: boolean): Response | null {
  const peer = peerOf(context)
  if (peer === 'remote') {
    return context.json({ code: 'loopback_only', message: 'This node answers requests from this machine only', details: { reason: 'non_loopback_peer' } }, 403)
  }
  if (peer === 'none' && !trustInProcess) {
    return context.json({ code: 'loopback_only', message: 'This node answers requests from this machine only', details: { reason: 'no_socket' } }, 403)
  }
  if (hasProxyHeader(context)) {
    return context.json({ code: 'proxied_request_refused', message: 'A request carrying proxy headers cannot act as the local owner', details: { reason: 'forwarded_headers' } }, 403)
  }
  return null
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
  // A supplied table is copied into a sealed map, so the caller cannot change it after boot.
  const policies = options.policies ? sealRoutePolicies(options.policies) : ROUTE_POLICIES
  const trustInProcess = options.trustInProcess === true

  /** The decision is synchronous unless the accounts adapter itself is asynchronous. */
  function decide(
    policy: RoutePolicy,
    principal: Principal,
    context: Context,
    pattern: string,
    state: { resourceOwner: boolean },
  ): Refusal | null | Promise<Refusal | null> {
    if (policy.kind === 'public' || policy.kind === 'node-signed') return null
    if (principal.kind === 'anonymous') return 'unauthenticated'
    if (policy.kind === 'authenticated') return principal.kind === 'user' ? null : 'forbidden'
    if (policy.kind === 'account') {
      return principal.kind === 'user' && principal.userId === nodeOwnerId ? null : 'forbidden'
    }
    const check = (resource: Resource, grants: readonly Grant[]): Refusal | null => {
      if (!can(principal, policy.action, resource, [...grants], now()).allowed) return 'forbidden'
      // `ownerOnly`: a grant or the admin role is not enough, the principal must own the resource.
      const owns = principal.kind === 'user' && principal.userId === resource.ownerUserId
      if (policy.ownerOnly && !owns) return 'forbidden'
      state.resourceOwner = owns
      return null
    }

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
    // Hono serves HEAD through the GET handler while `req.method` stays `HEAD`: look up as GET.
    const method = context.req.method === 'HEAD' ? 'GET' : context.req.method
    // Hono runs matched handlers in registration order and an endpoint handler answers without
    // calling `next()`, so the first matched endpoint is the one that will respond. A static route
    // registered before a parameterized one (`/threads/trash` before `/threads/:id`) shadows it.
    const route = matchedRoutes(context).find(
      (candidate) => isGovernedEndpoint(candidate) && (candidate.method === method || candidate.method === 'ALL'),
    )
    // Fail closed: no governed endpoint for this method means nothing under /api/ may run, whatever
    // else (a wildcard, a stray `ALL` route) matched. The answer is the unknown-path 404, which
    // reveals nothing about which paths exist.
    if (route === undefined) return context.json(API_NOT_FOUND_BODY, 404)

    const policy = policyFor(route.method, route.path, policies)
    if (!policy) return refuse(context, 'route_unmapped')
    if (!accounts) {
      const refusal = localRefusal(context, trustInProcess)
      if (refusal) return refusal
    }

    const state = { resourceOwner: false }
    const finish = (refusal: Refusal | null, principal: Principal): Outcome => {
      if (refusal) return refuse(context, refusal)
      const operator = principal.kind === 'user' && (principal.role === 'admin' || principal.userId === nodeOwnerId)
      context.set('authz', { principal, operator, resourceOwner: state.resourceOwner } satisfies AuthzContext)
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
      andThen(decide(policy, principal, context, route.path, state), (refusal) => finish(refusal, principal)))
  }
  return handler as MiddlewareHandler
}
