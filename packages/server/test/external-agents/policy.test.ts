import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, symlink, mkdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, owner, nodeId } from './helpers.ts'
import { resolveRole, rolesSchema, type Role, type RoleBinding } from '../../src/external-agents/types.ts'
import { claudeRateLimits, codexRateLimits } from '../../src/external-agents/quota.ts'

const session: RoleBinding = { backend: 'codex', connectionId: '11111111-1111-4111-8111-111111111111', model: 'session-model', params: {} }
const project: RoleBinding = { ...session, backend: 'native', model: 'project-model' }
for (const role of ['lead', 'executor', 'reviewer', 'judge', 'advisor', 'scout'] as Role[]) test(`role golden: ${role} session → project, explicit null refuses, no policy fallback`, () => {
  const golden = [
    { session: { [role]: session }, project: { [role]: project }, expected: { binding: session, source: 'session' } },
    { session: {}, project: { [role]: project }, expected: { binding: project, source: 'project' } },
    { session: { advisor: session }, project: { [role]: project }, expected: role === 'advisor' ? { binding: session, source: 'session' } : { binding: project, source: 'project' } },
  ]
  for (const row of golden) assert.deepEqual(resolveRole(role, row.session, row.project), row.expected)
  assert.throws(() => resolveRole(role, { [role]: null }, { [role]: project }), /role_unassigned/)
  assert.throws(() => resolveRole(role, {}, {}), /role_unassigned/)
  assert.equal(rolesSchema.safeParse({ automaticFallback: session }).success, false)
})

for (const adapter of ['claude-code', 'copilot', 'codex'] as const) test(`${adapter}: second account, delegated origin and forged sharing grant cannot reach subscription process`, async t => {
  const f = await fixture(t, [adapter])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  assert.throws(() => f.service().setEditorAllowed(owner, owner, binding.connectionId, 'editor', true), /subscription_owner_only/)
  for (const actorAccountId of ['editor', 'delegation-original-editor']) {
    await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId, projectId: 'p', role: 'lead', prompt: 'a prompt in a shared session' }), /Connection cannot pay/)
  }
  let launches = 0
  await assert.rejects(f.connections.dispatchAgent(owner, binding.connectionId, 'editor', true, {}, async () => { launches++; return '' }), /Connection cannot pay/)
  assert.equal(launches, 0)
  await assert.rejects(readFile(join(f.dir, adapter, 'trace.json')), { code: 'ENOENT' })
  assert.throws(() => f.service().setProjectRoles(owner, 'editor', 'p', { lead: binding }), /owner_required/)
})

test('API-key editor payment requires live owner consent; revocation and project roles persist over reload', async t => {
  const f = await fixture(t, ['gemini-cli'])
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { executor: binding })
  const run = () => f.service().run({ ownerAccountId: owner, actorAccountId: 'editor', projectId: 'p', role: 'executor', prompt: 'hello' })
  await assert.rejects(run(), /Connection cannot pay/)
  f.service().setEditorAllowed(owner, owner, binding.connectionId, 'editor', true)
  await f.reload()
  assert.equal(f.service().resolve(owner, 'p', 'executor').binding.connectionId, binding.connectionId)
  const result = await run()
  assert.match(result.text, /fixture completed/)
  f.service().setEditorAllowed(owner, owner, binding.connectionId, 'editor', false)
  await f.reload()
  await assert.rejects(run(), /Connection cannot pay/)
  const mode = (await stat(join(f.dir, 'external-agents.sqlite'))).mode & 0o777
  assert.equal(mode, 0o600)
})

test('invalid session binding never falls back to a payable project connection, unsupported params fail before launch', async t => {
  const f = await fixture(t)
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: binding })
  const base = { ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead' as const, prompt: 'hello' }
  await assert.rejects(f.service().run({ ...base, sessionRoles: { lead: { ...binding, connectionId: session.connectionId } } }), /Connection not found/)
  await assert.rejects(f.service().run({ ...base, sessionRoles: { lead: { ...binding, params: { temperature: 0.3 } } } }), /unsupported_parameter/)
  await assert.rejects(readFile(join(f.dir, 'codex', 'trace.json')), { code: 'ENOENT' })
})

