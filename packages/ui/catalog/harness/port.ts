// The catalog harness and the browser gates use the lane's web port. Same strict parsing as
// packages/web/dev-ports.ts: digits only, 1–65535; unset or empty means the default.
export function harnessPort(env: Readonly<Record<string, string | undefined>>, fallback = 5173): number {
  const raw = env['GUANXI_WEB_PORT']
  if (raw === undefined || raw === '') return fallback
  const port = /^\d{1,5}$/u.test(raw) ? Number(raw) : Number.NaN
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`GUANXI_WEB_PORT must be a TCP port from 1 to 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}
