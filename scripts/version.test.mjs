import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('the CLI reports its version without requiring valid node configuration or creating data', () => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'guanxi-version-'))
  const data = resolve(temporary, 'data')
  try {
    const reported = execFileSync(process.execPath, [resolve(root, 'packages/cli/src/bin.ts'), '--version'], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, GUANXI_PROVIDER_KEYS_FILE: '', GUANXI_DATA_DIR: data, GUANXI_API_PORT: 'not-a-port' },
    })
    assert.equal(reported.trim(), PRODUCT_VERSION)
    assert.equal(existsSync(data), false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
