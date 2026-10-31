/**
 * Route → authorization map for the HTTP API (ADR-0027, U3 route wiring).
 *
 * Every endpoint under `/api/` is declared here with the question the central hook asks before
 * the handler runs. A registered endpoint without an entry is refused at request time and aborts
 * boot, so a new route cannot ship unguarded. The inventory with the reasoning for each family
 * lives in `docs/plans/lanes/U3-route-authz.plan.md`.
 *
 * This file is data plus pure helpers: no Hono dependency, no storage.
 */
import type { Action, ResourceType } from './types.ts'

/** Id of the per-type root resource that collection and create routes are authorized against. */
export const ROOT_RESOURCE_ID = '@root'

/**
 * - `public`: no principal needed.
 * - `authenticated`: node information without per-user content; any `user` principal.
 * - `account`: data of the one account the handler is bound to; only that user.
 * - `node-signed`: the handler authenticates a federation node by its signed request.
 * - `authorize`: `can(principal, action, resource)`. Without `idParam` the resource is the root of
 *   its type (collection or create route; node-level actions use the local node). `ownerOnly`
 *   additionally requires the principal to be the resource owner, so neither a grant nor the
 *   server `admin` role can pass (reasoning is person-audience; D-155 forbids an admin override).
 */
export type RoutePolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'account' }
  | { kind: 'node-signed' }
  | { kind: 'authorize'; resource: ResourceType; action: Action; idParam?: string; ownerOnly?: true }

const PUBLIC: RoutePolicy = { kind: 'public' }
const AUTHENTICATED: RoutePolicy = { kind: 'authenticated' }
const ACCOUNT: RoutePolicy = { kind: 'account' }
const SIGNED: RoutePolicy = { kind: 'node-signed' }
/** Node operations a server `admin` may also perform. */
const NODE_ADMIN: RoutePolicy = { kind: 'authorize', resource: 'node', action: 'node.admin' }
/**
 * Node operations that reach the filesystem, the network on the owner's behalf or the owner's
 * configuration. Owner only, even for the `admin` role, until allowed roots are enforced.
 */
const NODE_OWNER: RoutePolicy = { kind: 'authorize', resource: 'node', action: 'node.admin', ownerOnly: true }

/** A resource named by the route parameter `idParam`. */
function on(resource: ResourceType, action: Action, idParam: string): RoutePolicy {
  return { kind: 'authorize', resource, action, idParam }
}

/** A resource only its owner may reach: no grant and no admin role helps. */
function ownerOn(resource: ResourceType, action: Action, idParam: string): RoutePolicy {
  return { kind: 'authorize', resource, action, idParam, ownerOnly: true }
}

/** The root resource of a type: collection and create routes. */
function root(resource: ResourceType, action: Action): RoutePolicy {
  return { kind: 'authorize', resource, action }
}

/** `ALL` routes under `/api/` that are middleware or the unknown-path fallback, not endpoints. */
export const NON_ENDPOINT_ALL_ROUTES: ReadonlySet<string> = new Set([
  '/api/*',
  '/api/agent/*',
  '/api/connections/*',
  '/api/federation/*',
  '/api/layouts/*',
  '/api/notifications/*',
  '/api/relay/*',
  '/api/sessions/*',
  '/api/voice/glossary/*',
  '/api/work/*',
])

