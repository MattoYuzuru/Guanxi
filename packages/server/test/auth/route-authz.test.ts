import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { apiErrorSchema } from '@guanxi/contract'
import { LOCAL_OWNER_PRINCIPAL, routeAuthz, type AccountsAdapter, type AuthzContext } from '../../src/auth/route-authz.ts'
import {
  ROUTE_POLICIES,
  ROOT_RESOURCE_ID,
  RouteAuthzError,
  assertRoutesMapped,
  listUnmappedRoutes,
  type RoutePolicy,
} from '../../src/auth/route-policy.ts'
import type { Action, Grant, Principal, Resource, ResourceType } from '../../src/auth/types.ts'

const NOW = 1_800_000_000_000
const OWNER = 'owner-1'

type Role = 'owner' | 'admin' | 'editor' | 'viewer' | 'stranger' | 'anonymous' | 'link'
const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer', 'stranger', 'anonymous', 'link']

const PRINCIPALS: Record<Role, Principal> = {
  owner: { kind: 'user', userId: OWNER, role: 'member', groups: [] },
  admin: { kind: 'user', userId: 'admin-1', role: 'admin', groups: [] },
  editor: { kind: 'user', userId: 'editor-1', role: 'member', groups: [] },
  viewer: { kind: 'user', userId: 'viewer-1', role: 'member', groups: [] },
  stranger: { kind: 'user', userId: 'stranger-1', role: 'member', groups: [] },
  anonymous: { kind: 'anonymous' },
  link: { kind: 'link', linkId: 'link-1' },
}

const SHAREABLE: readonly ResourceType[] = ['project', 'session', 'connection', 'run']

/** Every shareable resource with id `r1` carries one grant per sharing role. */
const GRANTS: Grant[] = SHAREABLE.flatMap((resourceType) => [
  grant(resourceType, 'editor', 'user', 'editor-1'),
  grant(resourceType, 'viewer', 'user', 'viewer-1'),
  grant(resourceType, 'viewer', 'link', 'link-1'),
])

function grant(resourceType: ResourceType, relation: Grant['relation'], subjectType: Grant['subjectType'], subjectId: string): Grant {
  return { resourceType, resourceId: 'r1', relation, subjectType, subjectId, createdBy: OWNER, createdAt: NOW - 1, expiresAt: null }
}

function adapter(overrides: Partial<AccountsAdapter> = {}): AccountsAdapter {
  return {
    nodeOwnerId: OWNER,
    principal: (context) => PRINCIPALS[(context.req.header('x-role') ?? 'anonymous') as Role],
    grants: (resource) => GRANTS.filter((g) => g.resourceType === resource.type && g.resourceId === resource.id),
    ...overrides,
  }
}

/** A stand-in app: the real hook in front of one stub handler per policy entry, in table order. */
function stubApp(options: { accounts?: AccountsAdapter } = {}): { app: Hono; hits: string[] } {
  const hits: string[] = []
  const app = new Hono()
  app.use('/api/*', routeAuthz({ ...options, now: () => NOW }))
  for (const key of ROUTE_POLICIES.keys()) {
    const [method, path] = key.split(' ') as [string, string]
    app.on(method, path, (context) => { hits.push(key); return context.json({ ok: true }) })
  }
  app.all('/api/*', (context) => context.json({ code: 'internal_error' }, 404))
  return { app, hits }
}

/** The concrete URL a pattern is exercised with: every parameter is the resource id `r1`. */
function concretePath(pattern: string): string {
  return pattern.replace(/:\w+(\{[^}]*\})?/gu, 'r1')
}

const LEVEL: Record<Action, number> = {
  'session.read': 1, 'session.prompt': 2, 'session.stop': 2, 'session.share': 3, 'session.delete': 3,
  'project.read': 1, 'project.write': 2, 'project.share': 3, 'project.delete': 3,
  'connection.use': 2, 'connection.read': 1, 'connection.manage': 3,
  'run.read': 1, 'run.cancel': 2,
  'node.admin': 3, 'account.invite': 3, 'account.ban': 3,
}

/** Independent oracle for the matrix: the status the policy kind and role must yield. */
function expectedStatus(policy: RoutePolicy, role: Role): 200 | 401 | 403 {
  if (policy.kind === 'public' || policy.kind === 'node-signed') return 200
  if (role === 'anonymous') return 401
  if (policy.kind === 'authenticated') return role === 'link' ? 403 : 200
  if (policy.kind === 'account') return role === 'owner' ? 200 : 403
  if (policy.resource === 'node') return role === 'owner' || role === 'admin' ? 200 : 403
  if (policy.idParam === undefined) return role === 'owner' ? 200 : 403
  const held: Record<Role, number> = { owner: 3, admin: 0, editor: 2, viewer: 1, stranger: 0, anonymous: 0, link: 1 }
  return held[role] >= LEVEL[policy.action] ? 200 : 403
}

