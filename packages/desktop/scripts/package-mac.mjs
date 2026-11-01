import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract/brand'
import { createConfig } from '../electron-builder.config.mjs'
import { MAC_ARCH } from '../packaging/targets.mjs'
import { artifactEvidence } from './lib/package-evidence.mjs'

const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const identity = () => ({ commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') })
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, MAC_ARCH)
assert.equal(git('status', '--porcelain'), '', 'package build requires clean committed source')
assert.ok(process.argv.length === 2 || JSON.stringify(process.argv.slice(2)) === JSON.stringify(['--publish', 'never']), 'package builds never publish')
const source = identity()
const config = createConfig(process.env)
const pkg = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
for (const script of ['build.mjs', 'stage-service.mjs']) execFileSync(process.execPath, [join(desktop, 'scripts', script)], { cwd: desktop, stdio: 'inherit' })
const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.config.mjs', '--mac', '--publish', 'never'], { cwd: desktop, stdio: 'inherit' })
assert.equal(git('status', '--porcelain'), '')
assert.deepEqual(identity(), source, 'source changed during package build')
const stem = `${PRODUCT_FILE_PREFIX}-desktop-${pkg.version}-${MAC_ARCH}`
const receipt = await artifactEvidence({ files: ['dmg', 'zip'].map(ext => join(desktop, 'release', `${stem}.${ext}`)), ...source,
  version: pkg.version, appId: config.appId, architecture: MAC_ARCH })
// This verifier currently covers ad-hoc packages. Signed builds keep their identity explicit.
receipt.signing = config.mac.identity === null ? 'ad-hoc' : 'developer-id'
receipt.notarized = config.mac.notarize
await writeFile(join(desktop, 'release', 'build-evidence.json'), JSON.stringify(receipt, null, 2) + '\n')
