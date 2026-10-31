import { chatIdempotencyScope } from '../jobs/chat-execution.ts'
import { assertChatSelection, providerChatGroups, chatContextWindow } from '../connections/chat.ts'
import { chatModelsResponse, parseChatModelSelection } from '@guanxi/contract'
/**
 * Роуты тредов: список, создание, история, отправка сообщения, остановка, компакция.
 */
import { Hono } from 'hono'
import {
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  compactThreadBody,
  compactThreadResponse,
  contextCheckpointQuery,
  createThreadBody,
  getContextResponse,
  getChatRetentionResponse,
  getThreadResponse,
  listChatTrashQuery,
  listChatTrashResponse,
  leaveSessionChatBody,
  leaveSessionChatResponse,
  listReasoningArtifactsQuery,
  listReasoningArtifactsResponse,
  getReasoningArtifactResponse,
  listProjectlessChatsQuery,
  PROJECT_CHAT_OWNERSHIP_VERSION,
  sendMessageBody,
  updateThreadBody,
  updateChatRetentionBody,
  restoreChatBody,
  restoreChatResponse,
  type ChatStreamEvent,
  type JobStreamEvent,
  type ThreadOptions,
} from '@guanxi/contract'
import { COMPACTION_PROMPT } from '../agent/prompts.ts'
import { buildContextState, estimateTokens } from '../context/usage.ts'
import type { AppContext } from '../context.ts'
import {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  operationOwner,
  type AdmissionTicket,
  type ResourceLease,
} from '../runtime/resource-governor.ts'
import { JobStoreError } from '../store/jobs.ts'
import { ReasoningArtifactStore } from '../store/reasoning-artifacts.ts'
import { canSeeReasoning, redactChatEvent, withoutReasoning } from '../auth/reasoning.ts'
import { fail, notFound } from './errors.ts'
import { lastEventId, sseResponse } from './sse.ts'

/** Заголовок треда из первого сообщения — чтобы список был читаемым без ручного ввода. */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? ''
  const trimmed = firstLine.slice(0, 60)
  return trimmed.length > 0 ? trimmed : 'Новый диалог'
}

export async function* compatibilityEvents(
  app: Pick<AppContext, 'jobService'>,
  jobId: string,
  after: number,
  signal: AbortSignal,
  /** False for a grantee: reasoning deltas are dropped (see `auth/reasoning.ts`). */
  reasoning = true,
): AsyncGenerator<ChatStreamEvent> {
  for await (const event of app.jobService.subscribe(jobId, after, signal)) {
    if (!event.output) continue
    const chatEvent = {
      ...event.output.event,
      seq: event.sequence,
    } as ChatStreamEvent
    const visible = reasoning ? chatEvent : redactChatEvent(chatEvent)
    if (visible) yield visible
  }
}

