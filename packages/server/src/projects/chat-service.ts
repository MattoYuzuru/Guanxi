import {
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  type CreateProjectChatBody,
  type Project,
  type ThreadOptions,
  type ThreadWithOwnership,
} from '@alamo/contract'
import type { ModelService } from '../models/service.ts'
import type { ThreadStore } from '../store/threads.ts'
import type { ProjectService } from './service.ts'

export type ProjectChatLookup =
  | { status: 'ok'; project: Project; thread: ThreadWithOwnership }
  | { status: 'project_not_found' }
  | { status: 'chat_not_found' }
  | { status: 'ownership_mismatch' }

/**
 * Canonical Project → Chat ownership boundary. It deliberately exposes no
 * reparent/update operation and never derives ownership from Workspace/path.
 */
export class ProjectChatService {
  private readonly threads: ThreadStore
  private readonly projects: ProjectService
  private readonly models: () => ModelService

  constructor(
    threads: ThreadStore,
    projects: ProjectService,
    models: () => ModelService,
  ) {
    this.threads = threads
    this.projects = projects
    this.models = models
  }

  list(projectId: string): { project: Project; chats: ThreadWithOwnership[] } | null {
    const project = this.projects.get(projectId)
    return project ? { project, chats: this.threads.listByProject(projectId) } : null
  }

  projectless(): ThreadWithOwnership[] {
    return this.threads.listProjectless()
  }

  get(projectId: string, threadId: string): ProjectChatLookup {
    const project = this.projects.get(projectId)
    if (!project) return { status: 'project_not_found' }
    const thread = this.threads.getWithOwnership(threadId)
    if (!thread) return { status: 'chat_not_found' }
    if (thread.projectId !== projectId) return { status: 'ownership_mismatch' }
    return { status: 'ok', project, thread }
  }

  async create(
    projectId: string,
    input: CreateProjectChatBody,
    signal: AbortSignal,
  ): Promise<ThreadWithOwnership | null> {
    if (!this.projects.get(projectId)) return null

    const options: ThreadOptions = {
      numCtx: input.options?.numCtx ?? DEFAULT_CHAT_NUM_CTX,
      temperature: input.options?.temperature ?? DEFAULT_TEMPERATURE,
      think: input.options?.think ?? 'off',
    }
    // Exactly one call preserves the existing model/context admission boundary.
    await this.models().assertContextAllowed(input.model, options.numCtx, signal)

    return this.threads.createWithOwnership({
      title: input.title ?? 'Новый диалог',
      mode: 'chat',
      model: input.model,
      workspaceId: null,
      projectId,
      options,
    })
  }
}
