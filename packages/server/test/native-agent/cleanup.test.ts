import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeContainer, assertRootsClean } from '../../src/native-agent/cleanup.ts'

test('unreachable Docker cleanup has a deadline and reports cleanup_unconfirmed', { timeout: 3000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4-cleanup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const docker = join(dir, 'docker')
  await writeFile(docker, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 })
  const began = Date.now()
  await assert.rejects(removeContainer(docker, 'unix:///fixture', 'fixture', 150), /cleanup_unconfirmed/)
  assert.ok(Date.now() - began < 1500, 'cleanup must settle within a bounded time')
})
test('persistent cleanup quarantine denies overlapping roots and malformed records, permits unrelated roots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4-quarantine-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'native-cleanup'))
  const record = join(dir, 'native-cleanup', 'owner.json')
  await writeFile(record, JSON.stringify(['/fixture/root']))
  for (const root of ['/fixture/root', '/fixture/root/nested', '/fixture']) assert.throws(() => assertRootsClean(dir, [root]), /cleanup_unconfirmed/)
  assert.doesNotThrow(() => assertRootsClean(dir, ['/fixture/sibling']))
  await writeFile(record, '{}')
  assert.throws(() => assertRootsClean(dir, ['/fixture/sibling']), /cleanup_unconfirmed/)
})
