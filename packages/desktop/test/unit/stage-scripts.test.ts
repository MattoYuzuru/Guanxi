import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import afterSign from '../../scripts/after-sign.mjs'
import { DigestMismatch, NODE_SHA256, NODE_VERSION, archiveName, archiveUrl, extractNodeRuntime, removeStaleUnpacks, sha256, verifiedArchive } from '../../scripts/lib/node-runtime.mjs'
import { ServiceLockError, serviceLock } from '../../scripts/lib/service-lock.mjs'
import { teamIdentifier, trueEntitlements, verifyNestedSignatures } from '../../scripts/lib/verify-signature.mjs'
import { verifyStagedService } from '../../scripts/lib/verify-stage.mjs'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guanxi-stage-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('pinned Node.js archive', () => {
  const bytes = Buffer.from('pretend this is a tarball')
  const digest = sha256(bytes)
  const ok = (body: Buffer) => async (_url: string, init?: { signal?: AbortSignal }) => {
    assert.ok(init?.signal, 'the download has a timeout signal')
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
  }

  it('pins digests for macOS and a version string that matches the archive URL', () => {
    assert.match(NODE_SHA256['darwin-arm64'], /^[0-9a-f]{64}$/)
    assert.equal(archiveName('darwin-arm64'), `node-v${NODE_VERSION}-darwin-arm64.tar.gz`)
    assert.equal(archiveUrl('darwin-arm64'), `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`)
  })

  it('uses a cached archive only if it matches the pinned digest', async () => {
    const cachePath = join(dir, 'cache', 'node.tar.gz')
    mkdirSync(join(dir, 'cache'))
    writeFileSync(cachePath, bytes)
    const never = async () => { throw new Error('must not download') }
    assert.deepEqual(await verifiedArchive({ cachePath, url: 'u', expected: digest, fetchImpl: never }), bytes)
    // A tampered cache is replaced by a verified download.
    writeFileSync(cachePath, 'tampered')
    assert.deepEqual(await verifiedArchive({ cachePath, url: 'u', expected: digest, fetchImpl: ok(bytes) }), bytes)
    assert.deepEqual(readFileSync(cachePath), bytes)
  })

  it('rejects a download whose digest is wrong and caches nothing', async () => {
    const cachePath = join(dir, 'cache', 'node.tar.gz')
    await assert.rejects(verifiedArchive({ cachePath, url: 'u', expected: digest, fetchImpl: ok(Buffer.from('evil')) }), DigestMismatch)
    assert.equal(existsSync(cachePath), false)
  })

  it('rejects an HTTP error', async () => {
    await assert.rejects(verifiedArchive({ cachePath: join(dir, 'x'), url: 'u', expected: digest, fetchImpl: async () => ({ ok: false, status: 503 }) as never }), /503/)
  })

  it('extracts from a fresh private file made of the verified bytes, and always removes it', async () => {
    const work = join(dir, 'work')
    const seen: string[] = []
    const fakeTar = (command: string, args: string[]) => {
      assert.equal(command, 'tar')
      const archive = args[1]!
      const into = args[3]!
      assert.deepEqual(readFileSync(archive), bytes, 'tar reads the verified bytes')
      assert.equal(statSync(archive).mode & 0o777, 0o600)
      seen.push(archive)
      mkdirSync(join(into, 'bin'), { recursive: true })
      writeFileSync(join(into, 'bin', 'node'), '#!node')
      writeFileSync(join(into, 'LICENSE'), 'MIT')
    }
    await extractNodeRuntime({ bytes, expected: digest, destination: join(dir, 'out', 'node'), workDir: work, run: fakeTar })
    assert.equal(readFileSync(join(dir, 'out', 'node', 'bin', 'node'), 'utf8'), '#!node')
    assert.equal(statSync(join(dir, 'out', 'node', 'bin', 'node')).mode & 0o777, 0o755)
    assert.equal(existsSync(seen[0]!), false)
    assert.deepEqual(readdirSync(work), [], 'no unpack-* left behind')
  })

  it('cleans up the scratch directory when extraction fails, and refuses unverified bytes before touching disk', async () => {
    const work = join(dir, 'work')
    await assert.rejects(extractNodeRuntime({ bytes, expected: digest, destination: join(dir, 'o'), workDir: work, run: () => { throw new Error('tar failed') } }), /tar failed/)
    assert.deepEqual(readdirSync(work), [])
    await assert.rejects(extractNodeRuntime({ bytes: Buffer.from('other'), expected: digest, destination: join(dir, 'o2'), workDir: join(dir, 'never'), run: () => undefined }), DigestMismatch)
    assert.equal(existsSync(join(dir, 'never')), false)
  })

  it('removes unpack-* leftovers of a killed run and nothing else', async () => {
    const work = join(dir, 'work')
    mkdirSync(join(work, 'unpack-abc'), { recursive: true })
    mkdirSync(join(work, 'keep'))
    await removeStaleUnpacks(work)
    assert.deepEqual(readdirSync(work), ['keep'])
  })

  it('extracts a real tar.gz with the system tar', async () => {
    const tree = join(dir, 'node-v1-darwin-arm64')
    mkdirSync(join(tree, 'bin'), { recursive: true })
    writeFileSync(join(tree, 'bin', 'node'), 'binary')
    writeFileSync(join(tree, 'LICENSE'), 'license text')
    writeFileSync(join(tree, 'extra'), 'dropped')
    execFileSync('tar', ['-czf', join(dir, 'node.tar.gz'), '-C', dir, 'node-v1-darwin-arm64'])
    const real = readFileSync(join(dir, 'node.tar.gz'))
    await extractNodeRuntime({ bytes: real, expected: sha256(real), destination: join(dir, 'dest'), workDir: join(dir, 'w') })
    assert.deepEqual(readdirSync(join(dir, 'dest')).sort(), ['LICENSE', 'bin'])
    assert.equal(readFileSync(join(dir, 'dest', 'bin', 'node'), 'utf8'), 'binary')
  })
})

