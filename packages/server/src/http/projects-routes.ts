import {
  PROJECT_PRESENTATION_VERSION,
  PROJECT_CHAT_OWNERSHIP_VERSION,
  contextCheckpointQuery,
  createProjectBody,
  createProjectChatBody,
  getProjectChatResponse,
  projectReferenceSchema,
  updateProjectBody,
  updateProjectPresentationBody,
} from '@alamo/contract'
import { Hono } from 'hono'
import type { AppContext } from '../context.ts'
import { buildContextState, estimateTokens } from '../context/usage.ts'
import { ProjectChatService } from '../projects/chat-service.ts'
import { fail, notFound } from './errors.ts'

export function projectsRoutes(app: AppContext): Hono {
  const routes = new Hono()
  let projectChatService: ProjectChatService | null = null
  const projectChats = () => {
    projectChatService ??= new ProjectChatService(app.threads, app.projects, app.models)
    return projectChatService
  }

  const validReference = (value: string) => projectReferenceSchema.safeParse(value).success

  routes.get('/', (context) => {
    const query = new URL(context.req.url).searchParams
    if (query.size === 0) return context.json({ projects: app.projects.list() })
    if (
      query.size !== 1 ||
      query.getAll('presentationVersion').length !== 1 ||
      query.get('presentationVersion') !== String(PROJECT_PRESENTATION_VERSION)
    ) {
      return context.json(
        { code: 'validation_failed', message: 'Unsupported Project presentation version', details: null },
        400,
      )
    }
    return context.json({
      presentationVersion: PROJECT_PRESENTATION_VERSION,
      projects: app.projects.listWithPresentation(),
    })
  })

  routes.post('/', async (context) => {
    const parsed = createProjectBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Project name must contain 1–120 characters', details: null },
        400,
      )
    }
    return context.json(app.projects.create(parsed.data.name), 201)
  })

  routes.get('/:id/chats', (context) => {
    const projectId = context.req.param('id')
    if (!validReference(projectId)) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Project reference', details: null },
        400,
      )
    }
    const result = projectChats().list(projectId)
    if (!result) return notFound(context, 'project_not_found', 'Project was not found')
    return context.json({
      ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
      project: result.project,
      chats: result.chats,
    })
  })

  routes.post('/:id/chats', async (context) => {
    const projectId = context.req.param('id')
    if (!validReference(projectId)) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Project reference', details: null },
        400,
      )
    }
    const parsed = createProjectChatBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Project Chat request', details: null },
        400,
      )
    }
    try {
      const thread = await projectChats().create(projectId, parsed.data, context.req.raw.signal)
      return thread
        ? context.json(thread, 201)
        : notFound(context, 'project_not_found', 'Project was not found')
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:id/chats/:threadId', (context) => {
    const query = new URL(context.req.url).searchParams
    const checkpointProjection = contextCheckpointQuery.safeParse(Object.fromEntries(query))
    if (
      query.size > 0 &&
      (!checkpointProjection.success ||
        query.getAll('contextCheckpointVersion').length !== 1 ||
        [...query.keys()].some((key) => key !== 'contextCheckpointVersion'))
    ) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid context checkpoint projection', details: null },
        400,
      )
    }
    const projectId = context.req.param('id')
    const threadId = context.req.param('threadId')
    if (!validReference(projectId) || !validReference(threadId)) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Project Chat reference', details: null },
        400,
      )
    }
    const result = projectChats().get(projectId, threadId)
    if (result.status === 'project_not_found') {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    if (result.status === 'chat_not_found') {
      return notFound(context, 'thread_not_found', 'Chat was not found')
    }
    if (result.status === 'ownership_mismatch') {
      return context.json(
        { code: 'project_chat_mismatch', message: 'Chat does not belong to this Project', details: null },
        409,
      )
    }

    const messages = app.threads.messages(result.thread.id)
    const contextCheckpoints = app.threads.contextCheckpoints(result.thread.id)
    const activeMessages = app.threads.activeContextMessages(result.thread.id)
    const lastUsage = [...activeMessages].reverse().find((message) => message.usage)?.usage ?? null
    const response = {
      ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
      project: result.project,
      thread: result.thread,
      messages,
      context: buildContextState({
        usedTokens:
          lastUsage?.promptTokens ??
          activeMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        allocatedTokens: result.thread.options.numCtx,
        usage: lastUsage,
        model: result.thread.model,
        tracker: app.tracker,
      }),
    }
    return context.json(
      query.size === 0
        ? response
        : getProjectChatResponse.parse({ ...response, contextCheckpoints }),
    )
  })

  routes.get('/:id', (context) => {
    const project = app.projects.get(context.req.param('id'))
    return project
      ? context.json(project)
      : notFound(context, 'project_not_found', 'Project was not found')
  })

  routes.patch('/:id/presentation', async (context) => {
    const parsed = updateProjectPresentationBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Project presentation metadata', details: null },
        400,
      )
    }
    const project = app.projects.updatePresentation(context.req.param('id'), parsed.data)
    return project
      ? context.json(project)
      : notFound(context, 'project_not_found', 'Project was not found')
  })

  routes.patch('/:id', async (context) => {
    const parsed = updateProjectBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Project name must contain 1–120 characters', details: null },
        400,
      )
    }
    const project = app.projects.rename(context.req.param('id'), parsed.data.name)
    return project
      ? context.json(project)
      : notFound(context, 'project_not_found', 'Project was not found')
  })

  return routes
}
