import { join } from 'node:path'
import { SERVICE_HOST } from '../config.ts'

export interface ServiceCommand {
  command: string
  args: string[]
  env: Record<string, string>
  /** The CLI entry that the command runs; shown in diagnostics. */
  entry: string
}

export class ServiceMissingError extends Error {
  readonly entry: string
  constructor(entry: string) {
    super(`service entry not found: ${entry}`)
    this.name = 'ServiceMissingError'
    this.entry = entry
  }
}

export interface LocateInput {
  packaged: boolean
  /** `process.resourcesPath` of the installed app. */
  resourcesPath: string
  /** The Electron executable; it runs as plain Node through `ELECTRON_RUN_AS_NODE`. */
  execPath: string
  /** Checkout root, used only when the app is not packaged. */
  repoRoot: string
  env: Record<string, string | undefined>
  port: number
  dataDir: string
  exists: (path: string) => boolean
}

/** Variables the child must not inherit: they would move its listener, or load code into it. */
const DROPPED = new Set(['NODE_OPTIONS', 'HOST', 'PORT', 'NODE_ENV'])

export function serviceEnvironment(
  env: Record<string, string | undefined>,
  port: number,
  dataDir: string,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.has(key)) continue
    if (key.startsWith('ELECTRON_') || key.startsWith('GUANXI_DESKTOP_')) continue
    clean[key] = value
  }
  clean['ELECTRON_RUN_AS_NODE'] = '1'
  clean['GUANXI_API_PORT'] = String(port)
  clean['GUANXI_DATA_DIR'] = dataDir
  return clean
}

/**
 * The service is the CLI entry, started as the CLI is started by hand (`--port --data-dir --no-open`).
 * Packaged: `Resources/service/bin.js` (staged by scripts/stage-service.mjs). Checkout: the TypeScript
 * entry, which Electron's bundled Node runs natively. `GUANXI_DESKTOP_SERVICE_ENTRY` redirects the
 * entry only for an unpackaged app, so an installed app cannot be pointed elsewhere by its environment.
 */
export function locateService(input: LocateInput): ServiceCommand {
  const override = input.packaged ? undefined : input.env['GUANXI_DESKTOP_SERVICE_ENTRY']
  const entry =
    override !== undefined && override !== ''
      ? override
      : input.packaged
        ? join(input.resourcesPath, 'service', 'bin.js')
        : join(input.repoRoot, 'packages', 'cli', 'src', 'bin.ts')
  if (!input.exists(entry)) throw new ServiceMissingError(entry)
  return {
    command: input.execPath,
    args: [entry, '--port', String(input.port), '--host', SERVICE_HOST, '--data-dir', input.dataDir, '--no-open'],
    env: serviceEnvironment(input.env, input.port, input.dataDir),
    entry,
  }
}
