/**
 * Точка входа сервера.
 *
 * Слушает петлевой интерфейс: Ollama не имеет аутентификации, и выставлять наружу
 * что-либо, что имеет к ней доступ, нельзя. Смена адреса — осознанное действие
 * через переменную окружения, а не значение по умолчанию.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createApp } from './app.ts'
import { createAppContext } from './context.ts'
import { apiPortFromEnv, dataDirFromEnv, devOriginsFromEnv } from './config/listen-env.ts'
import { defaultDbPath } from './store/db.ts'
import { bootServerKernel } from './runtime/kernel.ts'
import { connectionsPlugin, CONNECTIONS_SERVICE } from './connections/plugin.ts'
import { temporaryEgressPlugin, EGRESS_SERVICE } from './connections/egress.ts'
import type { VaultPolicy } from './vault/vault.ts'
import type { Connections } from './connections/service.ts'
import { connectionRoutes } from './connections/routes.ts'

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
export { LEGACY_SERVER_PROFILE, bootServerKernel } from './runtime/kernel.ts'
export type { ServerKernel } from './runtime/kernel.ts'
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
}

export async function start(options: StartOptions = {}) {
  const port = options.port ?? apiPortFromEnv(process.env, DEFAULT_PORT)
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const dataDir = options.dataDir ?? dataDirFromEnv(process.env)

  // The governor and the Ollama adapter run as kernel plugins (K1); the legacy
  // context consumes their services.
  const kernel = await bootServerKernel()
  let context: Awaited<ReturnType<typeof createAppContext>>
  try {
    context = await createAppContext({
      dbPath: defaultDbPath(dataDir),
      appVersion: APP_VERSION,
      governor: kernel.governor,
      ollama: kernel.ollama,
    })
  } catch (error) {
    await kernel.node.dispose().catch(() => undefined)
    throw error
  }

  try {
    if (!kernel.node.service(EGRESS_SERVICE)) await kernel.node.plugin(temporaryEgressPlugin)
    await kernel.node.plugin(connectionsPlugin, {
      databasePath: join(dirname(defaultDbPath(dataDir)), 'connections.sqlite'),
      localHost: () => context.settings.get().ollamaHost,
      policy: options.connectionsPolicy,
    })
  } catch (error) {
    await context.maintenance?.close().catch(() => undefined)
    await context.chatExecution.shutdown().catch(() => undefined)
    context.jobService.closeSubscriptions()
    await kernel.node.dispose().catch(() => undefined)
    context.db.close()
    throw error
  }
  const server = createApp(context, {
    devOrigins: options.devOrigins ?? devOriginsFromEnv(process.env),
  })

  server.route('/api/connections', connectionRoutes(kernel.node.service<Connections>(CONNECTIONS_SERVICE)!, 'local', options.devOrigins ?? devOriginsFromEnv(process.env)))

  // Неизвестный API-путь не должен проваливаться в SPA и возвращать HTML.
  server.all('/api/*', (c) =>
    c.json({ code: 'internal_error', message: 'API-маршрут не найден', details: null }, 404),
  )

  mountWeb(server, options.webDir ?? resolve(here, '../../web/dist'))

  let instance!: ReturnType<typeof serve>
  let actualPort: number
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
    context.db.close()
    await kernel.node.dispose().catch(() => undefined)
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
        await context.chatExecution.shutdown()
      } catch (error) {
        shutdownError ??= error
      } finally {
        context.jobService.closeSubscriptions()
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
