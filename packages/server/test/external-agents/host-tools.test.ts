import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, owner } from './helpers.ts'
import type { AdapterId } from '../../src/external-agents/types.ts'

test('OpenCode: the fixture receives a deny-all permission block', async t => {
  const f = await fixture(t, ['opencode'])
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  const env = await f.environment('opencode')
  assert.deepEqual(env.openCodeConfig.permission, { '*': 'deny' })
})

test('Goose: the fixture receives chat mode instead of autonomous tools', async t => {
  const f = await fixture(t, ['goose'])
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  const env = await f.environment('goose')
  assert.equal(env.gooseMode, 'chat')
})

for (const adapter of ['opencode', 'goose'] as AdapterId[]) test(`${adapter}: a non-owner actor is refused even with an editor payment grant`, async t => {
  const f = await fixture(t, [adapter])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  // The editor payment grant is valid for an API-key connection, so refusal must come
  // from the host-tool boundary, not from K3 payment policy.
  f.service().setEditorAllowed(owner, owner, binding.connectionId, 'editor', true)
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: 'editor', projectId: 'p', role: 'lead', prompt: 'cat ~/.codex/auth.json' }),
    /host_tools_owner_only/)
  await assert.rejects(readFile(join(f.dir, adapter, 'trace.json')), { code: 'ENOENT' })
})
