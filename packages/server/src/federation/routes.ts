import { Hono } from 'hono'
import { z, ZodError } from 'zod'
import { devicePollSchema, deviceRequestSchema, FEDERATION_VERSION, LAYOUT_CONFIG_MINOR, ATTEMPT_RESERVATIONS_MINOR, replicaEntrySchema,
  signedConfigOperationSchema, federationAuthSchema } from '@guanxi/contract/federation'
import { FEDERATION_BODY_BYTES, FederationError } from './crypto.ts'
import type { Federation, PeerContext } from './service.ts'

export { FEDERATION_BODY_BYTES }
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
    if (c.req.method === 'POST' && c.req.path === '/api/federation/device/code' &&
      c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new FederationError('json_required', 415)
    }
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
  app.get('/handshake', (c) => c.json({ version: FEDERATION_VERSION, negotiated: c.get('peer').version, readOnly: c.get('peer').readOnly,
    ...(c.get('peer').version.major === FEDERATION_VERSION.major && c.get('peer').version.minor >= ATTEMPT_RESERVATIONS_MINOR
      ? { capabilities: c.get('federation').capabilities() } : {}) }))
  app.get('/config', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'config')
    const operations = f.config.operations().filter((op) => op.operation.accountId === peer.accountId)
    if (c.get('peer').version.minor < LAYOUT_CONFIG_MINOR && operations.some(op => op.operation.value.kind === 'layout')) {
      // Omitting a layout dot would also omit a causal dependency of later settings. Require
      // an upgrade instead of exporting a truncated history that can never converge.
      throw new FederationError('contract_feature_unavailable', 426)
    }
    return c.json({ operations })
  })
  app.post('/config', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'config', true)
    const body = c.get('body')
    if (Array.isArray(body) && body.length > f.configOpsPerRequest) throw new FederationError('config_batch_too_large', 413)
    const ops = z.array(signedConfigOperationSchema).parse(body)
    if (c.get('peer').version.minor < LAYOUT_CONFIG_MINOR && ops.some(op => op.operation.value.kind === 'layout')) throw new FederationError('contract_feature_unavailable', 426)
    if (ops.some((op) => op.operation.accountId !== peer.accountId)) throw new FederationError('owner_mismatch', 403)
    return c.json({ applied: true, ...f.config.ingest(ops) })
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
  app.post('/attempts/offers', async (c) => c.json(await c.get('federation').receiveAttemptOffer(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/cancel', (c) => c.json(c.get('federation').cancelAttemptOffer(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/dispatch', async c => c.json(await c.get('federation').receiveDispatch(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/renew', c => c.json(c.get('federation').renewDispatch(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/events', c => { c.get('federation').receiveDispatchEvent(c.get('peer'), c.get('body') as never); return c.json({ applied: true }) })
  app.post('/attempts/state', c => c.json(c.get('federation').dispatchState(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/dispatch-cancel', c => c.json(c.get('federation').cancelDispatch(c.get('peer'), c.get('body') as never)))
  app.post('/attempts/runtime/observe', async c => c.json(await c.get('federation').receiveRelayObserve(c.get('peer'), c.get('body'))))
  app.post('/attempts/runtime/pin', c => c.json(c.get('federation').receiveRelayPin(c.get('peer'), c.get('body'))))
  app.post('/attempts/runtime/count', async c => c.json(await c.get('federation').receiveRelayCount(c.get('peer'), c.get('body'))))
  app.post('/telemetry', (c) => { c.get('federation').receiveTelemetry(c.get('peer'), c.get('body') as never); return c.json({ applied: true }) })
  app.get('/telemetry', (c) => {
    const f = c.get('federation'); const peer = f.authorize(c.get('peer'), 'telemetry')
    return c.json({ samples: f.telemetry(peer.accountId) })
  })
  return app
}