describe('route authorization matrix (roles x route policy map)', () => {
  it('covers every kind of policy and every shareable resource family', () => {
    const kinds = new Set([...ROUTE_POLICIES.values()].map((policy) => policy.kind))
    assert.deepEqual([...kinds].sort(), ['account', 'authenticated', 'authorize', 'node-signed', 'public'])
    const resources = new Set([...ROUTE_POLICIES.values()].flatMap((policy) => policy.kind === 'authorize' ? [policy.resource] : []))
    assert.deepEqual([...resources].sort(), ['connection', 'node', 'project', 'run', 'session'])
    assert.ok(ROUTE_POLICIES.size >= 150)
  })

  it('answers each role on every mapped route exactly as the policy and can() require', async () => {
    const { app, hits } = stubApp({ accounts: adapter() })
    const failures: string[] = []
    let cells = 0
    for (const [key, policy] of ROUTE_POLICIES) {
      const [method, pattern] = key.split(' ') as [string, string]
      for (const role of ROLES) {
        cells++
        const before = hits.length
        const response = await app.request(concretePath(pattern), { method, headers: { 'x-role': role } })
        const want = expectedStatus(policy, role)
        if (response.status !== want) failures.push(`${key} as ${role}: ${response.status}, want ${want}`)
        // A refused request never reaches the handler; an allowed one reaches exactly the one handler.
        const reached = hits.length - before
        if (reached !== (want === 200 ? 1 : 0)) failures.push(`${key} as ${role}: handler reached ${reached} times`)
        if (want !== 200) {
          const body = apiErrorSchema.parse(await response.json())
          if (body.code !== (want === 401 ? 'unauthenticated' : 'forbidden')) failures.push(`${key} as ${role}: code ${body.code}`)
        }
      }
    }
    assert.deepEqual(failures, [])
    assert.equal(cells, ROUTE_POLICIES.size * ROLES.length)
  })

  it('keeps the server admin out of other users data (D-155) but lets it administer the node', async () => {
    const { app } = stubApp({ accounts: adapter() })
    const as = async (role: Role, method: string, path: string) =>
      (await app.request(path, { method, headers: { 'x-role': role } })).status
    assert.equal(await as('admin', 'GET', '/api/threads/r1'), 403)
    assert.equal(await as('admin', 'GET', '/api/projects'), 403)
    assert.equal(await as('admin', 'GET', '/api/connections'), 403)
    assert.equal(await as('admin', 'PUT', '/api/settings'), 200)
    assert.equal(await as('admin', 'POST', '/api/models/r1/pull'), 200)
    assert.equal(await as('stranger', 'PUT', '/api/settings'), 403)
  })

  it('refuses a collection or create route to a shared editor: roots carry no grants', async () => {
    const { app } = stubApp({ accounts: adapter({ grants: () => GRANTS.map((g) => ({ ...g, resourceId: ROOT_RESOURCE_ID })) }) })
    for (const [method, path] of [['GET', '/api/threads'], ['POST', '/api/threads'], ['GET', '/api/projects'], ['POST', '/api/projects'], ['POST', '/api/connections']] as const) {
      const response = await app.request(path, { method, headers: { 'x-role': 'editor' } })
      assert.equal(response.status, 403, `${method} ${path}`)
    }
  })

  it('does not leak existence: a missing resource and a foreign one answer the same 403', async () => {
    const { app } = stubApp({ accounts: adapter() })
    const foreign = await app.request('/api/threads/r1/context', { headers: { 'x-role': 'stranger' } })
    const missing = await app.request('/api/threads/does-not-exist/context', { headers: { 'x-role': 'stranger' } })
    assert.equal(foreign.status, 403)
    assert.equal(missing.status, 403)
    assert.deepEqual(await foreign.json(), await missing.json())
  })

  it('shadowing: a static route registered before a parameterized one is judged by its own policy', async () => {
    const { app } = stubApp({ accounts: adapter() })
    // `GET /api/threads/models` precedes `GET /api/threads/:id`; a stranger may list models (authenticated)
    // but may not read a thread called "models".
    assert.equal((await app.request('/api/threads/models', { headers: { 'x-role': 'stranger' } })).status, 200)
    assert.equal((await app.request('/api/threads/r2', { headers: { 'x-role': 'stranger' } })).status, 403)
  })
})

