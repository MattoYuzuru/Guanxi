import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

const require = createRequire(import.meta.url)
export const desktopDir = resolve(import.meta.dirname, '../..')
export const fakeServiceEntry = resolve(import.meta.dirname, '../fixtures/fake-service.mjs')
export const repoRoot = resolve(desktopDir, '../..')
const electronPath = require('electron') as string

export function freePort(): Promise<number> {
  return new Promise((accept, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => accept(port))
    })
  })
}

export interface Sandbox {
  dir: string
  dataDir: string
  userDataDir: string
  cleanup(): void
}

/** A private directory per scenario: never `~/.guanxi`, never another scenario's data. */
export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-desktop-test-'))
  const dataDir = join(dir, 'data')
  const userDataDir = join(dir, 'user-data')
  mkdirSync(dataDir, { recursive: true })
  return { dir, dataDir, userDataDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export interface LaunchOptions {
  sandbox: Sandbox
  port: number
  /** Extra environment for the shell (and, where not filtered, the service). */
  env?: Record<string, string>
  /** `fake` (default) runs the fixture; `real` leaves the entry unset so the CLI in the checkout runs. */
  service?: 'fake' | 'real' | string
  lang?: string
}

export interface Launched {
  app: ElectronApplication
  page: Page
}

export function shellEnvironment(options: LaunchOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GUANXI_') && key !== 'NODE_OPTIONS' && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  env['GUANXI_API_PORT'] = String(options.port)
  env['GUANXI_DATA_DIR'] = options.sandbox.dataDir
  env['GUANXI_DESKTOP_TEST_HIDDEN'] = '1'
  if (options.lang) env['GUANXI_DESKTOP_LOCALE'] = options.lang
  env['GUANXI_DESKTOP_HEALTH_TIMEOUT_MS'] = '20000'
  env['GUANXI_DESKTOP_PROBE_TIMEOUT_MS'] = '2000'
  env['GUANXI_DESKTOP_POLL_INTERVAL_MS'] = '100'
  const service = options.service ?? 'fake'
  if (service === 'fake') env['GUANXI_DESKTOP_SERVICE_ENTRY'] = fakeServiceEntry
  else if (service !== 'real') env['GUANXI_DESKTOP_SERVICE_ENTRY'] = service
  return { ...env, ...options.env }
}

const launched = new Set<ElectronApplication>()

/** Close whatever a failed scenario left running, so one failure cannot hang the file or poison the next launch. */
export async function closeAllShells(): Promise<void> {
  await Promise.all([...launched].map((app) => app.close().catch(() => undefined)))
  launched.clear()
}

export async function launchShell(options: LaunchOptions): Promise<Launched> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir, `--user-data-dir=${options.sandbox.userDataDir}`],
    env: shellEnvironment(options),
    timeout: 60_000,
  })
  launched.add(app)
  app.once('close', () => launched.delete(app))
  const page = await app.firstWindow()
  return { app, page }
}

export interface ServiceFacts {
  pid: number
  port: number
}

export function readServiceManifest(sandbox: Sandbox): ServiceFacts | null {
  try {
    return JSON.parse(readFileSync(join(sandbox.dataDir, 'desktop', 'service.json'), 'utf8')) as ServiceFacts
  } catch {
    return null
  }
}

export function alive(pid: number): boolean {
  // pid 0 would address this process group, and 1 is init: neither is ever "the service".
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor<T>(label: string, read: () => Promise<T | null | false> | T | null | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== false && value !== undefined) return value as T
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((accept) => setTimeout(accept, 100))
  }
}

export async function killQuietly(pid: number | undefined): Promise<void> {
  if (pid === undefined || pid <= 1 || !alive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await waitFor(`pid ${pid} to exit`, () => !alive(pid), 5_000).catch(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  })
}

/** A loopback HTTP server that counts requests: proof that something remote was (not) contacted. */
export async function listenCounting(
  port: number,
  handler?: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ hits: string[]; close(): Promise<void> }> {
  const hits: string[] = []
  const server = createHttpServer((request, response) => {
    hits.push(`${request.method} ${request.url}`)
    response.setHeader('access-control-allow-origin', '*')
    if (handler) handler(request, response)
    else response.end('foreign')
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', accept)
  })
  return { hits, close: () => new Promise((accept) => server.close(() => accept())) }
}

/** A listener that accepts connections and never answers. */
export async function listenSilent(port: number): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', accept)
  })
  return {
    close: () =>
      new Promise((accept) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => accept())
      }),
  }
}
