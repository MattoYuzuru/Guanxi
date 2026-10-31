import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fixture, owner } from './helpers.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>
const input = { ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead' as const, prompt: 'plan the work' }
const apiFixture = async (t: Parameters<typeof fixture>[0], install = {}) => {
  const f = await fixture(t, ['claude-code'], {}, {}, { claudeApi: true, install })
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  return f
}
const noPrompt = async (f: Fixture) => assert.equal((await f.trace('claude-code').catch(() => [])).filter(frame => frame.method === 'session/prompt').length, 0)
/** The bridge process itself was never started (the fixture writes `environment.json` as soon as it runs). */
const neverLaunched = (f: Fixture) => assert.rejects(readFile(join(f.dir, 'claude-code', 'environment.json')), { code: 'ENOENT' })
/** Every file under the node's data directory, except the fixture's own scenario input (which holds the fake key by design). */
async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await files(path))
    else if (entry.name !== 'scenario.json') out.push(path)
  }
  return out
}
const withEffort = (f: Fixture, levels: string[] | null, current = 'default') => {
  const tape = structuredClone(f.tapes.get('claude-code')!) as { newSession: { configOptions: unknown[] } }
  if (levels) tape.newSession.configOptions.push({ id: 'effort', category: 'thought_level', name: 'Effort', type: 'select', currentValue: current,
    options: levels.map(value => ({ value, name: value })) })
  return tape
}

test('API key mode: the key reaches the bridge environment only, and is absent from every log, event, argument and file', async t => {
  const f = await apiFixture(t)
  const result = await f.service().run(input)
  assert.match(result.text, /fixture completed/)
  const env = await f.environment('claude-code')
  assert.equal(env.names.includes('ANTHROPIC_API_KEY'), true)
  assert.equal(env.anthropicKeyMatches, true)
  assert.deepEqual(env.argv, [])
  // The CLI's own subprocesses (MCP stdio servers, hooks, tools) are launched without the key (observed with the real CLI 2.1.287).
  assert.equal(env.subprocessScrub, '1')
  // The CLI probe saw the key through its environment too, and nothing else of a vendor login.
  const probe = JSON.parse(await readFile(join(f.dir, 'claude-code', 'auth-env.json'), 'utf8'))
  assert.equal(probe.hasKey, true)
  // The env is built from nothing: no ambient vendor token and no OAuth variable can come along.
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_SIMPLE']) assert.equal(env.names.includes(name), false, name)
  const events = f.kernel.sessionLog!.readAll(result.sessionId, 'person')
  const haystacks = [JSON.stringify(result), JSON.stringify(events), JSON.stringify(f.connections.snapshot(owner)), JSON.stringify(await f.trace('claude-code'))]
  for (const text of haystacks) assert.equal(text.includes(f.anthropicKey), false)
  // Control: the scan does see the key where it is meant to be (the fixture's own scenario input).
  assert.equal((await readFile(join(f.dir, 'claude-code', 'scenario.json'))).includes(f.anthropicKey), true)
  const scanned = await files(f.dir)
  assert.ok(scanned.length > 5)
  for (const path of scanned) assert.equal((await readFile(path)).includes(f.anthropicKey), false, path)
  // Billing is an observation with a source: API usage, not a subscription.
  const facts = f.connections.store.get(owner, f.bindings[0]!.connectionId).facts
  assert.equal(facts.api_key_login?.value, true)
  assert.equal(facts.billing?.value, 'api_usage')
  assert.equal(facts.billing?.source.endsWith('anthropic_api_key_connection'), true)
  assert.equal(facts.subscription_login, undefined)
})

test('API key mode keeps the Claude config directory for session resume, unlike other API agents', async t => {
  const f = await apiFixture(t)
  await f.service().run(input)
  const first = (await f.environment('claude-code')).HOME as string
  assert.ok((await stat(dirname(first))).isDirectory())
  await f.service().run(input)
  assert.equal((await f.environment('claude-code')).HOME, first)
})

test('API key mode: only authMethod api_key with the key in effect is accepted; anything else refuses before the prompt', async t => {
  for (const claudeAuth of [{ loggedIn: true, authMethod: 'claude.ai' }, { loggedIn: false, authMethod: 'none' }, { loggedIn: true, authMethod: 'api_key_helper' },
    { loggedIn: false, authMethod: 'api_key' }]) {
    const f = await apiFixture(t)
    await f.scenario('claude-code', { claudeAuth })
    await assert.rejects(f.service().run(input), /claude_api_key_not_in_effect/)
    await noPrompt(f)
    assert.equal(f.connections.store.get(owner, f.bindings[0]!.connectionId).facts.api_key_login?.value, false)
    assert.equal(f.connections.store.get(owner, f.bindings[0]!.connectionId).facts.billing?.value, null)
  }
})