describe('serviceLock: the shipped tree is the tree the repository locked', () => {
  const entry = (extra: object = {}) => ({ version: '1.0.0', resolved: 'https://registry/x.tgz', integrity: 'sha512-x', ...extra })

  it('lifts the workspace’s nested modules, keeps hoisted paths, drops dev-only packages', () => {
    const lock = serviceLock(
      {
        packages: {
          '': {},
          'packages/cli': { dependencies: { a: '^1', b: '^1' }, devDependencies: { d: '^1' } },
          'node_modules/a': entry({ dependencies: { c: '^1' } }),
          'packages/cli/node_modules/b': entry({ version: '2.0.0' }),
          'node_modules/b': entry({ version: '1.0.0' }),
          'node_modules/c': entry({ dev: true }),
          'node_modules/d': entry({ dev: true }),
        },
      },
      { workspace: 'packages/cli', name: 'svc', version: '9.9.9' },
    )
    assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/a', 'node_modules/b', 'node_modules/c'])
    assert.equal(lock.packages['node_modules/b']!.version, '2.0.0', 'the workspace’s own copy wins its place')
    assert.ok(!('dev' in lock.packages['node_modules/c']!))
    assert.equal(lock.lockfileVersion, 3)
  })

  it('keeps a nested dependency where its dependent finds it', () => {
    const lock = serviceLock(
      { packages: { 'packages/cli': { dependencies: { a: '^1' } }, 'node_modules/a': entry({ dependencies: { c: '^2' } }), 'node_modules/a/node_modules/c': entry({ version: '2.0.0' }), 'node_modules/c': entry() } },
      { workspace: 'packages/cli', name: 's', version: '1' },
    )
    assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/a', 'node_modules/a/node_modules/c'])
  })

  it('follows optional dependencies that exist and ignores optional ones that do not; a missing required one is an error', () => {
    const base = { 'packages/cli': { dependencies: { a: '^1' } }, 'node_modules/a': entry({ optionalDependencies: { 'a-darwin': '^1', 'a-gone': '^1' } }), 'node_modules/a-darwin': entry({ optional: true }) }
    const lock = serviceLock({ packages: base }, { workspace: 'packages/cli', name: 's', version: '1' })
    assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/a', 'node_modules/a-darwin'])
    assert.throws(() => serviceLock({ packages: { ...base, 'node_modules/a': entry({ dependencies: { missing: '^1' } }) } }, { workspace: 'packages/cli', name: 's', version: '1' }), ServiceLockError)
  })

  it('skips an optional peer, requires a normal one', () => {
    const packages = { 'packages/cli': { dependencies: { a: '^1' } }, 'node_modules/a': entry({ peerDependencies: { opt: '^1', req: '^1' }, peerDependenciesMeta: { opt: { optional: true } } }), 'node_modules/req': entry() }
    assert.deepEqual(Object.keys(serviceLock({ packages }, { workspace: 'packages/cli', name: 's', version: '1' }).packages), ['', 'node_modules/a', 'node_modules/req'])
  })

  it('refuses a layout it cannot reproduce instead of guessing (two packages for one path)', () => {
    const packages = {
      'packages/cli': { dependencies: { a: '^1', b: '^1' } },
      'packages/cli/node_modules/b': entry({ version: '2.0.0' }),
      'node_modules/a': entry({ dependencies: { b: '^1' } }),
      'node_modules/b': entry({ version: '1.0.0' }),
    }
    assert.throws(() => serviceLock({ packages }, { workspace: 'packages/cli', name: 's', version: '1' }), /Two different packages want node_modules\/b/)
  })

  it('refuses a workspace link and an unknown workspace', () => {
    assert.throws(() => serviceLock({ packages: { 'packages/cli': { dependencies: { w: '*' } }, 'node_modules/w': { resolved: 'packages/w', link: true } } }, { workspace: 'packages/cli', name: 's', version: '1' }), /workspace link/)
    assert.throws(() => serviceLock({ packages: {} }, { workspace: 'packages/cli', name: 's', version: '1' }), /not in the root lockfile/)
  })

  it('on the real repository lockfile: every CLI dependency is staged at the version and integrity the repository locked', () => {
    const root = resolve(import.meta.dirname, '../../../..')
    const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    const cli = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'))
    const lock = serviceLock(rootLock, { workspace: 'packages/cli', name: 'svc', version: cli.version })
    for (const name of Object.keys(cli.dependencies)) {
      const locked = rootLock.packages[`packages/cli/node_modules/${name}`] ?? rootLock.packages[`node_modules/${name}`]
      const staged = lock.packages[`node_modules/${name}`]
      assert.ok(staged, `${name} is staged`)
      assert.equal(staged.version, locked.version, name)
      assert.equal(staged.integrity, locked.integrity, name)
    }
    for (const [path, staged] of Object.entries(lock.packages)) {
      if (path === '') continue
      assert.ok(staged.integrity && staged.resolved, `${path} is pinned by integrity`)
      assert.ok(!('dev' in staged))
    }
    assert.ok(!Object.keys(lock.packages).some((path) => /electron|playwright|vite|react/.test(path)), 'no development tooling in the shipped tree')
  })
})

