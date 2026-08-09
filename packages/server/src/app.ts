/**
 * Сборка HTTP-приложения.
 *
 * Аутентификация подключается здесь же одним middleware. Локально это заглушка,
 * пропускающая всё; при выносе на сервер её место занимает настоящая проверка —
 * без правок в роутах. Это один из трёх инвариантов, ради которых фронт не
 * работает с файловой системой напрямую.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { approvalBody, updateSettingsBody } from '@alamo/contract'
import type { AppContext } from './context.ts'
import { getOllamaStatus } from './ollama/status.ts'
import { fail } from './http/errors.ts'
import { jobsRoutes } from './http/jobs-routes.ts'
import { featureFlagsRoutes } from './http/feature-flags-routes.ts'
import { modelsRoutes } from './http/models-routes.ts'
import { runtimeRoutes } from './http/runtime-routes.ts'
import { threadsRoutes } from './http/threads-routes.ts'
import { workspacesRoutes } from './http/workspaces-routes.ts'
import type { OllamaStatusOptions } from './ollama/status.ts'

export interface CreateAppOptions {
  /** Разрешить обращения с dev-сервера Vite. */
  devOrigins?: string[]
  /** Deterministic health probe boundary for tests. */
  ollamaStatus?: OllamaStatusOptions
}

export function createApp(app: AppContext, options: CreateAppOptions = {}): Hono {
  const server = new Hono()

  if (options.devOrigins?.length) {
    server.use('/api/*', cors({ origin: options.devOrigins, credentials: true }))
  }

  /*
   * Место для аутентификации. Локально пропускаем всё: сервер слушает только
   * петлевой интерфейс. При выносе наружу здесь появляется проверка сессии,
   * и ни один роут об этом не узнает.
   */
  server.use('/api/*', async (_context, next) => {
    await next()
  })

  server.get('/api/health', async (context) => {
    const observedAt = new Date().toISOString()
    const client = app.ollama()
    const ollama = await getOllamaStatus(client, options.ollamaStatus)

    return context.json({
      ok: true,
      appVersion: app.appVersion,
      application: {
        state: 'reachable',
        source: 'application_http',
        observedAt,
      },
      ollama,
      hardware: app.hardware,
      network: {
        // P0-D removed the undocumented ollama.com endpoint. Catalog provenance
        // is sampled by its own route instead of inferred here.
        ollamaComReachable: null,
        checkedAt: null,
        status: 'unknown',
        source: 'not_checked',
      },
    })
  })

  server.route('/api/models', modelsRoutes(app))
  server.route('/api/feature-flags', featureFlagsRoutes(app))
  server.route('/api/runtime', runtimeRoutes(app))
  server.route('/api/jobs', jobsRoutes(app))
  server.route('/api/threads', threadsRoutes(app))
  server.route('/api/workspaces', workspacesRoutes(app))

  server.post('/api/approvals/:id', async (context) => {
    const parsed = approvalBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Нужно поле decision', details: null },
        400,
      )
    }

    const accepted = app.approvals.decide(
      context.req.param('id'),
      parsed.data.decision,
      parsed.data.rememberForThread ?? false,
    )

    // false означает, что ожидание уже снято — истёк таймаут или ход остановлен.
    return context.json({ ok: accepted })
  })

  server.get('/api/settings', (context) => context.json(app.settings.get()))

  server.put('/api/settings', async (context) => {
    const parsed = updateSettingsBody.safeParse(await context.req.json().catch(() => null))
    if (!parsed.success) {
      return context.json(
        { code: 'validation_failed', message: 'Некорректное тело', details: parsed.error.flatten() },
        400,
      )
    }

    try {
      return context.json(app.settings.update(parsed.data))
    } catch (error) {
      return fail(context, error)
    }
  })

  return server
}