describe('route parameters', () => {
  it('hands the decoded route parameter to the resource projection', async () => {
    const seen: Array<[ResourceType, string]> = []
    const { app } = stubApp({
      accounts: adapter({
        resource: (type, id): Resource => { seen.push([type, id]); return { type, id, ownerUserId: OWNER } },
      }),
    })
    await app.request('/api/sessions/s%201%2Fx/events', { headers: { 'x-role': 'owner' } })
    await app.request('/api/models/a%2Fb/pull', { method: 'POST', headers: { 'x-role': 'owner' } })
    await app.request('/api/work/projects/p-9/items', { headers: { 'x-role': 'owner' } })
    await app.request('/api/projects/p-9/chats/t-4', { headers: { 'x-role': 'owner' } })
    assert.deepEqual(seen, [['session', 's 1/x'], ['project', 'p-9'], ['session', 't-4']])
  })

  it('refuses an id that spells the root resource', async () => {
    const { app, hits } = stubApp({ accounts: adapter() })
    const response = await app.request(`/api/threads/${encodeURIComponent(ROOT_RESOURCE_ID)}`, { headers: { 'x-role': 'owner' } })
    assert.equal(response.status, 403)
    assert.equal(hits.length, 0)
  })
})

describe('fail closed: a route without a policy', () => {
  for (const mode of ['local owner', 'remote owner'] as const) {
    it(`refuses an unmapped GET, POST and ALL endpoint without running the handler (${mode})`, async () => {
      const { app } = stubApp(mode === 'remote owner' ? { accounts: adapter() } : {})
      let ran = 0
      app.get('/api/ghost', (context) => { ran++; return context.json({ ok: true }) })
      app.post('/api/ghost/:id', (context) => { ran++; return context.json({ ok: true }) })
      app.all('/api/ghost-all', (context) => { ran++; return context.json({ ok: true }) })
      app.all('/api/ghost-family/*', (context) => { ran++; return context.json({ ok: true }) })
      const headers = { 'x-role': 'owner' }
      for (const [method, path] of [['GET', '/api/ghost'], ['POST', '/api/ghost/7'], ['PATCH', '/api/ghost-all'], ['DELETE', '/api/ghost-family/x/y']]) {
        const response = await app.request(path!, { method, headers })
        assert.equal(response.status, 403, `${method} ${path}`)
        const body = apiErrorSchema.parse(await response.json())
        assert.equal(body.code, 'route_unmapped')
      }
      assert.equal(ran, 0)
    })
  }

  it('lists every unmapped endpoint and the boot check throws with the list', () => {
    const { app } = stubApp()
    app.get('/api/ghost', (context) => context.json({}))
    app.on('PUT', '/api/ghost/:id', (context) => context.json({}))
    app.all('/api/ghost-all', (context) => context.json({}))
    const unmapped = listUnmappedRoutes(app.routes)
    assert.deepEqual(unmapped, ['GET /api/ghost', 'PUT /api/ghost/:id', 'ALL /api/ghost-all'])
    assert.throws(() => assertRoutesMapped(app.routes), (error: unknown) => {
      assert.ok(error instanceof RouteAuthzError)
      assert.equal(error.code, 'routes_unmapped')
      assert.deepEqual(error.routes, unmapped)
      assert.match(error.message, /GET \/api\/ghost/u)
      return true
    })
  })

  it('does not govern the web bundle or an API path nobody registered', async () => {
    const { app } = stubApp({ accounts: adapter() })
    app.get('/assets/app.js', (context) => context.text('js'))
    assert.equal((await app.request('/assets/app.js')).status, 200)
    // Unknown API path: no endpoint matched, the existing 404 fallback answers.
    const unknown = await app.request('/api/nothing-here', { headers: { 'x-role': 'anonymous' } })
    assert.equal(unknown.status, 404)
    // A registered path with another method also falls to the fallback, as before.
    assert.equal((await app.request('/api/health', { method: 'DELETE', headers: { 'x-role': 'anonymous' } })).status, 404)
  })
})

describe('local owner mode is unchanged', () => {
  it('admits the implicit owner on every mapped route without credentials', async () => {
    const { app, hits } = stubApp()
    for (const key of ROUTE_POLICIES.keys()) {
      const [method, pattern] = key.split(' ') as [string, string]
      const response = await app.request(concretePath(pattern), { method })
      assert.equal(response.status, 200, key)
    }
    assert.equal(hits.length, ROUTE_POLICIES.size)
  })

  it('adds no scheduling turn: the handler starts inside the request call, as before the hook', async () => {
    const { app, hits } = stubApp()
    // Existing tests (runtime reconciliation) assert that a handler's first call happens synchronously.
    const pending = [
      app.request('/api/runtime'),
      app.request('/api/threads/r1'),
      app.request('/api/models/r1/pull', { method: 'POST' }),
      app.request('/api/federation/handshake'),
    ]
    assert.equal(hits.length, 4)
    await Promise.all(pending)
  })

  it('exposes the owner principal to handlers', async () => {
    const app = new Hono<{ Variables: { authz: AuthzContext } }>()
    app.use('/api/*', routeAuthz())
    app.get('/api/health', (context) => context.json({ principal: context.get('authz').principal }))
    const body = await (await app.request('/api/health')).json() as { principal: Principal }
    assert.deepEqual(body.principal, LOCAL_OWNER_PRINCIPAL)
    assert.equal(body.principal.kind === 'user' && body.principal.role, 'admin')
  })
})
