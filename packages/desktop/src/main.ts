import { accessSync, constants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, app, dialog } from 'electron'
import { PRODUCT_NAME } from '@guanxi/contract/brand'
import { ConfigError, resolveConfig } from './config.ts'
import type { DesktopConfig } from './config.ts'
import { translate } from './messages.ts'
import type { MessageKey, ShellLocale } from './messages.ts'
import { pickLocale } from './messages.ts'
import { platformFor } from './platform/index.ts'
import { envName } from './env.ts'
import { ensureService, verifyOwner } from './service/handshake.ts'
import { isProcessAlive, removeManifest, servicePaths, spawnDetachedService, writeManifest } from './service/launcher.ts'
import { locateService } from './service/locate.ts'
import { commandOf, liveManifestPid, lookupListeners } from './service/owner.ts'
import { probeService } from './service/probe.ts'
import { stopService } from './service/stop.ts'
import { describeState, renderStatusPage, statusPageUrl } from './status-page.ts'
import type { ShellState } from './status-page.ts'
import { createMainWindow, installGuards } from './windows.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** While the window shows an error, look for a service started by someone else this often. */
const RECOVERY_INTERVAL_MS = 3_000

app.setName(PRODUCT_NAME)
const platform = platformFor(process.platform)

let config: DesktopConfig
let configError: ConfigError | null = null
try {
  config = resolveConfig(process.env, homedir())
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  configError = error
  // Fall back to defaults only to render the screen; no service is started in this state.
  config = resolveConfig({}, homedir())
}

// The system's first preferred language (app.getLocale() reports the Chromium locale, which on macOS can
// differ from the user's language list). `<PREFIX>_DESKTOP_LOCALE` is a development/test override only.
const localeOverride = !app.isPackaged ? process.env[envName('DESKTOP_LOCALE')] : undefined
const locale: ShellLocale = pickLocale(localeOverride ?? app.getPreferredSystemLanguages()[0] ?? app.getLocale())
const label = (key: MessageKey, values: Record<string, string | number> = {}) =>
  translate(locale, key, { product: PRODUCT_NAME, port: config.port, ...values })
const paths = servicePaths(config.dataDir)
// Development conveniences never apply to an installed app.
const hidden = !app.isPackaged && process.env[envName('DESKTOP_TEST_HIDDEN')] === '1'

const selfUid = typeof process.getuid === 'function' ? process.getuid() : null
const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
const ownerDeps = { listeners: () => lookupListeners(config.port), selfUid }
const expectedPid = () => liveManifestPid(config.port, { paths, alive: isProcessAlive, commandOf })

let window: BrowserWindow | null = null
let shown: ShellState['kind'] | 'service' = 'checking'
/** A function, not a comparison: `shown` changes across awaits and TypeScript cannot see that. */
const showingService = () => shown === 'service'
let handshakeRunning = false
let recoveryTimer: ReturnType<typeof setInterval> | null = null

function showState(state: ShellState): void {
  if (window === null || window.isDestroyed()) return
  shown = state.kind
  const html = renderStatusPage(describeState(state, { locale, product: PRODUCT_NAME, port: config.port }), locale)
  void window.loadURL(statusPageUrl(html)).catch(() => undefined)
}

function showService(): void {
  if (window === null || window.isDestroyed()) return
  shown = 'service'
  void window.loadURL(`${config.origin}/`).catch(() => undefined)
}

function stopRecovery(): void {
  if (recoveryTimer !== null) clearInterval(recoveryTimer)
  recoveryTimer = null
}

/** Attach-only recovery: a service that appears later (started by the CLI, or after the user freed the port) is picked up. */
function startRecovery(): void {
  stopRecovery()
  recoveryTimer = setInterval(() => {
    if (handshakeRunning || showingService()) return
    void (async () => {
      const result = await probeService(config.origin, { timeoutMs: config.probeTimeoutMs })
      if (result.kind !== 'ready' || handshakeRunning || showingService()) return
      // Same rule as the handshake: a Guanxi-shaped answer is attached to only when its owner is right.
      if (!(await verifyOwner(ownerDeps, await expectedPid())).ok) return
      stopRecovery()
      showService()
    })().catch(() => undefined)
  }, RECOVERY_INTERVAL_MS)
}

