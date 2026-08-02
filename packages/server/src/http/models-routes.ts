/**
 * Роуты моделей: список, каталог, профиль, установка, прогрев.
 */
import { Hono } from 'hono'
import {
  DEFAULT_NUM_CTX,
  listCatalogQuery,
  listModelsQuery,
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
import { sseResponse } from './sse.ts'
import { fail } from './errors.ts'

export function modelsRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.get('/', async (context) => {
    const query = listModelsQuery.safeParse(Object.fromEntries(new URL(context.req.url).searchParams))
    const contextLength = query.success ? (query.data.contextLength ?? DEFAULT_NUM_CTX) : DEFAULT_NUM_CTX

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
    const contextLength = parsed.success
      ? (parsed.data.contextLength ?? DEFAULT_NUM_CTX)
      : DEFAULT_NUM_CTX

    // Каталог должен открываться, даже когда Ollama не запущена.
    const installed = await app
      .ollama()
      .tags()
      .then((tags) => new Set(tags.models.map((model) => model.name)))
      .catch(() => new Set<string>())

    const result = await getCatalog({
      query: parsed.success ? parsed.data.q : undefined,
      contextLength,
      hardware: app.hardware,
      installed,
    })

    return context.json(result)
  })

  routes.get('/running', async (context) => {
    try {
      const models = await app.models().ps()
      return context.json({
        models,
        observedAt: models[0]?.observedAt ?? new Date().toISOString(),
      })
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/:name{.+}', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const requested = Number(context.req.query('contextLength'))
    const contextLength = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_NUM_CTX

    try {
      const detail = await app.models().detail(name, contextLength)
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
    const contextLength = body.success ? body.data.contextLength : DEFAULT_NUM_CTX

    const ownerController = new AbortController()
    const abortFromRequest = () => ownerController.abort(context.req.raw.signal.reason)
    if (context.req.raw.signal.aborted) abortFromRequest()
    else context.req.raw.signal.addEventListener('abort', abortFromRequest, { once: true })
    let ticket: AdmissionTicket | undefined
    let lease: ResourceLease | undefined
    try {
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
