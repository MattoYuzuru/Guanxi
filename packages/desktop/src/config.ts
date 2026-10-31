import { join, resolve } from 'node:path'
import { envName } from './env.ts'

/** The node's own variables (packages/server/src/config/listen-env.ts); the shell never invents another port knob. */
export const API_PORT_ENV = envName('API_PORT')
export const DATA_DIR_ENV = envName('DATA_DIR')
export const HEALTH_TIMEOUT_ENV = envName('DESKTOP_HEALTH_TIMEOUT_MS')
export const PROBE_TIMEOUT_ENV = envName('DESKTOP_PROBE_TIMEOUT_MS')
export const POLL_INTERVAL_ENV = envName('DESKTOP_POLL_INTERVAL_MS')
export const DEFAULT_API_PORT = 4310
/** Loopback only (AGENTS.md): the shell has no setting that points the window at another host. */
export const SERVICE_HOST = '127.0.0.1'

export interface DesktopConfig {
  host: typeof SERVICE_HOST
  port: number
  /** `http://127.0.0.1:<port>`, the only origin the renderer may show. */
  origin: string
  dataDir: string
  /** Total time the handshake waits for a service it started. */
  healthTimeoutMs: number
  /** Timeout of one probe request. */
  probeTimeoutMs: number
  pollIntervalMs: number
}

export class ConfigError extends Error {
  readonly variable: string
  readonly value: string
  constructor(variable: string, value: string) {
    super(`${variable} is invalid`)
    this.name = 'ConfigError'
    this.variable = variable
    this.value = value
  }
}

/** Digits only, 1-65535; a zero or malformed port would make the "single origin" ambiguous. */
function parsePort(variable: string, raw: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new ConfigError(variable, raw)
  const port = Number(raw)
  if (port < 1 || port > 65_535) throw new ConfigError(variable, raw)
  return port
}

function parsePositiveMs(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  if (!/^\d{1,7}$/.test(raw) || Number(raw) < 1) throw new ConfigError(variable, raw)
  return Number(raw)
}

export function resolveConfig(
  env: Record<string, string | undefined>,
  home: string,
): DesktopConfig {
  const rawPort = env[API_PORT_ENV]
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_API_PORT : parsePort(API_PORT_ENV, rawPort)
  const override = env[DATA_DIR_ENV]
  const dataDir = override !== undefined && override !== '' ? resolve(override) : join(home, '.guanxi')
  return {
    host: SERVICE_HOST,
    port,
    origin: `http://${SERVICE_HOST}:${port}`,
    dataDir,
    healthTimeoutMs: parsePositiveMs(HEALTH_TIMEOUT_ENV, env[HEALTH_TIMEOUT_ENV], 30_000),
    probeTimeoutMs: parsePositiveMs(PROBE_TIMEOUT_ENV, env[PROBE_TIMEOUT_ENV], 5_000),
    pollIntervalMs: parsePositiveMs(POLL_INTERVAL_ENV, env[POLL_INTERVAL_ENV], 250),
  }
}