test('account reports aggregate same reset window conservatively across nodes, isolate accounts, expire and persist', async t => {
  const f = await fixture(t, ['claude-code'])
  const binding = f.bindings[0]!
  const now = Date.now()
  const observedAt = new Date(now - 1000).toISOString()
  const reset = new Date(now + 3600_000).toISOString()
  f.service().observeClaudeStatusline(owner, owner, binding.connectionId, { rate_limits: { five_hour: { used_percentage: 25, resets_at: reset }, seven_day: null } }, observedAt)
  f.service().observeQuota(owner, binding.connectionId, { ownerAccountId: owner, billingAccount: 'claude-code-account', adapter: 'claude-code',
    nodeId: 'zz-another-owner-node', source: 'claude:statusline.rate_limits', observedAt, confidence: 'medium',
    windows: [{ name: 'five_hour', usedPercent: 60, resetsAt: reset }] }, now)
  await f.reload()
  const result = f.service().limits(owner, binding.connectionId, now)
  assert.equal(result.windows.find(w => w.name === 'five_hour')?.used.value, 60)
  assert.deepEqual(result.windows.find(w => w.name === 'five_hour')?.nodes.sort(), ['zz-another-owner-node', nodeId].sort())
  assert.equal(result.windows.find(w => w.name === 'seven_day')?.used.value, null)
  assert.equal(result.windows.find(w => w.name === 'seven_day')?.used.confidence, 'unknown')
  assert.equal(result.windows.find(w => w.name === 'five_hour')?.used.source, 'claude:statusline.rate_limits')
  const expired = f.service().limits(owner, binding.connectionId, now + 360_000)
  assert.equal(expired.known, false); assert.equal(expired.stale, true); assert.equal(expired.windows.length, 0)
  assert.throws(() => f.service().observeQuota(owner, binding.connectionId, { ...result.reports[0]!, ownerAccountId: 'editor' }), /quota_identity_mismatch/)
  assert.throws(() => f.service().observeQuota(owner, binding.connectionId, { ...result.reports[0]!, observedAt: new Date(now + 10000).toISOString() }, now), /future_observation/)
  assert.equal(claudeRateLimits({ rate_limits: { five_hour: { used_percentage: -1 } } })[0]!.usedPercent, null)
  assert.equal(codexRateLimits({ rateLimitsByLimitId: { first: { primary: { usedPercent: 5 } }, second: { primary: { usedPercent: 10 } } } }).length, 4)
  const latest = { ...result.reports[0]!, observedAt: '2026-10-21T12:00:01.900Z', windows: [{ name: 'newer', usedPercent: 90, resetsAt: '2026-10-22T12:00:00Z' }] }
  const older = { ...latest, observedAt: '2026-10-21T12:00:01Z', windows: [{ name: 'newer', usedPercent: 10, resetsAt: '2026-10-22T12:00:00.000Z' }] }
  // Isolate this observation order from the actual wall clock used above.
  latest.nodeId = 'precision-fixture'; older.nodeId = 'precision-fixture'
  f.service().observeQuota(owner, binding.connectionId, latest, Date.parse('2026-10-21T12:00:02Z'))
  f.service().observeQuota(owner, binding.connectionId, older, Date.parse('2026-10-21T12:00:02Z'))
  assert.equal(f.service().limits(owner, binding.connectionId, Date.parse('2026-10-21T12:00:02Z')).windows.find(w => w.name === 'newer')?.used.value, 90)
  f.service().observeQuota(owner, binding.connectionId, { ...older, nodeId: 'zz-precision-peer', observedAt: latest.observedAt,
    windows: [{ name: 'newer', usedPercent: 95, resetsAt: '2026-10-22T12:00:00Z' }] }, Date.parse('2026-10-21T12:00:02Z'))
  const equivalent = f.service().limits(owner, binding.connectionId, Date.parse('2026-10-21T12:00:02Z')).windows.filter(w => w.name === 'newer')
  assert.equal(equivalent.length, 1)
  assert.equal(equivalent[0]!.used.value, 95)
  assert.equal(equivalent[0]!.resetsAt, '2026-10-22T12:00:00.000Z')
  assert.deepEqual(equivalent[0]!.nodes.sort(), ['precision-fixture', 'zz-precision-peer'])
})

test('external local-runtime routes refuse before spawn rather than bypassing K3 host/context/governor', async t => {
  const f = await fixture(t, ['opencode'])
  const row = f.connections.create(owner, { name: 'Native local only', kind: 'local_runtime', provider: 'ollama', auth: 'none' })
  const install = { ...f.installations[0]!, connectionId: row.id }
  await f.reload({ installations: [install] })
  f.service().setProjectRoles(owner, owner, 'p', { lead: { ...f.bindings[0]!, connectionId: row.id, model: 'ollama/fixture' } })
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /external_api_key_required/)
  await assert.rejects(readFile(join(f.dir, 'opencode', 'trace.json')), { code: 'ENOENT' })
})

test('concurrency learning is account-scoped, persists, and a rejection tightens explicit operator policy', async t => {
  const f = await fixture(t)
  const install = f.installations[0]!
  await f.reload({ installations: [{ ...install, concurrency: 4 }] })
  assert.equal(f.service().limits(owner, install.connectionId).concurrency.successful, null)
  f.service().observeConcurrency(owner, owner, install.connectionId, 2, 'success')
  f.service().observeConcurrency(owner, owner, install.connectionId, 3, 'concurrency_rejected')
  await f.reload({ installations: [{ ...install, concurrency: 4 }] })
  const learned = f.service().limits(owner, install.connectionId).concurrency
  assert.equal(learned.successful, 2); assert.equal(learned.rejectedAt, 3)
  assert.equal(learned.confidence, 'low'); assert.ok(learned.observedAt)
  assert.throws(() => f.service().observeConcurrency(owner, 'editor', install.connectionId, 1, 'success'), /owner_required/)
  assert.throws(() => f.service().observeConcurrency(owner, owner, install.connectionId, 0, 'success'), /invalid_concurrency_observation/)
})

test('node binding, private directories and readiness fail closed', async t => {
  const f = await fixture(t)
  const install = f.installations[0]!
  await f.reload({ installations: [{ ...install, nodeId: 'different-node' }] })
  assert.throws(() => f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! }), /wrong_node/)
  await f.reload()
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  const config = await f.config('codex')
  assert.equal((await stat(config.configDirectory)).mode & 0o777, 0o700)
  await mkdir(join(f.dir, 'unrelated'))
  await rm(join(config.configDirectory, 'home'), { recursive: true })
  await symlink(join(f.dir, 'unrelated'), join(config.configDirectory, 'home'))
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /unsafe_config_directory/)
  f.kernel.scrubber.expect('test-pending')
  assert.throws(() => f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /egress_unavailable/)
  f.kernel.scrubber.ready('test-pending')
})
