/**
 * P1-b plugin manager: local T1 inspection, transactional install/upgrade,
 * peer and engine checks, and rollback at every injectable fault point.
 *
 * Every test uses a fresh temporary directory. No build script is ever run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { KERNEL_API_VERSION, ManifestError, type TrustTier } from '@guanxi/kernel'
import {
  FAULT_POINTS,
  INSTALL_FAULT_POINTS,
  PluginManager,
  PluginManagerError,
  SET_ENABLED_FAULT_POINTS,
  SimulatedCrash,
  SourceIntegrityError,
  UNINSTALL_FAULT_POINTS,
  satisfiesGuanxiRange,
  type BootSkip,
  type PluginManagerHooks,
  type PluginManagerOptions,
} from '../../src/plugins/manager.ts'

interface TestContext {
  after(callback: () => unknown): void
  skip(message?: string): void
}

interface PluginFixture {
  readonly id?: string
  readonly version?: string
  readonly license?: string | null
  readonly trust?: TrustTier
  readonly engines?: string
  readonly provides?: readonly string[]
  readonly requires?: readonly string[]
  readonly uses?: readonly string[]
  readonly scripts?: Readonly<Record<string, string>>
  readonly files?: Readonly<Record<string, string>>
}

const DEFAULT_ID = 'guanxi.test-plugin'
const FIXED_CLOCK = new Date('2026-10-22T12:00:00.000Z')

async function tempBase(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'p1b-manager-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function writePlugin(root: string, fixture: PluginFixture = {}): Promise<string> {
  const id = fixture.id ?? DEFAULT_ID
  const version = fixture.version ?? '1.0.0'
  const packageJson: Record<string, unknown> = {
    name: id,
    version,
    guanxi: {
      id,
      engines: { guanxi: fixture.engines ?? '^0.1.0' },
      provides: [...(fixture.provides ?? [])],
      requires: [...(fixture.requires ?? [])],
      uses: [...(fixture.uses ?? [])],
      contributes: {},
      trust: fixture.trust ?? 'T1',
    },
  }
  if (fixture.license !== null) packageJson['license'] = fixture.license ?? 'MIT'
  if (fixture.scripts !== undefined) packageJson['scripts'] = fixture.scripts
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  const files = fixture.files ?? { 'index.js': `export const version = '${version}'\n` }
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  return root
}

function manager(pluginsDir: string, overrides: Partial<PluginManagerOptions> = {}): PluginManager {
  return new PluginManager({
    pluginsDir,
    kernelApiVersion: KERNEL_API_VERSION,
    loaded: () => ({ provides: [] }),
    clock: () => FIXED_CLOCK,
    ...overrides,
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function topLevel(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort()
  } catch {
    return []
  }
}

async function recursiveListing(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true })).sort()
  } catch {
    return []
  }
}

async function optionalRead(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch {
    return null
  }
}

interface StateBytes {
  readonly plugins: Buffer | null
  readonly lock: Buffer | null
}

async function stateBytes(pluginsDir: string): Promise<StateBytes> {
  return {
    plugins: await optionalRead(join(pluginsDir, 'plugins.json')),
    lock: await optionalRead(join(pluginsDir, 'plugins.lock.json')),
  }
}

interface LockedEntry {
  readonly version: string
  readonly integrity: string
  readonly directory: string
}

async function lockEntries(pluginsDir: string): Promise<Record<string, LockedEntry>> {
  const text = await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')
  const parsed = JSON.parse(text) as { plugins: Record<string, LockedEntry> }
  return parsed.plugins
}

async function rejectsWithCode(run: Promise<unknown>, code: string): Promise<PluginManagerError> {
  let caught: unknown
  try {
    await run
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof PluginManagerError, `expected PluginManagerError, got ${String(caught)}`)
  assert.equal(caught.code, code)
  return caught
}

test('inspect validates the manifest, hashes files, and reports build scripts and license', async t => {
  const base = await tempBase(t)
  const source = join(base, 'source')
  await writePlugin(source, {
    version: '1.2.3',
    license: 'Apache-2.0',
    scripts: { postinstall: 'node build.js', preinstall: 'echo pre' },
    files: { 'index.js': 'export const value = 1\n', 'lib/a.js': 'export const a = 2\n' },
  })
  const pluginsDir = join(base, 'plugins')
  const plugins = manager(pluginsDir)
  const inspected = await plugins.inspect(source)
  assert.equal(inspected.manifest.id, DEFAULT_ID)
  assert.equal(inspected.manifest.trust, 'T1')
  assert.match(inspected.integrity, /^sha256-[0-9a-f]{64}$/)
  assert.deepEqual(inspected.buildScripts, ['preinstall', 'postinstall'])
  assert.equal(inspected.license, 'Apache-2.0')
  assert.equal(await exists(pluginsDir), false, 'inspect never creates the plugins directory')

  const first = inspected.integrity
  await writeFile(join(source, 'index.js'), 'export const value = 2\n')
  assert.notEqual((await plugins.inspect(source)).integrity, first, 'content changes the integrity')

  const unlicensed = join(base, 'unlicensed')
  await writePlugin(unlicensed, { license: null })
  assert.equal((await plugins.inspect(unlicensed)).license, null)
})

test('inspect refuses invalid manifests, symbolic links, and a symlinked source root', async t => {
  const base = await tempBase(t)
  const plugins = manager(join(base, 'plugins'))

  const invalid = join(base, 'invalid')
  await mkdir(invalid, { recursive: true })
  await writeFile(join(invalid, 'package.json'), JSON.stringify({ guanxi: { id: 'not-dotted' } }))
  await assert.rejects(plugins.inspect(invalid), (error: unknown) => error instanceof ManifestError)

  const source = join(base, 'source')
  await writePlugin(source)
  const outside = join(base, 'outside.js')
  await writeFile(outside, 'host secret\n')
  await symlink(outside, join(source, 'escape.js'))
  await assert.rejects(plugins.inspect(source), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_symlink')
    return true
  })

  const linked = join(base, 'linked-source')
  await symlink(source, linked)
  await assert.rejects(plugins.inspect(linked), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_symlink')
    return true
  })
})

test('install lays out the version directory, enabled set, lock, and safe-mode boot set', async t => {
  const base = await tempBase(t)
  const source = join(base, 'source')
  await writePlugin(source)
  const pluginsDir = join(base, 'plugins')
  const plugins = manager(pluginsDir)

  const installed = await plugins.install(source)
  const directory = 'guanxi.test-plugin@1.0.0'
  assert.equal(installed.version, '1.0.0')
  assert.equal(installed.enabled, true)
  assert.equal(installed.path, join(pluginsDir, directory))
  assert.equal(await exists(installed.path), true)
  assert.deepEqual(await topLevel(pluginsDir), [directory, 'plugins.json', 'plugins.lock.json'])
  assert.equal(await exists(join(pluginsDir, '.staging')), false)

  const enabled = JSON.parse(await readFile(join(pluginsDir, 'plugins.json'), 'utf8')) as { enabled: string[] }
  assert.deepEqual(enabled.enabled, [DEFAULT_ID])
  const lock = JSON.parse(await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')) as {
    plugins: Record<string, { version: string; integrity: string }>
  }
  assert.equal(lock.plugins[DEFAULT_ID]?.version, '1.0.0')
  assert.equal(lock.plugins[DEFAULT_ID]?.integrity, installed.integrity)
  assert.deepEqual(plugins.bootSet(), [installed.path])
  assert.deepEqual(plugins.bootSet({ safeMode: true }), [])
  assert.deepEqual(plugins.list().map(entry => entry.id), [DEFAULT_ID])

  await plugins.uninstall(DEFAULT_ID)
  assert.equal(await exists(installed.path), false)
  assert.deepEqual(plugins.list(), [])
  assert.deepEqual(plugins.bootSet(), [])
  assert.deepEqual(JSON.parse(await readFile(join(pluginsDir, 'plugins.json'), 'utf8')), {
    version: 1,
    enabled: [],
  })
  assert.deepEqual(await topLevel(pluginsDir), ['plugins.json', 'plugins.lock.json'])
})

test('upgrade replaces the old version directory and preserves the enabled flag', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })
  const plugins = manager(pluginsDir)

  await plugins.install(first)
  await plugins.setEnabled(DEFAULT_ID, false)
  assert.deepEqual(plugins.bootSet(), [])

  const upgraded = await plugins.install(second)
  assert.equal(upgraded.version, '2.0.0')
  assert.equal(upgraded.enabled, false)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@1.0.0')), false)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@2.0.0')), true)
  assert.deepEqual(plugins.list().map(entry => entry.version), ['2.0.0'])
  assert.deepEqual(plugins.bootSet(), [])

  await plugins.setEnabled(DEFAULT_ID, true)
  assert.deepEqual(plugins.bootSet(), [join(pluginsDir, 'guanxi.test-plugin@2.0.0')])
})

test('refuses engine mismatches and missing peers before any write', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  await mkdir(pluginsDir)
  await writeFile(join(pluginsDir, 'sentinel'), 'unchanged\n')
  const before = await recursiveListing(pluginsDir)

  const wrongEngine = await writePlugin(join(base, 'wrong-engine'), { engines: '^0.2.0' })
  await rejectsWithCode(manager(pluginsDir).install(wrongEngine), 'engine_mismatch')
  assert.deepEqual(await recursiveListing(pluginsDir), before)

  const missingPeer = await writePlugin(join(base, 'missing-peer'), {
    requires: ['test.never-provided'],
  })
  await rejectsWithCode(manager(pluginsDir).install(missingPeer), 'peer_missing')
  assert.deepEqual(await recursiveListing(pluginsDir), before)
  assert.equal(await exists(join(pluginsDir, 'plugins.json')), false)
  assert.equal(await exists(join(pluginsDir, 'plugins.lock.json')), false)
})

test('peer checks use loaded services and only enabled installed providers', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const provider = await writePlugin(join(base, 'provider'), {
    id: 'guanxi.provider',
    provides: ['test.shared'],
  })
  const consumer = await writePlugin(join(base, 'consumer'), {
    id: 'guanxi.consumer',
    requires: ['test.shared'],
  })
  const loadedConsumer = await writePlugin(join(base, 'loaded-consumer'), {
    id: 'guanxi.loaded-consumer',
    requires: ['test.loaded'],
  })
  const laterConsumer = await writePlugin(join(base, 'later-consumer'), {
    id: 'guanxi.later-consumer',
    requires: ['test.shared'],
  })

  await manager(pluginsDir, { loaded: () => ({ provides: ['test.loaded'] }) }).install(loadedConsumer)
  await manager(pluginsDir).install(provider)
  await manager(pluginsDir).install(consumer)
  await rejectsWithCode(manager(pluginsDir).setEnabled('guanxi.provider', false), 'dependency_in_use')
  assert.equal(manager(pluginsDir).list().find(entry => entry.id === 'guanxi.provider')?.enabled, true)
  await manager(pluginsDir).setEnabled('guanxi.consumer', false)
  await manager(pluginsDir).setEnabled('guanxi.provider', false)

  await rejectsWithCode(manager(pluginsDir).install(laterConsumer), 'peer_missing')
  assert.equal(await exists(join(pluginsDir, 'guanxi.later-consumer@1.0.0')), false)

  await manager(pluginsDir).setEnabled('guanxi.provider', true)
  await manager(pluginsDir).install(laterConsumer)
  assert.deepEqual(manager(pluginsDir).list().map(entry => entry.id), [
    'guanxi.consumer',
    'guanxi.later-consumer',
    'guanxi.loaded-consumer',
    'guanxi.provider',
  ])
})

test('an upgrade cannot count its own old version as a peer provider', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const first = await writePlugin(join(base, 'v1'), {
    id: 'guanxi.evolving',
    version: '1.0.0',
    provides: ['test.old-service'],
  })
  const second = await writePlugin(join(base, 'v2'), {
    id: 'guanxi.evolving',
    version: '2.0.0',
    requires: ['test.old-service'],
  })
  await manager(pluginsDir).install(first)
  await rejectsWithCode(manager(pluginsDir).install(second), 'peer_missing')
  assert.equal(await exists(join(pluginsDir, 'guanxi.evolving@2.0.0')), false)
  assert.equal(await exists(join(pluginsDir, 'guanxi.evolving@1.0.0')), true)
})

test('refuses unapproved build scripts and never runs approved ones', async t => {
  const base = await tempBase(t)
  const marker = join(base, 'script-ran')
  const source = await writePlugin(join(base, 'source'), {
    scripts: { postinstall: 'node build.js' },
    files: {
      'build.js': `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`,
      'index.js': 'export const value = 1\n',
    },
  })
  const pluginsDir = join(base, 'plugins')

  await rejectsWithCode(manager(pluginsDir).install(source), 'build_scripts_unapproved')
  assert.equal(await exists(marker), false)
  assert.equal(await exists(pluginsDir), false)

  const installed = await manager(pluginsDir).install(source, { approveBuildScripts: true })
  assert.equal(await exists(marker), false, 'approval records permission, it does not execute scripts')
  assert.equal(installed.buildScriptsApproved, true)
  assert.deepEqual(installed.buildScripts, ['postinstall'])
})

test('refuses T0 and T2 trust tiers', async t => {
  const base = await tempBase(t)
  for (const trust of ['T0', 'T2'] as const) {
    const source = await writePlugin(join(base, trust), { id: `guanxi.${trust.toLowerCase()}-plugin`, trust })
    const pluginsDir = join(base, `plugins-${trust}`)
    await rejectsWithCode(manager(pluginsDir).install(source), 'trust_tier_unsupported')
    assert.equal(await exists(pluginsDir), false, `${trust} was refused before any write`)
  }
})

test('refuses expected integrity and staged-copy mismatches, then cleans up', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))
  const pluginsDir = join(base, 'plugins')

  await rejectsWithCode(
    manager(pluginsDir).install(source, { expectedIntegrity: `sha256-${'0'.repeat(64)}` }),
    'integrity_mismatch',
  )
  assert.equal(await exists(pluginsDir), false)

  const tamperingHooks: PluginManagerHooks = {
    point: async name => {
      if (name !== 'install:copied') return
      const staged = await readdir(join(pluginsDir, '.staging'))
      assert.equal(staged.length, 1)
      await writeFile(join(pluginsDir, '.staging', staged[0]!, 'extra.js'), 'tampered\n')
    },
  }
  await rejectsWithCode(manager(pluginsDir, { hooks: tamperingHooks }).install(source), 'integrity_mismatch')
  assert.equal(await exists(pluginsDir), false)
})

test('refuses a source that changes after inspection and before copying', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))
  const pluginsDir = join(base, 'plugins')
  const hooks: PluginManagerHooks = {
    point: async name => {
      if (name === 'install:staging-created') {
        await writeFile(join(source, 'index.js'), 'changed after inspection\n')
      }
    },
  }
  await rejectsWithCode(manager(pluginsDir, { hooks }).install(source), 'integrity_mismatch')
  assert.equal(await exists(pluginsDir), false)
})

test('rolls back byte-for-byte at every install fault point', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })
  await manager(pluginsDir).install(first)
  const before = await stateBytes(pluginsDir)
  const beforeListing = await topLevel(pluginsDir)
  const beforeContent = await readFile(join(pluginsDir, 'guanxi.test-plugin@1.0.0', 'index.js'), 'utf8')
  assert.deepEqual(FAULT_POINTS, INSTALL_FAULT_POINTS)

  for (const point of INSTALL_FAULT_POINTS) {
    const hooks: PluginManagerHooks = {
      point: name => {
        if (name === point) throw new Error(`fault:${point}`)
      },
    }
    await assert.rejects(manager(pluginsDir, { hooks }).install(second), new RegExp(`fault:${point}`))
    assert.deepEqual(await stateBytes(pluginsDir), before, `state bytes after ${point}`)
    assert.deepEqual(await topLevel(pluginsDir), beforeListing, `directory listing after ${point}`)
    assert.equal(await exists(join(pluginsDir, '.staging')), false, `staging after ${point}`)
    assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@2.0.0')), false, `partial v2 after ${point}`)
    assert.equal(
      await readFile(join(pluginsDir, 'guanxi.test-plugin@1.0.0', 'index.js'), 'utf8'),
      beforeContent,
      `old content after ${point}`,
    )
    const listed = manager(pluginsDir).list()
    assert.deepEqual(
      listed.map(entry => ({ id: entry.id, version: entry.version, enabled: entry.enabled })),
      [{ id: DEFAULT_ID, version: '1.0.0', enabled: true }],
      `list after ${point}`,
    )
  }
})

test('an upgrade failure keeps the old version installed and enabled', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })
  await manager(pluginsDir).install(first)
  const before = await stateBytes(pluginsDir)
  const hooks: PluginManagerHooks = {
    point: name => {
      if (name === 'install:plugin-renamed') throw new Error('upgrade fault')
    },
  }

  await assert.rejects(manager(pluginsDir, { hooks }).install(second), /upgrade fault/)
  assert.deepEqual(await stateBytes(pluginsDir), before)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@1.0.0')), true)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@2.0.0')), false)
  assert.deepEqual(
    manager(pluginsDir).list().map(entry => ({ version: entry.version, enabled: entry.enabled })),
    [{ version: '1.0.0', enabled: true }],
  )

  const upgraded = await manager(pluginsDir).install(second)
  assert.equal(upgraded.version, '2.0.0')
  assert.equal(upgraded.enabled, true)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@1.0.0')), false)
  assert.equal(await exists(join(pluginsDir, 'guanxi.test-plugin@2.0.0')), true)
})

test('setEnabled and uninstall roll back byte-for-byte at every fault point', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  await manager(pluginsDir).install(source)
  await manager(pluginsDir).setEnabled(DEFAULT_ID, false)
  const disabled = await stateBytes(pluginsDir)

  for (const point of SET_ENABLED_FAULT_POINTS) {
    const hooks: PluginManagerHooks = {
      point: name => {
        if (name === point) throw new Error(`fault:${point}`)
      },
    }
    await assert.rejects(manager(pluginsDir, { hooks }).setEnabled(DEFAULT_ID, true), /fault:/)
    assert.deepEqual(await stateBytes(pluginsDir), disabled, `setEnabled state after ${point}`)
    assert.equal(manager(pluginsDir).list()[0]?.enabled, false, `setEnabled list after ${point}`)
  }

  await manager(pluginsDir).setEnabled(DEFAULT_ID, true)
  const enabled = await stateBytes(pluginsDir)
  const installedPath = join(pluginsDir, 'guanxi.test-plugin@1.0.0')
  for (const point of UNINSTALL_FAULT_POINTS) {
    const hooks: PluginManagerHooks = {
      point: name => {
        if (name === point) throw new Error(`fault:${point}`)
      },
    }
    await assert.rejects(manager(pluginsDir, { hooks }).uninstall(DEFAULT_ID), /fault:/)
    assert.deepEqual(await stateBytes(pluginsDir), enabled, `uninstall state after ${point}`)
    assert.equal(await exists(installedPath), true, `plugin directory after ${point}`)
    assert.equal(await exists(join(pluginsDir, '.staging')), false, `staging after ${point}`)
    assert.equal(manager(pluginsDir).list().length, 1, `list after ${point}`)
  }

  await manager(pluginsDir).uninstall(DEFAULT_ID)
  assert.deepEqual(manager(pluginsDir).list(), [])
  assert.equal(await exists(installedPath), false)
})

test('semver range forms are checked and unsupported forms are rejected', async t => {
  const cases: readonly [string, string, boolean][] = [
    ['^0.1.0', '0.1.9', true],
    ['^0.1.0', '0.2.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['^1.2.3', '1.9.9', true],
    ['^1.2.3', '2.0.0', false],
    ['~0.1.0', '0.1.9', true],
    ['~0.1.0', '0.2.0', false],
    ['>=0.1.0 <0.2.0', '0.1.9', true],
    ['>=0.1.0 <0.2.0', '0.2.0', false],
    ['0.1.0', '0.1.0', true],
    ['0.1.0', '0.1.1', false],
  ]
  for (const [range, version, expected] of cases) {
    assert.equal(satisfiesGuanxiRange(range, version), expected, `${range} against ${version}`)
  }
  for (const unsupported of ['0.1', '*', '^0.1.0 || ^0.2.0', '>0.1.0', '<=0.1.0', '0.1.0 - 0.2.0']) {
    assert.throws(() => satisfiesGuanxiRange(unsupported, '0.1.0'), ManifestError, unsupported)
  }

  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'), { engines: '~0.1.0' })
  const installed = await manager(join(base, 'plugins'), { kernelApiVersion: '0.1.9' }).install(source)
  assert.equal(installed.version, '1.0.0')
})

test('refuses a plugin without a safe package version before writing', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'), { version: 'not a version' })
  const pluginsDir = join(base, 'plugins')
  await rejectsWithCode(manager(pluginsDir).install(source), 'invalid_plugin_version')
  assert.equal(await exists(pluginsDir), false)
})

test('recover removes staging, stale temporary state, and unreferenced plugin directories', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  const plugins = manager(pluginsDir)
  const installed = await plugins.install(source)
  const backup = join(pluginsDir, 'guanxi.test-plugin@9.9.9')
  await mkdir(join(pluginsDir, '.staging', 'leftover'), { recursive: true })
  await writeFile(join(pluginsDir, '.staging', 'leftover', 'junk.js'), 'junk\n')
  await mkdir(backup, { recursive: true })
  await writeFile(join(backup, 'junk.js'), 'junk\n')
  await mkdir(join(pluginsDir, 'not-a-plugin'), { recursive: true })
  await writeFile(join(pluginsDir, '.plugins.json.deadbeef.tmp'), 'stale\n')

  const fresh = manager(pluginsDir)
  const report = await fresh.recover()
  assert.deepEqual(report.removedDirectories, ['guanxi.test-plugin@9.9.9'])
  assert.equal(report.removedStaging, true)
  assert.deepEqual(report.removedTemporaryFiles, ['.plugins.json.deadbeef.tmp'])
  assert.equal(await exists(join(pluginsDir, '.staging')), false)
  assert.equal(await exists(backup), false)
  assert.equal(await exists(join(pluginsDir, 'not-a-plugin')), true, 'unrelated directories are kept')
  assert.deepEqual(fresh.bootSet(), [installed.path])
  assert.deepEqual(fresh.list().map(entry => entry.version), ['1.0.0'])
})

test('recovery skips while the exclusive lock is held and keeps the in-flight directory', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  const installed = await manager(pluginsDir).install(source)
  const inFlight = join(pluginsDir, 'guanxi.test-plugin@2.0.0')
  await mkdir(inFlight, { recursive: true })
  await writeFile(join(inFlight, 'index.js'), 'another process is still installing\n')
  const lockPath = join(pluginsDir, '.lock')
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: process.pid, token: 'other-process', createdAt: new Date().toISOString() })}\n`,
  )

  const observer = manager(pluginsDir)
  const report = observer.recover()
  assert.equal(report.skipped, 'plugins_busy')
  assert.deepEqual(report.removedDirectories, [])
  assert.equal(await exists(inFlight), true, 'recover keeps an in-flight directory')
  assert.deepEqual(observer.list().map(entry => entry.version), ['1.0.0'])
  assert.equal(await exists(inFlight), true, 'list keeps an in-flight directory')
  assert.deepEqual(observer.bootSet(), [installed.path])
  assert.equal(await exists(inFlight), true, 'bootSet keeps an in-flight directory')

  await rm(lockPath)
  const swept = observer.recover()
  assert.equal(swept.skipped, undefined)
  assert.deepEqual(swept.removedDirectories, ['guanxi.test-plugin@2.0.0'])
  assert.equal(await exists(inFlight), false)
})

test('same-version reinstall is a no-op for identical integrity, refuses changed content', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  const plugins = manager(pluginsDir)
  const first = await plugins.install(source)
  const before = await stateBytes(pluginsDir)
  const beforeListing = await topLevel(pluginsDir)

  const again = await plugins.install(source)
  assert.equal(again.installedAt, first.installedAt, 'a no-op keeps the original install time')
  assert.deepEqual(await stateBytes(pluginsDir), before)
  assert.deepEqual(await topLevel(pluginsDir), beforeListing)

  await writeFile(join(source, 'index.js'), 'export const version = "changed"\n')
  await rejectsWithCode(plugins.install(source), 'version_exists')
  assert.deepEqual(await stateBytes(pluginsDir), before)
  assert.deepEqual(await topLevel(pluginsDir), beforeListing)
  assert.equal(
    await readFile(join(pluginsDir, 'guanxi.test-plugin@1.0.0', 'index.js'), 'utf8'),
    "export const version = '1.0.0'\n",
  )
  assert.deepEqual(plugins.bootSet(), [first.path])
})

test('same-version reinstall repairs a missing installed directory', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  const plugins = manager(pluginsDir)
  const first = await plugins.install(source)
  await rm(first.path, { recursive: true, force: true })
  assert.equal(await exists(first.path), false)
  assert.deepEqual(plugins.list().map(entry => entry.version), ['1.0.0'], 'the lock still names the version')

  const repaired = await plugins.install(source)
  assert.equal(repaired.version, '1.0.0')
  assert.equal(await exists(repaired.path), true, 'a missing directory is reinstalled')
  assert.equal(
    await readFile(join(repaired.path, 'index.js'), 'utf8'),
    "export const version = '1.0.0'\n",
  )
  assert.deepEqual(plugins.bootSet(), [repaired.path])
})

test('a crash at every install point recovers to a lockfile whose directories exist and boot', async t => {
  const base = await tempBase(t)
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })
  const lockRenamed = INSTALL_FAULT_POINTS.indexOf('install:lock-renamed')
  assert.ok(lockRenamed > 0)

  for (const [index, point] of INSTALL_FAULT_POINTS.entries()) {
    const pluginsDir = join(base, `crash-${index}`)
    await manager(pluginsDir).install(first)
    const crashing = manager(pluginsDir, {
      hooks: { point: name => {
        if (name === point) throw new SimulatedCrash(name)
      } },
    })
    await assert.rejects(crashing.install(second), (error: unknown) => {
      assert.ok(error instanceof SimulatedCrash, `crash at ${point}`)
      return true
    })

    const fresh = manager(pluginsDir)
    await fresh.recover()
    const locked = await lockEntries(pluginsDir)
    for (const [id, entry] of Object.entries(locked)) {
      assert.equal(await exists(join(pluginsDir, entry.directory)), true, `${id} after crash at ${point}`)
    }
    const expectedVersion = index >= lockRenamed ? '2.0.0' : '1.0.0'
    assert.deepEqual(fresh.bootSet(), [join(pluginsDir, `guanxi.test-plugin@${expectedVersion}`)], `boot after crash at ${point}`)
    const versions = fresh.list().map(entry => entry.version)
    assert.deepEqual(versions, [expectedVersion], `list after crash at ${point}`)
    assert.equal(await exists(join(pluginsDir, '.staging')), false, `staging after crash at ${point}`)
  }
})

test('a crash at every uninstall point recovers to a lockfile whose directories exist', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))
  const manifestRenamed = UNINSTALL_FAULT_POINTS.indexOf('uninstall:manifest-renamed')
  const lockRenamed = UNINSTALL_FAULT_POINTS.indexOf('uninstall:lock-renamed')
  assert.ok(manifestRenamed > 0)
  assert.ok(lockRenamed > manifestRenamed)

  for (const [index, point] of UNINSTALL_FAULT_POINTS.entries()) {
    const pluginsDir = join(base, `uninstall-crash-${index}`)
    const installed = await manager(pluginsDir).install(source)
    const crashing = manager(pluginsDir, {
      hooks: { point: name => {
        if (name === point) throw new SimulatedCrash(name)
      } },
    })
    await assert.rejects(crashing.uninstall(DEFAULT_ID), (error: unknown) => {
      assert.ok(error instanceof SimulatedCrash, `crash at ${point}`)
      return true
    })

    const fresh = manager(pluginsDir)
    await fresh.recover()
    const locked = await lockEntries(pluginsDir)
    for (const [id, entry] of Object.entries(locked)) {
      assert.equal(await exists(join(pluginsDir, entry.directory)), true, `${id} after crash at ${point}`)
    }
    const removed = index >= lockRenamed
    assert.deepEqual(
      fresh.list().map(entry => entry.version),
      removed ? [] : ['1.0.0'],
      `list after crash at ${point}`,
    )
    assert.deepEqual(
      fresh.bootSet(),
      !removed && index < manifestRenamed ? [installed.path] : [],
      `boot after crash at ${point}`,
    )
    assert.equal(await exists(join(pluginsDir, '.staging')), false, `staging after crash at ${point}`)
  }
})

test('bootSet skips and reports missing directories and changed integrity', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))

  const missingDir = join(base, 'missing')
  const missing = await manager(missingDir).install(source)
  await rm(missing.path, { recursive: true, force: true })
  const missingSkips: BootSkip[] = []
  assert.deepEqual(manager(missingDir).bootSet({ onSkip: skip => missingSkips.push(skip) }), [])
  assert.deepEqual(missingSkips.map(skip => ({ id: skip.id, reason: skip.reason })), [
    { id: DEFAULT_ID, reason: 'missing_directory' },
  ])

  const changedDir = join(base, 'changed')
  const changed = await manager(changedDir).install(source)
  await writeFile(join(changed.path, 'index.js'), 'tampered\n')
  const changedSkips: BootSkip[] = []
  assert.deepEqual(manager(changedDir).bootSet({ onSkip: skip => changedSkips.push(skip) }), [])
  assert.deepEqual(changedSkips.map(skip => ({ id: skip.id, reason: skip.reason })), [
    { id: DEFAULT_ID, reason: 'integrity_mismatch' },
  ])
})

test('rolls back a fresh install into a missing plugins directory at every fault point', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))
  const missing: StateBytes = { plugins: null, lock: null }

  for (const [index, point] of INSTALL_FAULT_POINTS.entries()) {
    const pluginsDir = join(base, `fresh-${index}`)
    const hooks: PluginManagerHooks = {
      point: name => {
        if (name === point) throw new Error(`fault:${point}`)
      },
    }
    await assert.rejects(manager(pluginsDir, { hooks }).install(source), new RegExp(`fault:${point}`))
    assert.deepEqual(await stateBytes(pluginsDir), missing, `state bytes after ${point}`)
    assert.deepEqual(await topLevel(pluginsDir), [], `directory listing after ${point}`)
    assert.equal(await exists(pluginsDir), false, `plugins directory after ${point}`)
  }

  const pluginsDir = join(base, 'happy')
  const fired: string[] = []
  const installed = await manager(pluginsDir, {
    hooks: { point: name => { fired.push(name) } },
  }).install(source)
  assert.deepEqual(fired, INSTALL_FAULT_POINTS, 'a happy install fires every declared point once, in order')
  assert.equal(await exists(installed.path), true)
})

test('same-version installs leave state untouched at every fault point', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const source = await writePlugin(join(base, 'source'))
  const changed = await writePlugin(join(base, 'changed'), {
    files: { 'index.js': 'export const version = "changed"\n' },
  })
  await manager(pluginsDir).install(source)
  const before = await stateBytes(pluginsDir)
  const beforeListing = await topLevel(pluginsDir)
  const lastDecision = INSTALL_FAULT_POINTS.indexOf('install:expected-integrity')
  assert.ok(lastDecision > 0)

  for (const [index, point] of INSTALL_FAULT_POINTS.entries()) {
    const hooks: PluginManagerHooks = {
      point: name => {
        if (name === point) throw new Error(`fault:${point}`)
      },
    }
    if (index <= lastDecision) {
      await assert.rejects(
        manager(pluginsDir, { hooks }).install(source),
        new RegExp(`fault:${point}`),
        `identical reinstall at ${point}`,
      )
    } else {
      const record = await manager(pluginsDir, { hooks }).install(source)
      assert.equal(record.version, '1.0.0')
    }
    assert.deepEqual(await stateBytes(pluginsDir), before, `identical reinstall state after ${point}`)
    assert.deepEqual(await topLevel(pluginsDir), beforeListing, `identical reinstall listing after ${point}`)

    if (index <= lastDecision) {
      await assert.rejects(
        manager(pluginsDir, { hooks }).install(changed),
        new RegExp(`fault:${point}`),
        `changed reinstall at ${point}`,
      )
    } else {
      await rejectsWithCode(manager(pluginsDir, { hooks }).install(changed), 'version_exists')
    }
    assert.deepEqual(await stateBytes(pluginsDir), before, `changed reinstall state after ${point}`)
    assert.deepEqual(await topLevel(pluginsDir), beforeListing, `changed reinstall listing after ${point}`)
  }

  assert.deepEqual(manager(pluginsDir).bootSet(), [join(pluginsDir, 'guanxi.test-plugin@1.0.0')])
})

test('rollback failures are attached to the thrown error as a cause chain', async t => {
  const base = await tempBase(t)
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })

  const installDir = join(base, 'install')
  await manager(installDir).install(first)
  const installHooks: PluginManagerHooks = {
    point: async name => {
      if (name !== 'install:plugin-renamed') return
      const statePath = join(installDir, 'plugins.json')
      await rm(statePath)
      await mkdir(statePath)
      throw new Error('commit fault')
    },
  }
  let installError: unknown
  try {
    await manager(installDir, { hooks: installHooks }).install(second)
  } catch (error) {
    installError = error
  }
  assert.ok(installError instanceof Error)
  assert.match(installError.message, /commit fault/)
  assert.ok(installError.cause instanceof AggregateError, 'install rollback failure is attached')
  assert.ok(installError.cause.errors.length >= 1)
  assert.match(String(installError.cause.errors[0]), /plugins\.json/)

  const uninstallDir = join(base, 'uninstall')
  await manager(uninstallDir).install(first)
  const uninstallHooks: PluginManagerHooks = {
    point: async name => {
      if (name !== 'uninstall:lock-renamed') return
      const statePath = join(uninstallDir, 'plugins.json')
      await rm(statePath)
      await mkdir(statePath)
      throw new Error('uninstall fault')
    },
  }
  let uninstallError: unknown
  try {
    await manager(uninstallDir, { hooks: uninstallHooks }).uninstall(DEFAULT_ID)
  } catch (error) {
    uninstallError = error
  }
  assert.ok(uninstallError instanceof Error)
  assert.match(uninstallError.message, /uninstall fault/)
  assert.ok(uninstallError.cause instanceof AggregateError, 'uninstall rollback failure is attached')
  assert.ok(uninstallError.cause.errors.length >= 1)
})

test('refuses hardlinked source files', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'), {
    files: { 'index.js': 'export const value = 1\n', 'shared.js': 'export const shared = 1\n' },
  })
  await link(join(source, 'shared.js'), join(source, 'alias.js'))
  const pluginsDir = join(base, 'plugins')
  await assert.rejects(manager(pluginsDir).inspect(source), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_hardlink')
    return true
  })
  await assert.rejects(manager(pluginsDir).install(source), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_hardlink')
    return true
  })
  assert.equal(await exists(pluginsDir), false)
})

test('refuses a FIFO source entry without blocking', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))
  try {
    execFileSync('mkfifo', [join(source, 'pipe')])
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      t.skip('mkfifo is unavailable on this host')
      return
    }
    throw error
  }
  const pluginsDir = join(base, 'plugins')
  await assert.rejects(manager(pluginsDir).inspect(source), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_not_regular')
    return true
  })
  await assert.rejects(manager(pluginsDir).install(source), (error: unknown) => {
    assert.ok(error instanceof SourceIntegrityError)
    assert.equal(error.code, 'source_not_regular')
    return true
  })
  assert.equal(await exists(pluginsDir), false)
})

test('requires a lock entry directory to equal id@version', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'))

  for (const [name, directory] of [['mismatch', 'elsewhere'], ['missing', undefined]] as const) {
    const pluginsDir = join(base, `lock-${name}`)
    await mkdir(pluginsDir, { recursive: true })
    const entry: Record<string, unknown> = {
      version: '1.0.0',
      integrity: `sha256-${'0'.repeat(64)}`,
      requires: [],
      provides: [],
      buildScripts: [],
      buildScriptsApproved: false,
      installedAt: null,
    }
    if (directory !== undefined) entry['directory'] = directory
    await writeFile(
      join(pluginsDir, 'plugins.lock.json'),
      `${JSON.stringify({ version: 1, plugins: { [DEFAULT_ID]: entry } }, null, 2)}\n`,
    )
    assert.throws(() => manager(pluginsDir).list(), (error: unknown) => {
      assert.ok(error instanceof PluginManagerError)
      assert.equal(error.code, 'invalid_state')
      return true
    })
    await rejectsWithCode(manager(pluginsDir).install(source), 'invalid_state')
  }
})

test('a second manager cannot install while the first holds the exclusive lock', async t => {
  const base = await tempBase(t)
  const pluginsDir = join(base, 'plugins')
  const first = await writePlugin(join(base, 'v1'), { version: '1.0.0' })
  const second = await writePlugin(join(base, 'v2'), { version: '2.0.0' })
  await manager(pluginsDir).install(first)

  let entered!: () => void
  let release!: () => void
  const atCommit = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  const holder = manager(pluginsDir, {
    hooks: {
      point: async name => {
        if (name !== 'install:staged-integrity') return
        entered()
        await hold
      },
    },
  })
  const installing = holder.install(second)
  await atCommit
  await rejectsWithCode(manager(pluginsDir).install(second), 'plugins_busy')
  release()
  const installed = await installing
  assert.equal(installed.version, '2.0.0')
  assert.equal(await exists(join(pluginsDir, '.lock')), false)
  assert.deepEqual(manager(pluginsDir).bootSet(), [installed.path])
})

test('refuses to remove or replace a service an enabled plugin requires', async t => {
  const base = await tempBase(t)
  const providerV1 = await writePlugin(join(base, 'provider-v1'), {
    id: 'guanxi.provider',
    version: '1.0.0',
    provides: ['test.shared'],
  })
  const providerV2 = await writePlugin(join(base, 'provider-v2'), {
    id: 'guanxi.provider',
    version: '2.0.0',
    provides: [],
  })
  const consumer = await writePlugin(join(base, 'consumer'), {
    id: 'guanxi.consumer',
    requires: ['test.shared'],
  })
  const pluginsDir = join(base, 'plugins')
  const plugins = manager(pluginsDir)
  await plugins.install(providerV1)
  await plugins.install(consumer)
  const before = await stateBytes(pluginsDir)
  const providerPath = join(pluginsDir, 'guanxi.provider@1.0.0')

  await rejectsWithCode(plugins.uninstall('guanxi.provider'), 'dependency_in_use')
  assert.equal(await exists(providerPath), true)
  await rejectsWithCode(plugins.setEnabled('guanxi.provider', false), 'dependency_in_use')
  assert.deepEqual(await stateBytes(pluginsDir), before)
  await rejectsWithCode(plugins.install(providerV2), 'dependency_in_use')
  assert.deepEqual(await stateBytes(pluginsDir), before)
  assert.equal(await exists(providerPath), true)
  assert.equal(await exists(join(pluginsDir, 'guanxi.provider@2.0.0')), false)

  await plugins.setEnabled('guanxi.consumer', false)
  const upgraded = await plugins.install(providerV2)
  assert.equal(upgraded.version, '2.0.0')
  assert.equal(await exists(providerPath), false)
  await plugins.uninstall('guanxi.provider')
  assert.deepEqual(plugins.list().map(entry => entry.id), ['guanxi.consumer'])
})

test('checks trust before build-script approval', async t => {
  const base = await tempBase(t)
  const source = await writePlugin(join(base, 'source'), {
    trust: 'T0',
    scripts: { postinstall: 'node build.js' },
  })
  const pluginsDir = join(base, 'plugins')
  const error = await rejectsWithCode(manager(pluginsDir).install(source), 'trust_tier_unsupported')
  assert.equal(error.details.pluginId, DEFAULT_ID)
  assert.equal(await exists(pluginsDir), false)
})
