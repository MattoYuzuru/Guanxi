/**
 * ADR-0015 invariant: no Guanxi feature imports Cordis directly. Inside the
 * kernel, only the two runtime bridges do.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const CORDIS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:cordis|@cordisjs\/[^'"]+|@deepseek-ai\/cordis[^'"]*)['"]/
const BRIDGES = new Set(['packages/kernel/src/cordis-runtime.js', 'packages/kernel/src/loader-runtime.js'])
const SKIP = new Set(['node_modules', 'dist', 'build', 'test-results', '.lane-data'])
// Tests that must name Cordis: the upstream canary and this file's self-check.
const EXEMPT = new Set(['packages/kernel/test/upstream-canary.test.ts', 'packages/kernel/test/boundary.test.ts'])

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield path
  }
}

describe('kernel import boundary', () => {
  it('lets only the kernel runtime bridges import Cordis', async () => {
    const offenders: string[] = []
    const bridges: string[] = []
    for await (const path of sources(join(repository, 'packages'))) {
      const file = relative(repository, path)
      if (EXEMPT.has(file)) continue
      if (!CORDIS_IMPORT.test(await readFile(path, 'utf8'))) continue
      if (BRIDGES.has(file)) bridges.push(file)
      else offenders.push(file)
    }
    assert.deepEqual(offenders, [])
    assert.deepEqual(bridges.sort(), [...BRIDGES].sort())
  })

  it('detects a direct Cordis import (self-check of the pattern)', () => {
    assert.match("import { Context } from 'cordis'", CORDIS_IMPORT)
    assert.match('const x = await import("@cordisjs/plugin-hmr")', CORDIS_IMPORT)
    assert.match("import x from '@deepseek-ai/cordis'", CORDIS_IMPORT)
    assert.doesNotMatch("import { Context } from '@guanxi/kernel'", CORDIS_IMPORT)
  })
})
