import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp, { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVendorCredentials, vendorCredentialViolations } from '../../scripts/check-vendor-credentials.ts'
import { fixture, owner } from './helpers.ts'

test('static gate scans all production packages, refuses seeded vendor reads/aliases and proprietary dependencies', async t => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  assert.deepEqual(await checkVendorCredentials(root), [])
  const source = '/test/packages/server/src/external-agents/seed.ts'
  for (const planted of [
    `import { readFile as load } from 'node:fs/promises'; await load(process.env.CODEX_HOME + '/auth.json')`,
    `import fs from 'node:fs'; fs.readFileSync('/tmp/.claude/.credentials.json')`,
    `import * as files from 'node:fs/promises'; await files['readFile']('/tmp/.codex/auth.json')`,
    `const fs = await import('node:fs/promises'); fs.readFile('/anything')`,
  ]) assert.ok(vendorCredentialViolations(planted, source).length > 0)
  assert.ok(vendorCredentialViolations(`import { readFile } from 'node:fs/promises'; readFile('/tmp/.codex/auth.json')`, '/test/packages/server/src/elsewhere.ts').length > 0)
  assert.ok(vendorCredentialViolations(`const fs = require('node:fs'); const load = fs.readFileSync; load('/tmp/.codex/auth.json')`, '/test/packages/server/src/elsewhere.ts').length > 0)
  assert.ok(vendorCredentialViolations(`const { readFile: load } = await import('node:fs/promises'); load('/tmp/.claude/.credentials.json')`, '/test/packages/server/src/elsewhere.ts').length > 0)
  assert.deepEqual(vendorCredentialViolations(`import { lstat, mkdir } from 'node:fs/promises'; await lstat(process.env.CODEX_HOME); await mkdir('/tmp/config')`, source), [])
  const seededRoot = await mkdtemp(join(tmpdir(), 'guanxi-k5-static-'))
  t.after(() => rm(seededRoot, { recursive: true, force: true }))
  await mkdir(join(seededRoot, 'packages', 'seed', 'src'), { recursive: true })
  await writeFile(join(seededRoot, 'packages', 'seed', 'src', 'seed.ts'), `import { readFile } from 'node:fs/promises'; readFile('/tmp/.codex/auth.json')`)
  await writeFile(join(seededRoot, 'packages', 'seed', 'package.json'), JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': '0.0.0' } }))
  const violations = await checkVendorCredentials(seededRoot)
  assert.equal(violations.length, 2)
  assert.ok(violations.some(v => v.includes('filesystem content access')))
  assert.ok(violations.some(v => v.includes('process-only dependency')))
})

test('runtime parent is denied every vendor-file read while the fixture CLI alone reads its throwaway login; seeded read trips the same trap', async t => {
  const f = await fixture(t)
  const config = await f.config('codex')
  const tokenFile = join(config.env.CODEX_HOME!, 'auth.json')
  await writeFile(tokenFile, f.secret, { mode: 0o600 })
  await f.scenario('codex', { readVendor: true })
  f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
  const attempts: string[] = []
  const trap = (path: unknown) => {
    if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return
    const name = resolve(path instanceof URL ? fileURLToPath(path) : String(path))
    if (name === resolve(config.configDirectory) || name.startsWith(resolve(config.configDirectory) + sep)) {
      attempts.push('blocked-vendor-read'); throw new Error('fixture_permission_denied')
    }
  }
  for (const [module, names] of [[fs, ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync']],
    [fsp, ['readFile', 'open', 'copyFile', 'cp']]] as const) for (const name of names) {
    const original = (module as any)[name].bind(module)
    t.mock.method(module as any, name, (...args: unknown[]) => { trap(args[0]); return original(...args) })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.throws(() => fs.readFileSync(tokenFile), /fixture_permission_denied/)
  assert.deepEqual(attempts, ['blocked-vendor-read'])
  attempts.length = 0
  const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
  assert.match(result.text, /fixture completed/)
  assert.equal((await f.environment('codex')).vendorRead, true)
  assert.deepEqual(attempts, [])
  assert.equal(JSON.stringify(f.kernel.sessionLog!.readAll(result.sessionId, 'person')).includes(f.secret), false)
})

test('the executable and every vendor directory are node-local and independently isolated by connection', async t => {
  const f = await fixture(t, ['codex', 'claude-code'])
  const a = await f.config('codex'); const b = await f.config('claude-code')
  assert.notEqual(a.configDirectory, b.configDirectory)
  assert.notEqual(a.env.HOME, process.env.HOME)
  assert.notEqual(a.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR)
  assert.notEqual(a.env.CODEX_HOME, process.env.CODEX_HOME)
  const { isolatedEnvironment } = await import('../../src/external-agents/process.ts')
  const otherOwner = await isolatedEnvironment(f.dir, { ...f.installations[0]!, ownerAccountId: 'another-owner' })
  const otherNode = await isolatedEnvironment(f.dir, { ...f.installations[0]!, nodeId: 'another-node' })
  assert.notEqual(a.configDirectory, otherOwner.configDirectory)
  assert.notEqual(a.configDirectory, otherNode.configDirectory)
  const instructions = await f.service().prepareLogin(owner, owner, f.bindings[1]!.connectionId)
  assert.deepEqual(instructions.args, ['auth', 'login'])
  assert.equal(instructions.environment.CLAUDE_CONFIG_DIR, b.env.CLAUDE_CONFIG_DIR)
  assert.equal('OPENAI_ACCESS_TOKEN' in instructions.environment, false)
  assert.throws(() => f.service().prepareLogin(owner, 'editor', f.bindings[1]!.connectionId), /owner_required/)
})
