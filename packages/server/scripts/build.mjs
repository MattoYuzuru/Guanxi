import { chmod, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const packageRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(packageRoot, 'dist')
const outfile = resolve(outDir, 'server.js')

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [resolve(packageRoot, 'src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
})

await chmod(outfile, 0o755)
await build({
  entryPoints: [resolve(packageRoot, 'src/native-agent/sandbox-worker.ts')],
  outfile: resolve(outDir, 'sandbox-worker.js'), bundle: true, platform: 'node', target: 'node22',
  format: 'esm', external: ['@anthropic-ai/sandbox-runtime'],
})
