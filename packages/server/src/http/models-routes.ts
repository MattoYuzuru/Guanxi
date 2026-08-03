/**
 * Роуты моделей: список, каталог, профиль, установка, прогрев.
 */
import { Hono } from 'hono'
import {
  DEFAULT_NUM_CTX,
  getModelQuery,
  listCatalogQuery,
  listModelsQuery,
  prewarmModelBody,
  warmModelBody,
  type PullStreamEvent,
} from '@alamo/contract'
import type { AppContext } from '../context.ts'
import { getCatalog } from '../models/catalog.ts'
import { OllamaUnavailableError } from '../ollama/client.ts'
import {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  operationOwner,
  type AdmissionTicket,
  type ResourceLease,
} from '../runtime/resource-governor.ts'
import { executePrewarm } from '../runtime/prewarm.ts'
import { sseResponse } from './sse.ts'
import { fail } from './errors.ts'

export function modelsRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', async (context) => {
    const query = listModelsQuery.safeParse(Object.fromEntries(new URL(context.req.url).searchParams))
    if (!query.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid model query', details: query.error.flatten() },
        400,
      )
    }
    const contextLength = query.data.contextLength ?? DEFAULT_NUM_CTX

    try {
      return context.json({ models: await app.models().listLocal(contextLength) })
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/catalog', async (context) => {
    const parsed = listCatalogQuery.safeParse(
      Object.fromEntries(new URL(context.req.url).searchParams),
    )
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid catalog query', details: parsed.error.flatten() },
        400,
      )
    }
    const contextLength = parsed.data.contextLength ?? DEFAULT_NUM_CTX

    // Каталог должен открываться, даже когда Ollama не запущена.
    const installed = await app
      .ollama()
      .tags()
      .then((tags) => new Set(tags.models.map((model) => model.name)))
      .catch(() => new Set<string>())

    const result = await getCatalog({
      query: parsed.data.q,
      contextLength,
      hardware: app.hardware,
      installed,
    })

    return context.json(result)
  })

  routes.get('/running', async (context) => {
    try {
      return context.json(
        await app.runtime.runningModels({ signal: context.req.raw.signal }),
      )
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:name{.+}', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const query = getModelQuery.safeParse(
      Object.fromEntries(new URL(context.req.url).searchParams),
    )
    if (!query.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid model query', details: query.error.flatten() },
        400,
      )
    }
    try {
      const detail = await app.models().detail(
        name,
        query.data.contextLength,
        context.req.raw.signal,
      )
      if (!detail) {
        return context.json(
          { code: 'model_not_found', message: `Модель ${name} не найдена`, details: null },
          404,
        )
      }
      return context.json(detail)
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.delete('/:name{.+}', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    try {
      await app.ollama().deleteModel(name)
      return context.json({ ok: true })
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.post('/:name{.+}/warm', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const body = warmModelBody.safeParse(await context.req.json().catch(() => ({})))
    if (!body.success) {
      return context.json(
        { code: 'validation_failed', message: 'Invalid warm request', details: body.error.flatten() },
        400,
      )
    }
    const contextLength = body.data.contextLength

    const ownerController = new AbortController()
    const abortFromRequest = () => ownerController.abort(context.req.raw.signal.reason)
    if (context.req.raw.signal.aborted) abortFromRequest()
    else context.req.raw.signal.addEventListener('abort', abortFromRequest, { once: true })
    let ticket: AdmissionTicket | undefined
    let lease: ResourceLease | undefined
    try {
      await app.models().assertContextAllowed(name, contextLength, ownerController.signal)
      ticket = app.governor.enqueue({
        owner: operationOwner('model_warm'),
        operation: 'model_warm',
        model: { provider: 'ollama', name },
        requestedContext: contextLength,
        priority: 'normal',
        enqueuedAt: new Date().toISOString(),
      })
      lease = await app.governor.acquire(ticket, {
        signal: ownerController.signal,
        abortOwner: () => ownerController.abort(RESOURCE_GOVERNOR_CLOSE_REASON),
      })
      if (ownerController.signal.aborted) {
        return context.json(
          { code: 'validation_failed', message: 'Прогрев отменён до запуска', details: null },
          409,
        )
      }

      const result = await app.models().warm(name, contextLength, ownerController.signal)
      if (!result) {
        return context.json(
          { code: 'model_not_found', message: `Модель ${name} не загрузилась`, details: null },
          404,
        )
      }
      return context.json(result)
    } catch (error) {
      if (ownerController.signal.aborted && app.governor.snapshot().accepting) {
        return context.json(
          { code: 'validation_failed', message: 'Прогрев отменён', details: null },
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

  routes.post('/:name{.+}/prewarm', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const body = prewarmModelBody.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json(
        {
          code: 'validation_failed',
          message: 'The prewarm request is invalid',
          details: null,
        },
        400,
      )
    }

    const result = await executePrewarm(
      {
        governor: app.governor,
        runtime: app.runtime,
        settings: app.settings,
        models: app.models,
        ollama: app.ollama,
      },
      name,
      body.data,
      context.req.raw.signal,
    )
    return context.json(result)
  })

  routes.post('/:name{.+}/stop', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    try {
      app.governor.assertCanUnload({ provider: 'ollama', name })
      await app.ollama().unload(name)
      return context.json({ ok: true })
    } catch (error) {
      return fail(context, error)
    }
  })

  /** Скачивание модели: NDJSON от Ollama переводим в SSE по контракту. */
  routes.post('/:name{.+}/pull', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const controller = new AbortController()
    const client = app.ollama()

    async function* events(): AsyncGenerator<PullStreamEvent> {
      let seq = 0
      const startedAt = Date.now()
      let lastCompleted = 0

      try {
        for await (const chunk of client.pull(name, controller.signal)) {
          if (chunk.error) {
            yield {
              type: 'error',
              seq: seq++,
              data: { code: 'upstream_error', message: chunk.error, details: null },
            }
            return
          }

          const total = chunk.total ?? null
          const completed = chunk.completed ?? null
          const elapsedSeconds = (Date.now() - startedAt) / 1000

          // Скорость считаем от начала: мгновенная слишком дёргается на глаз.
          const bytesPerSecond =
            completed !== null && elapsedSeconds > 0 ? Math.round(completed / elapsedSeconds) : null

          const remaining = total !== null && completed !== null ? total - completed : null
          const etaSeconds =
            remaining !== null && bytesPerSecond && bytesPerSecond > 0
              ? Math.round(remaining / bytesPerSecond)
              : null

          if (completed !== null) lastCompleted = completed

          yield {
            type: 'progress',
            seq: seq++,
            data: {
              status: chunk.status,
              digest: chunk.digest ?? null,
              totalBytes: total,
              completedBytes: completed,
              percent: total && completed !== null ? Math.round((completed / total) * 1000) / 10 : null,
              bytesPerSecond,
              etaSeconds,
            },
          }
        }

        void lastCompleted
        yield { type: 'done', seq: seq++, data: { name } }
      } catch (error) {
        yield {
          type: 'error',
          seq: seq++,
          data: {
            code: error instanceof OllamaUnavailableError ? 'ollama_unavailable' : 'upstream_error',
            message: error instanceof Error ? error.message : String(error),
            details: null,
          },
        }
      }
    }

    return sseResponse(events(), { onAbort: () => controller.abort() })
  })

  return routes
}
