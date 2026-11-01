import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { PRODUCT_VERSION } from '@guanxi/contract/brand'

const root = resolve(import.meta.dirname, '..')
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))

test('application package and lock versions agree with the shared release version', () => {
  const lock = json('package-lock.json')
  for (const workspace of ['cli', 'desktop', 'server']) {
    assert.equal(json(`packages/${workspace}/package.json`).version, PRODUCT_VERSION, workspace)
    assert.equal(lock.packages[`packages/${workspace}`].version, PRODUCT_VERSION, `${workspace} lock`)
  }
})

test('the actual CLI version command reports the shared release version without starting a node', () => {
  const reported = execFileSync(process.execPath, [resolve(root, 'packages/cli/src/bin.ts'), '--version'], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GUANXI_PROVIDER_KEYS_FILE: '' },
  })
  assert.equal(reported.trim(), PRODUCT_VERSION)
})
