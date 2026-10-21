import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, owner } from './helpers.ts'
import { ADAPTERS } from '../../src/external-agents/profiles.ts'
import { ExternalAgentError, type AdapterId } from '../../src/external-agents/types.ts'

for (const adapter of Object.keys(ADAPTERS) as AdapterId[]) test(`${adapter}: versioned protocol recording executes only the temp fixture; K3 and real K2 redact both directions`, async t => {
  const f = await fixture(t, [adapter])
  const previous = process.env.OPENAI_ACCESS_TOKEN
  process.env.OPENAI_ACCESS_TOKEN = f.secret
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_ACCESS_TOKEN; else process.env.OPENAI_ACCESS_TOKEN = previous })
  const binding = f.bindings[0]!
  f.service().setProjectRoles(owner, owner, 'project', { lead: binding })
  const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'project', role: 'lead', prompt: `inspect ${f.secret}` })
  assert.match(result.text, /fixture completed/)
  assert.equal(result.text.includes(f.secret), false)
  const trace = await f.trace(adapter)
  assert.equal(trace.filter(frame => frame.method === (adapter === 'codex' ? 'turn/start' : 'session/prompt')).length, 1)
  assert.equal(JSON.stringify(trace).includes(f.secret), false)
  assert.match(JSON.stringify(trace), /REDACTED/)
  const events = f.kernel.sessionLog!.readAll(result.sessionId, 'person')
  assert.equal(events.filter(e => e.type === 'prompt').length, 1)
  assert.equal(events.filter(e => e.type === 'assistant.message').length, 1)
  assert.equal(events.filter(e => e.type === 'turn.done').length, 1)
  assert.equal(events.some(e => e.type === 'reasoning'), false)
  assert.equal(JSON.stringify(events).includes(f.secret), false)
  assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING_FIXTURE'), false)
  assert.match(JSON.stringify(events), /REDACTED/)
  const env = await f.environment(adapter)
  assert.equal(env.names.includes('ANTHROPIC_AUTH_TOKEN'), false)
  assert.equal(env.names.includes('OPENAI_ACCESS_TOKEN'), false)
  assert.equal(env.names.includes('NODE_OPTIONS'), false)
  assert.equal(env.HOME.startsWith(f.dir), true)
  assert.equal(env.CODEX_HOME.startsWith(f.dir), true)
  if (adapter === 'gemini-cli') assert.equal(env.hasGeminiKey, true)
  if (adapter === 'claude-code') {
    assert.equal(env.CLAUDE_CODE_EXECUTABLE, await realpath(f.installations[0]!.executable))
    const row = f.connections.store.get(owner, binding.connectionId)
    assert.equal(row.facts.subscription_login?.value, true)
    assert.equal(row.facts.billing?.value, null)
    assert.ok(row.facts.billing?.observedAt)
  }
  if (adapter === 'codex') {
    const facts = f.service().limits(owner, binding.connectionId)
    assert.equal(facts.windows.find(w => w.name === 'codex.primary')?.used.value, 31)
    assert.equal(facts.windows.find(w => w.name === 'codex.secondary')?.used.value, null)
  }
})

for (const adapter of Object.keys(ADAPTERS) as AdapterId[]) test(`${adapter}: exact version drift refuses before prompt`, async t => {
  const f = await fixture(t, [adapter])
  await f.scenario(adapter, { scenario: 'wrong-version' })
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /adapter_version_mismatch/)
  assert.equal((await f.trace(adapter)).filter(frame => ['session/prompt', 'turn/start'].includes(String(frame.method))).length, 0)
})

test('ACP never approves a permission request', async t => {
  const f = await fixture(t, ['copilot'])
  await f.scenario('copilot', { scenario: 'permission' })
  f.service().setProjectRoles(owner, owner, 'p', { reviewer: f.bindings[0]! })
  await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'reviewer', prompt: 'hello' })
  const response = (await f.trace('copilot')).find(frame => frame.id === 'fixture-permission')
  assert.deepEqual(response?.result, { outcome: { outcome: 'cancelled' } })
})

test('Claude bare/subscription conflict and non-subscription auth are detected and reported without vendor-file discovery', async t => {
  const f = await fixture(t, ['claude-code'])
  const install = f.installations[0]!
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  const run = () => f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  await f.reload({ installations: [{ ...install, claudeBare: true }] })
  await assert.rejects(run(), /bare_subscription_unavailable/)
  const bare = f.connections.store.get(owner, install.connectionId).facts.bare!
  assert.equal(bare.value, true); assert.equal(bare.confidence, 'high'); assert.ok(bare.observedAt)
  await assert.rejects(readFile(join(f.dir, 'claude-code', 'trace.json')), { code: 'ENOENT' })
  await f.reload()
  await f.scenario('claude-code', { claudeAuth: { loggedIn: true, authMethod: 'api_key', untrustedExtra: f.secret } })
  await assert.rejects(run(), /claude_login_required/)
  assert.equal(f.connections.store.get(owner, install.connectionId).facts.subscription_login?.value, false)
  assert.equal(JSON.stringify(f.connections.snapshot(owner)).includes(f.secret), false)
})

test('Codex Sign in with ChatGPT is delegated to app-server; tokens and Business/API modes are refused', async t => {
  const f = await fixture(t)
  let authUrl = ''
  const result = await f.service().signInWithChatGPT(owner, owner, f.bindings[0]!.connectionId, url => { authUrl = url })
  assert.equal(result.plan, 'plus'); assert.match(authUrl, /^https:\/\/auth\.openai\.com\//)
  const trace = await f.trace('codex')
  assert.equal(trace.filter(m => m.method === 'account/login/start').length, 1)
  assert.deepEqual(trace.find(m => m.method === 'account/login/start')?.params, { type: 'chatgpt' })
  assert.equal(JSON.stringify(trace).includes('chatgptAuthTokens'), false)
  assert.throws(() => f.service().signInWithChatGPT(owner, 'editor', f.bindings[0]!.connectionId, () => undefined), /owner_required/)
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  for (const account of [{ account: { type: 'apiKey' } }, { account: { type: 'chatgpt', planType: 'business' } }]) {
    await f.scenario('codex', { account })
    await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), /chatgpt_login_required/)
    assert.equal((await f.trace('codex')).filter(m => m.method === 'turn/start').length, 0)
  }
})

test('transport failures have stable errors and zero raw stderr/malformed reasoning in plain logs', async t => {
  const f = await fixture(t, ['copilot'], { frameBytes: 2048 })
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  const logs: unknown[] = []
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args))
  t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args))
  for (const scenario of ['malformed', 'oversize', 'crash']) {
    await f.scenario('copilot', { scenario })
    await assert.rejects(f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' }), ExternalAgentError)
  }
  assert.deepEqual(logs, [])
  assert.equal(JSON.stringify(f.kernel.sessionLog!.list()).includes('PRIVATE_REASONING_FIXTURE'), false)
})
