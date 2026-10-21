import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { devicePollSchema, deviceRequestSchema, FEDERATION_VERSION, replicaEntrySchema,
  signedConfigOperationSchema, federationAuthSchema } from '@guanxi/contract/federation'
import { FederationError } from './crypto.ts'
import type { Federation, PeerContext } from './service.ts'

// Transport budget, not a model/context limit. Clients split replication pages on 413.
export const FEDERATION_BODY_BYTES = 1024 * 1024
async function jsonBody(request: Request): Promise<unknown> {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > FEDERATION_BODY_BYTES) { await reader.cancel(); throw new FederationError('message_too_large', 413) }
    chunks.push(part.value)
  }
  if (size === 0) return null
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new FederationError('invalid_message', 400) }
}
export function federationRoutes(resolve: () => Federation) {
  const app = new Hono<{ Variables: { federation: Federation; peer: PeerContext; body: unknown } }>()
  app.onError((error, c) => {
    const code = error instanceof FederationError ? error.code : error instanceof ZodError ? 'invalid_message' : 'federation_unavailable'
    const status = error instanceof FederationError ? error.status : error instanceof ZodError ? 400 : 503
    return c.json({ code }, status as 400)
  })
  app.use('*', async (c, next) => {
    const federation = resolve()
    c.set('federation', federation)
    const body = await jsonBody(c.req.raw)
    c.set('body', body)
    const url = new URL(c.req.url)
    if (['/device/code', '/device/token'].some((suffix) => url.pathname === `/api/federation${suffix}`) && c.req.method === 'POST') {
      await next(); return
    }
    let auth: unknown
    try { auth = JSON.parse(c.req.header('X-Guanxi-Node') ?? 'null') } catch { throw new FederationError('unauthenticated', 401) }
    const parsed = federationAuthSchema.safeParse(auth)
    if (!parsed.success) throw new FederationError('unauthenticated', 401)
    c.set('peer', federation.authenticate(c.req.method, url.pathname + url.search, body, parsed.data))
    await next()
  })
  app.post('/device/code', (c) => c.json(c.get('federation').enrollment.begin(deviceRequestSchema.parse(c.get('body')).publicKey)))
  app.post('/device/token', (c) => c.json(c.get('federation').enrollment.poll(devicePollSchema.parse(c.get('body')).device_code)))
  app.get('/handshake', (c) => c.json({ version: FEDERATION_VERSION, negotiated: c.get('peer').version, readOnly: c.get('peer').readOnly }))
  app.get('/config', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'config')
    return c.json({ operations: f.config.operations().filter((op) => op.operation.accountId === peer.accountId) })
  })
  app.post('/config', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'config', true)
    const ops = z.array(signedConfigOperationSchema).parse(c.get('body'))
    if (ops.some((op) => op.operation.accountId !== peer.accountId)) throw new FederationError('owner_mismatch', 403)
    f.config.ingest(ops); return c.json({ applied: true })
  })
  app.get('/replicas/:stream', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'replicas')
    const after = z.coerce.number().int().nonnegative().safe().parse(c.req.query('after') ?? 0)
    return c.json({ entries: f.replicas.export(peer, c.req.param('stream'), after) })
  })
  app.post('/replicas', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'replicas', true)
    f.replicas.ingest(peer, z.array(replicaEntrySchema).parse(c.get('body'))); return c.json({ applied: true })
  })
  app.post('/commands', (c) => c.json({ result: c.get('federation').receiveCommand(c.get('peer'), c.get('body') as never) }))
  app.post('/telemetry', (c) => { c.get('federation').receiveTelemetry(c.get('peer'), c.get('body') as never); return c.json({ applied: true }) })
  app.get('/telemetry', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'telemetry')
    if (peer.accountId !== f.identity.accountId) throw new FederationError('owner_mismatch', 403)
    return c.json({ samples: f.telemetry() })
  })
  return app
}
