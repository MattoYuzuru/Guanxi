import { delimiter, join } from 'node:path'
import { SERVICE_HOST } from '../config.ts'
import { DESKTOP_ENV_PREFIX, envName } from '../env.ts'

export interface ServiceCommand {
  /** A real Node.js executable. Never the Electron binary: the service forks `process.execPath` children. */
  command: string
  args: string[]
  env: Record<string, string>
  /** The CLI entry that the command runs; shown in diagnostics and matched against `ps` before a stop. */
  entry: string
}

export class ServiceMissingError extends Error {
  /** The file (or the program name) that could not be found. */
  readonly entry: string
  constructor(entry: string) {
    super(`service file not found: ${entry}`)
    this.name = 'ServiceMissingError'
    this.entry = entry
  }
}

export interface LocateInput {
  packaged: boolean
  /** `process.resourcesPath` of the installed app. */
  resourcesPath: string
  /** Checkout root, used only when the app is not packaged. */
  repoRoot: string
  env: Record<string, string | undefined>
  port: number
  dataDir: string
  exists: (path: string) => boolean
  isExecutable: (path: string) => boolean
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
    // Electron's own switches (ELECTRON_RUN_AS_NODE included) and the shell's settings stop here: the service
    // starts the user's tools with this environment.
    if (key.startsWith('ELECTRON_') || key.startsWith(DESKTOP_ENV_PREFIX)) continue
    clean[key] = value
  }
  clean[envName('API_PORT')] = String(port)
  clean[envName('DATA_DIR')] = dataDir
  return clean
}

export function resolveOnPath(name: string, pathEnv: string | undefined, isExecutable: (path: string) => boolean): string | null {
  for (const directory of (pathEnv ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * The service is the CLI entry, started as the CLI is started by hand (`--port --data-dir --no-open`), by a
 * real Node.js.
 *
 * - Packaged: `Resources/service/node/bin/node` (the pinned official Node staged by scripts/stage-service.mjs)
 *   running `Resources/service/bin.js`. The service forks and spawns `process.execPath` for its sandbox,
 *   index and storage helpers, so that must be a Node, not the Electron binary; this is also what lets the
 *   `RunAsNode` fuse stay off.
 * - Checkout: the `node` on PATH running `packages/cli/src/bin.ts`, as `npm start` does.
 *
 * `<PREFIX>_DESKTOP_SERVICE_ENTRY` and `<PREFIX>_DESKTOP_NODE` redirect the entry and the Node only for an
 * unpackaged app, so an installed app cannot be pointed elsewhere by its environment.
 */
export function locateService(input: LocateInput): ServiceCommand {
  const override = (suffix: string) => (input.packaged ? undefined : input.env[envName(`DESKTOP_${suffix}`)] || undefined)
  const entry =
    override('SERVICE_ENTRY') ??
    (input.packaged ? join(input.resourcesPath, 'service', 'bin.js') : join(input.repoRoot, 'packages', 'cli', 'src', 'bin.ts'))
  if (!input.exists(entry)) throw new ServiceMissingError(entry)

  let node: string
  if (input.packaged) {
    node = join(input.resourcesPath, 'service', 'node', 'bin', 'node')
    if (!input.isExecutable(node)) throw new ServiceMissingError(node)
  } else {
    const chosen = override('NODE') ?? resolveOnPath('node', input.env['PATH'], input.isExecutable)
    if (chosen === null || chosen === undefined || !input.isExecutable(chosen)) throw new ServiceMissingError(chosen ?? 'node (not on PATH)')
    node = chosen
  }
  return {
    command: node,
    args: [entry, '--port', String(input.port), '--host', SERVICE_HOST, '--data-dir', input.dataDir, '--no-open'],
    env: serviceEnvironment(input.env, input.port, input.dataDir),
    entry,
  }
}
