/**
 * Renderer security policy as pure data and pure decisions, so it can be tested without Electron.
 * Electron applies it in windows.ts; the decisions are the only place that names an allowed origin.
 */

/** The only webPreferences the shell ever gives a window (child windows included). The preload path is added by the caller. */
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  allowRunningInsecureContent: false,
  safeDialogs: true,
})

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function isSameOrigin(url: string, origin: string): boolean {
  return parse(url)?.origin === origin
}

/** Schemes the shell hands to the system. Everything else (file:, javascript:, custom schemes) is dropped. */
export function isExternallyOpenable(url: string): boolean {
  const parsed = parse(url)
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:')
}

/** `subframe`: a frame inside the window; like `redirect` it is never handed to the system browser. */
export type NavigationKind = 'navigate' | 'redirect' | 'subframe'
export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'deny' }
  /** Block in the window; open in the system browser (only for a navigation the user started). */
  | { action: 'external'; url: string }

/** `will-navigate`, `will-redirect` and `will-frame-navigate`: stay on the service origin. */
export function decideNavigation(url: string, origin: string, kind: NavigationKind = 'navigate'): NavigationDecision {
  if (isSameOrigin(url, origin)) return { action: 'allow' }
  if (kind === 'navigate' && isExternallyOpenable(url)) return { action: 'external', url }
  return { action: 'deny' }
}

export type WindowOpenDecision =
  /** Same-origin popout (the workspace popout window): a child window with the hardened preferences. */
  | { action: 'child' }
  | { action: 'external'; url: string }
  | { action: 'deny' }

/** `window.open` and `target=_blank`: never an arbitrary window. */
export function decideWindowOpen(url: string, origin: string): WindowOpenDecision {
  if (isSameOrigin(url, origin)) return { action: 'child' }
  if (isExternallyOpenable(url)) return { action: 'external', url }
  return { action: 'deny' }
}

/**
 * Network requests of the renderer. The window shows the node's origin and local data only: remote
 * images, fonts, scripts and sockets (for example from model output rendered as markdown) are cancelled,
 * so a page cannot phone home or load remote code. The system browser handles anything remote.
 */
export function allowRequest(url: string, origin: string): boolean {
  const parsed = parse(url)
  if (parsed === null) return false
  if (parsed.origin === origin) return true
  const host = new URL(origin).host
  if ((parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && parsed.host === host) return true
  return parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'devtools:'
}

export interface PermissionRequest {
  permission: string
  /** The URL (or origin) of the frame that asks. */
  requestingUrl: string
  isMainFrame: boolean
}

/**
 * Permissions the renderer may hold, decided per request. Allowed, for the top frame of the service origin only:
 * - `clipboard-sanitized-write`: every copy button in the UI (`navigator.clipboard.writeText`) needs it;
 *   it only ever writes plain text on a user gesture. `clipboard-read` stays denied.
 * - `fullscreen`: the UI may present a pane full screen; it exposes nothing.
 * Denied on purpose: `notifications` (the notification center, NC1, owns OS delivery through the shell, not
 * through the Web Notification API), `media` (voice, V1, will grant the microphone deliberately), geolocation,
 * midi, hid, usb, serial and everything else.
 */
export function allowPermission(request: PermissionRequest, origin: string): boolean {
  if (request.permission !== 'clipboard-sanitized-write' && request.permission !== 'fullscreen') return false
  return request.isMainFrame && isSameOrigin(request.requestingUrl, origin)
}

/**
 * The CSP added to every response of the service origin. It is defense in depth beside the request filter:
 * the node's pages may load from and connect to the node only. Inline script and style stay allowed because
 * the built `index.html` carries an inline theme bootstrap and the UI sets inline styles; tightening that
 * needs a nonce or hash from the web build (residual, see the hand-off).
 */
export function contentSecurityPolicy(origin: string): string {
  const socket = origin.replace(/^http/, 'ws')
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ')
}
