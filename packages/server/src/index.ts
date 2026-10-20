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
import { defaultDbPath } from './store/db.ts'
import { UiCatalogReviewService } from './ui-catalog/service.ts'
import { keychainSigner } from './ui-catalog/signer.ts'
import { findSourceCheckoutUiRoot } from './ui-catalog/source-checkout.ts'

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

/** Set to true by the bundled release builds (server and CLI esbuild `define`). */
declare const __GUANXI_RELEASE_BUILD__: boolean | undefined
export const RELEASE_BUILD =
  typeof __GUANXI_RELEASE_BUILD__ !== 'undefined' && __GUANXI_RELEASE_BUILD__ === true
export const DEFAULT_PORT = 4310

const here = dirname(fileURLToPath(import.meta.url))

/** Origins of the Vite dev server; GUANXI_WEB_PORT moves it in parallel worktrees. */
export function devOriginsFor(webPort: string): string[] {
  return [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]
}

export interface StartOptions {
  port?: number
  host?: string
  dataDir?: string
  /** Директория со сборкой фронта. По умолчанию ищется рядом с пакетом. */
  webDir?: string
  devOrigins?: string[]
}

export async function start(options: StartOptions = {}) {
  const port = options.port ?? (Number(process.env['PORT']) || DEFAULT_PORT)
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const dataDir = options.dataDir ?? join(process.env['HOME'] ?? '.', '.guanxi')

  const context = await createAppContext({
    dbPath: defaultDbPath(dataDir),
    appVersion: APP_VERSION,
  })

  // D-138: approvals are written only from a source checkout and never by a release build.
  const uiCatalog = new UiCatalogReviewService({
    uiRoot: RELEASE_BUILD ? null : findSourceCheckoutUiRoot(here),
    release: RELEASE_BUILD,
    signer: keychainSigner(),
  })

  const server = createApp(context, {
    devOrigins: options.devOrigins ?? devOriginsFor(process.env['GUANXI_WEB_PORT'] || '5173'),
    uiCatalog,
  })

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

  return { url, port: actualPort, host, context, close }
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
