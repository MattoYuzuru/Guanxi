import { Hono } from 'hono'
import { z } from 'zod'
import { nativeAgentInputSchema, nativeAgentPromptSchema, nativeProjectRootsInputSchema, deleteNativeSessionResponseSchema, nativeRetentionInputSchema, nativeRetentionSchema } from '@guanxi/contract'
import { isLoopbackPeer } from '../session-log/routes.ts'
import { NativeAgentError } from './service.ts'
import { SideChatError } from './side-chat.ts'
import type { NativeAgentService } from './plugin.ts'
const text = nativeAgentPromptSchema
export function nativeAgentRoutes(service: () => NativeAgentService, devOrigins: readonly string[] = []) {
  const app = new Hono()
  const status = { session_not_found: 404, session_unavailable: 409, session_busy: 409, operation_conflict: 409, context_too_large: 413, validation_failed: 400,
    quota_exhausted: 429, cancelled: 499, model_failed: 502, connection_unavailable: 503, egress_unavailable: 503, agent_unavailable: 503 } as const
  app.onError((error, c) => {
    if (error instanceof SideChatError) return c.json({ code: error.code, ...(error.details ? { details: error.details } : {}) }, status[error.code] as 400)
    return c.json({ code: error instanceof NativeAgentError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'validation_failed' : 'agent_unavailable' },
      error instanceof NativeAgentError && error.code.endsWith('not_found') ? 404 : error instanceof NativeAgentError && ['session_busy','writer_busy','cleanup_unconfirmed'].includes(error.code) ? 409 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503)
  })
  app.use('*', async (c, next) => {
    if (!isLoopbackPeer(c)) return c.json({ code: 'loopback_only' }, 403)
    c.header('Cache-Control', 'no-store')
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin')
      if (origin && origin !== new URL(c.req.url).origin && !devOrigins.includes(origin)) return c.json({ code: 'origin_denied' }, 403)
      if (c.req.method !== 'DELETE' && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ code: 'json_required' }, 415)
    }
    await next()
  })
  app.get('/projects', c => c.json({ projects: service().projects() }))
  app.post('/', async c => c.json(await service().create(nativeAgentInputSchema.parse(await c.req.json())), 202))
  app.patch('/projects/:id/roots', async c => c.json(service().setRoots(c.req.param('id'), nativeProjectRootsInputSchema.parse(await c.req.json()).workspaceIds)))
  app.post('/:id/leave', c => c.json(nativeRetentionSchema.parse(service().leaveSession(c.req.param('id')))))
  app.patch('/:id/retention', async c => c.json(nativeRetentionSchema.parse(service().setRetention(c.req.param('id'), nativeRetentionInputSchema.parse(await c.req.json()).mode))))
  app.delete('/:id', async c => c.json(deleteNativeSessionResponseSchema.parse(await service().deleteSession(c.req.param('id')))))
  app.get('/:id', c => c.json(service().progress(c.req.param('id'))))
  app.get('/:id/result', c => c.json(service().result(c.req.param('id'))))
  app.post('/:id/prompts', async c => { await service().prompt(c.req.param('id'), text.parse(await c.req.json()).text); return c.json({ ok: true }, 202) })
  app.post('/:id/stop', c => { service().stop(c.req.param('id')); return c.json({ ok: true }) })
  app.post('/:id/queue', async c => { await service().queue(c.req.param('id'), text.parse(await c.req.json()).text); return c.json({ ok: true }, 202) })
  // Ephemeral side chat: `respond` is stateless; `save` and `send` are the only durable actions.
  app.post('/:id/side-chat/respond', async c => c.json(await service().sideChatRespond(c.req.param('id'), await c.req.json(), c.req.raw.signal)))
  app.post('/:id/side-chat/save', async c => c.json(await service().sideChatSave(c.req.param('id'), await c.req.json())))
  app.post('/:id/side-chat/send', async c => c.json(await service().sideChatSend(c.req.param('id'), await c.req.json()), 202))
  app.delete('/:id/queue/:item', async c => { await service().removeQueued(c.req.param('id'), c.req.param('item')); return c.json({ ok: true }) })
  return app
}
