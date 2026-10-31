// Bundles the Electron main process (ESM) and the sandboxed preload (CommonJS) into dist/.
// The service is not bundled here: it is the CLI entry, staged separately (scripts/stage-service.mjs).
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const common = { bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' }

await build({
  ...common,
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(dist, 'main.js'),
  format: 'esm',
})

// A sandboxed preload cannot be an ES module.
await build({
  ...common,
  entryPoints: [resolve(root, 'src/preload.ts')],
  outfile: resolve(dist, 'preload.cjs'),
  format: 'cjs',
})
