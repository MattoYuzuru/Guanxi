import { Hono } from 'hono'
import {
  addWorkRevisionBodySchema,
  appendWorkEventBodySchema,
  listWorkItemsQuerySchema,
  setWorkModeBodySchema,
  workExportResponseSchema,
  workProjectIdSchema,
  type WorkErrorCode,
} from '@guanxi/contract'
import { ServiceUnavailableError, failureResponse, localGuard, wire } from '../http/local-guard.ts'
import type { WorkLedger } from './ledger.ts'
import { toEventWire, toItemsPageWire, toLatestRevisionWire, toModeWire, toPlanRevisionWire, workFailure } from './wire.ts'

/**
 * REST surface of the project work ledger under `/projects/:projectId`. `accountId` is the single
 * local owner today; it fixes the provenance of appended evidence (`user:<account>`). The ledger
 * itself is keyed by project, so account isolation of project ids is a U3 concern: each handler
 * receives the project id as a plain value, ready for a `project.read`/`project.write` check.
 *
 * Only human evidence is writable here. Harness, judge and agent evidence enter through kernel
 * services and can never be forged over HTTP.
 */
export function workRoutes(resolve: () => WorkLedger | undefined, accountId: string, devOrigins: readonly string[] = []): Hono {
  const routes = new Hono()
  const ledger = (): WorkLedger => {
    const current = resolve()
    if (current === undefined) throw new ServiceUnavailableError()
    return current
  }
  const project = (value: string | undefined): string => workProjectIdSchema.parse(value)
  routes.onError((error, c) => {
    if (error instanceof ServiceUnavailableError) {
      return failureResponse(c, { code: 'work_unavailable' satisfies WorkErrorCode, status: 503 })
    }
    return failureResponse(c, workFailure(error))
  })
  routes.use('*', localGuard(devOrigins))

  routes.get('/projects/:projectId/revision', (c) => c.json(toLatestRevisionWire(ledger().latest(project(c.req.param('projectId'))))))
  routes.post('/projects/:projectId/revisions', async (c) => {
    const id = project(c.req.param('projectId'))
    const body = addWorkRevisionBodySchema.parse(await c.req.json())
    return c.json(toPlanRevisionWire(ledger().addRevision(id, body.items)), 201)
  })
  routes.post('/projects/:projectId/events', async (c) => {
    const id = project(c.req.param('projectId'))
    const body = appendWorkEventBodySchema.parse(await c.req.json())
    return c.json(toEventWire(ledger().appendHumanEvent(accountId, id, body)), 201)
  })
  routes.get('/projects/:projectId/items', (c) => {
    const id = project(c.req.param('projectId'))
    const query = listWorkItemsQuerySchema.parse(c.req.query())
    return c.json(toItemsPageWire(ledger().page(id, query)))
  })
  routes.get('/projects/:projectId/mode', (c) => c.json(toModeWire(ledger().mode(project(c.req.param('projectId'))))))
  routes.put('/projects/:projectId/mode', async (c) => {
    const id = project(c.req.param('projectId'))
    const body = setWorkModeBodySchema.parse(await c.req.json())
    return c.json(toModeWire(ledger().setMode(id, body.mode, body.reason)))
  })
  routes.get('/projects/:projectId/export', (c) => {
    const id = project(c.req.param('projectId'))
    return c.json(wire(workExportResponseSchema, { projectId: id, ...ledger().exportMarkdown(id) }))
  })
  return routes
}
