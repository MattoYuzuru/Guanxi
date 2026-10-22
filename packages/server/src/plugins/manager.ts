/**
 * T1 plugin manager core (ADR-0022 §7; ROADMAP P1). A local directory is the
 * only supported source in this slice: inspect validates and hashes it, install
 * copies it transactionally into `<pluginsDir>/<id>@<version>/`, and the enabled
 * set plus exact versions and integrity live in two JSON files.
 *
 * T0 is core-only and T2 needs the later out-of-process sandbox. Build scripts
 * are never executed here; an explicit approval is only recorded in the lock.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  KERNEL_API_VERSION,
  readPackageManifest,
  satisfiesEngine,
  type GuanxiManifest,
} from '@guanxi/kernel'
import {
  computeDirectoryIntegrity,
  SourceIntegrityError,
} from './integrity.ts'

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
  'install:manifest-temp',
  'install:manifest-renamed',
  'install:lock-temp',
  'install:lock-renamed',
  'install:before-plugin-rename',
  'install:plugin-renamed',
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
  readonly buildScripts: readonly string[]
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
  readonly requires: readonly string[]
  readonly provides: readonly string[]
  readonly buildScripts: readonly string[]
  readonly buildScriptsApproved: boolean
  readonly installedAt: string | null
}

export interface InstallOptions {
  readonly approveBuildScripts?: boolean
  readonly expectedIntegrity?: string
}

export interface BootSetOptions {
  readonly safeMode?: boolean
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

const PLUGIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  if (source === undefined) return plugins
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

  /** Installed plugins sorted by id, oldest lock state included. */
  list(): InstalledPlugin[] {
    const state = this.readStateSync()
    return [...state.plugins.values()]
      .sort((left, right) => compareIds(left.id, right.id))
      .map(entry => this.publicEntry(entry, state.enabled.has(entry.id)))
  }

  /** Absolute directories to load; safe mode loads none (ADR-0022 invariant). */
  bootSet(options: BootSetOptions = {}): string[] {
    if (options.safeMode === true) return []
    const state = this.readStateSync()
    return [...state.plugins.values()]
      .filter(entry => state.enabled.has(entry.id))
      .sort((left, right) => compareIds(left.id, right.id))
      .map(entry => join(this.pluginsDir, entry.directory))
  }

  protected inspectVersion(sourceDir: string): Promise<string> {
    return inspectPluginSource(sourceDir).then(inspected => pluginVersion(inspected.packageJson, sourceDir))
  }

  protected async fault(name: PluginFaultPoint): Promise<void> {
    await this.hooks.point?.(name)
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
}
