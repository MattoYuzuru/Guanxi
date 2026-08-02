/**
 * Роуты тредов: список, создание, история, отправка сообщения, остановка, компакция.
 */
import { Hono } from 'hono'
import {
  DEFAULT_AGENT_TEMPERATURE,
  DEFAULT_CHAT_NUM_CTX,
  DEFAULT_NUM_CTX,
  DEFAULT_TEMPERATURE,
  createThreadBody,
  sendMessageBody,
  updateThreadBody,
  type ChatStreamEvent,
  type ThreadOptions,
} from '@alamo/contract'
import { runTurn, TURN_ABORT_REASON } from '../agent/loop.ts'
import { COMPACTION_PROMPT } from '../agent/prompts.ts'
import { buildContextState, estimateTokens } from '../context/usage.ts'
import type { AppContext } from '../context.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { fail, notFound } from './errors.ts'
import { lastEventId, sseResponse } from './sse.ts'

/** Заголовок треда из первого сообщения — чтобы список был читаемым без ручного ввода. */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? ''
  const trimmed = firstLine.slice(0, 60)
  return trimmed.length > 0 ? trimmed : 'Новый диалог'
}

export function threadsRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', (context) => context.json({ threads: app.threads.list() }))

  routes.post('/', async (context) => {
    const parsed = createThreadBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Некорректное тело запроса', details: parsed.error.flatten() },
        400,
      )
    }

    const { mode } = parsed.data
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

    const thread = app.threads.create({
      title: parsed.data.title ?? 'Новый диалог',
      mode,
      model: parsed.data.model,
      workspaceId,
      options: { ...defaults, ...parsed.data.options },
    })

    return context.json(thread, 201)
  })

  routes.get('/:id', (context) => {
    const thread = app.threads.get(context.req.param('id'))
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const messages = app.threads.messages(thread.id)
    const lastUsage = [...messages].reverse().find((message) => message.usage)?.usage ?? null

    return context.json({
      thread,
      messages,
      context: buildContextState({
        usedTokens: lastUsage?.promptTokens ?? messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
        allocatedTokens: thread.options.numCtx,
        usage: lastUsage,
        model: thread.model,
        tracker: app.tracker,
      }),
    })
  })

  routes.patch('/:id', async (context) => {
    const parsed = updateThreadBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json({ code: 'validation_failed', message: 'Некорректное тело', details: null }, 400)
    }

    const id = context.req.param('id')
    const existing = app.threads.get(id)
    if (!existing) return notFound(context, 'thread_not_found', 'Тред не найден')
    if (app.activeTurns.has(id)) {
      return context.json(
        { code: 'validation_failed', message: 'Нельзя менять тред во время генерации', details: null },
        409,
      )
    }
    if (parsed.data.workspaceId && !app.workspaces.get(parsed.data.workspaceId)) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
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
    app.activeTurns.get(id)?.abort(TURN_ABORT_REASON.explicitStop)
    app.approvals.forgetThread(id)

    if (!app.threads.delete(id)) return notFound(context, 'thread_not_found', 'Тред не найден')
    return context.json({ ok: true })
  })

  routes.get('/:id/context', (context) => {
    const thread = app.threads.get(context.req.param('id'))
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const messages = app.threads.messages(thread.id)
    const lastUsage = [...messages].reverse().find((message) => message.usage)?.usage ?? null

    return context.json(
      buildContextState({
        usedTokens: lastUsage?.promptTokens ?? 0,
        allocatedTokens: thread.options.numCtx,
        usage: lastUsage,
        model: thread.model,
        tracker: app.tracker,
      }),
    )
  })

  /** Останавливает идущий ход и снимает все ожидания подтверждения. */
  routes.post('/:id/stop', (context) => {
    const id = context.req.param('id')
    const controller = app.activeTurns.get(id)
    app.approvals.cancelThread(id)
    controller?.abort(TURN_ABORT_REASON.explicitStop)
    return context.json({ ok: controller !== undefined })
  })

  /* ─────────────────────────── Отправка сообщения ────────────────────────── */

  routes.post('/:id/messages', async (context) => {
    const threadId = context.req.param('id')
    const thread = app.threads.get(threadId)
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const parsed = sendMessageBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json({ code: 'validation_failed', message: 'Некорректное тело', details: null }, 400)
    }

    // Второй ход в тот же тред не запускаем: модель одна, очередь одна.
    if (app.activeTurns.has(threadId)) {
      return context.json(
        { code: 'validation_failed', message: 'В этом треде уже идёт генерация', details: null },
        409,
      )
    }

    const workspace = thread.workspaceId ? app.workspaces.get(thread.workspaceId) : null
    if (thread.workspaceId && !workspace) {
      return notFound(context, 'workspace_not_found', 'Рабочая директория не найдена')
    }
    if (workspace) app.workspaces.touch(workspace.id)

    if (app.threads.messages(threadId).length === 0) {
      app.threads.update(threadId, { title: deriveTitle(parsed.data.content) })
    }

    app.threads.addMessage({ threadId, role: 'user', content: parsed.data.content })

    const settings = app.settings.get()
    const registry = new ToolRegistry({
      hasWorkspace: thread.mode === 'agent' && workspace !== null,
      enableBash: settings.enableBash,
    })

    const controller = new AbortController()
    app.activeTurns.set(threadId, controller)

    const modelSupportsTools = await app.models().supportsTools(thread.model).catch(() => false)

    async function* stream(): AsyncGenerator<ChatStreamEvent> {
      try {
        yield* runTurn({
          thread: app.threads.get(threadId)!,
          workspace,
          client: app.ollama(),
          store: app.threads,
          registry,
          approvals: app.approvals,
          tracker: app.tracker,
          modelSupportsTools,
          autoApprove: parsed.success && parsed.data.autoApprove === true ? true : settings.autoApproveTools,
          enableBash: settings.enableBash,
          signal: controller.signal,
        })
      } finally {
        app.activeTurns.delete(threadId)
      }
    }

    return sseResponse(stream(), {
      onAbort: () => {
        if (!controller.signal.aborted) {
          controller.abort(TURN_ABORT_REASON.connectionAbort)
        }
      },
      skipUntilSeq: lastEventId(context.req.header('Last-Event-ID')),
    })
  })

  /* ──────────────────────────────── Компакция ────────────────────────────── */

  routes.post('/:id/compact', async (context) => {
    const threadId = context.req.param('id')
    const thread = app.threads.get(threadId)
    if (!thread) return notFound(context, 'thread_not_found', 'Тред не найден')

    const messages = app.threads.messages(threadId)
    // Хвост оставляем нетронутым: именно он нужен модели для продолжения разговора.
    const keepTail = 4
    if (messages.length <= keepTail + 1) {
      return context.json(
        { code: 'validation_failed', message: 'Сворачивать нечего — диалог слишком короткий', details: null },
        400,
      )
    }

    const toCompact = messages.slice(0, messages.length - keepTail)
    const transcript = toCompact
      .map((message) => `[${message.role}] ${message.content}`)
      .join('\n\n')
      .slice(0, 60_000)

    try {
      const response = await app.ollama().chat({
        model: thread.model,
        messages: [
          { role: 'system', content: COMPACTION_PROMPT },
          { role: 'user', content: transcript },
        ],
        options: { num_ctx: thread.options.numCtx, temperature: 0 },
      })

      const summary = response.message?.content?.trim()
      if (!summary) {
        return context.json(
          { code: 'upstream_error', message: 'Модель вернула пустую сводку', details: null },
          502,
        )
      }

      const compactedTokens = toCompact.reduce((sum, message) => sum + estimateTokens(message.content), 0)
      const lastSeq = toCompact.length - 1

      const message = app.threads.replaceWithSummary(
        threadId,
        lastSeq,
        `Сводка предыдущей части диалога:\n\n${summary}`,
        null,
      )

      const remaining = app.threads.messages(threadId)
      const usedTokens = remaining.reduce((sum, item) => sum + estimateTokens(item.content), 0)

      return context.json({
        message,
        context: buildContextState({
          usedTokens,
          allocatedTokens: thread.options.numCtx,
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
      })
    } catch (error) {
      return fail(context, error)
    }
  })

  return routes
}
