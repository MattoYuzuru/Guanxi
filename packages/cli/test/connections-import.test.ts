import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { connectionsImport } from '../src/connections-import.ts'

test('connections import passes only paths to the trusted node helper and returns references', async () => {
  const result = await connectionsImport(['--file', '/tmp/test-only.env', '--data-dir', '/tmp/test-only-data', '--json'], async (dir, file) => {
    assert.equal(dir, '/tmp/test-only-data'); assert.equal(file, '/tmp/test-only.env')
    return { imported: [{ connectionId: 'fixture-id', provider: 'openai', action: 'created' }] }
  })
  assert.equal(result.ok, true)
})

test('connections import suppresses raw importer errors and invalid argument values', async () => {
  const value = randomBytes(32).toString('hex')
  for (const args of [['--file', '/tmp/test-only.env'], ['--invalid', value], []]) {
    const result = await connectionsImport(args, async () => { throw new Error(value) })
    assert.deepEqual(result, { ok: false, error: 'provider_key_import_failed' })
    assert.ok(!JSON.stringify(result).includes(value))
  }
})


test('partial provider import returns a failed result with per-key codes and successful references', async () => {
  const result = await connectionsImport(['--file', '/tmp/fixture.env'], async () => ({
    imported: [{ connectionId: 'fixture-id', provider: 'deepseek', action: 'created' }],
    errors: [{ key: 'OPENAI_API_KEY', code: 'invalid_provider_key' as const }],
  }))
  assert.equal(result.ok, false)
  assert.ok('imported' in result)
})
