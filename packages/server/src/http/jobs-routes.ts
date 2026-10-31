import { canSeeReasoning, redactJobEvent } from '../auth/reasoning.ts'
import { Hono, type Context } from 'hono'
import {
  ROUTES,
  SSE_ERROR_EVENT_NAME,
  SSE_EVENT_NAME,
  SSE_LAST_EVENT_ID_HEADER,
  cancelJobResponse,
  cancelJobBody,
  createJobBody,
  createJobResponse,
  getJobResponse,
  jobEventCursorText,
  jobEventsQuery,
  jobPathParams,
  jobStreamEventSchema,
  type ApiError,
  type JobEvent,
} from '@guanxi/contract'
import type { AppContext } from '../context.ts'
import { JobServiceError } from '../jobs/service.ts'
import { JobStoreError } from '../store/jobs.ts'
import { SSE_HEADERS } from './sse.ts'

/** Public callers share one local API scope and cannot choose a storage namespace. */
export const PUBLIC_JOB_IDEMPOTENCY_SCOPE = 'local-api:v1'

const encoder = new TextEncoder()

function jobError(code: ApiError['code'], message: string): ApiError {
  return { code, message, details: null }
}

function validationFailure(context: Context, message = 'Invalid Job request'): Response {
  return context.json(jobError('validation_failed', message), 400)
}

function jobFailure(context: Context, error: unknown): Response {
  if (error instanceof JobStoreError) {
    switch (error.code) {
      case 'job_not_found':
        return context.json(jobError('job_not_found', 'Job not found'), 404)
      case 'invalid_input':
        return validationFailure(context)
      case 'job_terminal':
      case 'invalid_transition':
      case 'sequence_conflict':
        return context.json(jobError('job_conflict', 'Job state conflict'), 409)
      case 'stored_data_invalid':
        return context.json(jobError('storage_error', 'Stored Job data is invalid'), 500)
    }
  }
  if (error instanceof JobServiceError) {
    return context.json(jobError('job_conflict', 'Job state conflict'), 409)
  }
  return context.json(jobError('storage_error', 'Job storage operation failed'), 500)
}

function parseJobId(context: Context): string | null {
  const parsed = jobPathParams.safeParse({ jobId: context.req.param('jobId') })
  return parsed.success ? parsed.data.jobId : null
}

function eventFrame(event: JobEvent, reasoning: boolean): Uint8Array {
  const parsed = jobStreamEventSchema.parse(reasoning ? event : redactJobEvent(event))
  return encoder.encode(
    `id: ${parsed.sequence}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(parsed)}\n\n`,
  )
}

function failureFrame(): Uint8Array {
  const error = jobError('storage_error', 'Job event subscription failed')
  return encoder.encode(
    `event: ${SSE_ERROR_EVENT_NAME}\ndata: ${JSON.stringify(error)}\n\n`,
  )
}

/**
 * Pull one persisted event per downstream demand signal. The stream buffers at
 * most one frame, while producer mutations remain independent in JobService.
 */
function jobEventResponse(
  source: AsyncIterable<JobEvent>,
  subscriber: AbortController,
  requestSignal: AbortSignal,
  reasoning: boolean,
): Response {
  const iterator = source[Symbol.asyncIterator]()
  let closed = false

  const onRequestAbort = () => subscriber.abort()
  requestSignal.addEventListener('abort', onRequestAbort, { once: true })
  if (requestSignal.aborted) subscriber.abort()

  const cleanup = () => {
    if (closed) return
    closed = true
    requestSignal.removeEventListener('abort', onRequestAbort)
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next()
          if (next.done) {
            cleanup()
            controller.close()
            return
          }
          controller.enqueue(eventFrame(next.value, reasoning))
        } catch {
          controller.enqueue(failureFrame())
          subscriber.abort()
          await iterator.return?.()
          cleanup()
          controller.close()
        }
      },
      async cancel() {
        subscriber.abort()
        await iterator.return?.()
        cleanup()
      },
    },
    { highWaterMark: 1 },
  )

  return new Response(stream, { headers: SSE_HEADERS })
}

export function jobsRoutes(app: AppContext): Hono {
  const routes = new Hono()

  routes.post('/', async (context) => {
    const parsed = createJobBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return validationFailure(context)

    try {
      const result = app.jobService.create({
        ...parsed.data,
        idempotencyScope: PUBLIC_JOB_IDEMPOTENCY_SCOPE,
      })
      const response = createJobResponse.parse({
        ...result,
        eventsUrl: ROUTES.jobEvents(result.job.id),
      })
      return context.json(response, result.created ? 202 : 200)
    } catch (error) {
      return jobFailure(context, error)
    }
  })

  routes.get('/:jobId', (context) => {
    const jobId = parseJobId(context)
    if (!jobId) return validationFailure(context, 'Invalid Job ID')

    try {
      const job = app.jobService.get(jobId)
      if (!job) return context.json(jobError('job_not_found', 'Job not found'), 404)
      return context.json(getJobResponse.parse({ job }))
    } catch (error) {
      return jobFailure(context, error)
    }
  })

  routes.get('/:jobId/events', (context) => {
    const jobId = parseJobId(context)
    if (!jobId) return validationFailure(context, 'Invalid Job ID')

    const url = new URL(context.req.url)
    if (url.searchParams.getAll('after').length > 1) {
      return validationFailure(context, 'Invalid Job event cursor')
    }
    const query = jobEventsQuery.safeParse(Object.fromEntries(url.searchParams))
    const rawLastEventId = context.req.header(SSE_LAST_EVENT_ID_HEADER)
    const lastEventId = rawLastEventId === undefined
      ? undefined
      : jobEventCursorText.safeParse(rawLastEventId)
    if (!query.success || (lastEventId !== undefined && !lastEventId.success)) {
      return validationFailure(context, 'Invalid Job event cursor')
    }

    const after = query.data.after
    const reconnectAfter = lastEventId?.success ? lastEventId.data : undefined
    if (after !== undefined && reconnectAfter !== undefined && after !== reconnectAfter) {
      return validationFailure(context, 'Conflicting Job event cursors')
    }
    const cursor = after ?? reconnectAfter ?? 0

    try {
      const job = app.jobService.get(jobId)
      if (!job) return context.json(jobError('job_not_found', 'Job not found'), 404)
      app.jobService.validateSubscription(jobId, cursor)

      const subscriber = new AbortController()
      return jobEventResponse(
        app.jobService.subscribe(jobId, cursor, subscriber.signal),
        subscriber,
        context.req.raw.signal,
        canSeeReasoning(context),
      )
    } catch (error) {
      return jobFailure(context, error)
    }
  })

  routes.post('/:jobId/cancel', async (context) => {
    const jobId = parseJobId(context)
    if (!jobId) return validationFailure(context, 'Invalid Job ID')
    const parsed = cancelJobBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) return validationFailure(context)

    try {
      return context.json(
        cancelJobResponse.parse({ job: await app.chatExecution.cancel(jobId, parsed.data.reason) }),
      )
    } catch (error) {
      return jobFailure(context, error)
    }
  })

  return routes
}
