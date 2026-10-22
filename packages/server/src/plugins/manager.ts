/**
 * T1 plugin manager core (ADR-0022 §7; ROADMAP P1). A local directory is the
 * only supported source in this slice: inspect validates and hashes it, install
 * copies it transactionally into `<pluginsDir>/<id>@<version>/`, and the enabled
 * set plus exact versions and integrity live in two JSON files.
 *
 * T0 is core-only and T2 needs the later out-of-process sandbox. Build scripts
 * are never executed here; an explicit approval is only recorded in the lock.
 */
import { randomBytes } from 'node:crypto'
import { constants, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  KERNEL_API_VERSION,
  readPackageManifest,
  satisfiesEngine,
  type GuanxiManifest,
} from '@guanxi/kernel'
import {
  computeDirectoryIntegrity,
  computeDirectoryIntegritySync,
  SourceIntegrityError,
} from './integrity.ts'

export { SourceIntegrityError } from './integrity.ts'

export const BUILD_SCRIPT_NAMES = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** Fault points reachable during a successful install, in call order. */
export const INSTALL_FAULT_POINTS = [
  'install:start',
  'install:inspected',
  'install:engine',
  'install:state-read',
  'install:peer',
  'install:build-scripts',
  'install:trust',
  'install:expected-integrity',
  'install:staging-created',
  'install:copied',
  'install:staged-integrity',
  'install:metadata-planned',
  'install:before-plugin-rename',
  'install:plugin-renamed',
  'install:manifest-temp',
  'install:manifest-renamed',
  'install:lock-temp',
  'install:lock-renamed',
  'install:before-previous-remove',
  'install:committed',
] as const

export const UNINSTALL_FAULT_POINTS = [
  'uninstall:start',
  'uninstall:state-read',
  'uninstall:backup',
  'uninstall:manifest-temp',
  'uninstall:manifest-renamed',
  'uninstall:lock-temp',
  'uninstall:lock-renamed',
  'uninstall:committed',
] as const

export const SET_ENABLED_FAULT_POINTS = [
  'set-enabled:start',
  'set-enabled:state-read',
  'set-enabled:manifest-temp',
  'set-enabled:manifest-renamed',
  'set-enabled:committed',
] as const

/** The primary enumeration used by install rollback tests. */
export const FAULT_POINTS = INSTALL_FAULT_POINTS

export type InstallFaultPoint = (typeof INSTALL_FAULT_POINTS)[number]
export type UninstallFaultPoint = (typeof UNINSTALL_FAULT_POINTS)[number]
export type SetEnabledFaultPoint = (typeof SET_ENABLED_FAULT_POINTS)[number]
export type PluginFaultPoint = InstallFaultPoint | UninstallFaultPoint | SetEnabledFaultPoint

export interface PluginManagerHooks {
  /** Throw or reject to exercise rollback at a named step. */
  point(name: PluginFaultPoint): void | Promise<void>
}

export type PluginManagerErrorCode =
  | 'engine_mismatch'
  | 'peer_missing'
  | 'build_scripts_unapproved'
  | 'trust_tier_unsupported'
  | 'integrity_mismatch'
  | 'invalid_package_json'
  | 'invalid_plugin_version'
  | 'invalid_state'
  | 'plugin_not_installed'
  | 'plugin_directory_exists'
  | 'version_exists'
  | 'invalid_arguments'

export interface PluginManagerErrorDetails {
  readonly pluginId?: string
  readonly missing?: readonly string[]
  readonly buildScripts?: readonly string[]
  readonly expected?: string
  readonly actual?: string
}

export class PluginManagerError extends Error {
  readonly code: PluginManagerErrorCode
  readonly details: PluginManagerErrorDetails

  constructor(code: PluginManagerErrorCode, message: string, details: PluginManagerErrorDetails = {}) {
    super(message)
    this.name = 'PluginManagerError'
    this.code = code
    this.details = details
  }
}

/**
 * Thrown by a fault-injection hook to model a process kill: the manager
 * propagates it without running rollback so a test can build a fresh manager
 * and exercise `recover()`.
 */
export class SimulatedCrash extends Error {
  readonly simulatedCrash = true

  constructor(point: string) {
    super(`simulated crash at ${point}`)
    this.name = 'SimulatedCrash'
  }
}

export interface BootSkip {
  readonly id: string
  readonly directory: string
  readonly reason: 'missing_directory' | 'integrity_mismatch'
  readonly expectedIntegrity: string
  /** Null when the directory is missing. */
  readonly actualIntegrity: string | null
}

export interface RecoveryReport {
  /** True when a `.staging` directory was removed. */
  readonly removedStaging: boolean
  /** Unreferenced `<id>@<version>` directory names, sorted. */
  readonly removedDirectories: readonly string[]
  /** Stale state temporary files removed from `pluginsDir`, sorted. */
  readonly removedTemporaryFiles: readonly string[]
}

export interface PluginManagerOptions {
  /** Directory that holds installed plugin directories and the two state files. */
  readonly pluginsDir: string
  /** Version that `engines.guanxi` ranges are checked against. */
  readonly kernelApiVersion?: string
  /** Services provided by plugins already loaded outside this manager. */
  readonly loaded: () => { readonly provides: readonly string[] }
  /** Injectable time source for the lock's `installedAt`. */
  readonly clock?: () => Date
  readonly hooks?: PluginManagerHooks
}

