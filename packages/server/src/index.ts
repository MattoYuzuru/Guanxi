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

export { JobStore, JobStoreError } from './store/jobs.ts'
export { JobService, JobServiceError } from './jobs/service.ts'
export type { JobServiceErrorCode, JobServiceOptions } from './jobs/service.ts'
export type {
  AppendJobEventInput,
  CreateJobInput,
  CreateJobResult,
  JobStoreErrorCode,
  TerminalizeJobInput,
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
}

export async function start(options: StartOptions = {}) {
  const port = options.port ?? (Number(process.env['PORT']) || DEFAULT_PORT)
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const dataDir = options.dataDir ?? join(process.env['HOME'] ?? '.', '.alamo')

  const context = await createAppContext({
    dbPath: defaultDbPath(dataDir),
    appVersion: APP_VERSION,
  })

  const server = createApp(context, {
    devOrigins: options.devOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173'],
  })

  // Неизвестный API-путь не должен проваливаться в SPA и возвращать HTML.
  server.all('/api/*', (c) =>
    c.json({ code: 'internal_error', message: 'API-маршрут не найден', details: null }, 404),
  )

  mountWeb(server, options.webDir ?? resolve(here, '../../web/dist'))

  let instance!: ReturnType<typeof serve>
  const actualPort = await new Promise<number>((resolvePort, reject) => {
    const onError = (error: Error) => reject(error)
    instance = serve({ fetch: server.fetch, port, hostname: host }, (address) => {
      instance.off('error', onError)
      resolvePort(address.port)
    })
    instance.once('error', onError)
  })
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const url = `http://${browserHost}:${actualPort}`

  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closing) return closing
    for (const controller of context.activeTurns.values()) controller.abort()
    closing = new Promise((resolveClose) => {
      instance.close(() => {
        context.db.close()
        resolveClose()
      })
    })
    return closing
  }

  const shutdown = () => {
    void close().finally(() => process.exit(0))
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
      `Alamo UI ${APP_VERSION}\n\nСборка фронта не найдена (${webDir}).\n` +
        `Для разработки запусти: npm run dev:web\nAPI доступен на /api/health\n`,
    )
  })
}
