import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '@alamo/server'

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

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage())
  process.exit(0)
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION)
  process.exit(0)
}

try {
  const options = parseArgs(args)
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
  console.error(error instanceof Error ? error.message : String(error))
  console.error('\n' + usage())
  process.exit(1)
}