export interface InspectResult {
  readonly manifest: GuanxiManifest
  readonly integrity: string
  readonly buildScripts: string[]
  readonly license: string | null
}

export interface InstalledPlugin {
  readonly id: string
  readonly version: string
  readonly integrity: string
  readonly enabled: boolean
  /** Absolute installed directory. */
  readonly path: string
  /** Relative directory name inside `pluginsDir`. */
  readonly directory: string
  readonly requires: string[]
  readonly provides: string[]
  readonly buildScripts: string[]
  readonly buildScriptsApproved: boolean
  readonly installedAt: string | null
}

export interface InstallOptions {
  readonly approveBuildScripts?: boolean
  readonly expectedIntegrity?: string
}

export interface BootSetOptions {
  readonly safeMode?: boolean
  /** Reports an enabled entry whose directory is missing or fails its integrity check. */
  readonly onSkip?: (skip: BootSkip) => void
}

interface InspectedPlugin extends InspectResult {
  readonly version: string
  readonly packageJson: Record<string, unknown>
}

interface LockedPlugin {
  readonly id: string
  readonly version: string
  readonly integrity: string
  readonly directory: string
  readonly requires: readonly string[]
  readonly provides: readonly string[]
  readonly buildScripts: readonly string[]
  readonly buildScriptsApproved: boolean
  readonly installedAt: string | null
  /** False for a hand-written or older lock entry whose `provides` is unknown. */
  readonly providesKnown: boolean
}

interface StateSnapshot {
  /** Exact bytes, or null when the file did not exist. */
  readonly plugins: Buffer | null
  readonly lock: Buffer | null
}

interface ManagerState {
  readonly enabled: Set<string>
  readonly plugins: Map<string, LockedPlugin>
  readonly snapshot: StateSnapshot
}

interface InstallRollbackContext {
  readonly snapshot: StateSnapshot | undefined
  readonly stagingDir: string | null
  readonly target: string | null
  readonly targetCreated: boolean
  readonly pluginsDirCreated: boolean
  readonly stagingRootCreated: boolean
}

const PLUGIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PLUGIN_DIRECTORY_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+@[^@/\\]+$/
const STATE_TEMPORARY_NAME = /^\.plugins(?:\.lock)?\.json\.[0-9a-f]+\.tmp$/
const EMPTY_RECOVERY: RecoveryReport = {
  removedStaging: false,
  removedDirectories: [],
  removedTemporaryFiles: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSimulatedCrash(error: unknown): error is SimulatedCrash {
  return error instanceof SimulatedCrash || (isRecord(error) && error['simulatedCrash'] === true)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new PluginManagerError('invalid_state', `${path}: invalid JSON (${String(error)})`)
  }
}

function parsePluginsFile(text: string, path: string): Set<string> {
  const parsed = parseJson(text, path)
  const enabled = new Set<string>()
  const add = (value: unknown, fallback: boolean): void => {
    if (typeof value === 'string') {
      enabled.add(value)
      return
    }
    if (!isRecord(value)) throw new PluginManagerError('invalid_state', `${path}: invalid plugin entry`)
    const id = value['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw new PluginManagerError('invalid_state', `${path}: a plugin entry has no id`)
    }
    if (value['enabled'] !== false && fallback) enabled.add(id)
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) add(entry, true)
    return enabled
  }
  if (!isRecord(parsed)) throw new PluginManagerError('invalid_state', `${path}: must be a JSON object`)
  const list = parsed['enabled']
  if (Array.isArray(list)) {
    for (const entry of list) add(entry, true)
    return enabled
  }
  if (isRecord(list)) {
    for (const [id, value] of Object.entries(list)) {
      if (value !== false) enabled.add(id)
    }
    return enabled
  }
  const plugins = parsed['plugins']
  if (Array.isArray(plugins)) {
    for (const entry of plugins) add(entry, true)
    return enabled
  }
  if (isRecord(plugins)) {
    for (const [id, value] of Object.entries(plugins)) {
      if (typeof value === 'boolean') {
        if (value) enabled.add(id)
      } else if (isRecord(value)) {
        if (value['enabled'] !== false) enabled.add(id)
      } else if (typeof value === 'string') {
        enabled.add(id)
      } else {
        throw new PluginManagerError('invalid_state', `${path}.plugins.${id}: invalid entry`)
      }
    }
    return enabled
  }
  // Tolerate an older direct `{ id: true | { enabled } }` map.
  for (const [id, value] of Object.entries(parsed)) {
    if (id === 'version' || id === 'schemaVersion') continue
    if (value === true) enabled.add(id)
    else if (value === false) continue
    else if (isRecord(value) && value['enabled'] !== false) enabled.add(id)
  }
  return enabled
}

