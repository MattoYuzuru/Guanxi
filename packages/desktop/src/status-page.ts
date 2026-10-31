import type { HandshakeFailure } from './service/handshake.ts'
import { API_PORT_ENV } from './config.ts'
import { translate } from './messages.ts'
import type { MessageKey, ShellLocale } from './messages.ts'

export type ShellState =
  | { kind: 'checking' }
  | { kind: 'starting' }
  | { kind: 'stopped' }
  | { kind: 'load_failed' }
  | { kind: 'failure'; failure: HandshakeFailure }
  | { kind: 'config_invalid'; variable: string; value: string }

export interface StatusContext {
  locale: ShellLocale
  product: string
  port: number
}

export interface StatusDescription {
  /** Stable machine id, also the `data-state` attribute (tests and accessibility tooling read it). */
  id: string
  severity: 'progress' | 'error'
  title: string
  body: string
  detail: string | null
  footer: string | null
}

export function describeState(state: ShellState, context: StatusContext): StatusDescription {
  const { locale, product, port } = context
  const t = (key: MessageKey, values: Record<string, string | number> = {}) =>
    translate(locale, key, { product, port, portVariable: API_PORT_ENV, ...values })
  const footer = t('status.footer')

  if (state.kind === 'checking') {
    return { id: 'checking', severity: 'progress', title: t('status.checking.title'), body: t('status.checking.body'), detail: null, footer: null }
  }
  if (state.kind === 'starting') {
    return { id: 'starting', severity: 'progress', title: t('status.starting.title'), body: t('status.starting.body'), detail: null, footer: null }
  }
  if (state.kind === 'stopped') {
    return { id: 'stopped', severity: 'progress', title: t('status.stopped.title'), body: t('status.stopped.body'), detail: null, footer: null }
  }
  if (state.kind === 'load_failed') {
    return { id: 'load_failed', severity: 'error', title: t('status.load_failed.title'), body: t('status.load_failed.body'), detail: null, footer }
  }
  if (state.kind === 'config_invalid') {
    return {
      id: 'config_invalid', severity: 'error', title: t('status.config_invalid.title'),
      body: t('status.config_invalid.body', { variable: state.variable, value: state.value }), detail: null, footer,
    }
  }
  const failure = state.failure
  switch (failure.code) {
    case 'service_missing':
      return {
        id: failure.code, severity: 'error', title: t('status.service_missing.title'),
        body: t('status.service_missing.body', { entry: failure.entry }),
        detail: failure.detail === undefined ? null : t('status.service_missing.detail', { detail: failure.detail }),
        footer,
      }
    case 'port_busy':
      return { id: failure.code, severity: 'error', title: t('status.port_busy.title'), body: t('status.port_busy.body'), detail: null, footer }
    case 'port_owned_by_other_user':
      return { id: failure.code, severity: 'error', title: t('status.port_owned_by_other_user.title'), body: t('status.port_owned_by_other_user.body'), detail: null, footer }
    case 'port_unverified':
      return { id: failure.code, severity: 'error', title: t('status.port_unverified.title'), body: t('status.port_unverified.body'), detail: null, footer }
    case 'health_timeout': {
      const variant = !failure.startedByShell ? 'attached' : failure.stopped ? 'started' : 'unstopped'
      const seconds = Math.max(1, Math.round(failure.timeoutMs / 1000))
      return {
        id: failure.code, severity: 'error', title: t(`status.health_timeout.${variant}.title`),
        body: t(`status.health_timeout.${variant}.body`, { seconds, pid: failure.pid ?? '' }), detail: null, footer,
      }
    }
    case 'service_exited':
      return {
        id: failure.code, severity: 'error', title: t('status.service_exited.title'),
        body: t('status.service_exited.body', { code: failure.exitCode ?? failure.signal ?? 'unknown', log: failure.logPath }),
        detail: null, footer,
      }
    case 'ui_missing':
      return { id: failure.code, severity: 'error', title: t('status.ui_missing.title'), body: t('status.ui_missing.body'), detail: null, footer }
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * A static page with no script and no remote reference: system colours follow light/dark, the CSP forbids
 * everything but inline style. Failure states have no button on purpose (D-203, no Retry button): the shell
 * re-checks on its own and offers Reconnect in the View menu.
 */
export function renderStatusPage(description: StatusDescription, locale: ShellLocale): string {
  const live = description.severity === 'error' ? 'role="alert"' : 'role="status" aria-live="polite"'
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(description.title)}</title>
<style>
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 34rem; padding: 2rem; }
h1 { font-size: 1.25rem; margin: 0 0 0.75rem; font-weight: 600; }
p { margin: 0 0 0.75rem; overflow-wrap: anywhere; }
.footer { opacity: 0.7; font-size: 0.875rem; }
</style>
</head>
<body>
<main ${live} data-state="${escapeHtml(description.id)}" data-severity="${description.severity}">
<h1>${escapeHtml(description.title)}</h1>
<p>${escapeHtml(description.body)}</p>
${description.detail === null ? '' : `<p>${escapeHtml(description.detail)}</p>\n`}${description.footer === null ? '' : `<p class="footer">${escapeHtml(description.footer)}</p>\n`}</main>
</body>
</html>
`
}

export function statusPageUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
