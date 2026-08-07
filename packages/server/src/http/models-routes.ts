/**
 * Роуты моделей: список, каталог, профиль, установка, прогрев.
 */
import { Hono, type Context } from 'hono'
import {
  DEFAULT_NUM_CTX,
  completionProbeBody,
  getModelQuery,
  huggingFaceRepositoryBody,
  huggingFaceSearchBody,
  listCatalogQuery,
  listModelsQuery,
  modelCapabilityOverrideMutationBody,
  ollamaReferencePreviewBody,
  ollamaReferenceStartBody,
  prewarmModelBody,
  warmModelBody,
  type HuggingFaceReferencePreview,
  type ModelCapabilityOverrideMutationBody,
  type ModelCapabilityOverrideOutcome,
} from '@alamo/contract'
import type { AppContext } from '../context.ts'
import { getCatalog } from '../models/catalog.ts'
import { pullModelEvents } from '../models/ollama-pull.ts'
import {
  HuggingFaceReferenceError,
  normalizeHuggingFaceReference,
} from '../models/hugging-face-reference.ts'
import {
  normalizeOllamaReference,
  OllamaReferenceError,
} from '../models/ollama-reference.ts'
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
      return context.json({
        models: await app.models().listLocal(contextLength, context.req.raw.signal),
      })
    } catch (error) {
      return fail(context, error)
    }
  })

  routes.get('/catalog', async (context) => {
    const searchParams = new URL(context.req.url).searchParams
    const repeated = [...new Set(searchParams.keys())].filter(
      (key) => searchParams.getAll(key).length !== 1,
    )
    const parsed = repeated.length === 0
      ? listCatalogQuery.safeParse(Object.fromEntries(searchParams))
      : { success: false as const, error: null }
    if (!parsed.success) {
      return context.json(
        {
          code: 'validation_failed',
          message: 'Invalid catalog query',
          details: parsed.error?.flatten() ?? { repeatedKeys: repeated },
        },
        400,
      )
    }
    const contextLength = parsed.data.contextLength ?? DEFAULT_NUM_CTX

    // Каталог должен открываться, даже когда Ollama не запущена.
    const installed = await app
      .ollama()
      .tags(context.req.raw.signal)
      .then((tags) => ({
        models: tags.models.map((model) => ({
          name: model.name,
          digest: model.digest,
        })),
        observedAt: new Date().toISOString(),
      }))
      .catch(() => null)
    context.req.raw.signal.throwIfAborted()

    const result = await getCatalog({
      query: parsed.data.q,
      contextLength,
      filters: parsed.data,
      pagination: parsed.data.page === undefined
        ? undefined
        : { page: parsed.data.page, pageSize: parsed.data.pageSize! },
      hardware: app.hardware,
      installed,
      signal: context.req.raw.signal,
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

  routes.post('/imports/ollama-reference/preview', async (context) => {
    const body = ollamaReferencePreviewBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) return invalidOllamaReferenceResponse(context)
    try {
      return context.json({ preview: normalizeOllamaReference(body.data.reference) })
    } catch (error) {
      if (error instanceof OllamaReferenceError) {
        return invalidOllamaReferenceResponse(context, error.reason)
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The Ollama reference could not be checked safely',
          details: null,
        },
        500,
      )
    }
  })

  routes.post('/imports/ollama-reference/start', async (context) => {
    const body = ollamaReferenceStartBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) return invalidOllamaReferenceResponse(context)

    let normalizedModelName: string
    try {
      const preview = normalizeOllamaReference(body.data.reference)
      normalizedModelName = preview.normalizedModelName
      if (body.data.confirmedModelName !== normalizedModelName) {
        return invalidOllamaReferenceResponse(context, 'confirmation_mismatch')
      }
    } catch (error) {
      if (error instanceof OllamaReferenceError) {
        return invalidOllamaReferenceResponse(context, error.reason)
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The confirmed Ollama pull could not start safely',
          details: null,
        },
        500,
      )
    }

    const controller = new AbortController()
    const events = connectionOwnedPullEvents(
      app,
      normalizedModelName,
      context.req.raw.signal,
      controller,
    )
    return sseResponse(
      events,
      { onAbort: () => controller.abort('ollama-reference-client-disconnected') },
    )
  })

  /**
   * P2-J read-only Hugging Face discovery. POST keeps arbitrary user query text out of
   * request lines, access logs and referrers, matching the reference-preview precedent.
   *
   * Registered ahead of the greedy `/:name{.+}` routes to keep the discovery paths
   * lexically adjacent to the other `imports`/`discovery` entry points. Order is not
   * load-bearing for these two: every greedy POST pattern carries a required suffix
   * (`/warm`, `/prewarm`, `/probes/completion`, `/stop`, `/pull`,
   * `/capability-overrides`), so none of them can match a discovery path.
   *
   * Both handlers are read-only: no pull, probe, prewarm, load, unload, Governor
   * admission, catalog refresh or background Job is started, and the Web client never
   * learns the Hub endpoint.
   */
  routes.post('/discovery/hugging-face/search', async (context) => {
    const body = huggingFaceSearchBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) return invalidHuggingFaceRequestResponse(context)
    try {
      return context.json({
        result: await app.huggingFace.search({
          query: body.data.query,
          page: body.data.page,
          pageSize: body.data.pageSize,
          cursor: body.data.cursor,
          signal: context.req.raw.signal,
        }),
      })
    } catch {
      // A caller disconnect is a cancellation, never a provider verdict.
      if (context.req.raw.signal.aborted) {
        return invalidHuggingFaceRequestResponse(context, 'request_cancelled', 409)
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The Hugging Face search could not be completed safely',
          details: null,
        },
        500,
      )
    }
  })

  routes.post('/discovery/hugging-face/repository', async (context) => {
    const body = huggingFaceRepositoryBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) return invalidHuggingFaceRequestResponse(context)

    let preview: HuggingFaceReferencePreview
    try {
      preview = normalizeHuggingFaceReference(body.data.reference)
    } catch (error) {
      if (error instanceof HuggingFaceReferenceError) {
        return invalidHuggingFaceRequestResponse(context, error.reason)
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The Hugging Face reference could not be checked safely',
          details: null,
        },
        500,
      )
    }

    try {
      return context.json({
        result: await app.huggingFace.repository({
          preview,
          signal: context.req.raw.signal,
        }),
      })
    } catch {
      if (context.req.raw.signal.aborted) {
        return invalidHuggingFaceRequestResponse(context, 'request_cancelled', 409)
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The Hugging Face repository could not be read safely',
          details: null,
        },
        500,
      )
    }
  })

  /**
   * P2-I user assertions. Write and clear share one strict body so the caller
   * always states the exact identity it rendered; the service revalidates it at
   * the mutation point. Registered before the generic `/:name` routes so the
   * greedy name pattern cannot swallow this suffix.
   */
  const capabilityOverrideMutation = (
    mutate: (
      name: string,
      body: ModelCapabilityOverrideMutationBody,
      signal: AbortSignal,
    ) => Promise<ModelCapabilityOverrideOutcome>,
  ) => async (context: Context) => {
    // A malformed percent-escape must stay a typed validation failure instead of
    // throwing out of the handler as an untyped 500.
    let name: string
    try {
      name = decodeURIComponent(context.req.param('name') ?? '')
    } catch {
      return context.json(
        {
          code: 'validation_failed',
          message: 'The capability override request is invalid',
          details: null,
        },
        400,
      )
    }
    const body = modelCapabilityOverrideMutationBody.safeParse(
      await context.req.json().catch(() => null),
    )
    if (!body.success) {
      return context.json(
        {
          code: 'validation_failed',
          message: 'The capability override request is invalid',
          details: null,
        },
        400,
      )
    }
    try {
      return context.json({
        outcome: await mutate(name, body.data, context.req.raw.signal),
      })
    } catch {
      if (context.req.raw.signal.aborted) {
        return context.json(
          {
            code: 'validation_failed',
            message: 'The capability override request was cancelled',
            details: null,
          },
          409,
        )
      }
      return context.json(
        {
          code: 'internal_error',
          message: 'The capability override could not be changed safely',
          details: null,
        },
        500,
      )
    }
  }

  routes.post(
    '/:name{.+}/capability-overrides',
    capabilityOverrideMutation((name, body, signal) =>
      app.capabilityOverrides.apply(name, body, signal),
    ),
  )

  routes.delete(
    '/:name{.+}/capability-overrides',
    capabilityOverrideMutation((name, body, signal) =>
      app.capabilityOverrides.clear(name, body, signal),
    ),
  )

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

  routes.post('/:name{.+}/probes/completion', async (context) => {
    const name = decodeURIComponent(context.req.param('name'))
    const body = completionProbeBody.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json(
        {
          code: 'validation_failed',
          message: 'The completion probe request is invalid',
          details: null,
        },
        400,
      )
    }
    try {
      const evidence = await app.completionProbe.execute(
        name,
        body.data,
        context.req.raw.signal,
      )
      return context.json({ evidence })
    } catch {
      return context.json(
        {
          code: 'internal_error',
          message: 'The completion probe could not be completed safely',
          details: null,
        },
        500,
      )
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
    return sseResponse(
      connectionOwnedPullEvents(app, name, context.req.raw.signal, controller),
      { onAbort: () => controller.abort('legacy-pull-client-disconnected') },
    )
  })

  return routes
}

