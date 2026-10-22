import { chmod, cp, mkdir, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const packageRoot = resolve(import.meta.dirname, '..')
const workspaceRoot = resolve(packageRoot, '../..')
const outDir = resolve(packageRoot, 'dist')
const outfile = resolve(outDir, 'bin.js')
const webDist = resolve(workspaceRoot, 'packages/web/dist')

await stat(resolve(webDist, 'index.html')).catch(() => {
  throw new Error('Сначала соберите фронтенд: npm run build --workspace @guanxi/web')
})

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [resolve(packageRoot, 'src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['web-tree-sitter', 'ignore'],
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // Release builds never write component approvals (D-138); see packages/server/src/index.ts.
  define: { __GUANXI_RELEASE_BUILD__: 'true' },
})

await cp(webDist, resolve(outDir, 'web'), { recursive: true })
await chmod(outfile, 0o755)
await build({
  entryPoints: [resolve(workspaceRoot, 'packages/server/src/native-agent/sandbox-worker.ts')],
  outfile: resolve(outDir, 'sandbox-worker.js'), bundle: true, platform: 'node', target: 'node22',
  format: 'esm', external: ['@anthropic-ai/sandbox-runtime'],
})

await build({
  entryPoints: [resolve(workspaceRoot, 'packages/server/src/indexing/worker.ts')],
  outfile: resolve(outDir, 'index-worker.js'), bundle: true, platform: 'node', target: 'node22',
  format: 'esm', external: ['web-tree-sitter', 'ignore'],
})
