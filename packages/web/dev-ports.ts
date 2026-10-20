// Ports of the Vite dev server and the browser gate. Parallel worktrees (docs/plans/lanes)
// set them per lane; the defaults match a single checkout. Keep the parsing in step with
// packages/server/src/config/listen-env.ts.

type Env = Readonly<Record<string, string | undefined>>

export const DEFAULT_WEB_PORT = 5173
export const DEFAULT_API_PORT = 4310

/** Strict TCP port: digits only, 1–65535. Unset or empty means "use the fallback". */
export function portFromEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const port = /^\d{1,5}$/u.test(raw) ? Number(raw) : Number.NaN
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`${name} must be a TCP port from 1 to 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

export const webPortFromEnv = (env: Env): number =>
  portFromEnv(env, 'GUANXI_WEB_PORT', DEFAULT_WEB_PORT)

export const apiPortFromEnv = (env: Env): number =>
  portFromEnv(env, 'GUANXI_API_PORT', DEFAULT_API_PORT)
