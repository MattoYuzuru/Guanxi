import { relayPlugin, RELAY_SERVICE, type RelayService } from './relay/plugin.ts'
import { relayStartRoutes } from './relay/routes.ts'
import { RelayRuntimeSource, type RelayRuntimePolicy } from './relay/runtime.ts'
import type { RelayStartHost } from './relay/start.ts'
import { RelayError, type Reserves } from './relay/types.ts'
import { realpath } from 'node:fs/promises'
/**
 * Точка входа сервера.
 *
 * Слушает петлевой интерфейс: Ollama не имеет аутентификации, и выставлять наружу
 * что-либо, что имеет к ней доступ, нельзя. Смена адреса — осознанное действие
 * через переменную окружения, а не значение по умолчанию.
 */
import { federationRoutes } from './federation/routes.ts'
import { FEDERATION_SERVICE, type FederationHostOptions } from './federation/plugin.ts'
import type { Federation } from './federation/service.ts'
import { FederationError } from './federation/crypto.ts'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.ts'
import { createAppContext } from './context.ts'
import { apiPortFromEnv, dataDirFromEnv, devOriginsFromEnv, portFromEnv, WEB_PORT_ENV, DEFAULT_WEB_PORT } from './config/listen-env.ts'
import { defaultDbPath, openDb } from './store/db.ts'
import { bootServerKernel } from './runtime/kernel.ts'
import { UiCatalogReviewService } from './ui-catalog/service.ts'
import { approvalSignerPath, helperSigner } from './ui-catalog/signer.ts'
import { findSourceCheckoutUiRoot } from './ui-catalog/source-checkout.ts'
import { RELEASE_BUILD } from './release.ts'

import { connectionsPlugin, CONNECTIONS_SERVICE } from './connections/plugin.ts'
import type { VaultPolicy } from './vault/vault.ts'
import type { Connections } from './connections/service.ts'
import { ConnectionError } from './connections/errors.ts'
import { connectionRoutes } from './connections/routes.ts'
import { nativeAgentPlugin, NATIVE_AGENT_SERVICE, type NativeAgentService } from './native-agent/plugin.ts'
import { nativeAgentRoutes } from './native-agent/routes.ts'
import { externalAgentPlugin } from './external-agents/plugin.ts'
import type { ExternalPolicy } from './external-agents/types.ts'

export { RELEASE_BUILD } from './release.ts'
export { JobStore, JobStoreError } from './store/jobs.ts'
export { QuickRunStore } from './store/quick-runs.ts'
export { RecipeStore } from './store/recipes.ts'
export { ArtifactStore, ArtifactStoreError } from './store/artifacts.ts'
export type {
  ArtifactDownloadHeaders,
  ArtifactOrphanInventory,
  ArtifactReadOptions,
  ArtifactStoreErrorCode,
  ArtifactStoreHooks,
  ArtifactStoreOptions,
  ArtifactWriteOptions,
} from './store/artifacts.ts'
export { JobService, JobServiceError } from './jobs/service.ts'
export {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  SINGLE_PERMIT_POLICY_BASIS,
  ResourceGovernor,
  ResourceGovernorError,
  operationOwner,
} from './runtime/resource-governor.ts'
export { RESOURCE_GOVERNOR_SERVICE, resourceGovernorPlugin } from './runtime/governor-plugin.ts'
export { OLLAMA_ADAPTER_SERVICE, ollamaAdapterPlugin } from './ollama/plugin.ts'
export type { OllamaAdapter, OllamaAdapterConfig } from './ollama/plugin.ts'
export { LEGACY_SERVER_PROFILE, SESSION_LOG_LAYER, bootServerKernel } from './runtime/kernel.ts'
export type { ServerKernel, ServerKernelOptions } from './runtime/kernel.ts'
export * from './egress/index.ts'
export * from './session-log/index.ts'
export type {
  AdmissionExplanation,
  AdmissionPriority,
  AdmissionRequest,
  AdmissionTicket,
  AdmissionTicketState,
  GovernorDecisionCode,
  ModelResourceRequest,
  ResourceGovernorSnapshot,
  ResourceLease,
  ResourceOperation,
  ResourceOwner,
} from './runtime/resource-governor.ts'
export {
  CHAT_JOB_OPERATION,
  CHAT_OUTPUT_CHUNK_BYTES,
  ChatJobExecutionOwner,
  chatIdempotencyScope,
  chatRequestFingerprint,
} from './jobs/chat-execution.ts'
export {
  ChatRecoveryError,
  DEFAULT_CHAT_RECOVERY_OUTPUT_PAGE_SIZE,
  DEFAULT_CHAT_RECOVERY_SCAN_PAGE_SIZE,
  reconcileLostChatExecution,
  recoverChatJobs,
} from './jobs/chat-recovery.ts'
export type {
  ChatRecoveryCheckpoint,
  ChatRecoveryOptions,
  ChatRecoveryReport,
} from './jobs/chat-recovery.ts'
export type { JobServiceErrorCode, JobServiceOptions } from './jobs/service.ts'
export { PUBLIC_JOB_IDEMPOTENCY_SCOPE } from './http/jobs-routes.ts'
export type {
  AppendJobEventInput,
  ChatJobAssociation,
  CreateChatJobInput,
  CreateChatJobResult,
  CreateJobInput,
  CreateJobResult,
  JobStoreErrorCode,
  TerminalizeJobInput,
  TerminalizeChatJobInput,
  TerminalizeJobResult,
  TransitionJobInput,
  TransitionJobResult,
} from './store/jobs.ts'

