/** D-212: the owner's long-lived subscription token (`claude setup-token`) is a K5 credential for the official Claude Code CLI only. Fake tokens. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseProviderKeyFile } from '../../src/connections/dotenv.ts'
import { fixture, owner } from './helpers.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>
const input = { ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead' as const, prompt: 'plan the work' }
const tokenFixture = async (t: Parameters<typeof fixture>[0]) => {
  const f = await fixture(t, ['claude-code'], {}, {}, { claudeToken: true })
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  return f
}
const noPrompt = async (f: Fixture) => assert.equal((await f.trace('claude-code').catch(() => [])).filter(frame => frame.method === 'session/prompt').length, 0)
const neverLaunched = (f: Fixture) => assert.rejects(readFile(join(f.dir, 'claude-code', 'environment.json')), { code: 'ENOENT' })
async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await files(path))
    else if (entry.name !== 'scenario.json' && entry.name !== 'token.env') out.push(path) // the fixture's own inputs
  }
  return out
}

test('token mode: the token arrives as CLAUDE_CODE_OAUTH_TOKEN in the bridge and probe environment only, billed to the subscription', async t => {
  const f = await tokenFixture(t)
  const row = f.connections.store.get(owner, f.bindings[0]!.connectionId)
  assert.deepEqual([row.kind, row.provider, row.auth, row.name], ['agent', 'claude-code', 'cli_login', 'claude-code (dotenv)'])
  assert.ok(row.secretRef, 'the token is in the vault')
  assert.equal(f.connections.snapshot(owner).connections.some(c => c.kind === 'model_api'), false, 'it never became a model API connection')
  const result = await f.service().run(input)
  assert.match(result.text, /fixture completed/)
  const env = await f.environment('claude-code')
  assert.equal(env.oauthTokenMatches, true)
  assert.equal(env.names.includes('CLAUDE_CODE_OAUTH_TOKEN'), true)
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) assert.equal(env.names.includes(name), false, name)
  assert.deepEqual(env.argv, []); assert.equal(env.subprocessScrub, '1')
  const probe = JSON.parse(await readFile(join(f.dir, 'claude-code', 'auth-env.json'), 'utf8'))
  assert.equal(probe.hasToken, true); assert.equal(probe.hasKey, false)
  const facts = f.connections.store.get(owner, f.bindings[0]!.connectionId).facts
  assert.equal(facts.token_login?.value, true); assert.equal(facts.billing?.value, 'subscription')
  assert.equal(facts.billing?.source.endsWith('claude_code_oauth_token_connection'), true)
  // The endpoint and the permission mode are pinned for this launch too.
  const created = (await f.trace('claude-code')).find(frame => frame.method === 'session/new')!
  assert.equal(created.params._meta.claudeCode.options.settings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
  // Nowhere else: not the result, the events, the connections, the trace, nor any file (the token, its tail, or its family prefix with the tail).
  const events = f.kernel.sessionLog!.readAll(result.sessionId, 'person')
  const tail = f.oauthToken.slice(-20)
  for (const text of [JSON.stringify(result), JSON.stringify(events), JSON.stringify(f.connections.snapshot(owner)), JSON.stringify(await f.trace('claude-code')), JSON.stringify(f.service().capabilities(owner))]) {
    assert.equal(text.includes(f.oauthToken), false); assert.equal(text.includes(tail), false)
  }
  assert.equal((await readFile(join(f.dir, 'claude-code', 'scenario.json'))).includes(f.oauthToken), true, 'control: the scan sees the token where it is meant to be')
  const scanned = await files(f.dir)
  assert.ok(scanned.length > 5)
  for (const path of scanned) { const bytes = await readFile(path); assert.equal(bytes.includes(f.oauthToken), false, path); assert.equal(bytes.includes(tail), false, path) }
})

test('token mode: only authMethod oauth_token is accepted; anything else refuses before the prompt', async t => {
  for (const claudeAuth of [{ loggedIn: true, authMethod: 'claude.ai' }, { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }, { loggedIn: false, authMethod: 'none' },
    { loggedIn: false, authMethod: 'oauth_token' }]) {
    const f = await tokenFixture(t)
    await f.scenario('claude-code', { claudeAuth })
    await assert.rejects(f.service().run(input), /claude_token_not_in_effect/, JSON.stringify(claudeAuth))
    await noPrompt(f)
    const facts = f.connections.store.get(owner, f.bindings[0]!.connectionId).facts
    assert.equal(facts.token_login?.value, false); assert.equal(facts.billing?.value, null)
  }
})

test('token mode refuses vendor settings files that could redirect the token or relax permissions', async t => {
  for (const placement of [['config', 'settings.json'], ['work', '.claude', 'settings.local.json']]) {
    const f = await tokenFixture(t)
    const file = join((await f.config('claude-code')).configDirectory, ...placement)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://redirect.invalid' } }))
    await assert.rejects(f.service().run(input), /claude_settings_present/)
    await neverLaunched(f)
  }
})

test('the token is a Claude Code credential only: no model API use, no editor grant, no other author, nothing to sign in to', async t => {
  const f = await tokenFixture(t)
  const id = f.bindings[0]!.connectionId
  await assert.rejects(f.connections.complete(owner, id, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, { model: 'claude-sonnet-4-5', runId: 'r', requestId: 'q' }), /not a model API/)
  await assert.rejects(async () => f.connections.saveSecret(owner, id, f.oauthToken), /CLI logins are managed/)
  assert.throws(() => f.service().setEditorAllowed(owner, owner, id, 'friend', true), /subscription_owner_only/)
  await assert.rejects(f.service().run({ ...input, actorAccountId: 'friend' }), /Connection cannot pay/)
  await assert.rejects(f.service().prepareLogin(owner, owner, id), /api_or_local_required/)
  await neverLaunched(f)
})

test('token families are never exchanged: an API key is not a Claude Code token, and the subscription token is not an API key', async t => {
  const token = `sk-ant-oat01-${'a'.repeat(40)}`, apiKey = `sk-ant-api03-${'b'.repeat(40)}`
  const parse = (text: string, oauthToken: boolean) => parseProviderKeyFile(text, { oauthToken })
  // The distinct name is read only in token mode, and only a subscription token passes it.
  assert.deepEqual(parse(`CLAUDE_CODE_OAUTH_TOKEN=${token}`, true).entries.map(e => e.provider), ['claude-code'])
  assert.deepEqual(parse(`CLAUDE_CODE_OAUTH_TOKEN=${apiKey}`, true).errors.map(e => e.key), ['CLAUDE_CODE_OAUTH_TOKEN'])
  assert.throws(() => parse(`CLAUDE_CODE_OAUTH_TOKEN=${token}`, false), /invalid/, 'ignored outside token mode: nothing to import')
  // The owner put the token under the API key's name: in token mode it is a Claude Code credential, never an Anthropic API connection.
  assert.deepEqual(parse(`ANTHROPIC_API_KEY=${token}`, true).entries.map(e => e.provider), ['claude-code'])
  assert.deepEqual(parse(`ANTHROPIC_API_KEY=${token}`, false).entries, [])
  assert.deepEqual(parse(`ANTHROPIC_API_KEY=${token}`, false).errors.map(e => e.key), ['ANTHROPIC_API_KEY'])
  // An API key under that name stays an API key; it cannot be a token.
  assert.deepEqual(parse(`ANTHROPIC_API_KEY=${apiKey}`, true).entries.map(e => e.provider), ['anthropic'])
  // Both names present: the distinct one wins and the other must not be a second token.
  const both = parse(`CLAUDE_CODE_OAUTH_TOKEN=${token}\nANTHROPIC_API_KEY=sk-ant-oat01-${'c'.repeat(40)}`, true)
  assert.deepEqual([both.entries.map(e => e.provider), both.errors.map(e => e.key)], [['claude-code'], ['ANTHROPIC_API_KEY']])
  // K3 still refuses the token as an API key anywhere else.
  const f = await fixture(t, ['claude-code'], {}, {}, { claudeApi: true })
  const row = f.connections.create(owner, { name: 'a', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  await assert.rejects(async () => f.connections.saveSecret(owner, row.id, token), /An API key is required/)
})
