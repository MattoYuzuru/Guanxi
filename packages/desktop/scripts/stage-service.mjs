// Stages the node service that the packaged app runs (Resources/service): the CLI bundle with its web UI
// and workers, plus its production dependencies installed beside it, plus a pinned official Node.js. The shell
// starts it as `service/node/bin/node service/bin.js --port --data-dir --no-open`. The service forks and spawns
// `process.execPath` for its sandbox, index and storage helpers, so it must run on a real Node, not on the
// Electron binary.
//
//   node scripts/stage-service.mjs            build web + CLI, then stage
//   node scripts/stage-service.mjs --no-build stage from existing packages/cli/dist
//
// Dependencies install with --ignore-scripts: every native package used here ships N-API prebuilds or
// WebAssembly, so nothing is compiled on the machine that packages.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract/brand'

// Node.js 26.9.0 (released 2026-09-16) is the version the repository's CI runs. The digests are pinned here,
// copied from https://nodejs.org/dist/v26.9.0/SHASUMS256.txt; a download that does not match is rejected.
// Bump deliberately for security releases (hand-off, residual risk).
const NODE_VERSION = '26.9.0'
const NODE_SHA256 = {
  'darwin-arm64': '6f3de7ed853ee283b4bf24b6e426618f1d357401ce5815db1866eb85eb4b05d9',
  'darwin-x64': '06b2e742ed9025dc84adc830243b3f731956eac9c321bccd0ede384209af02a8',
}

const root = resolve(import.meta.dirname, '../../..')
const out = resolve(import.meta.dirname, '../.stage/service')
const cliDist = join(root, 'packages/cli/dist')

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

const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'))
await writeFile(
  join(out, 'package.json'),
  `${JSON.stringify({ name: `${PRODUCT_FILE_PREFIX}-service`, version: cli.version, private: true, type: 'module', dependencies: cli.dependencies }, null, 2)}\n`,
)
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], out)

// The pinned Node.js, verified against its digest, cached beside the stage.
const platformKey = `${process.platform}-${process.arch}`
const expectedDigest = NODE_SHA256[platformKey]
if (!expectedDigest) throw new Error(`No pinned Node.js digest for ${platformKey}; add one to scripts/stage-service.mjs`)
const archiveName = `node-v${NODE_VERSION}-${platformKey}.tar.gz`
const cache = resolve(import.meta.dirname, '../.stage/cache')
const archive = join(cache, archiveName)
await mkdir(cache, { recursive: true })
let bytes = await readFile(archive).catch(() => null)
if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`)
  if (!response.ok) throw new Error(`Node.js download failed: ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expectedDigest) throw new Error(`Node.js archive digest mismatch: ${digest}`)
  await writeFile(archive, bytes)
}
const unpacked = await mkdtemp(join(cache, 'unpack-'))
run('tar', ['-xzf', archive, '-C', unpacked, '--strip-components=1'], root)
await mkdir(join(out, 'node', 'bin'), { recursive: true })
await cp(join(unpacked, 'bin', 'node'), join(out, 'node', 'bin', 'node'))
await cp(join(unpacked, 'LICENSE'), join(out, 'node', 'LICENSE'))
await chmod(join(out, 'node', 'bin', 'node'), 0o755)
await rm(unpacked, { recursive: true, force: true })

// Slim the bundle: keep only this platform's N-API prebuilds (staging runs on the target OS and CPU),
// and drop grammar C sources, which only a compiler would use.
const target = `${process.platform}-${process.arch}`
async function prune(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === 'prebuilds') {
      for (const platform of await readdir(path)) if (platform !== target) await rm(join(path, platform), { recursive: true, force: true })
    } else if (entry.name === 'src' && /tree-sitter-/.test(directory)) {
      await rm(path, { recursive: true, force: true })
    } else {
      await prune(path)
    }
  }
}
await prune(join(out, 'node_modules'))

const entries = await readdir(out)
console.log(`staged service in ${out}: ${entries.sort().join(', ')}`)