/** Key of one endpoint in {@link ROUTE_POLICIES}: the Hono method and registered path pattern. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

const POLICY_ENTRIES: ReadonlyArray<readonly [string, string, RoutePolicy]> = [
  // Health, settings, node information
  ['GET', '/api/health', AUTHENTICATED],
  ['GET', '/api/settings', NODE_OWNER],
  ['PUT', '/api/settings', NODE_OWNER],
  ['GET', '/api/feature-flags', AUTHENTICATED],
  ['GET', '/api/runtime', AUTHENTICATED],
  ['POST', '/api/runtime/estimated-parallel-admission', AUTHENTICATED],
  ['POST', '/api/approvals/:id', ACCOUNT],
  ['GET', '/api/layouts/context', ACCOUNT],
  ['GET', '/api/layouts', ACCOUNT],
  ['PUT', '/api/layouts', ACCOUNT],
  ['GET', '/api/layouts/geometry', ACCOUNT],
  ['PUT', '/api/layouts/geometry', ACCOUNT],
  ['GET', '/api/ui-catalog/review-capability', AUTHENTICATED],
  ['GET', '/api/ui-catalog/components/:id/review', AUTHENTICATED],
  ['POST', '/api/ui-catalog/components/:id/review', NODE_OWNER],

  // Models and workspaces
  ['GET', '/api/models', AUTHENTICATED],
  ['GET', '/api/models/catalog', AUTHENTICATED],
  ['GET', '/api/models/running', AUTHENTICATED],
  ['GET', '/api/models/:name{.+}', AUTHENTICATED],
  ['POST', '/api/models/imports/ollama-reference/preview', NODE_OWNER],
  ['POST', '/api/models/imports/ollama-reference/start', NODE_OWNER],
  ['POST', '/api/models/discovery/hugging-face/search', NODE_OWNER],
  ['POST', '/api/models/discovery/hugging-face/repository', NODE_OWNER],
  ['POST', '/api/models/discovery/hugging-face/selection', NODE_OWNER],
  ['POST', '/api/models/discovery/hugging-face/download', NODE_OWNER],
  ['POST', '/api/models/imports/hugging-face-gguf/start', NODE_OWNER],
  ['POST', '/api/models/:name{.+}/capability-overrides', NODE_ADMIN],
  ['DELETE', '/api/models/:name{.+}/capability-overrides', NODE_ADMIN],
  ['DELETE', '/api/models/:name{.+}', NODE_ADMIN],
  ['POST', '/api/models/:name{.+}/warm', NODE_ADMIN],
  ['POST', '/api/models/:name{.+}/prewarm', NODE_ADMIN],
  ['POST', '/api/models/:name{.+}/probes/completion', NODE_ADMIN],
  ['POST', '/api/models/:name{.+}/stop', NODE_ADMIN],
  ['POST', '/api/models/:name{.+}/pull', NODE_OWNER],
  ['GET', '/api/workspaces', NODE_OWNER],
  ['GET', '/api/workspaces/browse', NODE_OWNER],
  ['POST', '/api/workspaces', NODE_OWNER],
  ['GET', '/api/workspaces/:id', NODE_OWNER],
  ['DELETE', '/api/workspaces/:id', NODE_OWNER],

  // Threads (chat sessions), quick runs, jobs
  ['GET', '/api/threads/models', AUTHENTICATED],
  ['GET', '/api/threads', root('session', 'session.read')],
  ['POST', '/api/threads', root('session', 'session.prompt')],
  ['GET', '/api/threads/trash', root('session', 'session.read')],
  ['GET', '/api/threads/:id/retention', on('session', 'session.read', 'id')],
  ['PATCH', '/api/threads/:id/retention', on('session', 'session.update', 'id')],
  ['POST', '/api/threads/:id/restore', on('session', 'session.update', 'id')],
  ['POST', '/api/threads/:id/session-leave', on('session', 'session.update', 'id')],
  ['GET', '/api/threads/:id/reasoning-artifacts', ownerOn('session', 'session.read', 'id')],
  ['GET', '/api/threads/:id/reasoning-artifacts/:artifactId', ownerOn('session', 'session.read', 'id')],
  ['GET', '/api/threads/:id', on('session', 'session.read', 'id')],
  ['PATCH', '/api/threads/:id', on('session', 'session.update', 'id')],
  ['DELETE', '/api/threads/:id', on('session', 'session.delete', 'id')],
  ['GET', '/api/threads/:id/context', on('session', 'session.read', 'id')],
  ['POST', '/api/threads/:id/stop', on('session', 'session.stop', 'id')],
  ['POST', '/api/threads/:id/messages', on('session', 'session.prompt', 'id')],
  ['POST', '/api/threads/:id/compact', on('session', 'session.prompt', 'id')],
  ['GET', '/api/quick-runs', root('session', 'session.read')],
  ['POST', '/api/quick-runs', root('session', 'session.prompt')],
  ['PATCH', '/api/quick-runs/:id/retention', on('session', 'session.update', 'id')],
  ['GET', '/api/quick-runs/:id', on('session', 'session.read', 'id')],
  ['POST', '/api/jobs', root('session', 'session.prompt')],
  ['GET', '/api/jobs/:jobId', on('run', 'run.read', 'jobId')],
  ['GET', '/api/jobs/:jobId/events', on('run', 'run.read', 'jobId')],
  ['POST', '/api/jobs/:jobId/cancel', on('run', 'run.cancel', 'jobId')],

  // Session inspector (K2)
  ['GET', '/api/sessions', root('session', 'session.read')],
  ['GET', '/api/sessions/list/page', root('session', 'session.read')],
  ['GET', '/api/sessions/search', root('session', 'session.read')],
  ['GET', '/api/sessions/:sessionId', on('session', 'session.read', 'sessionId')],
  ['GET', '/api/sessions/:sessionId/events', ownerOn('session', 'session.read', 'sessionId')],
  ['GET', '/api/sessions/:sessionId/spans', ownerOn('session', 'session.read', 'sessionId')],
  ['GET', '/api/sessions/:sessionId/export', ownerOn('session', 'session.read', 'sessionId')],
  ['GET', '/api/sessions/:sessionId/stream', ownerOn('session', 'session.read', 'sessionId')],

  // Projects, recipes, attachments, work ledger
  ['GET', '/api/projects', root('project', 'project.read')],
  ['POST', '/api/projects', root('project', 'project.write')],
  ['GET', '/api/projects/:id', on('project', 'project.read', 'id')],
  ['PATCH', '/api/projects/:id', on('project', 'project.write', 'id')],
  ['PATCH', '/api/projects/:id/presentation', on('project', 'project.write', 'id')],
  ['GET', '/api/projects/:id/chats', root('session', 'session.read')],
  ['POST', '/api/projects/:id/chats', root('session', 'session.prompt')],
  ['GET', '/api/projects/:id/chats/:threadId', on('session', 'session.read', 'threadId')],
  ['GET', '/api/recipes', ACCOUNT],
  ['POST', '/api/recipes', ACCOUNT],
  ['PATCH', '/api/recipes/:id/name', ACCOUNT],
  ['POST', '/api/recipes/:id/revisions', ACCOUNT],
  ['POST', '/api/recipes/:id/revisions/:revision/jobs', ACCOUNT],
  ['GET', '/api/recipes/:id/revisions/:revision/jobs/:jobId', ACCOUNT],
  ['GET', '/api/recipes/:id/revisions/:revision', ACCOUNT],
  ['GET', '/api/recipes/:id', ACCOUNT],
  ['GET', '/api/artifacts/policy', AUTHENTICATED],
  ['GET', '/api/artifacts', ACCOUNT],
  ['POST', '/api/artifacts', ACCOUNT],
  ['GET', '/api/artifacts/:id/content', ACCOUNT],
  ['GET', '/api/artifacts/:id', ACCOUNT],
  ['GET', '/api/work/projects/:projectId/revision', on('project', 'project.read', 'projectId')],
  ['POST', '/api/work/projects/:projectId/revisions', on('project', 'project.write', 'projectId')],
  ['POST', '/api/work/projects/:projectId/events', on('project', 'project.write', 'projectId')],
  ['GET', '/api/work/projects/:projectId/items', on('project', 'project.read', 'projectId')],
  ['GET', '/api/work/projects/:projectId/mode', on('project', 'project.read', 'projectId')],
  ['PUT', '/api/work/projects/:projectId/mode', on('project', 'project.write', 'projectId')],
  ['GET', '/api/work/projects/:projectId/export', on('project', 'project.read', 'projectId')],

  // Connections and the vault
  ['GET', '/api/connections', root('connection', 'connection.read')],
  ['POST', '/api/connections', root('connection', 'connection.manage')],
  ['PATCH', '/api/connections/:id', on('connection', 'connection.manage', 'id')],
  ['DELETE', '/api/connections/:id', on('connection', 'connection.manage', 'id')],
  ['POST', '/api/connections/vault/unlock', ACCOUNT],
  ['POST', '/api/connections/vault/lock', ACCOUNT],
  ['PUT', '/api/connections/:id/secret', on('connection', 'connection.manage', 'id')],
  ['GET', '/api/connections/:id/models', on('connection', 'connection.use', 'id')],
  ['POST', '/api/connections/:id/probe', on('connection', 'connection.manage', 'id')],

  // Native agent and relay
  ['GET', '/api/agent/projects', root('project', 'project.read')],
  ['POST', '/api/agent', root('session', 'session.prompt')],
  ['PATCH', '/api/agent/projects/:id/roots', on('project', 'project.write', 'id')],
  ['POST', '/api/agent/:id/leave', on('session', 'session.update', 'id')],
  ['PATCH', '/api/agent/:id/retention', on('session', 'session.update', 'id')],
  ['DELETE', '/api/agent/:id', on('session', 'session.delete', 'id')],
  ['GET', '/api/agent/:id', on('session', 'session.read', 'id')],
  ['GET', '/api/agent/:id/result', on('session', 'session.read', 'id')],
  ['POST', '/api/agent/:id/prompts', on('session', 'session.prompt', 'id')],
  ['POST', '/api/agent/:id/stop', on('session', 'session.stop', 'id')],
  ['POST', '/api/agent/:id/queue', on('session', 'session.prompt', 'id')],
  ['POST', '/api/agent/:id/side-chat/respond', on('session', 'session.prompt', 'id')],
  ['POST', '/api/agent/:id/side-chat/save', on('session', 'session.prompt', 'id')],
  ['POST', '/api/agent/:id/side-chat/send', on('session', 'session.prompt', 'id')],
  ['DELETE', '/api/agent/:id/queue/:item', on('session', 'session.prompt', 'id')],
  ['POST', '/api/relay', NODE_OWNER],
  ['GET', '/api/relay/starts/:key', on('run', 'run.read', 'key')],
  ['GET', '/api/relay/starts/:key/result', on('run', 'run.read', 'key')],
  ['POST', '/api/relay/starts/:key/stop', on('run', 'run.cancel', 'key')],
  ['GET', '/api/relay/:runId', on('run', 'run.read', 'runId')],
  ['GET', '/api/relay/:runId/result', on('run', 'run.read', 'runId')],
  ['POST', '/api/relay/:runId/stop', on('run', 'run.cancel', 'runId')],

  // Account-bound sidecars
  ['GET', '/api/notifications', ACCOUNT],
  ['GET', '/api/notifications/actions', ACCOUNT],
  ['GET', '/api/notifications/:id', ACCOUNT],
  ['POST', '/api/notifications/:id/read', ACCOUNT],
  ['POST', '/api/notifications/:id/snooze', ACCOUNT],
  ['POST', '/api/notifications/:id/actions', ACCOUNT],
  ['GET', '/api/voice/glossary', ACCOUNT],
  ['POST', '/api/voice/glossary', ACCOUNT],
  ['POST', '/api/voice/glossary/apply-preview', ACCOUNT],
  ['PUT', '/api/voice/glossary/:id', ACCOUNT],
  ['GET', '/api/voice/glossary/:id/history', ACCOUNT],
  ['POST', '/api/voice/glossary/:id/deactivate', ACCOUNT],
  ['POST', '/api/voice/glossary/:id/reactivate', ACCOUNT],
  ['POST', '/api/voice/glossary/:id/revert', ACCOUNT],

  // Federation: enrollment bootstrap is unsigned by design, everything else is signed per request.
  ['POST', '/api/federation/device/code', PUBLIC],
  ['POST', '/api/federation/device/token', PUBLIC],
  ['GET', '/api/federation/handshake', SIGNED],
  ['GET', '/api/federation/config', SIGNED],
  ['POST', '/api/federation/config', SIGNED],
  ['GET', '/api/federation/replicas/:stream', SIGNED],
  ['POST', '/api/federation/replicas', SIGNED],
  ['POST', '/api/federation/commands', SIGNED],
  ['POST', '/api/federation/attempts/offers', SIGNED],
  ['POST', '/api/federation/attempts/cancel', SIGNED],
  ['POST', '/api/federation/attempts/dispatch', SIGNED],
  ['POST', '/api/federation/attempts/renew', SIGNED],
  ['POST', '/api/federation/attempts/events', SIGNED],
  ['POST', '/api/federation/attempts/state', SIGNED],
  ['POST', '/api/federation/attempts/dispatch-cancel', SIGNED],
  ['POST', '/api/federation/attempts/runtime/observe', SIGNED],
  ['POST', '/api/federation/attempts/runtime/pin', SIGNED],
  ['POST', '/api/federation/attempts/runtime/count', SIGNED],
  ['POST', '/api/federation/telemetry', SIGNED],
  ['GET', '/api/federation/telemetry', SIGNED],
]

/** A map that refuses mutation once built, so no caller can weaken the policy table at run time. */
class SealedPolicyMap extends Map<string, RoutePolicy> {
  #sealed = false
  constructor(entries: Iterable<readonly [string, RoutePolicy]>) {
    super()
    for (const [key, policy] of entries) {
      if (this.has(key)) throw new Error(`duplicate route policy: ${key}`)
      super.set(key, Object.freeze({ ...policy }))
    }
    this.#sealed = true
  }
  override set(key: string, policy: RoutePolicy): this {
    if (this.#sealed) throw new TypeError('ROUTE_POLICIES is sealed')
    return super.set(key, policy)
  }
  override delete(): boolean { throw new TypeError('ROUTE_POLICIES is sealed') }
  override clear(): void { throw new TypeError('ROUTE_POLICIES is sealed') }
}

/** Every declared policy, keyed by {@link routeKey}. Sealed: set, delete and clear throw. */
export const ROUTE_POLICIES: ReadonlyMap<string, RoutePolicy> = new SealedPolicyMap(
  POLICY_ENTRIES.map(([method, path, policy]) => [routeKey(method, path), policy] as const),
)

/** The declared policy of one registered endpoint, or `undefined` when it is unmapped. */
export function policyFor(method: string, path: string, policies: ReadonlyMap<string, RoutePolicy> = ROUTE_POLICIES): RoutePolicy | undefined {
  return policies.get(routeKey(method, path))
}

/** A registered route as Hono reports it (`app.routes` or a matched route). */
export interface RegisteredRoute {
  readonly method: string
  readonly path: string
}

/**
 * True when the route is an endpoint the policy map governs: it lives under `/api/` and is not
 * one of the known middleware or fallback `ALL` patterns.
 */
export function isGovernedEndpoint(route: RegisteredRoute): boolean {
  if (!route.path.startsWith('/api/')) return false
  return !(route.method === 'ALL' && NON_ENDPOINT_ALL_ROUTES.has(route.path))
}

/** `METHOD path` of every governed endpoint without a declared policy, in registration order. */
export function listUnmappedRoutes(routes: readonly RegisteredRoute[], policies: ReadonlyMap<string, RoutePolicy> = ROUTE_POLICIES): string[] {
  const unmapped: string[] = []
  for (const route of routes) {
    if (!isGovernedEndpoint(route)) continue
    const key = routeKey(route.method, route.path)
    if (!policies.has(key) && !unmapped.includes(key)) unmapped.push(key)
  }
  return unmapped
}

/** Boot refusal: one or more `/api/` endpoints have no declared authorization policy. */
export class RouteAuthzError extends Error {
  readonly code = 'routes_unmapped'
  readonly routes: string[]

  constructor(routes: string[]) {
    super(`Routes without an authorization policy: ${routes.join(', ')}`)
    this.name = 'RouteAuthzError'
    this.routes = [...routes]
  }
}

/** Throws {@link RouteAuthzError} listing every unmapped endpoint. */
export function assertRoutesMapped(routes: readonly RegisteredRoute[], policies: ReadonlyMap<string, RoutePolicy> = ROUTE_POLICIES): void {
  const unmapped = listUnmappedRoutes(routes, policies)
  if (unmapped.length > 0) throw new RouteAuthzError(unmapped)
}
