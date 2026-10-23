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
  app.route('/api/federation', federationRoutes(() => {
    const service = options.federation()
    if (!service) throw new FederationError('federation_unavailable', 503)
    return service
  }))
  app.all('*', c => c.json({ code: 'not_found' }, 404))
  return app
}
