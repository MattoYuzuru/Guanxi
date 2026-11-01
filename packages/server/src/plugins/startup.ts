/** Trusted local T1 startup. Integrity pins bytes; T1 code still has full process rights. */
import { isDeepStrictEqual } from 'node:util'
import { cp, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'
import { definePlugin, isGuanxiPlugin, KERNEL_API_VERSION, parseManifest, readPackageManifest, satisfiesEngine,
  type GuanxiManifest, type GuanxiPlugin, type Kernel, type PluginHandle } from '@guanxi/kernel'
import { computeDirectoryIntegrity } from './integrity.ts'
import { PluginManager, type InstalledPlugin } from './manager.ts'

export type TrustedPluginCode = 'missing_directory' | 'integrity_mismatch' | 'invalid_package'
  | 'invalid_entry' | 'trust_tier_unsupported' | 'core_collision' | 'dependency_unavailable'
  | 'dependency_cycle' | 'manifest_mismatch' | 'import_failed' | 'apply_failed' | 'cleanup_failed'
  | 'state_invalid' | 'snapshot_failed'

export interface TrustedPluginOutcome {
  readonly id: string
  readonly status: 'loaded' | 'skipped'
  readonly code?: TrustedPluginCode
}
export interface TrustedPluginReport {
  readonly mode: 'normal' | 'safe-mode'
  readonly outcomes: readonly TrustedPluginOutcome[]
}
export interface TrustedPluginOptions {
  /** Defaults to the node data directory's `plugins` child. Never accepted over HTTP. */
  directory?: string
  /** Recovery mode: no addon state, source or entry is read. Core plugins remain enabled. */
  safeMode?: boolean
}
export interface TrustedPluginRuntime {
  readonly report: TrustedPluginReport
  /** Idempotent; removes addon effects before their private runtime copies. */
  dispose(): Promise<void>
}
export class TrustedPluginStartupError extends Error {
  readonly code: TrustedPluginCode
  constructor(code: TrustedPluginCode) {
    super(`Trusted plugin startup failed: ${code}`)
    this.name = 'TrustedPluginStartupError'
    this.code = code
  }
}

interface Candidate {
  installed: InstalledPlugin
  manifest: GuanxiManifest
  entry: string
  snapshot: string
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

async function candidate(installed: InstalledPlugin, directory: string, reserved: ReadonlySet<string>): Promise<Candidate> {
  const snapshot = join(directory, installed.directory)
  await cp(installed.path, snapshot, { recursive: true, dereference: false, errorOnExist: true, force: false })
  if (await computeDirectoryIntegrity(snapshot) !== installed.integrity) throw new TrustedPluginStartupError('integrity_mismatch')
  let pkg: Record<string, unknown>, manifest: GuanxiManifest
  try {
    pkg = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest = readPackageManifest(pkg)
  } catch { throw new TrustedPluginStartupError('invalid_package') }
  if (manifest.trust !== 'T1') throw new TrustedPluginStartupError('trust_tier_unsupported')
  if (reserved.has(manifest.id)) throw new TrustedPluginStartupError('core_collision')
  if (manifest.id !== installed.id || pkg.version !== installed.version || !satisfiesEngine(manifest.engines.guanxi)
      || !isDeepStrictEqual(manifest.requires, installed.requires) || !isDeepStrictEqual(manifest.provides, installed.provides)) {
    throw new TrustedPluginStartupError('manifest_mismatch')
  }
  const main = pkg.main
  if (pkg.type !== 'module' || typeof main !== 'string' || !main || isAbsolute(main) || main.includes('\\')
      || (!main.endsWith('.mjs') && !main.endsWith('.js'))) throw new TrustedPluginStartupError('invalid_entry')
  const entry = resolve(snapshot, main)
  if (!inside(snapshot, entry)) throw new TrustedPluginStartupError('invalid_entry')
  try {
    if (!(await lstat(entry)).isFile() || await realpath(entry) !== entry) throw new Error('entry')
  } catch { throw new TrustedPluginStartupError('invalid_entry') }
  return { installed, manifest, entry, snapshot }
}

/** Check the entire required graph before running any module's top-level code. */
function ordered(candidates: Candidate[], kernel: Kernel): Candidate[] {
  const services = new Map<string, Candidate>(), slots = new Map<string, Candidate>()
  const ids = new Set<string>()
  for (const item of candidates) {
    const manifest = item.manifest
    if (ids.has(manifest.id)) throw new TrustedPluginStartupError('core_collision')
    ids.add(manifest.id)
    for (const name of manifest.provides) {
      if (kernel.service(name) !== undefined || services.has(name)) throw new TrustedPluginStartupError('core_collision')
      services.set(name, item)
    }
    for (const name of manifest.contributes.slotDeclarations) {
      if (slots.has(name) || kernel.slots.isDeclared(name)) throw new TrustedPluginStartupError('core_collision')
      slots.set(name, item)
    }
  }
  const result: Candidate[] = [], visiting = new Set<Candidate>(), done = new Set<Candidate>()
  const visit = (item: Candidate) => {
    if (done.has(item)) return
    if (visiting.has(item)) throw new TrustedPluginStartupError('dependency_cycle')
    visiting.add(item)
    for (const name of item.manifest.requires) {
      const provider = services.get(name)
      if (provider) visit(provider)
      else if (kernel.service(name) === undefined) throw new TrustedPluginStartupError('dependency_unavailable')
    }
    for (const name of item.manifest.contributes.slots) {
      const provider = slots.get(name)
      if (provider) visit(provider)
      else if (!kernel.slots.isDeclared(name)) throw new TrustedPluginStartupError('dependency_unavailable')
    }
    visiting.delete(item); done.add(item); result.push(item)
  }
  for (const item of candidates) visit(item)
  return result
}

/** Keep plugin-thrown error contents out of the host's loader failure and kernel apply log. */
function guarded(plugin: GuanxiPlugin<unknown>, manifest: GuanxiManifest): GuanxiPlugin<undefined> {
  return definePlugin({ manifest, async apply(ctx) {
    try {
      const cleanup = await plugin.apply(ctx, undefined)
      if (typeof cleanup === 'function') return async () => {
        try { await cleanup() } catch { throw new TrustedPluginStartupError('cleanup_failed') }
      }
    } catch { throw new TrustedPluginStartupError('apply_failed') }
  } })
}

/** Called once by the host, after all core plugins and before the HTTP listener. */
export async function loadTrustedPlugins(kernel: Kernel, options: Required<Pick<TrustedPluginOptions, 'directory'>> & TrustedPluginOptions,
  reservedIds: readonly string[]): Promise<TrustedPluginRuntime> {
  if (options.safeMode === true) return { report: { mode: 'safe-mode', outcomes: [] }, dispose: async () => {} }
  const outcomes: TrustedPluginOutcome[] = [], handles: PluginHandle[] = []
  let directory: string | undefined, disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= (async () => {
    let failed = false
    for (const handle of [...handles].reverse()) {
      try { await handle.dispose() } catch { failed = true }
    }
    if (directory) { try { await rm(directory, { recursive: true, force: true }) } catch { failed = true } }
    if (failed) throw new TrustedPluginStartupError('cleanup_failed')
  })()
  try {
    const manager = new PluginManager({ pluginsDir: options.directory, loaded: () => ({ provides: [] }) })
    let entries: InstalledPlugin[]
    try {
      entries = manager.bootEntries({ recover: false, onSkip: item => {
        // Hand-written lock ids are untrusted metadata too; reports contain only valid plugin ids.
        const id = parseManifest({ id: item.id, trust: 'T1', engines: { guanxi: KERNEL_API_VERSION } }).id
        outcomes.push({ id, status: 'skipped', code: item.reason })
      } })
    } catch { throw new TrustedPluginStartupError('state_invalid') }
    if (entries.length > 0) directory = await realpath(await mkdtemp(join(tmpdir(), `${PRODUCT_FILE_PREFIX}-t1-`)))
    const candidates: Candidate[] = [], reserved = new Set(reservedIds)
    for (const installed of entries) candidates.push(await candidate(installed, directory!, reserved))
    for (const item of ordered(candidates, kernel)) {
      // Earlier trusted top-level code must not silently change a later candidate's pinned bytes.
      if (await computeDirectoryIntegrity(item.snapshot) !== item.installed.integrity) throw new TrustedPluginStartupError('integrity_mismatch')
      let plugin: unknown
      try { plugin = (await import(pathToFileURL(item.entry).href)).default } catch { throw new TrustedPluginStartupError('import_failed') }
      if (!isGuanxiPlugin(plugin)) throw new TrustedPluginStartupError('manifest_mismatch')
      let manifest: GuanxiManifest
      try { manifest = parseManifest(plugin.manifest) } catch { throw new TrustedPluginStartupError('manifest_mismatch') }
      if (!isDeepStrictEqual(manifest, item.manifest)) throw new TrustedPluginStartupError('manifest_mismatch')
      // A previous trusted module may have modified another snapshot; recheck immediately before its apply.
      if (await computeDirectoryIntegrity(item.snapshot) !== item.installed.integrity) {
        throw new TrustedPluginStartupError('integrity_mismatch')
      }
      let handle: PluginHandle
      try { handle = await kernel.plugin(guarded(plugin, manifest)) } catch { throw new TrustedPluginStartupError('apply_failed') }
      handles.push(handle)
      if (handle.state !== 'active') throw new TrustedPluginStartupError('dependency_unavailable')
      outcomes.push({ id: manifest.id, status: 'loaded' })
    }
    if (handles.some(handle => handle.state !== 'active')) throw new TrustedPluginStartupError('apply_failed')
    return { report: { mode: 'normal', outcomes }, dispose }
  } catch (error) {
    await dispose().catch(() => undefined)
    throw error instanceof TrustedPluginStartupError ? error : new TrustedPluginStartupError('snapshot_failed')
  }
}
