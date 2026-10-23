import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('no test process sees the owner\'s provider key file, and both ways of running the suite load the guard', () => {
  assert.equal(process.env['GUANXI_PROVIDER_KEYS_FILE'], undefined)
  const server = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts.test as string
  const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).scripts['test:core'] as string
  assert.match(server, /--import \.\/test\/setup\/no-ambient-key-file\.mjs/)
  assert.match(root, /--import \.\/packages\/server\/test\/setup\/no-ambient-key-file\.mjs/)
})