async function connect(): Promise<void> {
  if (handshakeRunning) return
  if (configError !== null) {
    showState({ kind: 'config_invalid', variable: configError.variable, value: configError.value })
    return
  }
  handshakeRunning = true
  stopRecovery()
  try {
    showState({ kind: 'checking' })
    const result = await ensureService({
      config,
      logPath: paths.log,
      probe: () => probeService(config.origin, { timeoutMs: config.probeTimeoutMs }),
      ...ownerDeps,
      expectedPid,
      forgetManifest: () => removeManifest(paths),
      locate: () =>
        locateService({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          repoRoot: join(app.getAppPath(), '..', '..'),
          env: process.env,
          port: config.port,
          dataDir: config.dataDir,
          exists: existsSync,
          isExecutable,
        }),
      spawn: (command) => spawnDetachedService(command, paths),
      onStarted: (pid, command) =>
        writeManifest(paths, { pid, port: config.port, startedAt: new Date().toISOString(), entry: command.entry }),
      onPhase: (phase) => {
        if (phase === 'starting') showState({ kind: 'starting' })
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    })
    if (result.ok) {
      showService()
    } else {
      showState({ kind: 'failure', failure: result })
      startRecovery()
    }
  } finally {
    handshakeRunning = false
  }
}

async function stopFromMenu(): Promise<void> {
  const parent = window !== null && !window.isDestroyed() ? window : undefined
  const options = {
    type: 'warning' as const,
    buttons: [label('stop.confirm.stop'), label('stop.confirm.cancel')],
    defaultId: 1,
    cancelId: 1,
    message: label('stop.confirm.title'),
    detail: label('stop.confirm.detail'),
  }
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  if (response !== 0) return
  const result = await stopService({
    paths,
    probe: (port) => probeService(`http://${config.host}:${port}`, { timeoutMs: config.probeTimeoutMs }),
    kill: (pid, signal) => process.kill(pid, signal),
    alive: isProcessAlive,
    commandOf,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    timeoutMs: 10_000,
  })
  const text = result.ok
    ? label('stop.done')
    : result.reason === 'not_stopped'
      ? label('stop.not_stopped', { pid: result.pid })
      : result.reason === 'not_permitted'
        ? label('stop.not_permitted', { pid: result.pid })
        : label(result.reason === 'not_managed' ? 'stop.not_managed' : 'stop.not_running')
  if (result.ok) {
    showState({ kind: 'stopped' })
    startRecovery()
  }
  await (parent ? dialog.showMessageBox(parent, { message: text }) : dialog.showMessageBox({ message: text }))
}

function openWindow(): void {
  window = createMainWindow(
    { origin: config.origin, preloadPath: join(here, 'preload.cjs') },
    { title: PRODUCT_NAME, hidden },
  )
  window.on('closed', () => {
    window = null
  })
  // The interface itself can fail after a good handshake (the service went away, the renderer crashed): say so
  // in the window and keep looking for the service instead of leaving a blank or broken page.
  window.webContents.on('did-fail-load', (_event, errorCode, _description, validatedURL, isMainFrame) => {
    // -3 aborted (a newer navigation), -20 blocked by our own filter: neither means the interface is lost.
    if (!isMainFrame || errorCode === -3 || errorCode === -20 || validatedURL.startsWith('data:')) return
    interfaceLost()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') interfaceLost()
  })
  void connect()
}

function interfaceLost(): void {
  if (handshakeRunning) return
  showState({ kind: 'load_failed' })
  startRecovery()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window === null) return openWindow()
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app.whenReady().then(() => {
    // Before the first window exists, so every webContents (popouts included) is covered.
    installGuards({ origin: config.origin, preloadPath: join(here, 'preload.cjs') })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        platform.menuTemplate({
          product: PRODUCT_NAME,
          label: (key) => label(key),
          reconnect: () => void connect(),
          stopService: () => void stopFromMenu().catch((error: unknown) => console.error('stop failed', error)),
          developerTools: !app.isPackaged,
        }),
      ),
    )
    openWindow()
  })

  // Closing windows or quitting never signals the service (it is a detached process of its own).
  app.on('window-all-closed', () => {
    if (platform.quitWhenAllWindowsClosed) app.quit()
  })
  app.on('activate', () => {
    if (platform.reopenOnActivate && BrowserWindow.getAllWindows().length === 0) openWindow()
  })
}