export function threadsRoutes(app: AppContext): Hono {
  const routes = new Hono()
  const reasoningArtifacts = () => new ReasoningArtifactStore(app.db)

  const reasoningScope = (context: { req: { url: string } }) => {
    const query = new URL(context.req.url).searchParams
    const parsed = listReasoningArtifactsQuery.safeParse(Object.fromEntries(query))
    const allowed = new Set(['artifactVersion', 'enforcementVersion', 'scope', 'projectId'])
    if (
      !parsed.success ||
      [...query.keys()].some((key) => !allowed.has(key)) ||
      [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
    ) return null
    return parsed.data.scope === 'project'
      ? { query: parsed.data, store: { scope: 'project' as const, projectId: parsed.data.projectId } }
      : { query: parsed.data, store: { scope: 'projectless' as const, projectId: null } }
  }

  routes.get('/models', async c => {
    const groups = app.connections ? await providerChatGroups(app.connections(), c.req.raw.signal) : []
    return c.json(chatModelsResponse.parse({ groups }))
  })

  routes.get('/',  (context) => {
    const query = new URL(context.req.url).searchParams
    if (query.size === 0) return context.json({ threads: app.threads.list() })
    const parsed = listProjectlessChatsQuery.safeParse(Object.fromEntries(query))
    if (
      !parsed.success ||
      query.size !== 2 ||
      query.getAll('ownershipVersion').length !== 1 ||
      query.getAll('scope').length !== 1
    ) {
      return context.json(
        { code: 'validation_failed', message: 'Unsupported Chat ownership query', details: null },
        400,
      )
    }
    return context.json({
      ownershipVersion: PROJECT_CHAT_OWNERSHIP_VERSION,
      scope: 'projectless' as const,
      chats: app.threads.listProjectless(),
    })
  })

  routes.post('/', async (context) => {
    const parsed = createThreadBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Некорректное тело запроса', details: parsed.error.flatten() },
        400,
      )
    }

    const { mode } = parsed.data
    if (mode !== 'chat' && parsed.data.model.startsWith('k3:')) return context.json({ code: 'validation_failed', message: 'Provider models require Chat mode', details: null }, 400)
    const workspaceId = mode === 'agent' ? (parsed.data.workspaceId ?? null) : null
    if (workspaceId && !app.workspaces.get(workspaceId)) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    }

    const defaults: ThreadOptions = {
      // Агентному режиму нужно окно больше: в него идут результаты инструментов.
      numCtx: mode === 'agent' ? DEFAULT_NUM_CTX : DEFAULT_CHAT_NUM_CTX,
      temperature: mode === 'agent' ? DEFAULT_AGENT_TEMPERATURE : DEFAULT_TEMPERATURE,
      think: 'off',
    }
    const options = { ...defaults, ...parsed.data.options }

    try {
      await assertChatSelection(app,
        parsed.data.model,
        options.numCtx,
        context.req.raw.signal,
      )
    } catch (error) {
      return fail(context, error)
    }

    const thread = app.threads.create({
      title: parsed.data.title ?? 'Новый диалог',
      mode,
      model: parsed.data.model,
      workspaceId,
      options,
    })

    return context.json(thread, 201)
  })

  routes.get('/trash', (context) => {
    const query = new URL(context.req.url).searchParams
    const raw = Object.fromEntries(query)
    const parsed = listChatTrashQuery.safeParse(raw)
    const allowedKeys = new Set([
      'lifecycleVersion',
      'deletionVersion',
      'scope',
      'projectId',
      'limit',
    ])
    if (
      !parsed.success ||
      [...query.keys()].some((key) => !allowedKeys.has(key)) ||
      [...new Set(query.keys())].some((key) => query.getAll(key).length !== 1)
    ) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Chat Trash query', details: null },
        400,
      )
    }
    if (parsed.data.scope === 'project' && !app.projects.get(parsed.data.projectId)) {
      return notFound(context, 'project_not_found', 'Project was not found')
    }
    const page = app.retention.listTrash(
      parsed.data.scope === 'project'
        ? { scope: 'project', projectId: parsed.data.projectId }
        : { scope: 'projectless' },
      parsed.data.limit,
    )
    return context.json(listChatTrashResponse.parse({
      lifecycleVersion: parsed.data.lifecycleVersion,
      deletionVersion: parsed.data.deletionVersion,
      scope: parsed.data.scope,
      projectId: parsed.data.scope === 'project' ? parsed.data.projectId : null,
      ...page,
    }))
  })

  routes.get('/:id/retention', (context) => {
    const result = app.retention.get(context.req.param('id'))
    if (result.status === 'not_found') {
      return notFound(context, 'thread_not_found', 'Chat was not found')
    }
    if (result.status === 'not_chat') {
      return context.json(
        { code: 'validation_failed', message: 'Retention is available only for Chat', details: null },
        400,
      )
    }
    if (result.status === 'in_trash') {
      return notFound(context, 'thread_not_found', 'Chat was not found in active work')
    }
    return context.json(getChatRetentionResponse.parse(result.retention))
  })

  routes.patch('/:id/retention', async (context) => {
    const parsed = updateChatRetentionBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Chat retention request', details: null },
        400,
      )
    }
    const result = app.retention.update(context.req.param('id'), parsed.data.policy)
    if (result.status === 'not_found') {
      return notFound(context, 'thread_not_found', 'Chat was not found')
    }
    if (result.status === 'not_chat') {
      return context.json(
        { code: 'validation_failed', message: 'Retention is available only for Chat', details: null },
        400,
      )
    }
    if (result.status === 'in_trash') {
      return context.json(
        {
          code: 'validation_failed',
          message: 'A Chat in Trash can be restored only to Keep or 7 days',
          details: null,
        },
        409,
      )
    }
    if (result.status === 'recovery_expired') {
      return context.json(
        { code: 'validation_failed', message: 'Session recovery grace has elapsed', details: null },
        409,
      )
    }
    return context.json(getChatRetentionResponse.parse(result.retention))
  })

  routes.post('/:id/restore', async (context) => {
    const parsed = restoreChatBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Chat restore request', details: null },
        400,
      )
    }
    const result = app.retention.restore(context.req.param('id'))
    if (result.status === 'not_found') {
      return notFound(context, 'thread_not_found', 'Chat was not found')
    }
    if (result.status === 'not_chat') {
      return context.json(
        { code: 'validation_failed', message: 'Restore is available only for Chat', details: null },
        400,
      )
    }
    if (result.status === 'not_in_trash') {
      return context.json(
        { code: 'validation_failed', message: 'Chat is not in Trash', details: null },
        409,
      )
    }
    if (result.status === 'recovery_expired') {
      return context.json(
        { code: 'validation_failed', message: 'Session recovery grace has elapsed', details: null },
        409,
      )
    }
    if ('deletionVersion' in parsed.data) {
      const retention = app.retention.get(result.lifecycle.chatId)
      if (retention.status !== 'ok') {
        return context.json(
          { code: 'storage_error', message: 'Restored Chat retention is unavailable', details: null },
          500,
        )
      }
      return context.json(restoreChatResponse.parse({
        ...result.lifecycle,
        deletionVersion: parsed.data.deletionVersion,
        hardDeletion: retention.retention.policy.mode === 'session'
          ? 'session_metadata_after_recovery_not_scheduled'
          : 'not_implemented',
      }))
    }
    return context.json(restoreChatResponse.parse(result.lifecycle))
  })

  routes.post('/:id/session-leave', async (context) => {
    const parsed = leaveSessionChatBody.safeParse(await context.req.json().catch(() => null))
    const chatId = context.req.param('id')
    if (!parsed.success || parsed.data.chatId !== chatId) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid Session leave command', details: null },
        400,
      )
    }
    const scope = parsed.data.scope === 'project'
      ? { scope: 'project' as const, projectId: parsed.data.projectId! }
      : { scope: 'projectless' as const }
    const result = app.retention.leaveSession(chatId, scope)
    if (result.status === 'not_found') {
      return notFound(context, 'thread_not_found', 'Chat was not found')
    }
    if (result.status === 'not_chat' || result.status === 'not_session') {
      return context.json(
        { code: 'validation_failed', message: 'Leave is available only for Session Chat', details: null },
        409,
      )
    }
    if (result.status === 'scope_mismatch') {
      return context.json(
        { code: 'validation_failed', message: 'Session leave Chat scope mismatch', details: null },
        400,
      )
    }
    return context.json(leaveSessionChatResponse.parse(result.lifecycle))
  })

  routes.get('/:id/reasoning-artifacts', (context) => {
    const scope = reasoningScope(context)
    if (!scope) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid reasoning Artifact scope', details: null },
        400,
      )
    }
    const result = reasoningArtifacts().list(context.req.param('id'), scope.store)
    if (result.status === 'scope_mismatch') {
      return context.json(
        { code: 'validation_failed', message: 'Reasoning Artifact Chat scope mismatch', details: null },
        400,
      )
    }
    if (result.status !== 'ok') {
      return notFound(context, 'thread_not_found', 'Chat was not found in active work')
    }
    return context.json(listReasoningArtifactsResponse.parse({
      artifactVersion: scope.query.artifactVersion,
      enforcementVersion: scope.query.enforcementVersion,
      enforcement: {
        state: 'active',
        owner: 'server_maintenance',
        boundary: 'reasoning_artifacts_only',
        inclusiveDueBoundary: true,
      },
      chatId: context.req.param('id'),
      scope: scope.query.scope,
      projectId: scope.query.scope === 'project' ? scope.query.projectId : null,
      generatedAnswers: result.generatedAnswers,
      artifacts: result.artifacts,
    }))
  })

  routes.get('/:id/reasoning-artifacts/:artifactId', (context) => {
    const scope = reasoningScope(context)
    if (!scope) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid reasoning Artifact scope', details: null },
        400,
      )
    }
    const result = reasoningArtifacts().get(
      context.req.param('id'),
      context.req.param('artifactId'),
      scope.store,
    )
    if (result.status === 'scope_mismatch') {
      return context.json(
        { code: 'validation_failed', message: 'Reasoning Artifact Chat scope mismatch', details: null },
        400,
      )
    }
    if (result.status !== 'ok') {
      return notFound(context, 'thread_not_found', 'Reasoning Artifact was not found in active Chat')
    }
    return context.json(getReasoningArtifactResponse.parse(result.artifact))
  })

  routes.get('/:id', (context) => {
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
    const thread = app.threads.get(context.req.param('id'))
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const messages = app.threads.messages(thread.id)
    const contextCheckpoints = app.threads.contextCheckpoints(thread.id)
    const activeMessages = app.threads.activeContextMessages(thread.id)
    const lastUsage = [...activeMessages].reverse().find((message) => message.usage)?.usage ?? null

    const response = {
      thread,
      messages: canSeeReasoning(context) ? messages : withoutReasoning(messages),
      context: buildContextState({
        usedTokens:
          lastUsage?.promptTokens ??
          activeMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        allocatedTokens: thread.options.numCtx,
        providerContext: chatContextWindow(app, thread.model),
        usage: lastUsage,
        model: thread.model,
        tracker: app.tracker,
      }),
    }
    return context.json(
      query.size === 0
        ? response
        : getThreadResponse.parse({ ...response, contextCheckpoints }),
    )
  })

  routes.patch('/:id', async (context) => {
    const parsed = updateThreadBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json({ code: 'validation_failed', message: 'Некорректное тело', details: null }, 400)
    }
    const id = context.req.param('id')
    const existing = app.threads.get(id)
    if (!existing) return notFound(context, 'thread_not_found', 'Тред не найден')
    if (app.chatExecution.isThreadActive(id)) {
      return context.json(
        { code: 'validation_failed', message: 'Нельзя менять тред во время генерации', details: null },
        409,
      )
    }
    const ownership = app.threads.getWithOwnership(id)
    if (ownership?.projectId && parsed.data.workspaceId !== undefined) {
      return context.json(
        {
          code: 'validation_failed',
          message: 'Project Chat filesystem scope is not configurable through Thread update',
          details: null,
        },
        400,
      )
    }
    if (parsed.data.workspaceId && !app.workspaces.get(parsed.data.workspaceId)) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    }

    const nextModel = parsed.data.model ?? existing.model
    if (existing.mode !== 'chat' && nextModel.startsWith('k3:')) return context.json({ code: 'validation_failed', message: 'Provider models require Chat mode', details: null }, 400)
    const nextContext = parsed.data.options?.numCtx ?? existing.options.numCtx
    try {
      await assertChatSelection(app,
        nextModel,
        nextContext,
        context.req.raw.signal,
      )
    } catch (error) {
      return fail(context, error)
    }

    const updated = app.threads.update(id, parsed.data)
    if (!updated) return notFound(context, 'thread_not_found', 'Тред не найден')
    if (
      parsed.data.workspaceId !== undefined &&
      parsed.data.workspaceId !== existing.workspaceId
    ) {
      app.approvals.forgetThread(id)
    }
    return context.json(updated)
  })

  routes.delete('/:id', (context) => {
    const id = context.req.param('id')
    if (app.chatExecution.isThreadActive(id)) {
      return context.json(
        { code: 'validation_failed', message: 'Сначала остановите активную генерацию', details: null },
        409,
      )
    }
    app.approvals.forgetThread(id)

    if (!app.threads.delete(id)) return notFound(context, 'thread_not_found', 'Тред не найден')
    return context.json({ ok: true })
  })

  routes.get('/:id/context', (context) => {
    const thread = app.threads.get(context.req.param('id'))
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const messages = app.threads.activeContextMessages(thread.id)
    const lastUsage = [...messages].reverse().find((message) => message.usage)?.usage ?? null

    return context.json(
      getContextResponse.parse(buildContextState({
        usedTokens:
          lastUsage?.promptTokens ??
          messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
        allocatedTokens: thread.options.numCtx,
        providerContext: chatContextWindow(app, thread.model),
        usage: lastUsage,
        model: thread.model,
        tracker: app.tracker,
      })),
    )
  })

  /** Останавливает идущий ход и снимает все ожидания подтверждения. */
  routes.post('/:id/stop', async (context) => {
    const id = context.req.param('id')
    app.approvals.cancelThread(id)
    const job = await app.chatExecution.cancelThread(id)
    return context.json({ ok: job !== null })
  })

  /* ─────────────────────────── Отправка сообщения ────────────────────────── */

  routes.post('/:id/messages', async (context) => {
    const threadId = context.req.param('id')
    const parsed = sendMessageBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json({ code: 'validation_failed', message: 'Некорректное тело', details: null }, 400)
    }

    const thread = app.threads.get(threadId)
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')
    let sendBody = parsed.data
    const provider = thread.model.startsWith('k3:')
    try {
      if (app.connections) sendBody = app.connections().scrubChat(sendBody, provider)
    } catch (error) {
      // Local Chat must survive missing K3 and incomplete vault registration.
      if (provider) return fail(context, error)
    }

    const active = app.jobs.activeChatJobForThread(threadId)
    if (active && (!sendBody.idempotencyKey || active.job.idempotencyKey !== sendBody.idempotencyKey)) {
      return context.json(
        { code: 'validation_failed', message: 'В этом треде уже идёт генерация', details: null },
        409,
      )
    }

    const workspace = thread.workspaceId ? app.workspaces.get(thread.workspaceId) : null
    if (thread.workspaceId && !workspace) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    }
    const replay = sendBody.idempotencyKey
      ? app.jobs.chatCommand(chatIdempotencyScope(threadId), sendBody.idempotencyKey) : null
    try {
      if (!replay) await assertChatSelection(app,
        thread.model,
        thread.options.numCtx,
        context.req.raw.signal,
      )
    } catch (error) {
      return fail(context, error)
    }
    let result
    try {
      result = app.chatExecution.createAndStart({
        threadId,
        idempotencyKey: sendBody.idempotencyKey,
        snapshot: {
          content: sendBody.content,
          attachments: sendBody.attachments ?? [],
          autoApprove: sendBody.autoApprove ?? null,
        },
        derivedTitle: deriveTitle(sendBody.content),
      })
    } catch (error) {
      if (error instanceof JobStoreError && error.code === 'idempotency_conflict') {
        return context.json(
          { code: 'job_conflict', message: 'Ключ повтора уже связан с другим запросом', details: null },
          409,
        )
      }
      if (error instanceof JobStoreError && error.code === 'invalid_input') {
        return context.json(
          { code: 'validation_failed', message: 'Некорректная Chat-команда', details: null },
          400,
        )
      }
      return context.json(
        { code: 'storage_error', message: 'Chat-команда не была сохранена', details: null },
        500,
      )
    }

    const subscriber = new AbortController()
    return sseResponse(compatibilityEvents(
      app,
      result.job.id,
      lastEventId(context.req.header('Last-Event-ID')) ?? 0,
      subscriber.signal,
      canSeeReasoning(context),
    ), {
      onAbort: () => subscriber.abort(),
      skipUntilSeq: lastEventId(context.req.header('Last-Event-ID')),
    })
  })

  /* ──────────────────────────────── Компакция ────────────────────────────── */

  routes.post('/:id/compact', async (context) => {
    const threadId = context.req.param('id')
    const parsed = compactThreadBody.safeParse(await context.req.json().catch(() => ({})))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid context checkpoint intent', details: null },
        400,
      )
    }
    if (!app.threads.get(threadId)) {
      return notFound(context, 'thread_not_found', 'Тред не найден')
    }

    const replayCommittedIntent = () => {
      if (!parsed.data.idempotencyKey) return null
      const existing = app.threads.contextCheckpointByIntent(
        threadId,
        parsed.data.idempotencyKey,
      )
      if (!existing) return null
      const thread = app.threads.get(threadId)
      if (!thread) return null
      const activeMessages = app.threads.activeContextMessages(threadId)
      const usedTokens = activeMessages.reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0,
      )
      return context.json(compactThreadResponse.parse({
        checkpoint: existing,
        context: buildContextState({
          usedTokens,
          allocatedTokens: thread.options.numCtx,
        providerContext: chatContextWindow(app, thread.model),
          usage: null,
          model: thread.model,
          tracker: app.tracker,
        }),
        compactedTokens: 0,
        estimatedRepefillMs: app.tracker.estimateColdPrefillMs(thread.model, usedTokens),
      }))
    }

    try {
      const replay = replayCommittedIntent()
      if (replay) return replay
    } catch (error) {
      return fail(context, error)
    }

    if (parseChatModelSelection(app.threads.get(threadId)!.model)) return context.json({ code: 'validation_failed', message: 'Provider Chat compaction is not available yet', details: null }, 400)
    const ownerController = new AbortController()
    const abortFromRequest = () => ownerController.abort(context.req.raw.signal.reason)
    if (context.req.raw.signal.aborted) abortFromRequest()
    else context.req.raw.signal.addEventListener('abort', abortFromRequest, { once: true })
    let ticket: AdmissionTicket | undefined
    let lease: ResourceLease | undefined
    try {
      const admissionThread = app.threads.get(threadId)
      if (!admissionThread) return notFound(context, 'thread_not_found', 'Тред не найден')
      ticket = app.governor.enqueue({
        owner: operationOwner('compaction'),
        operation: 'compaction',
        model: { provider: 'ollama', name: admissionThread.model },
        requestedContext: admissionThread.options.numCtx,
        priority: 'normal',
        enqueuedAt: new Date().toISOString(),
      })
      lease = await app.governor.acquire(ticket, {
        signal: ownerController.signal,
        abortOwner: () => ownerController.abort(RESOURCE_GOVERNOR_CLOSE_REASON),
      })
      if (ownerController.signal.aborted) {
        return context.json(
          { code: 'validation_failed', message: 'Компакция отменена до запуска', details: null },
          409,
        )
      }

      // A queued compaction must plan from state observed after admission.
      const thread = app.threads.get(threadId)
      if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')
      if (
        thread.model !== lease.model.name ||
        thread.options.numCtx !== lease.requestedContext
      ) {
        return context.json(
          {
            code: 'job_conflict',
            message: 'Параметры треда изменились во время ожидания компакции',
            details: null,
          },
          409,
        )
      }

      // A same-intent waiter may have observed absence before the winner
      // persisted. Reconcile again under the exclusive inference lease.
      const replay = replayCommittedIntent()
      if (replay) return replay

      // Хвост оставляем нетронутым: именно он нужен модели для продолжения разговора.
      const selection = app.threads.compactionCandidates(threadId, 4)
      if (!selection) {
        return context.json(
          { code: 'validation_failed', message: 'Сворачивать нечего — диалог слишком короткий', details: null },
          400,
        )
      }

      const transcript = selection.messages
        .map((message) => `[${message.role}] ${message.content}`)
        .join('\n\n')

      const response = await app.ollama().chat(
        {
          model: thread.model,
          messages: [
            { role: 'system', content: COMPACTION_PROMPT },
            { role: 'user', content: transcript },
          ],
          options: { num_ctx: thread.options.numCtx, temperature: 0 },
        },
        ownerController.signal,
      )

      const summary = response.message?.content?.trim()
      if (!summary) {
        return context.json(
          { code: 'upstream_error', message: 'Модель вернула пустую сводку', details: null },
          502,
        )
      }

      const compactedTokens = selection.messages.reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0,
      )

      const checkpoint = app.threads.createContextCheckpoint({
        checkpointId: parsed.data.idempotencyKey,
        threadId,
        upToSeq: selection.upToSeq,
        expectedPreviousCheckpointId: selection.expectedPreviousCheckpointId,
        summary,
      })

      const remaining = app.threads.activeContextMessages(threadId)
      const usedTokens = remaining.reduce((sum, item) => sum + estimateTokens(item.content), 0)

      return context.json(compactThreadResponse.parse({
        checkpoint,
        context: buildContextState({
          usedTokens,
          allocatedTokens: thread.options.numCtx,
        providerContext: chatContextWindow(app, thread.model),
          usage: null,
          model: thread.model,
          tracker: app.tracker,
        }),
        compactedTokens,
        /*
         * Честная цена: компакция сбросила префикс KV-кэша, и следующий ход
         * придётся считать с нуля. Замер на 7.8k токенов дал 41.8 с против 0.3 с
         * при попадании в кэш — умалчивать об этом нельзя.
         */
        estimatedRepefillMs: app.tracker.estimateColdPrefillMs(thread.model, usedTokens),
      }))
    } catch (error) {
      if (ownerController.signal.aborted && app.governor.snapshot().accepting) {
        return context.json(
          { code: 'validation_failed', message: 'Компакция отменена', details: null },
          409,
        )
      }
      return fail(context, error)
    } finally {
      context.req.raw.signal.removeEventListener('abort', abortFromRequest)
      lease?.release()
      if (!lease && ticket) app.governor.cancel(ticket)
    }
  })

  return routes
}
