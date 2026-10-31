// Stages the node service that the packaged app runs (Resources/service): the CLI bundle with its web UI
// and workers, plus its production dependencies installed beside it. The shell starts it as
// `Electron(ELECTRON_RUN_AS_NODE) service/bin.js --port --data-dir --no-open`.
//
//   node scripts/stage-service.mjs            build web + CLI, then stage
//   node scripts/stage-service.mjs --no-build stage from existing packages/cli/dist
//
// Dependencies install with --ignore-scripts: every native package used here ships N-API prebuilds or
// WebAssembly, so nothing is compiled on the machine that packages.
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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
  `${JSON.stringify({ name: 'guanxi-service', version: cli.version, private: true, type: 'module', dependencies: cli.dependencies }, null, 2)}\n`,
)
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], out)

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