function lockedPlugin(id: string, value: unknown, path: string): LockedPlugin {
  if (!isRecord(value)) throw new PluginManagerError('invalid_state', `${path}: invalid lock entry for "${id}"`)
  const version = value['version']
  const integrity = value['integrity'] ?? value['checksum']
  if (typeof version !== 'string' || version.length === 0) {
    throw new PluginManagerError('invalid_state', `${path}: lock entry "${id}" has no version`)
  }
  if (typeof integrity !== 'string' || !integrity.startsWith('sha256-')) {
    throw new PluginManagerError('invalid_state', `${path}: lock entry "${id}" has no sha256- integrity`)
  }
  const directory = typeof value['directory'] === 'string' ? value['directory'] : `${id}@${version}`
  if (directory.length === 0 || directory.includes('/') || directory.includes('\\') || directory === '.' || directory === '..') {
    throw new PluginManagerError('invalid_state', `${path}: lock entry "${id}" has an unsafe directory`)
  }
  const installedAt = typeof value['installedAt'] === 'string' ? value['installedAt'] : null
  return {
    id,
    version,
    integrity,
    directory,
    requires: stringArray(value['requires']),
    provides: stringArray(value['provides']),
    buildScripts: stringArray(value['buildScripts']),
    buildScriptsApproved: value['buildScriptsApproved'] === true,
    installedAt,
    providesKnown: Object.prototype.hasOwnProperty.call(value, 'provides'),
  }
}

function parseLockFile(text: string, path: string): Map<string, LockedPlugin> {
  const parsed = parseJson(text, path)
  if (!isRecord(parsed)) throw new PluginManagerError('invalid_state', `${path}: must be a JSON object`)
  const source = parsed['plugins'] ?? parsed['packages'] ?? parsed['locked']
  const plugins = new Map<string, LockedPlugin>()
  const add = (id: string, value: unknown): void => {
    if (plugins.has(id)) throw new PluginManagerError('invalid_state', `${path}: duplicate lock entry "${id}"`)
    plugins.set(id, lockedPlugin(id, value, path))
  }
  if (source === undefined) {
    // Tolerate an older direct `{ id: { version, integrity } }` map.
    for (const [id, entry] of Object.entries(parsed)) {
      if (id === 'version' || id === 'schemaVersion') continue
      if (isRecord(entry) && typeof entry['version'] === 'string') add(id, entry)
    }
    return plugins
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || entry['id'].length === 0) {
        throw new PluginManagerError('invalid_state', `${path}: a lock entry has no id`)
      }
      add(entry['id'], entry)
    }
  } else if (isRecord(source)) {
    for (const [id, entry] of Object.entries(source)) add(id, entry)
  } else {
    throw new PluginManagerError('invalid_state', `${path}: plugins must be an array or an object`)
  }
  return plugins
}

function licenseOf(packageJson: Record<string, unknown>): string | null {
  const license = packageJson['license']
  if (typeof license === 'string') return license
  if (isRecord(license) && typeof license['type'] === 'string') return license['type']
  return null
}

function buildScriptsOf(packageJson: Record<string, unknown>): string[] {
  const scripts = packageJson['scripts']
  if (!isRecord(scripts)) return []
  return BUILD_SCRIPT_NAMES.filter(name => Object.prototype.hasOwnProperty.call(scripts, name))
}

function parsePackageJson(text: string, path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new PluginManagerError('invalid_package_json', `${path}: invalid JSON (${String(error)})`)
  }
  if (!isRecord(parsed)) throw new PluginManagerError('invalid_package_json', `${path}: must be a JSON object`)
  return parsed
}

function pluginVersion(packageJson: Record<string, unknown>, path: string): string {
  const version = packageJson['version']
  if (typeof version !== 'string' || !PLUGIN_VERSION.test(version)) {
    throw new PluginManagerError(
      'invalid_plugin_version',
      `${path}: package.json version must be a safe release or pre-release version such as "1.2.3"`,
    )
  }
  return version
}

async function inspectPluginSource(sourceDir: string): Promise<InspectedPlugin> {
  if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
    throw new PluginManagerError('invalid_arguments', 'inspect() needs a source directory')
  }
  const root = resolve(sourceDir)
  const integrity = await computeDirectoryIntegrity(root)
  const packagePath = join(root, 'package.json')
  let text: string
  try {
    text = await readFile(packagePath, 'utf8')
  } catch (error) {
    throw new PluginManagerError(
      'invalid_package_json',
      `${packagePath}: cannot read package.json (${String(error)})`,
    )
  }
  const packageJson = parsePackageJson(text, packagePath)
  const manifest = readPackageManifest(packageJson)
  return {
    manifest,
    integrity,
    buildScripts: buildScriptsOf(packageJson),
    license: licenseOf(packageJson),
    version: typeof packageJson['version'] === 'string' ? packageJson['version'] : '',
    packageJson,
  }
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}


function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/** Accept our hex form and the SRI base64 form for the same SHA-256 digest. */
function sameIntegrity(expected: string, actual: string): boolean {
  if (expected === actual) return true
  if (!actual.startsWith('sha256-')) return false
  const actualHex = actual.slice('sha256-'.length)
  if (!/^[0-9a-f]{64}$/.test(actualHex)) return false
  const expectedBody = expected.startsWith('sha256-')
    ? expected.slice('sha256-'.length)
    : expected.startsWith('sha256:')
      ? expected.slice('sha256:'.length)
      : null
  if (expectedBody === null) return false
  if (/^[0-9a-f]{64}$/.test(expectedBody)) return expectedBody === actualHex
  const decoded = Buffer.from(expectedBody, 'base64')
  return decoded.length === 32 && decoded.toString('hex') === actualHex
}

function serializePlugins(enabled: ReadonlySet<string>): string {
  return `${JSON.stringify({ version: 1, enabled: [...enabled].sort(compareIds) }, null, 2)}\n`
}