describe('verifyStagedService', () => {
  const stage = () => {
    const service = join(dir, 'service')
    mkdirSync(join(service, 'node', 'bin'), { recursive: true })
    mkdirSync(join(service, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(service, 'bin.js'), '')
    writeFileSync(join(service, 'node', 'bin', 'node'), '')
    chmodSync(join(service, 'node', 'bin', 'node'), 0o755)
    return service
  }
  const version = () => `v${NODE_VERSION}\n`

  it('accepts a complete service whose Node reports the pinned version', async () => {
    await verifyStagedService(stage(), { nodeVersion: NODE_VERSION, run: version })
  })
  it('rejects a missing or non-executable Node, a missing bundle, empty modules and a different Node version', async () => {
    const service = stage()
    await assert.rejects(verifyStagedService(service, { nodeVersion: NODE_VERSION, run: () => 'v1.0.0\n' }), /reports v1\.0\.0/)
    chmodSync(join(service, 'node', 'bin', 'node'), 0o644)
    await assert.rejects(verifyStagedService(service, { nodeVersion: NODE_VERSION, run: version }), /bundled Node\.js is missing/)
    rmSync(join(service, 'node'), { recursive: true })
    await assert.rejects(verifyStagedService(service, { nodeVersion: NODE_VERSION, run: version }), /bundled Node\.js/)
    rmSync(join(service, 'bin.js'))
    await assert.rejects(verifyStagedService(service, { nodeVersion: NODE_VERSION, run: version }), /CLI bundle/)
    const empty = stage()
    rmSync(join(empty, 'node_modules', 'x'), { recursive: true })
    await assert.rejects(verifyStagedService(empty, { nodeVersion: NODE_VERSION, run: version }), /empty node_modules|bin\.js/)
  })
})

describe('nested signatures (run on a signed build only)', () => {
  const entitlementsFile = resolve(import.meta.dirname, '../../packaging/entitlements.mac.plist')
  const app = '/x/Guanxi.app'
  const node = `${app}/Contents/Resources/service/node/bin/node`
  const addon = `${app}/Contents/Resources/service/node_modules/@napi-rs/keyring-darwin-arm64/keyring.node`
  const plist = (keys: string[]) => `<plist><dict>${keys.map((key) => `<key>${key}</key><true/>`).join('')}</dict></plist>`
  const APP_KEYS = ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']

  /** A fake codesign: per-path team and entitlements, and a set of paths that fail verification. */
  const codesign = (info: Record<string, { team: string | null; keys: string[] }>, invalid: string[] = []) => (_file: string, args: string[]) => {
    const target = args[args.length - 1]!
    if (args[0] === '--verify') {
      if (invalid.includes(target)) throw new Error('invalid signature')
      return ''
    }
    const fact = info[target]!
    if (args[0] === '-dvv') return `Identifier=x\nTeamIdentifier=${fact.team ?? 'not set'}\n`
    return plist(fact.keys)
  }
  const good = { team: 'ABCDE12345', keys: APP_KEYS }

  it('parses entitlements and Team IDs', () => {
    assert.deepEqual(trueEntitlements(plist(['b', 'a'])), ['a', 'b'])
    assert.deepEqual(trueEntitlements('<key>x</key><false/>'), [])
    assert.equal(teamIdentifier('TeamIdentifier=ABC'), 'ABC')
    assert.equal(teamIdentifier('TeamIdentifier=not set'), null)
    assert.equal(teamIdentifier('nothing'), null)
  })

  it('passes when the Node and every addon carry the app’s Team ID and exactly the app’s entitlements', async () => {
    const result = await verifyNestedSignatures({ appPath: app, entitlementsFile, binaries: [node, addon], run: codesign({ [app]: good, [node]: good, [addon]: good }) })
    assert.deepEqual(result, { team: 'ABCDE12345', checked: 2, entitlements: APP_KEYS })
  })

  it('fails on a different Team ID, extra or missing entitlements, an invalid signature, an unsigned app', async () => {
    const run = (info: Record<string, { team: string | null; keys: string[] }>, invalid: string[] = []) => verifyNestedSignatures({ appPath: app, entitlementsFile, binaries: [node, addon], run: codesign({ [app]: good, [node]: good, [addon]: good, ...info }, invalid) })
    await assert.rejects(run({ [node]: { team: 'OTHERTEAM1', keys: APP_KEYS } }), /Team ID OTHERTEAM1, expected ABCDE12345/)
    await assert.rejects(run({ [node]: { team: 'ABCDE12345', keys: [...APP_KEYS, 'com.apple.security.cs.disable-library-validation'] } }), /entitlements \[.*disable-library-validation/)
    await assert.rejects(run({ [addon]: { team: 'ABCDE12345', keys: [] } }), /entitlements \[\], expected/)
    await assert.rejects(run({}, [node]), /signature invalid/)
    await assert.rejects(run({ [app]: { team: null, keys: [] } }), /no Team ID/)
    await assert.rejects(verifyNestedSignatures({ appPath: app, entitlementsFile, binaries: [addon], run: codesign({ [app]: good, [addon]: good }) }), /bundled Node\.js was not found/)
  })

  it('the afterSign hook does nothing for an unsigned build or another platform', async () => {
    const context = { electronPlatformName: 'darwin', appOutDir: '/nowhere', packager: { appInfo: { productFilename: 'Guanxi' } } }
    const saved = process.env['GUANXI_DESKTOP_SIGN']
    delete process.env['GUANXI_DESKTOP_SIGN']
    try {
      await afterSign(context)
      await afterSign({ ...context, electronPlatformName: 'linux' })
      process.env['GUANXI_DESKTOP_SIGN'] = '1'
      await assert.rejects(afterSign(context), 'with signing on it really checks (the app does not exist here)')
    } finally {
      if (saved === undefined) delete process.env['GUANXI_DESKTOP_SIGN']
      else process.env['GUANXI_DESKTOP_SIGN'] = saved
    }
  })
})
