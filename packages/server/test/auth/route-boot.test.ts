import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { start } from '../../src/index.ts'
import { ROUTE_POLICIES, RouteAuthzError, isGovernedEndpoint, listUnmappedRoutes, routeKey } from '../../src/auth/route-policy.ts'
import { identity } from '../federation/harness.ts'

/** The full route set needs the `federation` option; without it the federation rows are absent. */
function federation() {
  const { identity: node, privateKey } = identity('route-boot-node')
  return { identity: node, privateKey }
}

describe('route policy map against the booted server', () => {
  let dataDir: string
  before(() => { dataDir = mkdtempSync(join(tmpdir(), 'guanxi-route-boot-')) })
  after(() => { rmSync(dataDir, { recursive: true, force: true }) })

  it('declares every registered /api endpoint and keeps no stale policy', { timeout: 60_000 }, async () => {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [], federation: federation() })
    try {
      const routes = server.app.routes
      assert.deepEqual(listUnmappedRoutes(routes), [])
      const registered = new Set(routes.filter(isGovernedEndpoint).map((route) => routeKey(route.method, route.path)))
      const stale = [...ROUTE_POLICIES.keys()].filter((key) => !registered.has(key))
      assert.deepEqual(stale, [], 'a policy names a route that is no longer registered')
      // The set is large enough that an accidentally empty registration cannot pass.
      assert.ok(registered.size >= 150, `only ${registered.size} endpoints registered`)
    } finally {
      await server.close()
    }
  })

  it('serves the single owner exactly as before over a real loopback socket', { timeout: 60_000 }, async () => {
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
    try {
      const base = `http://127.0.0.1:${server.port}`
      assert.equal((await fetch(`${base}/api/health`)).status, 200)
      assert.equal((await fetch(`${base}/api/settings`)).status, 200)
      assert.equal((await fetch(`${base}/api/threads`)).status, 200)
      assert.equal((await fetch(`${base}/api/models/catalog`)).status, 200)
      const unknown = await fetch(`${base}/api/not-a-route`)
      assert.equal(unknown.status, 404)
      assert.equal(((await unknown.json()) as { code: string }).code, 'internal_error')
    } finally {
      await server.close()
    }
  })

  it('refuses to boot when a route has no policy, and names it', { timeout: 60_000 }, async () => {
    const policies = ROUTE_POLICIES as Map<string, unknown>
    const key = 'GET /api/health'
    const saved = policies.get(key)
    assert.ok(saved)
    policies.delete(key)
    try {
      const outcome = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
        .then((server) => ({ server }), (error: unknown) => ({ error }))
      // A boot that wrongly succeeds is closed first so the failure is an assertion, not a hung process.
      if ('server' in outcome) await outcome.server.close()
      assert.ok('error' in outcome, 'the boot must refuse an unmapped route')
      assert.ok(outcome.error instanceof RouteAuthzError)
      assert.deepEqual(outcome.error.routes, [key])
    } finally {
      policies.set(key, saved)
    }
    // The failed boot released the data directory: the next boot succeeds.
    const server = await start({ port: 0, host: '127.0.0.1', dataDir, webDir: dataDir, devOrigins: [] })
    await server.close()
  })
})
