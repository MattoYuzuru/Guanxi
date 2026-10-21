import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp, { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import childProcess from 'node:child_process'
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

test('rule 1: template heads, spans and tails taint a vendor path like string literals', () => {
  const other = '/x/packages/server/src/elsewhere/seed.ts'
  assert.ok(vendorCredentialViolations(
    "import { readFile } from 'node:fs/promises'; import { homedir } from 'node:os'; await readFile(`${homedir()}/.codex/auth.json`)", other).length > 0)
  assert.ok(vendorCredentialViolations(
    "import { readFile } from 'node:fs/promises'; const home = '/Users/o'; await readFile(`${home}/.claude/.credentials.json`)", other).length > 0)
})

test('rule 2: rename, link and symlink moves are forbidden on vendor paths', () => {
  const k5 = '/x/packages/server/src/external-agents/seed.ts'
  for (const planted of [
    "import { rename } from 'node:fs/promises'; await rename('/Users/o/.codex/auth.json', '/tmp/x')",
    "import { renameSync } from 'node:fs'; renameSync('/Users/o/.codex/auth.json', '/tmp/x')",
    "import { link } from 'node:fs/promises'; await link('/Users/o/.codex/auth.json', '/tmp/x')",
    "import { linkSync } from 'node:fs'; linkSync('/Users/o/.codex/auth.json', '/tmp/x')",
    "import { symlink } from 'node:fs/promises'; await symlink('/Users/o/.codex/auth.json', '/iso/config/auth.json')",
    "import { symlinkSync } from 'node:fs'; symlinkSync('/Users/o/.codex/auth.json', '/iso/config/auth.json')",
  ]) assert.ok(vendorCredentialViolations(planted, k5).length > 0, planted)
})

test('rule 3: call, apply and bind indirection resolves to the underlying filesystem API', () => {
  const k5 = '/x/packages/server/src/external-agents/seed.ts'
  for (const planted of [
    "import fs from 'node:fs'; fs.readFileSync.call(null, '/Users/o/.codex/auth.json')",
    "import { readFileSync as r } from 'node:fs'; r.apply(null, ['/Users/o/.codex/auth.json'])",
    "import { readFile } from 'node:fs/promises'; readFile.bind(null, '/Users/o/.codex/auth.json')",
  ]) assert.ok(vendorCredentialViolations(planted, k5).length > 0, planted)
})

test('rule 4: namespace destructuring is an alias import', () => {
  const k5 = '/x/packages/server/src/external-agents/seed.ts'
  for (const planted of [
    "import * as f from 'node:fs'; const { readFileSync: r } = f; r('/Users/o/.codex/auth.json')",
    "import * as f from 'node:fs/promises'; const { readFile: r } = f; await r('/Users/o/.codex/auth.json')",
    "const { readFileSync: r } = require('node:fs'); r('/Users/o/.codex/auth.json')",
  ]) assert.ok(vendorCredentialViolations(planted, k5).length > 0, planted)
})

test('rule 5: createRequire is refused under external-agents', () => {
  const k5 = '/x/packages/server/src/external-agents/seed.ts'
  for (const planted of [
    "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); req('node:fs').readFileSync('/Users/o/.codex/auth.json')",
    "import { createRequire as make } from 'node:module'; const req = make(import.meta.url); req('node:child_process')",
  ]) assert.ok(vendorCredentialViolations(planted, k5).length > 0, planted)
  assert.deepEqual(vendorCredentialViolations(
    "import { readFile } from 'node:fs/promises'; await readFile('/tmp/x')", '/x/packages/server/src/elsewhere/seed.ts'), [])
})

test('rule 6: child_process imports and executions are confined to spawn in process.ts', () => {
  const k5 = '/x/packages/server/src/external-agents/seed.ts'
  const processFile = '/x/packages/server/src/external-agents/process.ts'
  for (const planted of [
    "import { execFileSync } from 'node:child_process'; execFileSync('cat', ['/x'])",
    "import cp from 'node:child_process'; cp.exec('cat /x')",
    "import * as cp from 'node:child_process'; cp.spawnSync('cat')",
    "const { fork } = require('node:child_process'); fork('/x')",
    "import { spawn } from 'node:child_process'; spawn('cat')",
    "import { exec } from 'node:child_process'; exec('security find-generic-password')",
  ]) assert.ok(vendorCredentialViolations(planted, k5).length > 0, planted)
  assert.deepEqual(vendorCredentialViolations("import { spawn } from 'node:child_process'; spawn('x')", processFile), [])
  assert.deepEqual(vendorCredentialViolations(
    "import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'; spawn('x')", processFile), [])
  assert.ok(vendorCredentialViolations("import { execFileSync, spawn } from 'node:child_process'; spawn('x')", processFile).length > 0)
  assert.ok(vendorCredentialViolations("import * as cp from 'node:child_process'; cp.spawn('x')", processFile).length > 0)
  assert.ok(vendorCredentialViolations(
    "import { execFileSync } from 'node:child_process'; execFileSync('cat', ['/Users/o/.claude/.credentials.json'])",
    '/x/packages/server/src/elsewhere/seed.ts').length > 0)
})

test('rule 7: the scan covers every source/scripts directory, kernel/bin and all module extensions', async t => {
  const seededRoot = await mkdtemp(join(tmpdir(), 'guanxi-k5-scope-'))
  t.after(() => rm(seededRoot, { recursive: true, force: true }))
  const files = [
    'packages/seed/src/a.ts', 'packages/seed/src/b.tsx', 'packages/seed/src/c.js',
    'packages/seed/src/d.mjs', 'packages/seed/src/e.cjs', 'packages/seed/scripts/f.mts',
    'packages/kernel/bin/g.cts',
  ]
  for (const file of files) {
    const path = join(seededRoot, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `import { readFile } from 'node:fs/promises'; await readFile('/Users/o/.codex/auth.json')`)
  }
  const violations = await checkVendorCredentials(seededRoot)
  assert.equal(violations.length, files.length)
  for (const file of files) assert.ok(violations.some(violation => violation.startsWith(file)), file)
})

test('runtime trap watches vendor paths under HOME and child_process helpers during an adapter run', async t => {
  const f = await fixture(t)
  const config = await f.config('codex')
  await writeFile(join(config.env.CODEX_HOME!, 'auth.json'), f.secret, { mode: 0o600 })
  await f.scenario('codex', { readVendor: true })
  const fakeHome = await mkdtemp(join(tmpdir(), 'guanxi-k5-home-'))
  t.after(() => rm(fakeHome, { recursive: true, force: true }))
  const watched = ['.claude', '.codex', '.copilot', '.gemini', '.config'].map(name => join(fakeHome, name))
  for (const directory of watched) await mkdir(directory, { recursive: true })
  const tokenFile = join(fakeHome, '.codex', 'auth.json')
  await writeFile(tokenFile, '{"token":"dummy-token"}', { mode: 0o600 })
  const attempts: string[] = []
  const watchedPath = (path: string) => watched.some(directory => path === directory || path.startsWith(directory + sep))
  const trapPath = (path: unknown) => {
    if (typeof path !== 'string' && !(path instanceof URL) && !Buffer.isBuffer(path)) return
    const name = resolve(path instanceof URL ? fileURLToPath(path) : String(path))
    if (watchedPath(name)) { attempts.push('blocked-vendor-read'); throw new Error('fixture_permission_denied') }
  }
  for (const [module, names] of [[fs, ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync']],
    [fsp, ['readFile', 'open', 'copyFile', 'cp']]] as const) for (const name of names) {
    const original = (module as any)[name].bind(module)
    t.mock.method(module as any, name, (...args: unknown[]) => { trapPath(args[0]); return original(...args) })
  }
  for (const name of ['spawn', 'execFile', 'execFileSync', 'exec', 'execSync', 'spawnSync'] as const) {
    const original = (childProcess as any)[name].bind(childProcess)
    t.mock.method(childProcess as any, name, (...args: unknown[]) => {
      const text = args.map(value => typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '').join(' ')
      if (watched.some(directory => text.includes(directory))) {
        attempts.push(`blocked-child-process:${name}`); throw new Error('fixture_permission_denied')
      }
      return original(...args)
    })
  }
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.throws(() => fs.readFileSync(tokenFile), /fixture_permission_denied/)
  assert.throws(() => childProcess.execFileSync('/bin/cat', [tokenFile]), /fixture_permission_denied/)
  attempts.length = 0
  const previousHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    f.service().setProjectRoles(owner, owner, 'p', { lead: f.bindings[0]! })
    const result = await f.service().run({ ownerAccountId: owner, actorAccountId: owner, projectId: 'p', role: 'lead', prompt: 'hello' })
    assert.match(result.text, /fixture completed/)
    assert.equal(result.text.includes('dummy-token'), false)
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome }
  assert.equal((await f.environment('codex')).vendorRead, true)
  assert.equal((await f.environment('codex')).HOME.startsWith(fakeHome), false)
  assert.deepEqual(attempts, [])
})