const APP_VERSION = '0.1.0'

export const DEFAULT_PORT = 4310

const here = dirname(fileURLToPath(import.meta.url))

export interface StartOptions {
  port?: number
  host?: string
  dataDir?: string
  /** Директория со сборкой фронта. По умолчанию ищется рядом с пакетом. */
  webDir?: string
  devOrigins?: string[]
  connectionsPolicy?: VaultPolicy
  federation?: Omit<FederationHostOptions, 'db'>
  /** Trusted node-local installed CLIs; no executable paths or account identity arrive over HTTP. */
  externalAgents?: ExternalPolicy
  /** T0-only proved runtime counter and owned-checkout adapter; neither comes from HTTP. */
  relay?: { runtime: RelayRuntimePolicy; reserves: Reserves; allocate?: RelayStartHost['allocate'] }
}

export async function start(options: StartOptions = {}) {
  const port = options.port ?? apiPortFromEnv(process.env, DEFAULT_PORT)
  let actualPort = port
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const dataDir = options.dataDir ?? dataDirFromEnv(process.env)

  // The governor, the Ollama adapter (K1), the egress scrubber and the session
  // log (K2) run as kernel plugins; the legacy context consumes their services.
  // The database opens first because the session log plugin is bound to it.
  const dbPath = defaultDbPath(dataDir)
  const db = openDb(dbPath)
  let kernel: Awaited<ReturnType<typeof bootServerKernel>>
  try {
    kernel = await bootServerKernel(undefined, { db, federation: options.federation })
  } catch (error) {
    db.close()
    throw error
  }
  let context: Awaited<ReturnType<typeof createAppContext>>
  try {
    context = await createAppContext({
      dbPath,
      db,
      appVersion: APP_VERSION,
      governor: kernel.governor,
      ollama: kernel.ollama,
      sessionLog: kernel.sessionLog ?? undefined,
    })
  } catch (error) {
    await kernel.node.dispose().catch(() => undefined)
    db.close()
    throw error
  }

  // D-138: approvals are written only from a source checkout and never by a release build.
  const uiCatalog = new UiCatalogReviewService({
    uiRoot: RELEASE_BUILD ? null : findSourceCheckoutUiRoot(here),
    release: RELEASE_BUILD,
    signer: helperSigner({ helperPath: approvalSignerPath() }),
  })

  try {
    await kernel.node.plugin(connectionsPlugin, {
      databasePath: join(dirname(defaultDbPath(dataDir)), 'connections.sqlite'),
      localHost: () => context.settings.get().ollamaHost,
      policy: options.connectionsPolicy,
    })
    await kernel.node.plugin(nativeAgentPlugin, { db, host: context, dataDir: dirname(dbPath), nodePorts: () => [actualPort, portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)] })
    await kernel.node.plugin(relayPlugin, { db, startHost: {
      ...(options.relay ? { reserves: options.relay.reserves, allocate: options.relay.allocate,
        ...(options.relay.runtime.counter ? { runtime: new RelayRuntimeSource(kernel.node.service<Connections>(CONNECTIONS_SERVICE)!,
          () => context.models(), options.relay.runtime) } : {}) } : {}),
      nodePorts: () => [actualPort, portFromEnv(process.env, WEB_PORT_ENV, DEFAULT_WEB_PORT)],
      project: async (id, signal) => {
        signal.throwIfAborted()
        const project = kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)!.projects().find(p => p.id === id)
        if (!project) throw new RelayError('relay_project_unavailable')
        const roots = await Promise.all(project.filesystemBindings.map(async binding => {
          const workspace = context.workspaces.get(binding.workspaceId)
          if (!workspace) throw new RelayError('relay_project_unavailable')
          return realpath(workspace.rootPath)
        }))
        signal.throwIfAborted()
        return { projectId: id, roots, source: 'native-project-roots+workspace-store', observedAt: Date.now() }
      },
    } })
    if (options.externalAgents) await kernel.node.plugin(externalAgentPlugin, { dataDir: dirname(dbPath), policy: options.externalAgents })
  } catch (error) {
    await context.maintenance?.close().catch(() => undefined)
    await context.chatExecution.shutdown().catch(() => undefined)
    context.jobService.closeSubscriptions()
    await kernel.node.dispose().catch(() => undefined)
    context.db.close()
    throw error
  }
  const server = createApp(context, {
    host, port: () => actualPort,
    devOrigins: options.devOrigins ?? devOriginsFromEnv(process.env),
    uiCatalog,
    layouts: options.federation ? () => {
      const federation = kernel.node.service<Federation>(FEDERATION_SERVICE)
      if (!federation) throw new FederationError('federation_unavailable', 503)
      return federation.layouts
    } : undefined,
  })

  server.route('/api/connections', connectionRoutes(() => {
    const service = kernel.node.service<Connections>(CONNECTIONS_SERVICE)
    if (!service) throw new ConnectionError('egress_unavailable', 'Connections unavailable')
    return service
  }, 'local', options.devOrigins ?? devOriginsFromEnv(process.env)))
  server.route('/api/agent', nativeAgentRoutes(() => {
    const service = kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)
    if (!service) throw new Error('agent_unavailable')
    return service
  }, options.devOrigins ?? devOriginsFromEnv(process.env)))
  server.route('/api/relay', relayStartRoutes(() => {
    const service = kernel.node.service<RelayService>(RELAY_SERVICE)
    if (!service) throw new RelayError('relay_closed')
    return service.publicStarts
  }, options.devOrigins ?? devOriginsFromEnv(process.env)))

  if (options.federation) server.route('/api/federation', federationRoutes(() => {
    const service = kernel.node.service<Federation>(FEDERATION_SERVICE)
    if (!service) throw new FederationError('federation_unavailable', 503)
    return service
  }))

  // Неизвестный API-путь не должен проваливаться в SPA и возвращать HTML.
  server.all('/api/*', (c) =>
    c.json({ code: 'internal_error', message: 'API-маршрут не найден', details: null }, 404),
  )

  mountWeb(server, options.webDir ?? resolve(here, '../../web/dist'))

  let instance!: ReturnType<typeof serve>
  try {
    actualPort = await new Promise<number>((resolvePort, reject) => {
      const onError = (error: Error) => reject(error)
      instance = serve({ fetch: server.fetch, port, hostname: host }, (address) => {
        instance.off('error', onError)
        resolvePort(address.port)
      })
      instance.once('error', onError)
    })
  } catch (error) {
    await context.maintenance?.close().catch(() => undefined)
    await context.chatExecution.shutdown().catch(() => undefined)
    context.jobService.closeSubscriptions()
    context.sessionLog?.closeSubscriptions()
    await kernel.node.dispose().catch(() => undefined)
    context.db.close()
    throw error
  }
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const url = `http://${browserHost}:${actualPort}`

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      // Stop accepting commands first; existing Chat streams stay alive long
      // enough to observe their truthful internal-shutdown terminal event.
      const listenerClosed = new Promise<void>((resolveClose) => {
        instance.close(() => resolveClose())
      })
      let shutdownError: unknown = null
      try {
        await context.maintenance?.close()
      } catch (error) {
        shutdownError = error
      }
      try {
        await kernel.node.service<NativeAgentService>(NATIVE_AGENT_SERVICE)?.shutdown()
        await context.chatExecution.shutdown()
      } catch (error) {
        shutdownError ??= error
      } finally {
        context.jobService.closeSubscriptions()
        // Inspector streams are open-ended; end them so the listener can close.
        context.sessionLog?.closeSubscriptions()
        await listenerClosed
        // Unload plugins before the database they may use is closed. Each
        // plugin cleanup is bounded by the kernel's step timeout; the HTTP
        // listener close above is not bounded (it waits for open responses).
        try {
          await kernel.node.dispose()
        } catch (error) {
          shutdownError ??= error
        }
        context.db.close()
        process.removeListener('SIGINT', shutdown)
        process.removeListener('SIGTERM', shutdown)
      }
      if (shutdownError) throw shutdownError
    })()
    return closing
  }

  const shutdown = () => {
    void close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return { url, port: actualPort, host, context, kernel, close }
}

/**
 * Раздаёт production-сборку, даже если она появилась уже после запуска сервера.
 *
 * Это важно для разработки: backend часто стартует раньше первого `vite build`.
 * `serveStatic` проверяет файл на каждом запросе, поэтому после сборки не нужен
 * рестарт процесса.
 */
export function mountWeb(server: ReturnType<typeof createApp>, webDir: string): void {
  // Собранный фронт раздаётся тем же процессом: одна команда, один порт.
  const serveFiles = serveStatic({ root: webDir })
  const serveIndex = serveStatic({ path: 'index.html', root: webDir })

  server.use('/*', serveFiles)
  // Роутинг на стороне клиента: всё неизвестное отдаём в index.html.
  server.get('*', async (context, next) => {
    if (existsSync(join(webDir, 'index.html'))) {
      return serveIndex(context, next)
    }

    return context.text(
      `Guanxi ${APP_VERSION}\n\nСборка фронта не найдена (${webDir}).\n` +
        `Для разработки запусти: npm run dev:web\nAPI доступен на /api/health\n`,
    )
  })
}
