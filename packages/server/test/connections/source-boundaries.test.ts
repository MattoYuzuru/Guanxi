import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract'
import * as browserBrand from '../../../web/src/lib/brand.ts'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
async function sources(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build'].includes(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) files.push(path)
  }
  return files
}

test('node branding never imports browser source and existing browser exports stay compatible', async () => {
  assert.equal(browserBrand.PRODUCT_NAME, PRODUCT_NAME)
  assert.equal(browserBrand.PRODUCT_FILE_PREFIX, PRODUCT_FILE_PREFIX)
  for (const path of await sources(join(packageRoot, 'src'))) {
    assert.doesNotMatch(await readFile(path, 'utf8'), /(?:from\s*|import\s*\()\s*['"][^'"]*web\/src/, path)
  }
})


test('published CLI declares the native keychain backend kept external by its bundle', async () => {
  const cli = JSON.parse(await readFile(new URL('../../../cli/package.json', import.meta.url), 'utf8'))
  const server = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(cli.dependencies?.['@napi-rs/keyring'], server.dependencies['@napi-rs/keyring'])
  assert.match(cli.dependencies['@napi-rs/keyring'], /^\d+\.\d+\.\d+$/)
})