function serializeLock(plugins: ReadonlyMap<string, LockedPlugin>): string {
  const locked: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const id of [...plugins.keys()].sort(compareIds)) {
    const entry = plugins.get(id)!
    locked[id] = {
      version: entry.version,
      integrity: entry.integrity,
      directory: entry.directory,
      requires: [...entry.requires],
      provides: [...entry.provides],
      buildScripts: [...entry.buildScripts],
      buildScriptsApproved: entry.buildScriptsApproved,
      installedAt: entry.installedAt,
    }
  }
  return `${JSON.stringify({ version: 1, plugins: locked }, null, 2)}\n`
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, data: Buffer): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, null)
    if (bytesWritten <= 0) throw new Error('short write while copying a plugin file')
    offset += bytesWritten
  }
}

async function copyRegularFile(source: string, destination: string, mode: number): Promise<void> {
  let from: Awaited<ReturnType<typeof open>> | undefined
  let to: Awaited<ReturnType<typeof open>> | undefined
  try {
    try {
      from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new SourceIntegrityError('source_symlink', source, 'symbolic links are not allowed in a plugin source')
      }
      throw new SourceIntegrityError('source_unreadable', source, `cannot read the plugin source file (${String(error)})`)
    }
    const stat = await from.stat()
    if (!stat.isFile()) {
      throw new SourceIntegrityError('source_not_regular', source, 'only regular files can be installed')
    }
    to = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode & 0o777,
    )
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const { bytesRead } = await from.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      await writeAll(to, buffer.subarray(0, bytesRead))
    }
    await to.sync()
  } finally {
    await to?.close().catch(() => undefined)
    await from?.close().catch(() => undefined)
  }
}

async function copyPluginEntries(source: string, destination: string, root: string): Promise<void> {
  const names = (await readdir(source)).sort()
  for (const name of names) {
    const from = join(source, name)
    const to = join(destination, name)
    const stat = await lstat(from)
    if (stat.isSymbolicLink()) {
      throw new SourceIntegrityError('source_symlink', from, 'symbolic links are not allowed in a plugin source')
    }
    let real: string
    try {
      real = await realpath(from)
    } catch (error) {
      throw new SourceIntegrityError('source_unreadable', from, `cannot resolve the plugin source entry (${String(error)})`)
    }
    if (!isInside(root, real)) {
      throw new SourceIntegrityError('source_outside_root', from, 'the plugin source entry resolves outside the source directory')
    }
    if (stat.isDirectory()) {
      await mkdir(to, { mode: stat.mode & 0o777 })
      await copyPluginEntries(from, to, root)
    } else if (stat.isFile()) {
      await copyRegularFile(from, to, stat.mode)
    } else {
      throw new SourceIntegrityError('source_not_regular', from, 'only regular files and directories can be installed')
    }
  }
}

