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

export type NavigationKind = 'navigate' | 'redirect'
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

/** Permissions the renderer may hold. None today: voice (V1) grants the microphone deliberately. */
export function allowPermission(_permission: string): boolean {
  return false
}