async function* connectionOwnedPullEvents(
  app: AppContext,
  modelName: string,
  requestSignal: AbortSignal,
  controller: AbortController,
) {
  const abortFromRequest = () => controller.abort(
    requestSignal.reason ?? 'pull-request-disconnected',
  )
  if (requestSignal.aborted) abortFromRequest()
  else requestSignal.addEventListener('abort', abortFromRequest, { once: true })
  try {
    yield* pullModelEvents(app.ollama(), modelName, controller.signal)
  } finally {
    requestSignal.removeEventListener('abort', abortFromRequest)
  }
}

function invalidOllamaReferenceResponse(
  context: Context,
  reason = 'invalid_request',
): Response {
  return context.json(
    {
      code: 'validation_failed',
      message: 'The Ollama reference is invalid',
      details: { reason },
    },
    400,
  )
}

/**
 * One redacted refusal shape for the discovery boundary. It carries a typed reason and
 * never the Hub endpoint, host, response body or any credential.
 */
function invalidHuggingFaceRequestResponse(
  context: Context,
  reason = 'invalid_request',
  status: 400 | 409 = 400,
): Response {
  return context.json(
    {
      code: 'validation_failed',
      message: 'The Hugging Face discovery request is invalid',
      details: { reason },
    },
    status,
  )
}