async function copyPluginTree(sourceDir: string, destination: string): Promise<void> {
  const stat = await lstat(sourceDir)
  if (stat.isSymbolicLink()) {
    throw new SourceIntegrityError('source_symlink', sourceDir, 'the plugin source itself must not be a symbolic link')
  }
  if (!stat.isDirectory()) {
    throw new SourceIntegrityError('source_not_directory', sourceDir, 'the plugin source must be a directory')
  }
  const root = await realpath(sourceDir)
  await copyPluginEntries(sourceDir, destination, root)
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR' && code !== 'EBADF' && code !== 'EPERM') {
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * Minimal `engines.guanxi` range check. Supported forms: `x.y.z`, `^x.y.z`,
 * `~x.y.z`, and whitespace-separated conjunctions of `>=x.y.z` and `<x.y.z`.
 * Pre-release tags, wildcards, `||`, `>`, `<=` and hyphen ranges are rejected
 * by the kernel validator rather than half-supported.
 */
export function satisfiesGuanxiRange(range: string, version: string): boolean {
  return satisfiesEngine(range, version)
}

export class PluginManager {
  readonly pluginsDir: string
  readonly kernelApiVersion: string
  private readonly loaded: () => { readonly provides: readonly string[] }
  private readonly clock: () => Date
  private readonly hooks: PluginManagerHooks
  private readonly pluginsPath: string
  private readonly lockPath: string
  private tail: Promise<unknown> = Promise.resolve()
  private recovered = false

  constructor(options: PluginManagerOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('PluginManager needs options')
    if (typeof options.pluginsDir !== 'string' || options.pluginsDir.length === 0) {
      throw new TypeError('PluginManager options.pluginsDir must be a non-empty string')
    }
    if (typeof options.loaded !== 'function') throw new TypeError('PluginManager options.loaded must be a function')
    this.pluginsDir = resolve(options.pluginsDir)
    this.kernelApiVersion = options.kernelApiVersion ?? KERNEL_API_VERSION
    this.loaded = options.loaded
    this.clock = options.clock ?? (() => new Date())
    this.hooks = options.hooks ?? { point: () => undefined }
    this.pluginsPath = join(this.pluginsDir, 'plugins.json')
    this.lockPath = join(this.pluginsDir, 'plugins.lock.json')
  }

  /** Read-only source inspection. It never creates the plugins directory. */
  async inspect(sourceDir: string): Promise<InspectResult> {
    const inspected = await inspectPluginSource(sourceDir)
    return {
      manifest: inspected.manifest,
      integrity: inspected.integrity,
      buildScripts: [...inspected.buildScripts],
      license: inspected.license,
    }
  }

  /** Install or upgrade a local T1 plugin. Enabled state is preserved on upgrade. */
  install(sourceDir: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
    return this.enqueue(() => this.installLocked(sourceDir, options))
  }

  /** Remove an installed plugin and its lock entry. */
  uninstall(id: string): Promise<void> {
    return this.enqueue(() => this.uninstallLocked(id))
  }

  /** Change only the enabled set; the lock keeps the exact installed version. */
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.enqueue(() => this.setEnabledLocked(id, enabled))
  }

  /** Installed plugins sorted by id, oldest lock state included. */
  list(): InstalledPlugin[] {
    this.ensureRecovered()
    const state = this.readStateSync()
    return [...state.plugins.values()]
      .sort((left, right) => compareIds(left.id, right.id))
      .map(entry => this.publicEntry(entry, state.enabled.has(entry.id)))
  }

  /**
   * Absolute directories to load; safe mode loads none (ADR-0022 invariant).
   * An enabled entry whose directory is missing or whose bytes no longer match
   * the locked integrity is skipped and reported through `onSkip`.
   */
  bootSet(options: BootSetOptions = {}): string[] {
    if (options.safeMode === true) return []
    this.ensureRecovered()
    const state = this.readStateSync()
    const paths: string[] = []
    for (const entry of [...state.plugins.values()]
      .filter(candidate => state.enabled.has(candidate.id))
      .sort((left, right) => compareIds(left.id, right.id))) {
      const path = join(this.pluginsDir, entry.directory)
      let stat: ReturnType<typeof lstatSync> | undefined
      try {
        stat = lstatSync(path)
      } catch {
        stat = undefined
      }
      if (stat === undefined || !stat.isDirectory()) {
        options.onSkip?.({
          id: entry.id,
          directory: entry.directory,
          reason: 'missing_directory',
          expectedIntegrity: entry.integrity,
          actualIntegrity: null,
        })
        continue
      }
      let actual: string | null = null
      try {
        actual = computeDirectoryIntegritySync(path)
      } catch {
        actual = null
      }
      if (actual === null || !sameIntegrity(entry.integrity, actual)) {
        options.onSkip?.({
          id: entry.id,
          directory: entry.directory,
          reason: 'integrity_mismatch',
          expectedIntegrity: entry.integrity,
          actualIntegrity: actual,
        })
        continue
      }
      paths.push(path)
    }
    return paths
  }

  private publicEntry(entry: LockedPlugin, enabled: boolean): InstalledPlugin {
    return {
      id: entry.id,
      version: entry.version,
      integrity: entry.integrity,
      enabled,
      path: join(this.pluginsDir, entry.directory),
      directory: entry.directory,
      requires: [...entry.requires],
      provides: [...entry.provides],
      buildScripts: [...entry.buildScripts],
      buildScriptsApproved: entry.buildScriptsApproved,
      installedAt: entry.installedAt,
    }
  }

  /**
   * Remove leftovers of an interrupted install: `.staging`, our own stale state
   * temporary files, and every `<id>@<version>` directory that the lock does
   * not reference. Returns what was removed. No-op when `pluginsDir` is absent.
   */
  recover(): RecoveryReport {
    const report = this.recoverSync()
    this.recovered = true
    return report
  }

  private ensureRecovered(): void {
    if (this.recovered) return
    this.recover()
  }

  private recoverSync(): RecoveryReport {
    let names: string[]
    try {
      names = readdirSync(this.pluginsDir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return EMPTY_RECOVERY
      throw new PluginManagerError('invalid_state', `${this.pluginsDir}: cannot scan for recovery (${String(error)})`)
    }
    const lock = this.readOptionalSync(this.lockPath)
    const locked = lock === null ? new Map<string, LockedPlugin>() : parseLockFile(lock.toString('utf8'), this.lockPath)
    const referenced = new Set([...locked.values()].map(entry => entry.directory))
    const removedDirectories: string[] = []
    const removedTemporaryFiles: string[] = []
    let removedStaging = false

    for (const name of names.sort(compareIds)) {
      const path = join(this.pluginsDir, name)
      if (name === '.staging') {
        rmSync(path, { recursive: true, force: true })
        removedStaging = true
        continue
      }
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isFile() && STATE_TEMPORARY_NAME.test(name)) {
        rmSync(path, { force: true })
        removedTemporaryFiles.push(name)
      } else if (stat.isDirectory() && PLUGIN_DIRECTORY_NAME.test(name) && !referenced.has(name)) {
        rmSync(path, { recursive: true, force: true })
        removedDirectories.push(name)
      }
    }
    return { removedStaging, removedDirectories, removedTemporaryFiles }
  }

  private readOptionalSync(path: string): Buffer | null {
    try {
      return readFileSync(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw new PluginManagerError('invalid_state', `${path}: cannot read state (${String(error)})`)
    }
  }

  private readStateSync(): ManagerState {
    const plugins = this.readOptionalSync(this.pluginsPath)
    const lock = this.readOptionalSync(this.lockPath)
    return {
      enabled: plugins === null ? new Set() : parsePluginsFile(plugins.toString('utf8'), this.pluginsPath),
      plugins: lock === null ? new Map() : parseLockFile(lock.toString('utf8'), this.lockPath),
      snapshot: { plugins, lock },
    }
  }

  private async fault(name: PluginFaultPoint): Promise<void> {
    await this.hooks.point?.(name)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async installLocked(sourceDir: string, options: InstallOptions): Promise<InstalledPlugin> {
    this.ensureRecovered()
    let snapshot: StateSnapshot | undefined
    let stagingDir: string | null = null
    let target: string | null = null
    let targetCreated = false
    let pluginsDirCreated = false
    let stagingRootCreated = false
    const stagingRoot = join(this.pluginsDir, '.staging')
    try {
      await this.fault('install:start')
      if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
        throw new PluginManagerError('invalid_arguments', 'install() needs a source directory')
      }
      if (options === null || typeof options !== 'object') {
        throw new PluginManagerError('invalid_arguments', 'install() options must be an object')
      }
      const root = resolve(sourceDir)
      const inspected = await inspectPluginSource(root)
      await this.fault('install:inspected')
      const manifest = inspected.manifest

      if (!satisfiesGuanxiRange(manifest.engines.guanxi, this.kernelApiVersion)) {
        throw new PluginManagerError(
          'engine_mismatch',
          `plugin "${manifest.id}" needs engines.guanxi "${manifest.engines.guanxi}", not kernel ${this.kernelApiVersion}`,
          { pluginId: manifest.id, expected: manifest.engines.guanxi, actual: this.kernelApiVersion },
        )
      }
      await this.fault('install:engine')

      const state = await this.readState()
      snapshot = state.snapshot
      await this.fault('install:state-read')

      const provided = await this.installedProvides(state, manifest.id)
      for (const name of this.loadedProvides()) provided.add(name)
      const missing = manifest.requires.filter(name => !provided.has(name))
      if (missing.length > 0) {
        throw new PluginManagerError(
          'peer_missing',
          `plugin "${manifest.id}" requires ${missing.map(name => `"${name}"`).join(', ')}, which no enabled plugin or loaded kernel provides`,
          { pluginId: manifest.id, missing },
        )
      }
      await this.fault('install:peer')

      if (inspected.buildScripts.length > 0 && options.approveBuildScripts !== true) {
        throw new PluginManagerError(
          'build_scripts_unapproved',
          `plugin "${manifest.id}" declares build scripts (${inspected.buildScripts.join(', ')}); approve them explicitly`,
          { pluginId: manifest.id, buildScripts: inspected.buildScripts },
        )
      }
      await this.fault('install:build-scripts')

      if (manifest.trust !== 'T1') {
        throw new PluginManagerError(
          'trust_tier_unsupported',
          `plugin "${manifest.id}" has trust ${manifest.trust}; only T1 installs are supported in this slice`,
          { pluginId: manifest.id },
        )
      }
      await this.fault('install:trust')

      if (options.expectedIntegrity !== undefined && !sameIntegrity(options.expectedIntegrity, inspected.integrity)) {
        throw new PluginManagerError(
          'integrity_mismatch',
          `plugin "${manifest.id}" integrity ${inspected.integrity} does not match the expected ${options.expectedIntegrity}`,
          { pluginId: manifest.id, expected: options.expectedIntegrity, actual: inspected.integrity },
        )
      }
      await this.fault('install:expected-integrity')

      const version = pluginVersion(inspected.packageJson, join(root, 'package.json'))
      const directory = `${manifest.id}@${version}`
      const targetPath = join(this.pluginsDir, directory)
      target = targetPath
      const previous = state.plugins.get(manifest.id)

      if (previous && previous.version === version) {
        if (sameIntegrity(previous.integrity, inspected.integrity)) {
          return this.publicEntry(previous, state.enabled.has(manifest.id))
        }
        throw new PluginManagerError(
          'version_exists',
          `plugin "${manifest.id}@${version}" is already installed with different content; install a new version to upgrade`,
          { pluginId: manifest.id, expected: previous.integrity, actual: inspected.integrity },
        )
      }

      if (await pathExists(targetPath)) {
        throw new PluginManagerError(
          'plugin_directory_exists',
          `plugin directory already exists for "${manifest.id}@${version}" but is not the locked version`,
          { pluginId: manifest.id },
        )
      }

      const enabled = new Set(state.enabled)
      if (!previous) enabled.add(manifest.id)
      const nextPlugins = new Map(state.plugins)
      const nextEntry: LockedPlugin = {
        id: manifest.id,
        version,
        integrity: inspected.integrity,
        directory,
        requires: [...manifest.requires],
        provides: [...manifest.provides],
        buildScripts: [...inspected.buildScripts],
        buildScriptsApproved: inspected.buildScripts.length > 0 && options.approveBuildScripts === true,
        installedAt: this.nowIso(),
        providesKnown: true,
      }
      nextPlugins.set(manifest.id, nextEntry)

      if (!(await pathExists(this.pluginsDir))) {
        await mkdir(this.pluginsDir, { recursive: true })
        pluginsDirCreated = true
      }
      if (!(await pathExists(stagingRoot))) {
        await mkdir(stagingRoot, { recursive: true })
        stagingRootCreated = true
      }
      stagingDir = await mkdtemp(join(stagingRoot, 'stage-'))
      await this.fault('install:staging-created')

      await copyPluginTree(root, stagingDir)
      await this.fault('install:copied')

      const stagedIntegrity = await computeDirectoryIntegrity(stagingDir)
      if (stagedIntegrity !== inspected.integrity) {
        throw new PluginManagerError(
          'integrity_mismatch',
          `plugin "${manifest.id}" changed while it was staged (expected ${inspected.integrity}, got ${stagedIntegrity})`,
          { pluginId: manifest.id, expected: inspected.integrity, actual: stagedIntegrity },
        )
      }
      if (options.expectedIntegrity !== undefined && !sameIntegrity(options.expectedIntegrity, stagedIntegrity)) {
        throw new PluginManagerError(
          'integrity_mismatch',
          `staged plugin "${manifest.id}" integrity ${stagedIntegrity} does not match the expected ${options.expectedIntegrity}`,
          { pluginId: manifest.id, expected: options.expectedIntegrity, actual: stagedIntegrity },
        )
      }
      await this.fault('install:staged-integrity')
      await this.fault('install:metadata-planned')

      // Commit the directory first: a crash before the state write leaves only
      // an unreferenced directory, never a lock entry with no directory.
      await this.fault('install:before-plugin-rename')
      const staging = stagingDir
      if (staging === null) throw new Error('plugin staging directory disappeared')
      await rename(staging, targetPath)
      stagingDir = null
      targetCreated = true
      await syncDirectory(this.pluginsDir)
      await this.fault('install:plugin-renamed')

      await this.writeAtomicWithFaults(
        this.pluginsPath,
        serializePlugins(enabled),
        'install:manifest-temp',
        'install:manifest-renamed',
      )
      await this.writeAtomicWithFaults(
        this.lockPath,
        serializeLock(nextPlugins),
        'install:lock-temp',
        'install:lock-renamed',
      )
      await this.fault('install:before-previous-remove')
      await this.fault('install:committed')

      // The commit is final from here: cleanup failures leave an old or
      // unreferenced directory behind, and `recover()` sweeps it later.
      if (previous && previous.version !== version) {
        await rm(join(this.pluginsDir, previous.directory), { recursive: true, force: true }).catch(() => undefined)
      }
      if (stagingRootCreated) await this.removeEmptyDirectory(stagingRoot)
      return this.publicEntry(nextEntry, enabled.has(manifest.id))
    } catch (error) {
      if (isSimulatedCrash(error)) throw error
      await this.rollbackInstall({
        snapshot,
        stagingDir,
        target,
        targetCreated,
        pluginsDirCreated,
        stagingRootCreated,
      })
      throw error
    }
  }

  private async uninstallLocked(id: string): Promise<void> {
    let snapshot: StateSnapshot | undefined
    let backupDir: string | null = null
    let backupMoved = false
    let directory: string | null = null
    let stagingRootCreated = false
    const stagingRoot = join(this.pluginsDir, '.staging')
    try {
      await this.fault('uninstall:start')
      if (typeof id !== 'string' || id.length === 0) {
        throw new PluginManagerError('invalid_arguments', 'uninstall() needs a plugin id')
      }
      const state = await this.readState()
      snapshot = state.snapshot
      await this.fault('uninstall:state-read')
      const entry = state.plugins.get(id)
      if (!entry) {
        throw new PluginManagerError('plugin_not_installed', `plugin "${id}" is not installed`, { pluginId: id })
      }
      directory = join(this.pluginsDir, entry.directory)
      const nextPlugins = new Map(state.plugins)
      nextPlugins.delete(id)
      const nextEnabled = new Set(state.enabled)
      nextEnabled.delete(id)

      if (await pathExists(directory)) {
        if (!(await pathExists(stagingRoot))) {
          await mkdir(stagingRoot, { recursive: true })
          stagingRootCreated = true
        }
        backupDir = join(stagingRoot, `removed-${randomBytes(12).toString('hex')}`)
        await rename(directory, backupDir)
        backupMoved = true
      }
      await this.fault('uninstall:backup')

      await this.writeAtomicWithFaults(
        this.pluginsPath,
        serializePlugins(nextEnabled),
        'uninstall:manifest-temp',
        'uninstall:manifest-renamed',
      )
      await this.writeAtomicWithFaults(
        this.lockPath,
        serializeLock(nextPlugins),
        'uninstall:lock-temp',
        'uninstall:lock-renamed',
      )
      await this.fault('uninstall:committed')

      if (backupDir !== null) {
        await rm(backupDir, { recursive: true, force: true }).catch(() => undefined)
        backupDir = null
      }
      if (stagingRootCreated) await this.removeEmptyDirectory(stagingRoot)
    } catch (error) {
      if (backupMoved && backupDir !== null && directory !== null) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        await rename(backupDir, directory).catch(() => undefined)
      }
      if (snapshot !== undefined) await this.restoreSnapshot(snapshot).catch(() => undefined)
      if (stagingRootCreated) await this.removeEmptyDirectory(stagingRoot)
      throw error
    }
  }

  private async setEnabledLocked(id: string, enabled: boolean): Promise<void> {
    let snapshot: StateSnapshot | undefined
    let wrote = false
    try {
      await this.fault('set-enabled:start')
      if (typeof id !== 'string' || id.length === 0) {
        throw new PluginManagerError('invalid_arguments', 'setEnabled() needs a plugin id')
      }
      if (typeof enabled !== 'boolean') {
        throw new PluginManagerError('invalid_arguments', 'setEnabled() needs a boolean state')
      }
      const state = await this.readState()
      snapshot = state.snapshot
      await this.fault('set-enabled:state-read')
      if (!state.plugins.has(id)) {
        throw new PluginManagerError('plugin_not_installed', `plugin "${id}" is not installed`, { pluginId: id })
      }
      const next = new Set(state.enabled)
      if (enabled) next.add(id)
      else next.delete(id)
      wrote = true
      await this.writeAtomicWithFaults(
        this.pluginsPath,
        serializePlugins(next),
        'set-enabled:manifest-temp',
        'set-enabled:manifest-renamed',
      )
      await this.fault('set-enabled:committed')
    } catch (error) {
      if (wrote && snapshot !== undefined) {
        await this.restoreFile(this.pluginsPath, snapshot.plugins).catch(() => undefined)
      }
      throw error
    }
  }

  private async rollbackInstall(context: InstallRollbackContext): Promise<void> {
    if (context.targetCreated && context.target !== null) {
      await rm(context.target, { recursive: true, force: true }).catch(() => undefined)
    }
    if (context.stagingDir !== null) {
      await rm(context.stagingDir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (context.snapshot !== undefined) {
      await this.restoreSnapshot(context.snapshot).catch(() => undefined)
    }
    if (context.stagingRootCreated) {
      await this.removeEmptyDirectory(join(this.pluginsDir, '.staging'))
    }
    if (context.pluginsDirCreated) await this.removeEmptyDirectory(this.pluginsDir)
  }

  private async restoreSnapshot(snapshot: StateSnapshot): Promise<void> {
    await this.restoreFile(this.pluginsPath, snapshot.plugins)
    await this.restoreFile(this.lockPath, snapshot.lock)
  }

  private async restoreFile(path: string, bytes: Buffer | null): Promise<void> {
    const current = await this.readOptional(path)
    if (bytes === null) {
      if (current !== null) await unlink(path)
      return
    }
    if (current !== null && current.equals(bytes)) return
    await this.writeAtomic(path, bytes)
  }

  private async writeAtomicWithFaults(
    path: string,
    data: string | Buffer,
    temporaryPoint: PluginFaultPoint,
    renamedPoint: PluginFaultPoint,
  ): Promise<void> {
    await this.writeAtomic(
      path,
      data,
      async () => this.fault(temporaryPoint),
      async () => this.fault(renamedPoint),
    )
  }

  private async writeAtomic(
    path: string,
    data: string | Buffer,
    beforeRename?: () => Promise<void>,
    afterRename?: () => Promise<void>,
  ): Promise<void> {
    const directory = dirname(path)
    const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(data)
      await handle.sync()
      await handle.close()
      handle = undefined
      await beforeRename?.()
      await rename(temporary, path)
      await syncDirectory(directory)
      await afterRename?.()
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  private async removeEmptyDirectory(path: string): Promise<void> {
    await rmdir(path).catch(() => undefined)
  }

  private async readOptional(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      throw new PluginManagerError('invalid_state', `${path}: cannot read state (${String(error)})`)
    }
  }

  private async readState(): Promise<ManagerState> {
    const plugins = await this.readOptional(this.pluginsPath)
    const lock = await this.readOptional(this.lockPath)
    return {
      enabled: plugins === null ? new Set() : parsePluginsFile(plugins.toString('utf8'), this.pluginsPath),
      plugins: lock === null ? new Map() : parseLockFile(lock.toString('utf8'), this.lockPath),
      snapshot: { plugins, lock },
    }
  }

  private async installedProvides(state: ManagerState, excludeId: string): Promise<Set<string>> {
    const provided = new Set<string>()
    for (const [id, entry] of state.plugins) {
      if (id === excludeId || !state.enabled.has(id)) continue
      if (entry.providesKnown) {
        for (const name of entry.provides) provided.add(name)
        continue
      }
      try {
        const text = await readFile(join(this.pluginsDir, entry.directory, 'package.json'), 'utf8')
        const manifest = readPackageManifest(
          parsePackageJson(text, join(this.pluginsDir, entry.directory, 'package.json')),
        )
        for (const name of manifest.provides) provided.add(name)
      } catch {
        // A disabled or incomplete installed copy provides nothing.
      }
    }
    return provided
  }

  private loadedProvides(): Set<string> {
    const loaded = this.loaded()
    if (!isRecord(loaded) || !Array.isArray(loaded.provides)) {
      throw new PluginManagerError('invalid_arguments', 'loaded() must return { provides: string[] }')
    }
    const provided = new Set<string>()
    for (const name of loaded.provides) {
      if (typeof name !== 'string') {
        throw new PluginManagerError('invalid_arguments', 'loaded().provides must contain only strings')
      }
      provided.add(name)
    }
    return provided
  }

  private nowIso(): string {
    const value = this.clock()
    const date = value instanceof Date ? value : new Date(value as unknown as string)
    if (Number.isNaN(date.getTime())) {
      throw new PluginManagerError('invalid_arguments', 'clock() must return a valid Date')
    }
    return date.toISOString()
  }

}
