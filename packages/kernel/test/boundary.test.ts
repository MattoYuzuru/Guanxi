/**
 * ADR-0037: Guanxi runs on its own kernel. No package imports or depends on
 * Cordis or DeepSeek Harness's Cordis copy.
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const CORDIS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:cordis|@cordisjs\/[^'"]+|@deepseek-ai\/cordis[^'"]*)['"]/
const CORDIS_DEPENDENCY = /^(?:cordis|@cordisjs\/.+|@deepseek-ai\/cordis.*)$/
const SKIP = new Set(['node_modules', 'dist', 'build', 'test-results', '.lane-data'])
const SELF = 'packages/kernel/test/boundary.test.ts'

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

describe('kernel boundary', () => {
  it('has no Cordis import or dependency anywhere in the workspace', async () => {
    const offenders: string[] = []
    for await (const path of files(join(repository, 'packages'))) {
      const file = relative(repository, path)
      if (file === SELF) continue
      if (/\.(?:[cm]?[jt]sx?)$/.test(path) && CORDIS_IMPORT.test(await readFile(path, 'utf8'))) offenders.push(file)
      if (path.endsWith('package.json')) {
        const pkg = JSON.parse(await readFile(path, 'utf8'))
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const name of Object.keys(pkg[field] ?? {})) if (CORDIS_DEPENDENCY.test(name)) offenders.push(`${file}#${field}.${name}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('detects a Cordis import (self-check of the pattern)', () => {
    assert.match("import { Context } from 'cordis'", CORDIS_IMPORT)
    assert.match('const x = await import("@cordisjs/plugin-hmr")', CORDIS_IMPORT)
    assert.match("import x from '@deepseek-ai/cordis'", CORDIS_IMPORT)
    assert.doesNotMatch("import { definePlugin } from '@guanxi/kernel'", CORDIS_IMPORT)
  })
})
