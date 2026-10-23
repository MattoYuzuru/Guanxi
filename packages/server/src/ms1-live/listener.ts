import { Hono } from 'hono'
import { FederationError } from '../federation/crypto.ts'
import { federationRoutes } from '../federation/routes.ts'
import type { Federation } from '../federation/service.ts'
import { hostAllowlist } from '../http/host-allowlist.ts'

/** The application served by the federation-only listener of an MS1 node: the signed node-to-node API and a `404` for everything
 * else, behind the same Host allowlist as the owner API. It is the only application the operator's ssh forward reaches. */
export function federationListener(options: { host: string; port: number; federation: () => Federation | undefined }): Hono {
  const app = new Hono()
  app.use('*', hostAllowlist({ host: options.host, port: options.port }))
  // Device enrollment is the one unsigned, state-writing part of the federation API. MS1 nodes are paired by exchanging public
  // files, never by enrollment, so it is not served here at all.
  app.all('/api/federation/device/*', c => c.json({ code: 'not_found' }, 404))
  // An MS1 node serves relay model calls only, and those are counted jobs (the executor re-counts and re-renders them). A job
  // without the home's count is a plain chat call, which this pairing never makes: refuse it before anything reads it further.
  app.post('/api/federation/attempts/dispatch', async (c, next) => {
    const body = await c.req.raw.clone().json().catch(() => null) as { grant?: { job?: { counted?: unknown } } } | null
    if (!body?.grant?.job?.counted || typeof body.grant.job.counted !== 'object') return c.json({ code: 'uncounted_refused' }, 403)
    await next()
  })
  app.route('/api/federation', federationRoutes(() => {
    const service = options.federation()
    if (!service) throw new FederationError('federation_unavailable', 503)
    return service
  }))
  app.all('*', c => c.json({ code: 'not_found' }, 404))
  return app
}
