import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import {
  createGlossaryEntryBodySchema,
  glossaryEmptyBodySchema,
  glossaryEntryIdSchema,
  glossaryHistoryResponseSchema,
  glossaryPreviewBodySchema,
  listGlossaryQuerySchema,
  listGlossaryResponseSchema,
  updateGlossaryEntryBodySchema,
  type GlossaryErrorCode,
} from '@guanxi/contract'
import { ServiceUnavailableError, failureResponse, localGuard, wire } from '../http/local-guard.ts'
import type { VoiceGlossary } from './plugin.ts'
import { glossaryFailure, mutating, toPreviewWire, toRevisionWire, toStoredEntryWire } from './wire.ts'

/**
 * REST surface of the voice glossary. `accountId` is the single local owner today and is passed
 * to every store call, so a U3 `can()` check becomes one call per handler. Revisions written
 * here always have source `user`.
 */
export function glossaryRoutes(resolve: () => VoiceGlossary | undefined, accountId: string, devOrigins: readonly string[] = []): Hono {
  const routes = new Hono()
  const voice = (): VoiceGlossary => {
    const current = resolve()
    if (current === undefined) throw new ServiceUnavailableError()
    return current
  }
  routes.onError((error, c) => {
    if (error instanceof ServiceUnavailableError) {
      return failureResponse(c, { code: 'glossary_unavailable' satisfies GlossaryErrorCode, status: 503 })
    }
    return failureResponse(c, glossaryFailure(error))
  })
  routes.use('*', localGuard(devOrigins))

  routes.get('/', (c) => {
    const query = listGlossaryQuerySchema.parse(c.req.query())
    const rows = voice().store.list(accountId, { projectId: query.projectId, includeInactive: query.includeInactive })
    return c.json(wire(listGlossaryResponseSchema, { entries: rows.map(toStoredEntryWire) }))
  })
  routes.post('/', async (c) => {
    const body = createGlossaryEntryBodySchema.parse(await c.req.json())
    const id = body.id ?? `gl_${randomUUID()}`
    const row = mutating(() => voice().store.create(accountId, body.scope, body.projectId ?? null, { ...body.entry, id }, 'user'))
    return c.json(toStoredEntryWire(row), 201)
  })
  routes.post('/apply-preview', async (c) => {
    const body = glossaryPreviewBodySchema.parse(await c.req.json())
    const { service } = voice()
    const projectId = body.projectId ?? null
    // `apply` and `effective` share the cached compiled set; the revision hash names exactly it.
    const result = service.apply(accountId, projectId, body.text)
    return c.json(toPreviewWire(result, service.effective(accountId, projectId)))
  })
  routes.put('/:id', async (c) => {
    const id = glossaryEntryIdSchema.parse(c.req.param('id'))
    const body = updateGlossaryEntryBodySchema.parse(await c.req.json())
    return c.json(toStoredEntryWire(mutating(() => voice().store.update(accountId, id, { ...body.entry, id }, 'user'))))
  })
  routes.get('/:id/history', (c) => {
    const id = glossaryEntryIdSchema.parse(c.req.param('id'))
    return c.json(wire(glossaryHistoryResponseSchema, { revisions: voice().store.history(accountId, id).map(toRevisionWire) }))
  })
  for (const command of ['deactivate', 'reactivate', 'revert'] as const) {
    routes.post(`/:id/${command}`, async (c) => {
      const id = glossaryEntryIdSchema.parse(c.req.param('id'))
      glossaryEmptyBodySchema.parse(await c.req.json())
      return c.json(toStoredEntryWire(mutating(() => voice().store[command](accountId, id))))
    })
  }
  return routes
}
