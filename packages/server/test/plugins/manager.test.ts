/**
 * P1-b plugin manager: local T1 inspection, transactional install/upgrade,
 * peer and engine checks, and rollback at every injectable fault point.
 *
 * Every test uses a fresh temporary directory. No build script is ever run.
 */
import assert from 'node:assert/strict'
import {
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
  SourceIntegrityError,
  UNINSTALL_FAULT_POINTS,
  satisfiesGuanxiRange,
  type PluginManagerHooks,
  type PluginManagerOptions,
} from '../../src/plugins/manager.ts'

interface TestContext {
  after(callback: () => unknown): void
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
