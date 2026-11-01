// Stages the node service that the packaged app runs (Resources/service): the CLI bundle with its web UI and
// workers, its production dependencies, and a pinned official Node.js. The shell starts it as
// `service/node/bin/node service/bin.js --port --data-dir --no-open`. The service forks and spawns
// `process.execPath` for its sandbox, index and storage helpers, so it must run on a real Node, not on the
// Electron binary.
//
//   node scripts/stage-service.mjs            build web + CLI, then stage
//   node scripts/stage-service.mjs --no-build stage from existing packages/cli/dist
//
// - Dependencies come from the repository lockfile (scripts/lib/service-lock.mjs), installed with `npm ci
//   --ignore-scripts`: the shipped tree is the tested tree, integrity-checked, and nothing floats. Every native
//   package used here ships N-API prebuilds or WebAssembly, so nothing is compiled on the machine that packages.
// - Node.js is verified against a SHA-256 pinned in scripts/lib/node-runtime.mjs and extracted from the verified
//   bytes.
// - It builds for one CPU (packaging/targets.mjs) and refuses to run on another: prebuilds and the Node binary are
//   host-specific.
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract/brand'
import { MAC_ARCH } from '../packaging/targets.mjs'
import { NODE_SHA256, NODE_VERSION, archiveName, archiveUrl, extractNodeRuntime, removeStaleUnpacks, verifiedArchive } from './lib/node-runtime.mjs'
import { serviceLock } from './lib/service-lock.mjs'
import { verifyStagedService } from './lib/verify-stage.mjs'
import { collectLegalNotices } from './lib/legal-notices.mjs'

const root = resolve(import.meta.dirname, '../../..')
const stage = resolve(import.meta.dirname, '../.stage')
const out = join(stage, 'service')
const cliDist = join(root, 'packages/cli/dist')

if (process.platform !== 'darwin' || process.arch !== MAC_ARCH) {
  throw new Error(`The macOS package is built for darwin-${MAC_ARCH} and must be staged on it (this host is ${process.platform}-${process.arch}): native prebuilds and Node.js are host-specific`)
}
const platformKey = `${process.platform}-${process.arch}`

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

if (!process.argv.includes('--no-build')) {
  run('npm', ['run', 'build', '--workspace', '@guanxi/web'], root)
  run('npm', ['run', 'build', '--workspace', 'guanxi'], root)
}
await stat(join(cliDist, 'bin.js')).catch(() => {
  throw new Error('packages/cli/dist/bin.js is missing: run without --no-build')
})

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(cliDist, out, { recursive: true, filter: (source) => !source.endsWith('.map') })

// Production dependencies of the CLI exactly as the root lockfile resolved them.
const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'))
const name = `${PRODUCT_FILE_PREFIX}-service`
const rootLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const lock = serviceLock(rootLock, { workspace: 'packages/cli', name, version: cli.version })
await writeFile(join(out, 'package.json'), `${JSON.stringify({ name, version: cli.version, private: true, type: 'module', dependencies: cli.dependencies }, null, 2)}\n`)
await writeFile(join(out, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], out)

// Legal texts include bundled assets and an explicitly labelled npm build/runtime superset.
// Only lock-derived root node_modules paths and allowlisted top-level notice files are read.
await collectLegalNotices({ repository: root, destination: join(out, 'licenses'), lock: rootLock })

// The pinned Node.js, verified against its digest (cached beside the stage, re-verified on every use).
const cache = join(stage, 'cache')
await removeStaleUnpacks(cache)
const expected = NODE_SHA256[platformKey]
if (!expected) throw new Error(`No pinned Node.js digest for ${platformKey}; add one to scripts/lib/node-runtime.mjs`)
const bytes = await verifiedArchive({
  cachePath: join(cache, archiveName(platformKey)),
  url: archiveUrl(platformKey),
  expected,
  log: (line) => console.log(line),
})
await extractNodeRuntime({ bytes, expected, destination: join(out, 'node'), workDir: cache })

// Slim the bundle: keep only this platform's N-API prebuilds, and drop grammar C sources (only a compiler uses them).
async function prune(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === 'prebuilds') {
      for (const platform of await readdir(path)) if (platform !== platformKey) await rm(join(path, platform), { recursive: true, force: true })
    } else if (entry.name === 'src' && /tree-sitter-/.test(directory)) {
      await rm(path, { recursive: true, force: true })
    } else {
      await prune(path)
    }
  }
}
await prune(join(out, 'node_modules'))

// Pre-pack check: what electron-builder is about to copy into the app is complete and runs.
await verifyStagedService(out, {
  nodeVersion: NODE_VERSION,
  run: (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed (${result.status})`)
    return result.stdout
  },
})

console.log(`staged service in ${out}: ${(await readdir(out)).sort().join(', ')}`)