test('subscription mode is unchanged: no key variable, only claude.ai is accepted, an ambient key is not forwarded', async t => {
  const previous = process.env.ANTHROPIC_API_KEY
  const ambient = 'sk-ant-api03-AMBIENT-CANARY-0000000000000000000000'
  process.env.ANTHROPIC_API_KEY = ambient
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous })
  const f = await fixture(t, ['claude-code'])
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  await f.service().run(input)
  const env = await f.environment('claude-code')
  assert.equal(env.names.includes('ANTHROPIC_API_KEY'), false)
  assert.equal(env.subprocessScrub, null, 'the subscription launch is unchanged')
  const facts = f.connections.store.get(owner, f.bindings[0]!.connectionId).facts
  assert.equal(facts.subscription_login?.value, true); assert.equal(facts.billing?.value, null); assert.equal(facts.api_key_login, undefined)
  await f.scenario('claude-code', { claudeAuth: { loggedIn: true, authMethod: 'api_key' } })
  await assert.rejects(f.service().run(input), /claude_login_required/)
})

test('API key mode refusals: wrong provider, missing key, OAuth token, base URL override', async t => {
  const f = await apiFixture(t)
  const install = f.installations[0]!
  const bind = async (connectionId: string) => {
    await f.reload({ installations: [{ ...install, connectionId }] })
    f.service().setProjectRoles(owner, owner, 'p', { lead: { ...f.bindings[0]!, connectionId } })
  }
  const attempt = async (connectionId: string, pattern: RegExp) => {
    await bind(connectionId)
    await assert.rejects(f.service().run(input), pattern)
    await noPrompt(f)
    await neverLaunched(f)
  }
  // A key of another provider never pays for Claude Code.
  const other = f.connections.create(owner, { name: 'openai', kind: 'model_api', provider: 'openai', auth: 'api_key' })
  await f.connections.saveSecret(owner, other.id, f.secret)
  await attempt(other.id, /claude_api_connection_required/)
  // The connection exists but holds no key: nothing is launched and no bridge ever sees an empty variable.
  const empty = f.connections.create(owner, { name: 'anthropic-empty', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  await attempt(empty.id, /credential unavailable/)
  // An OAuth token is not an API key, even when mislabelled (K3 refuses it at storage).
  const oauth = f.connections.create(owner, { name: 'anthropic-oauth', kind: 'model_api', provider: 'anthropic', auth: 'api_key' })
  await assert.rejects(async () => f.connections.saveSecret(owner, oauth.id, 'sk-ant-oat01-' + 'a'.repeat(40)), /An API key is required/)
  await attempt(oauth.id, /credential unavailable/)
  // A connection pinned to another API root cannot carry Claude Code's key.
  const rooted = f.connections.store.create(owner, { name: 'anthropic-root', kind: 'model_api', provider: 'anthropic', auth: 'api_key' }, { baseUrl: 'https://api.example.com/v1', allowPrivate: false })
  await f.connections.saveSecret(owner, rooted.id, f.anthropicKey)
  await attempt(rooted.id, /claude_api_connection_required/)
})

test('API key mode: another author can never use Claude Code through the key, and there is nothing to sign in to', async t => {
  const f = await apiFixture(t)
  const connectionId = f.bindings[0]!.connectionId
  // As for every API-key agent that runs host tools, a grant may exist but the run is refused before any process launch.
  f.service().setEditorAllowed(owner, owner, connectionId, 'friend', true)
  await assert.rejects(f.service().run({ ...input, actorAccountId: 'friend' }), /host_tools_owner_only/)
  await assert.rejects(f.service().prepareLogin(owner, owner, connectionId), /api_or_local_required/)
  await noPrompt(f)
  await neverLaunched(f)
  assert.equal(JSON.stringify(f.service().capabilities(owner)).includes(f.anthropicKey), false)
})

test('Claude effort is set through the bridge option, for both payment modes, and an unavailable level refuses before the prompt', async t => {
  for (const claudeApi of [true, false]) {
    const f = await fixture(t, ['claude-code'], {}, {}, { claudeApi, install: { claudeEffort: 'medium' } })
    f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
    await f.scenario('claude-code', { tape: withEffort(f, ['low', 'medium', 'high']) })
    await f.service().run(input)
    const sets = (await f.trace('claude-code')).filter(frame => frame.method === 'session/set_config_option')
    assert.deepEqual(sets.map(frame => [frame.params.configId, frame.params.value]), [['model', 'model-fixture'], ['effort', 'medium']])
    for (const levels of [['low', 'high'], null]) {
      await f.scenario('claude-code', { tape: withEffort(f, levels) })
      await assert.rejects(f.service().run(input), /effort_unavailable/)
      await noPrompt(f)
    }
  }
})

test('without an effort policy no effort option is touched', async t => {
  const f = await apiFixture(t)
  await f.scenario('claude-code', { tape: withEffort(f, ['low', 'medium']) })
  await f.service().run(input)
  assert.deepEqual((await f.trace('claude-code')).filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params.configId), ['model'])
})

const effortFrames = async (f: Fixture) => (await f.trace('claude-code')).filter(frame => frame.method === 'session/set_config_option' && frame.params.configId === 'effort')
const leadTurn = (resume: string | null) => ({ mcpServers: [], resume: resume ? { acpSessionId: resume } : null, hibernateSignal: new AbortController().signal,
  onSession: () => undefined, onActivity: () => undefined, onUsage: () => undefined })

test('effort levels that exist only after the model switch are read from the switch response, not from session/new', async t => {
  const f = await apiFixture(t, { claudeEffort: 'medium' })
  await f.scenario('claude-code', { effortAfterModel: ['low', 'medium', 'high'] })
  await f.service().run(input)
  assert.deepEqual((await effortFrames(f)).map(frame => frame.params.value), ['medium'])
  await f.scenario('claude-code', { effortAfterModel: ['low', 'high'] })
  await assert.rejects(f.service().run(input), /effort_unavailable/)
  await noPrompt(f)
})

test('an effort the agent acknowledges but does not apply refuses before the prompt; one already current is not set again', async t => {
  const f = await apiFixture(t, { claudeEffort: 'medium' })
  await f.scenario('claude-code', { tape: withEffort(f, ['low', 'medium']), effortIgnored: true })
  await assert.rejects(f.service().run(input), /effort_selection_failed/)
  await noPrompt(f)
  await f.scenario('claude-code', { tape: withEffort(f, ['low', 'medium'], 'medium') })
  await f.service().run(input)
  assert.equal((await effortFrames(f)).length, 0)
  assert.equal(f.connections.store.get(owner, f.bindings[0]!.connectionId).facts.effort!.source.endsWith('acp_session_option_current'), true)
})

test('a resumed (loaded) lead session sets the effort when the agent reports its options and keeps its own when it does not', async t => {
  const f = await apiFixture(t, { claudeEffort: 'medium' })
  const lead = { loadSession: true }
  await f.scenario('claude-code', { lead, tape: withEffort(f, ['low', 'medium', 'high']) })
  await f.service().run({ ...input, lead: leadTurn('lead-session-1') })
  const frames = await f.trace('claude-code')
  assert.equal(frames.filter(frame => frame.method === 'session/load').length, 1)
  assert.deepEqual((await effortFrames(f)).map(frame => frame.params.value), ['medium'])
  const effortFact = () => f.connections.store.get(owner, f.bindings[0]!.connectionId).facts.effort!
  assert.equal(effortFact().value, 'medium'); assert.equal(effortFact().source.endsWith('acp_set_config_option'), true)
  await f.scenario('claude-code', { lead })
  await f.service().run({ ...input, lead: leadTurn('lead-session-1') })
  assert.equal((await f.trace('claude-code')).filter(frame => frame.method === 'session/load').length, 1)
  assert.equal((await effortFrames(f)).length, 0, 'no option reported: the loaded session keeps the effort it was created with')
  assert.equal(effortFact().value, null, 'and the node records that it could not apply the effort')
  assert.equal(effortFact().source.endsWith('loaded_session_options_not_reported'), true)
  // A new session in the same position is refused instead: the agent must offer the level.
  await assert.rejects(f.service().run({ ...input, lead: leadTurn(null) }), /effort_unavailable/)
})

test('claudeEffort belongs to Claude Code installations only', async t => {
  const f = await fixture(t, ['copilot'])
  await assert.rejects(f.reload({ installations: [{ ...f.installations[0]!, claudeEffort: 'medium' }] }), /claude_only|claudeEffort/)
})

test('API key mode refuses to launch when vendor settings files could redirect the key or relax permissions; subscription mode is not affected', async t => {
  const placements = [['config', 'settings.json'], ['config', 'settings.local.json'], ['work', '.claude', 'settings.json'], ['work', '.claude', 'settings.local.json'], ['home', '.claude', 'settings.json']]
  for (const placement of placements) {
    const f = await apiFixture(t)
    const base = (await f.config('claude-code')).configDirectory
    const file = join(base, ...placement)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://redirect.invalid' }, permissions: { defaultMode: 'bypassPermissions' } }))
    await assert.rejects(f.service().run(input), /claude_settings_present/, placement.join('/'))
    await neverLaunched(f)
    await assert.rejects(readFile(join(f.dir, 'claude-code', 'auth-env.json')), { code: 'ENOENT' }, 'not even the status probe saw the key')
  }
  // The subscription directory is another one, and the owner's own settings there stay theirs.
  const sub = await fixture(t, ['claude-code'])
  sub.service().setProjectRoles(owner, owner, 'p', { lead: sub.bindings[0]! })
  const base = (await sub.config('claude-code')).configDirectory
  await writeFile(join(base, 'config', 'settings.json'), JSON.stringify({ model: 'sonnet', effortLevel: 'medium' }))
  await sub.service().run(input)
})

test('API key mode pins the endpoint and the permission mode in the bridge\'s programmatic settings tier, and nowhere else', async t => {
  const f = await apiFixture(t)
  await f.service().run(input)
  const created = (await f.trace('claude-code')).find(frame => frame.method === 'session/new')!
  const settings = created.params._meta?.claudeCode?.options?.settings
  assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
  assert.equal(settings.permissions.defaultMode, 'default')
  assert.equal(JSON.stringify(created).includes(f.anthropicKey), false)
  const sub = await fixture(t, ['claude-code'])
  sub.service().setProjectRoles(owner, owner, 'p', { lead: sub.bindings[0]! })
  await sub.service().run(input)
  assert.equal((await sub.trace('claude-code')).find(frame => frame.method === 'session/new')!.params._meta, undefined)
})

test('API key mode requires the CLI to name the injected variable as the key source', async t => {
  for (const apiKeySource of [undefined, 'apiKeyHelper', '/Users/x/settings.json']) {
    const f = await apiFixture(t)
    await f.scenario('claude-code', { claudeAuth: { loggedIn: true, authMethod: 'api_key', ...(apiKeySource ? { apiKeySource } : {}) } })
    await assert.rejects(f.service().run(input), /claude_api_key_not_in_effect/, String(apiKeySource))
    await noPrompt(f)
  }
  const f = await apiFixture(t)
  await f.scenario('claude-code', { claudeAuth: { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' } })
  await f.service().run(input)
})

test('a settings path that is a dangling symlink still refuses the launch (lstat, not stat)', async t => {
  const f = await apiFixture(t)
  const base = (await f.config('claude-code')).configDirectory
  await symlink(join(base, 'does-not-exist.json'), join(base, 'config', 'settings.json'))
  await assert.rejects(f.service().run(input), /claude_settings_present/)
  await neverLaunched(f)
})

test('a lead turn allows its own node tool server and nothing else; a turn without one allows nothing', async t => {
  const f = await apiFixture(t)
  await f.scenario('claude-code', { lead: {} })
  const turn = { ...leadTurn(null), mcpServers: [{ type: 'http' as const, name: 'guanxi', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer test-only' }] }] }
  await f.service().run({ ...input, lead: turn })
  const options = (await f.trace('claude-code')).find(frame => frame.method === 'session/new')!.params._meta.claudeCode.options
  assert.deepEqual(options.allowedTools, ['mcp__guanxi'])
  assert.deepEqual(options.settings.permissions, { defaultMode: 'default', allow: ['mcp__guanxi'] })
  assert.equal(options.settings.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com')
  const plain = await apiFixture(t)
  await plain.service().run(input)
  const settings = (await plain.trace('claude-code')).find(frame => frame.method === 'session/new')!.params._meta.claudeCode.options
  assert.equal(settings.allowedTools, undefined)
  assert.deepEqual(settings.settings.permissions, { defaultMode: 'default' })
})
