import { join, resolve } from 'node:path'

/**
 * Environment overrides for where the node listens and keeps its data. Parallel worktrees
 * (docs/plans/lanes) set them per lane so two servers never share a port or `~/.guanxi`.
 */
export type ListenEnv = Readonly<Record<string, string | undefined>>

export const API_PORT_ENV = 'GUANXI_API_PORT'
export const WEB_PORT_ENV = 'GUANXI_WEB_PORT'
export const DATA_DIR_ENV = 'GUANXI_DATA_DIR'
export const DEFAULT_WEB_PORT = 5173

/** Strict TCP port: digits only, 1–65535. Unset or empty means "use the fallback". */
export function portFromEnv(env: ListenEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const port = /^\d{1,5}$/u.test(raw) ? Number(raw) : Number.NaN
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`${name} must be a TCP port from 1 to 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

/** `GUANXI_API_PORT` wins; otherwise the legacy lenient `PORT`; otherwise the fallback. */
export function apiPortFromEnv(env: ListenEnv, fallback: number): number {
  const legacy = Number(env['PORT']) || fallback
  return portFromEnv(env, API_PORT_ENV, legacy)
}

export function dataDirFromEnv(env: ListenEnv): string {
  const override = env[DATA_DIR_ENV]
  if (override !== undefined && override !== '') return resolve(override)
  return join(env['HOME'] ?? '.', '.guanxi')
}

/** Origins of the Vite dev server, which `GUANXI_WEB_PORT` moves. */
export function devOriginsFromEnv(env: ListenEnv): string[] {
  const port = portFromEnv(env, WEB_PORT_ENV, DEFAULT_WEB_PORT)
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
}
