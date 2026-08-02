import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, start } from '@alamo/server'
import { probeExistingAlamo } from './existing.ts'

const VERSION = '0.1.0'
const here = dirname(fileURLToPath(import.meta.url))

type CliOptions = {
  port?: number
  host?: string
  dataDir?: string
  open: boolean
}

function usage(): string {
  return `Alamo UI ${VERSION}

Использование:
  alamo-ui [--port 4310] [--host 127.0.0.1] [--data-dir PATH] [--no-open]

Опции:
  --port       HTTP-порт (по умолчанию 4310)
  --host       Адрес прослушивания (по умолчанию 127.0.0.1)
  --data-dir   Директория SQLite и локальных данных
  --no-open    Не открывать браузер
  -h, --help   Показать справку
  -v, --version Показать версию`
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { open: true }

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--no-open') {
      options.open = false
      continue
    }
    if (arg === '--port' || arg === '--host' || arg === '--data-dir') {
      const value = args[index + 1]
      if (!value) throw new Error(`После ${arg} нужно значение`)
      index++

      if (arg === '--port') {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
          throw new Error(`Некорректный порт: ${value}`)
        }
        options.port = port
      } else if (arg === '--host') {
        options.host = value
      } else {
        options.dataDir = resolve(value)
      }
      continue
    }
    throw new Error(`Неизвестная опция: ${arg}`)
  }

  return options
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] }

  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore',
  })
  child.once('error', () => {
    console.warn(`Не удалось открыть браузер автоматически. Откройте ${url}`)
  })
  child.unref()
}

function requestedUrl(options: CliOptions): { url: string; port: number } {
  const environmentPort = Number(process.env['PORT'])
  const port =
    options.port ??
    (Number.isInteger(environmentPort) && environmentPort > 0 && environmentPort <= 65_535
      ? environmentPort
      : DEFAULT_PORT)
  const host = options.host ?? process.env['HOST'] ?? '127.0.0.1'
  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return { url: `http://${browserHost}:${port}`, port }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage())
  process.exit(0)
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

let options: CliOptions
try {
  options = parseArgs(args)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('\n' + usage())
  process.exit(1)
}

const requested = requestedUrl(options)
const existing = requested.port === 0 ? null : await probeExistingAlamo(requested.url)

if (existing?.kind === 'ui') {
  console.log(`Alamo UI ${VERSION} уже запущен: ${existing.url}`)
  if (options.open) openBrowser(existing.url)
} else if (existing?.kind === 'api-only') {
  console.error(
    `На ${existing.url} уже работает Alamo${existing.version ? ` ${existing.version}` : ''}, ` +
      'но frontend у этого процесса не был собран.',
  )
  console.error('Останови старый процесс и повтори: alamo-ui')
  process.exitCode = 1
} else {
  try {
    const bundledWeb = resolve(here, 'web')
    const developmentWeb = resolve(here, '../../web/dist')
    const webDir = existsSync(bundledWeb) ? bundledWeb : developmentWeb

    const server = await start({
      port: options.port,
      host: options.host,
      dataDir: options.dataDir,
      webDir,
    })

    console.log(`Alamo UI ${VERSION} запущен: ${server.url}`)
    if (options.open) openBrowser(server.url)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'EADDRINUSE') {
      console.error(`Порт ${requested.port} уже занят другим процессом.`)
      console.error('Запусти Alamo на свободном порту: alamo-ui --port 0')
    } else {
      console.error(
        `Не удалось запустить Alamo UI: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    process.exitCode = 1
  }
}
