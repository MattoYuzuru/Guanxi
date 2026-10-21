#!/usr/bin/env node
/**
 * Regenerates packages/ui/catalog/manifest.json. `--check` exits 1 when the committed file is
 * stale (G10 runs the same comparison).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, serialiseManifest } from '../tooling/manifest.ts'

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const target = join(uiRoot, 'catalog', 'manifest.json')
const next = serialiseManifest(buildManifest(uiRoot))

if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8')
  if (current !== next) {
    console.error('catalog/manifest.json is stale: run `npm run manifest --workspace @guanxi/ui`')
    process.exit(1)
  }
  console.log('catalog/manifest.json is fresh')
} else {
  writeFileSync(target, next)
  console.log(`wrote ${target}`)
}
