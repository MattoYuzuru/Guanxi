import { BrowserWindow, app, ipcMain, session, shell } from 'electron'
import type { Session, WebContents } from 'electron'
import { createExternalOpener } from './external-open.ts'
import type { ExternalOpener } from './external-open.ts'
import { INFO_CHANNEL } from './ipc.ts'
import type { DesktopInfo } from './ipc.ts'
import {
  SECURE_WEB_PREFERENCES,
  allowPermission,
  allowRequest,
  contentSecurityPolicy,
  decideNavigation,
  decideWindowOpen,
  isSameOrigin,
} from './security.ts'

export interface WindowSecurity {
  origin: string
  preloadPath: string
}

/** Input that counts as the user acting (a click, a key, a touch); scripted events never reach this hook. */
const USER_INPUT = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'touchEnd', 'gestureTap'])

function secureWindowPreferences(security: WindowSecurity) {
  return { ...SECURE_WEB_PREFERENCES, preload: security.preloadPath }
}

/** Applies the navigation lock to one webContents (windows, popouts and every frame inside them). */
function lockNavigation(contents: WebContents, security: WindowSecurity, opener: ExternalOpener): void {
  contents.on('input-event', (_event, input) => {
    if (USER_INPUT.has(input.type)) opener.noteUserInput()
  })
  // Main frame: a navigation the user started may go to the system browser. The window stays where it is.
  contents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, security.origin, 'navigate')
    if (decision.action === 'allow') return
    event.preventDefault()
    if (decision.action === 'external') opener.request(decision.url)
  })
  contents.on('will-redirect', (event, url) => {
    if (decideNavigation(url, security.origin, 'redirect').action !== 'allow') event.preventDefault()
  })
  // Subframes never reach the system browser: a frame the page embeds is not the user's click.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (decideNavigation(event.url, security.origin, 'subframe').action !== 'allow') event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, security.origin)
    if (decision.action === 'child') {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: secureWindowPreferences(security) } }
    }
    if (decision.action === 'external') opener.request(decision.url)
    return { action: 'deny' }
  })
}

/** Session-level policy: no remote requests, a CSP on the service's documents, a short permission list. */
export function lockSession(target: Session, origin: string): void {
  target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] },
    (details, callback) => callback({ cancel: !allowRequest(details.url, origin) }),
  )
  // Defense in depth beside the request filter: the node's own pages may load and connect to themselves only.
  const policy = contentSecurityPolicy(origin)
  target.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) }
    const existing = Object.keys(responseHeaders).find((name) => name.toLowerCase() === 'content-security-policy')
    // Several policies intersect, so ours can only narrow what the node already sends.
    responseHeaders['Content-Security-Policy'] = [...(existing ? responseHeaders[existing] ?? [] : []), policy]
    if (existing && existing !== 'Content-Security-Policy') delete responseHeaders[existing]
    callback({ responseHeaders })
  })
  target.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowPermission({ permission, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame }, origin)),
  )
  target.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    allowPermission({ permission, requestingUrl: details.requestingUrl ?? requestingOrigin, isMainFrame: details.isMainFrame ?? false }, origin),
  )
  target.setDevicePermissionHandler(() => false)
}

/** Install once, before the first window exists, so every webContents (including popouts) is covered. */
export function installGuards(security: WindowSecurity): void {
  const opener = createExternalOpener({ open: (url) => void shell.openExternal(url), now: () => Date.now() })
  app.on('web-contents-created', (_event, contents) => lockNavigation(contents, security, opener))
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
