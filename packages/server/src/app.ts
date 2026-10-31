/**
 * HTTP application assembly.
 *
 * Authorization is one middleware here (`routeAuthz`): every `/api/*` route is declared in the
 * route policy map and routes carry no checks of their own. Locally the principal is the
 * implicit owner; on a remote node an accounts adapter supplies it. This is one of the three
 * invariants that keep the frontend away from the filesystem.
 */
import { layoutsRoutes } from './layouts/routes.ts'
import type { ReplicatedLayouts } from './layouts/replication.ts'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { hostAllowlist, type HostAllowlistOptions } from './http/host-allowlist.ts'
import { approvalBody, minimalHealthSchema, updateSettingsBody } from '@guanxi/contract'
import type { AppContext } from './context.ts'
import { getOllamaStatus } from './ollama/status.ts'
import { fail } from './http/errors.ts'
import { jobsRoutes } from './http/jobs-routes.ts'
import { featureFlagsRoutes } from './http/feature-flags-routes.ts'
import { modelsRoutes } from './http/models-routes.ts'
import { runtimeRoutes } from './http/runtime-routes.ts'
import { threadsRoutes } from './http/threads-routes.ts'
import { workspacesRoutes } from './http/workspaces-routes.ts'
import { projectsRoutes } from './http/projects-routes.ts'
import { quickRunsRoutes } from './http/quick-runs-routes.ts'
import { recipesRoutes } from './http/recipes-routes.ts'
import { artifactsRoutes } from './http/artifacts-routes.ts'
import { uiCatalogRoutes } from './http/ui-catalog-routes.ts'
import { UiCatalogReviewService } from './ui-catalog/service.ts'
import { unavailableSigner } from './ui-catalog/signer.ts'
import { sessionLogRoutes } from './session-log/routes.ts'
import type { OllamaStatusOptions } from './ollama/status.ts'
import { routeAuthz, type AuthzContext, type RouteAuthzOptions } from './auth/route-authz.ts'

export interface CreateAppOptions extends HostAllowlistOptions {
  /** Разрешить обращения с dev-сервера Vite. */
  devOrigins?: string[]
  /** Deterministic health probe boundary for tests. */
  ollamaStatus?: OllamaStatusOptions
  /**
   * Component catalog review writer (D-138). Omitted means read-only: no source checkout and
   * no signer, so the catalog shows bundled records only.
   */
  uiCatalog?: UiCatalogReviewService
  /** The configured F1 node owns the account and signed layout write boundary. */
  layouts?: () => ReplicatedLayouts | null
  /** Route authorization: absent is the single-owner local mode; remote mode passes the accounts adapter. */
  authz?: RouteAuthzOptions
}

export function createApp(app: AppContext, options: CreateAppOptions = {}): Hono {
  const server = new Hono()
  server.use('*', hostAllowlist(options))

  if (options.devOrigins?.length) {
    server.use('/api/*', cors({
      origin: options.devOrigins,
      credentials: true,
      allowHeaders: ['Content-Type', 'Idempotency-Key'],
      exposeHeaders: [
        'Accept-Ranges',
        'Content-Disposition',
        'Content-Length',
        'Digest',
        'ETag',
      ],
    }))
  }

  /*
   * The single authorization point. Locally the principal is the implicit owner (the boot guard
   * keeps the listener on loopback); a remote node takes it from the accounts adapter. A route
   * without a declared policy is refused.
   */
  server.use('/api/*', routeAuthz(options.authz))

  server.get('/api/health', async (context: Context<{ Variables: { authz?: AuthzContext } }>) => {
    // Hardware and Ollama detail are for the node owner and the admin role; any other signed-in user gets liveness only.
    if (context.get('authz')?.operator !== true) return context.json(minimalHealthSchema.parse({ ok: true }))

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

  server.route('/api/layouts', layoutsRoutes(() => app.db, options.devOrigins, options.layouts))
  server.route('/api/models', modelsRoutes(app))
  server.route('/api/feature-flags', featureFlagsRoutes(app))
  server.route('/api/runtime', runtimeRoutes(app))
  server.route('/api/jobs', jobsRoutes(app))
  server.route('/api/threads', threadsRoutes(app))
  server.route('/api/workspaces', workspacesRoutes(app))
  server.route('/api/projects', projectsRoutes(app))
  server.route('/api/quick-runs', quickRunsRoutes(app))
  server.route('/api/recipes', recipesRoutes(app))
  server.route('/api/artifacts', artifactsRoutes(app))
  server.route(
    '/api/ui-catalog',
    uiCatalogRoutes(
      options.uiCatalog ??
        new UiCatalogReviewService({
          uiRoot: null,
          release: false,
          signer: unavailableSigner('platform_unsupported'),
        }),
      options.devOrigins ?? [],
    ),
  )
  server.route('/api/sessions', sessionLogRoutes(() => app.sessionLog))

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
