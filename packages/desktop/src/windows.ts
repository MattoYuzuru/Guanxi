import { BrowserWindow, app, ipcMain, session, shell } from 'electron'
import type { Session, WebContents } from 'electron'
import { INFO_CHANNEL } from './ipc.ts'
import type { DesktopInfo } from './ipc.ts'
import {
  SECURE_WEB_PREFERENCES,
  allowPermission,
  allowRequest,
  decideNavigation,
  decideWindowOpen,
  isSameOrigin,
} from './security.ts'

export interface WindowSecurity {
  origin: string
  preloadPath: string
}

/** Hands a URL to the system browser. Looked up on `shell` at call time so tests can observe it. */
function openExternal(url: string): void {
  void shell.openExternal(url)
}

function secureWindowPreferences(security: WindowSecurity) {
  return { ...SECURE_WEB_PREFERENCES, preload: security.preloadPath }
}

/** Applies the navigation lock to one webContents (windows, popouts and every frame inside them). */
function lockNavigation(contents: WebContents, security: WindowSecurity): void {
  const guard = (event: { preventDefault(): void }, url: string, kind: 'navigate' | 'redirect') => {
    const decision = decideNavigation(url, security.origin, kind)
    if (decision.action === 'allow') return
    event.preventDefault()
    if (decision.action === 'external') openExternal(decision.url)
  }
  contents.on('will-navigate', (event, url) => guard(event, url, 'navigate'))
  contents.on('will-redirect', (event, url) => guard(event, url, 'redirect'))
  contents.on('will-frame-navigate', (event) => guard(event, event.url, 'navigate'))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, security.origin)
    if (decision.action === 'child') {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: secureWindowPreferences(security) } }
    }
    if (decision.action === 'external') openExternal(decision.url)
    return { action: 'deny' }
  })
}

/** Session-level policy: no remote requests, no permission grants. */
export function lockSession(target: Session, origin: string): void {
  target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] },
    (details, callback) => callback({ cancel: !allowRequest(details.url, origin) }),
  )
  target.setPermissionRequestHandler((_contents, permission, callback) => callback(allowPermission(permission)))
  target.setPermissionCheckHandler((_contents, permission) => allowPermission(permission))
  target.setDevicePermissionHandler(() => false)
}

/** Install once, before the first window exists, so every webContents (including popouts) is covered. */
export function installGuards(security: WindowSecurity): void {
  app.on('web-contents-created', (_event, contents) => lockNavigation(contents, security))
  lockSession(session.defaultSession, security.origin)
  ipcMain.handle(INFO_CHANNEL, (event): DesktopInfo | null => {
    // Only the service's own pages may ask; the shell's status page and foreign frames get nothing.
    if (!isSameOrigin(event.senderFrame?.url ?? '', security.origin)) return null
    return { shell: 'electron', platform: process.platform, shellVersion: app.getVersion() }
  })
}

export interface MainWindowOptions {
  title: string
  hidden: boolean
}

export function createMainWindow(security: WindowSecurity, options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 640,
    minHeight: 480,
    title: options.title,
    show: false,
    webPreferences: secureWindowPreferences(security),
  })
  if (!options.hidden) window.once('ready-to-show', () => window.show())
  return window
}
