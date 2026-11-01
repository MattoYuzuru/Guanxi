import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createKernel, definePlugin, parseManifest, type GuanxiManifest } from '@guanxi/kernel'
import { start } from '../../src/index.ts'
import { PluginManager } from '../../src/plugins/manager.ts'
import { computeDirectoryIntegrity } from '../../src/plugins/integrity.ts'
import { loadTrustedPlugins, TrustedPluginStartupError, type TrustedPluginCode, type TrustedPluginRuntime } from '../../src/plugins/startup.ts'

const project = resolve(import.meta.dirname, '../../../..')
const cli = join(project, 'packages/cli/src/bin.ts')
const fixtureManifest = (id: string, extra: Record<string, unknown> = {}) => parseManifest({
  id, engines: { guanxi: '^0.1.0' }, trust: 'T1', ...extra,
})

function moduleText(manifest: GuanxiManifest, body = '', top = ''): string {
  return `${top}\nexport default { [Symbol.for('guanxi.kernel.plugin')]: '0.1.0', manifest: ${JSON.stringify(manifest)},
    apply(ctx) { ${body} } }\n`
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'guanxi-p1-startup-'))
  const directory = join(base, 'data', 'plugins'), logs: unknown[] = []
  const kernel = createKernel({ onLog: record => logs.push(record) }), runtimes: TrustedPluginRuntime[] = []
  const manager = new PluginManager({ pluginsDir: directory, loaded: () => ({ provides: ['test.core', 'test.provider', 'test.cyclic', 'connections.registry', 'agent.native'] }) })
  t.after(async () => {
    for (const runtime of runtimes) await runtime.dispose().catch(() => undefined)
    await kernel.dispose()
    await rm(base, { recursive: true, force: true })
  })
  async function install(id: string, options: { manifest?: Record<string, unknown>; body?: string; top?: string; main?: string; files?: Record<string, string> } = {}) {
    const source = join(base, 'sources', id), manifest = fixtureManifest(id, options.manifest)
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module', main: options.main ?? 'index.mjs', guanxi: manifest, license: 'MIT' }))
    await writeFile(join(source, 'index.mjs'), moduleText(manifest, options.body, options.top))
    for (const [name, text] of Object.entries(options.files ?? {})) {
      await mkdir(dirname(join(source, name)), { recursive: true }); await writeFile(join(source, name), text)
    }
    return manager.install(source)
  }
  async function load(reserved: string[] = []) {
    const runtime = await loadTrustedPlugins(kernel, { directory }, reserved)
    runtimes.push(runtime); return runtime
  }
  return { base, directory, kernel, manager, install, load, logs, runtimes }
}

const errorCode = (code: TrustedPluginCode) => (error: unknown) => error instanceof TrustedPluginStartupError && error.code === code

test('real startup loads the default installed T1 directory after core, and close disposes once', async t => {
  const f = await fixture(t), marker = join(f.base, 'cleanup')
  await f.install('test.start', { manifest: { requires: ['connections.registry', 'agent.native'], provides: ['test.ready'] },
    top: `import { appendFileSync } from 'node:fs';`,
    body: `ctx.provide('test.ready', { ready: true }); return () => appendFileSync(${JSON.stringify(marker)}, 'closed');` })
  const node = await start({ port: 0, dataDir: join(f.base, 'data'), webDir: f.base, devOrigins: [] })
  try {
    assert.deepEqual(node.kernel.node.service('test.ready'), { ready: true })
    assert.ok(node.kernel.node.service('runs.durable'))
    assert.ok(node.kernel.node.service('connections.registry'))
    assert.equal((await fetch(`${node.url}/api/health`)).status, 200)
    assert.deepEqual(node.trustedPlugins, { mode: 'normal', outcomes: [{ id: 'test.start', status: 'loaded' }] })
  } finally { await node.close(); await node.close() }
  assert.equal(await readFile(marker, 'utf8'), 'closed')
  assert.equal(node.kernel.node.counters().fibers, 0)
})

test('safe mode reads no malformed addon state, imports nothing, and keeps core services', async t => {
  const f = await fixture(t), marker = join(f.base, 'top-level')
  await f.install('test.safe', { top: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');` })
  await writeFile(join(f.directory, 'plugins.lock.json'), 'not-json')
  const before = await readFile(join(f.directory, 'plugins.lock.json'), 'utf8')
  const node = await start({ port: 0, dataDir: join(f.base, 'data'), webDir: f.base, trustedPlugins: { safeMode: true } })
  try {
    assert.deepEqual(node.trustedPlugins, { mode: 'safe-mode', outcomes: [] })
    for (const name of ['governor', 'runs.durable', 'session.log', 'connections.registry', 'agent.native']) assert.ok(node.kernel.node.service(name), name)
    assert.equal(await readFile(join(f.directory, 'plugins.lock.json'), 'utf8'), before)
    assert.equal((await readdir(f.base)).includes('top-level'), false)
  } finally { await node.close() }
})

test('absent addon state loads none without creating an installation directory', async t => {
  const f = await fixture(t)
  const runtime = await f.load()
  assert.deepEqual(runtime.report, { mode: 'normal', outcomes: [] })
  assert.equal((await readdir(f.base)).includes('data'), false)
})

test('disabled, missing and tampered addons are not imported and skips have content-free codes', async t => {
  const f = await fixture(t), marker = join(f.base, 'top-level')
  const top = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'ran');`
  await f.install('test.disabled', { top }); await f.manager.setEnabled('test.disabled', false)
  const missing = await f.install('test.missing', { top }); await rm(missing.path, { recursive: true })
  const tampered = await f.install('test.tampered', { top }); await writeFile(join(tampered.path, 'index.mjs'), `${top}\nthrow Error('private-source');`)
  const runtime = await f.load()
  assert.deepEqual(runtime.report.outcomes, [
    { id: 'test.missing', status: 'skipped', code: 'missing_directory' },
    { id: 'test.tampered', status: 'skipped', code: 'integrity_mismatch' },
  ])
  assert.equal((await readdir(f.base)).includes('top-level'), false)
  assert.equal(JSON.stringify(runtime.report).includes(f.base), false)
})

test('required services order providers before consumers despite installed ID order', async t => {
  const f = await fixture(t)
  await f.install('test.z-provider', { manifest: { provides: ['test.provider'] }, body: "ctx.provide('test.provider', 41);" })
  await f.install('test.a-consumer', { manifest: { requires: ['test.provider'], provides: ['test.answer'] }, body: "ctx.provide('test.answer', ctx.service('test.provider') + 1);" })
  const runtime = await f.load()
  assert.equal(f.kernel.service('test.answer'), 42)
  assert.deepEqual(runtime.report.outcomes.map(o => o.id), ['test.z-provider', 'test.a-consumer'])
})

test('declared slot owners load before consumers through explicit host-helper imports', async t => {
  const f = await fixture(t), helpers = pathToFileURL(join(project, 'packages/kernel/src/index.ts')).href
  await f.install('test.z-owner', { manifest: { contributes: { slotDeclarations: ['test.slot'] } },
    top: `import { declareSlot } from ${JSON.stringify(helpers)};`, body: "declareSlot(ctx, 'test.slot');" })
  await f.install('test.a-consumer', { manifest: { contributes: { slots: ['test.slot'] } },
    top: `import { contribute } from ${JSON.stringify(helpers)};`, body: "contribute(ctx, 'test.slot', { id: 'entry', value: 'ready' });" })
  const runtime = await f.load()
  assert.deepEqual(runtime.report.outcomes.map(o => o.id), ['test.z-owner', 'test.a-consumer'])
  assert.deepEqual(f.kernel.slots.list('test.slot').map(entry => ({ id: entry.id, value: entry.value })), [{ id: 'entry', value: 'ready' }])
  await runtime.dispose()
  assert.equal(f.kernel.slots.isDeclared('test.slot'), false)
  assert.equal(f.kernel.slots.list('test.slot').length, 0)
})

for (const scenario of ['missing dependency', 'dependency cycle', 'core id', 'core service', 'core slot', 'undeclared slot'] as const) {
  test(`${scenario} is refused before top-level code or apply`, async t => {
    const f = await fixture(t), marker = join(f.base, 'side-effect')
    const top = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`
    if (scenario === 'core service') await f.kernel.plugin(definePlugin({ manifest: { id: 'test.core', trust: 'T0', engines: { guanxi: '^0.1.0' }, provides: ['test.core'] }, apply: ctx => { ctx.provide('test.core', true) } }))
    if (scenario === 'core slot') await f.kernel.plugin(definePlugin({ manifest: { id: 'test.core', trust: 'T0', engines: { guanxi: '^0.1.0' }, contributes: { slotDeclarations: ['test.slot'] } }, apply: async ctx => { const { declareSlot } = await import('@guanxi/kernel'); declareSlot(ctx, 'test.slot') } }))
    await f.install('test.target', { top, manifest: scenario === 'missing dependency' ? { requires: ['test.provider'] }
      : scenario === 'dependency cycle' ? { provides: ['test.provider'], requires: ['test.cyclic'] }
      : scenario === 'core service' ? { provides: ['test.core'] }
      : scenario === 'core slot' ? { contributes: { slotDeclarations: ['test.slot'] } }
      : scenario === 'undeclared slot' ? { contributes: { slots: ['test.absent'] } } : {} })
    if (scenario === 'dependency cycle') await f.install('test.cycle', { manifest: { provides: ['test.cyclic'], requires: ['test.provider'] } })
    const code = scenario === 'dependency cycle' ? 'dependency_cycle' : ['core id', 'core service', 'core slot'].includes(scenario) ? 'core_collision' : 'dependency_unavailable'
    await assert.rejects(f.load(scenario === 'core id' ? ['test.target'] : []), errorCode(code))
    assert.equal((await readdir(f.base)).includes('side-effect'), false)
    assert.equal(f.kernel.counters().fibers, scenario === 'core service' || scenario === 'core slot' ? 1 : 0)
  })
}

for (const main of ['../outside.mjs', '/tmp/outside.mjs', 'index.cjs', 'missing.mjs']) {
  test(`entry ${main} is refused before import`, async t => {
    const f = await fixture(t)
    await f.install('test.entry', { main })
    await assert.rejects(f.load(), errorCode('invalid_entry'))
    assert.equal(f.kernel.counters().fibers, 0)
  })
}

test('symlinked entry is not executed even when the installed directory is redirected after capture', async t => {
  const f = await fixture(t), installed = await f.install('test.link')
  await rm(join(installed.path, 'index.mjs'))
  await symlink(cli, join(installed.path, 'index.mjs'))
  const runtime = await f.load()
  assert.deepEqual(runtime.report.outcomes, [{ id: 'test.link', status: 'skipped', code: 'integrity_mismatch' }])
  assert.equal(f.kernel.counters().fibers, 0)
})

test('export manifest mismatch is refused before apply, and plugin error text stays out of loader errors', async t => {
  const f = await fixture(t)
  await f.install('test.mismatch', { top: '', files: { 'index.mjs': moduleText(fixtureManifest('test.foreign'), "throw Error('private-apply');") } })
  await assert.rejects(f.load(), errorCode('manifest_mismatch'))
  assert.equal(f.kernel.counters().fibers, 0)
})

test('apply failure rolls back earlier addon effects, retains core, and sanitizes thrown contents', async t => {
  const f = await fixture(t), cleaned = join(f.base, 'cleaned'), snapshot = join(f.base, 'snapshot')
  await f.kernel.plugin(definePlugin({ manifest: { id: 'test.core', trust: 'T0', engines: { guanxi: '^0.1.0' }, provides: ['test.core'] }, apply: ctx => { ctx.provide('test.core', true) } }))
  await f.install('test.a-good', { manifest: { provides: ['test.good'] }, top: "import { appendFileSync } from 'node:fs';",
    body: `appendFileSync(${JSON.stringify(snapshot)}, import.meta.url); ctx.provide('test.good', true); ctx.effect(() => () => appendFileSync(${JSON.stringify(cleaned)}, 'once'));` })
  await f.install('test.z-fail', { body: "ctx.on('test.event', () => {}); throw Error('private-apply-sentinel');" })
  await assert.rejects(f.load(), errorCode('apply_failed'))
  assert.equal(await readFile(cleaned, 'utf8'), 'once')
  assert.equal(f.kernel.service('test.good'), undefined)
  assert.equal(f.kernel.service('test.core'), true)
  assert.equal(f.kernel.counters().listeners, 0)
  assert.equal(f.kernel.counters().fibers, 1)
  assert.equal(JSON.stringify(f.logs).includes('private-apply-sentinel'), false)
  await assert.rejects(readFile(fileURLToPath(await readFile(snapshot, 'utf8'))), { code: 'ENOENT' })
})

test('fresh runtime copies load fresh relative module graphs and remain available through disposal', async t => {
  const f = await fixture(t)
  await f.install('test.fresh', { manifest: { provides: ['test.counter'] }, top: "import { next } from './counter.mjs';",
    files: { 'counter.mjs': 'let count = 0; export const next = () => ++count;' }, body: "ctx.provide('test.counter', { count: next(), url: import.meta.url });" })
  const first = await f.load()
  const firstValue = f.kernel.service<{ count: number; url: string }>('test.counter')!
  assert.equal(firstValue.count, 1)
  assert.ok((await readFile(fileURLToPath(firstValue.url), 'utf8')).includes('import.meta.url'))
  assert.equal((await stat(dirname(dirname(fileURLToPath(firstValue.url))))).mode & 0o777, 0o700)
  await first.dispose(); await first.dispose()
  assert.equal(f.kernel.counters().fibers, 0)
  await assert.rejects(readFile(fileURLToPath(firstValue.url)), { code: 'ENOENT' })
  const second = await f.load()
  const secondValue = f.kernel.service<{ count: number; url: string }>('test.counter')!
  assert.equal(secondValue.count, 1, 'relative dependency did not reuse the first module instance')
  assert.notEqual(secondValue.url, firstValue.url)
  await second.dispose()
})

test('two addon providers of the same service are refused before either module executes', async t => {
  const f = await fixture(t), marker = join(f.base, 'top-level')
  const top = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'ran');`
  await f.install('test.one', { manifest: { provides: ['test.shared'] }, top })
  await f.install('test.two', { manifest: { provides: ['test.shared'] }, top })
  await assert.rejects(f.load(), errorCode('core_collision'))
  assert.equal((await readdir(f.base)).includes('top-level'), false)
})

test('installed bytes changed after snapshot creation cannot change the later addon execution', async t => {
  const f = await fixture(t)
  const later = await f.install('test.z-later', { manifest: { provides: ['test.pinned'] }, body: "ctx.provide('test.pinned', 42);" })
  const changed = moduleText(fixtureManifest('test.z-later', { provides: ['test.pinned'] }), "ctx.provide('test.pinned', 999);")
  await f.install('test.a-mutator', { top: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(later.path, 'index.mjs'))}, ${JSON.stringify(changed)});` })
  const runtime = await f.load()
  assert.equal(f.kernel.service('test.pinned'), 42)
  assert.equal(await readFile(join(later.path, 'index.mjs'), 'utf8'), changed)
  await runtime.dispose()
})

for (const trust of ['T0', 'T2']) {
  test(`hand-written pinned ${trust} state is refused before top-level code`, async t => {
    const f = await fixture(t), marker = join(f.base, 'top-level')
    const installed = await f.install('test.trust', { top: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');` })
    const pkgPath = join(installed.path, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { guanxi: { trust: string } }
    pkg.guanxi.trust = trust
    await writeFile(pkgPath, JSON.stringify(pkg))
    const lockPath = join(f.directory, 'plugins.lock.json'), lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.plugins['test.trust'].integrity = await computeDirectoryIntegrity(installed.path)
    await writeFile(lockPath, JSON.stringify(lock))
    await assert.rejects(f.load(), errorCode('trust_tier_unsupported'))
    assert.equal((await readdir(f.base)).includes('top-level'), false)
  })
}

test('actual node startup aborts before listening after addon apply failure; safe-mode can recover the same state', async t => {
  const f = await fixture(t)
  await f.install('test.failure', { body: "throw Error('private-source-sentinel');" })
  const reservation = createServer()
  await new Promise<void>(resolveReady => reservation.listen(0, '127.0.0.1', resolveReady))
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolveClosed, reject) => reservation.close(error => error ? reject(error) : resolveClosed()))
  const options = { port, dataDir: join(f.base, 'data'), webDir: f.base }
  await assert.rejects(start(options), errorCode('apply_failed'))
  const probe = createConnection({ host: '127.0.0.1', port })
  const [error] = await once(probe, 'error') as [NodeJS.ErrnoException]
  assert.equal(error.code, 'ECONNREFUSED', 'failed startup left no HTTP listener')
  const node = await start({ ...options, trustedPlugins: { safeMode: true } })
  try {
    assert.equal(node.kernel.node.counters().fibers, 12)
    assert.equal((await fetch(`${node.url}/api/health`)).status, 200)
  } finally { await node.close() }
})

test('node startup inspection preserves retained unreferenced installation data', async t => {
  const f = await fixture(t), orphan = join(f.directory, 'test.archive@1.0.0')
  await mkdir(orphan, { recursive: true }); await writeFile(join(orphan, 'retained'), 'keep')
  const before = await readdir(f.directory)
  await f.load()
  assert.deepEqual(await readdir(f.directory), before)
  assert.equal(await readFile(join(orphan, 'retained'), 'utf8'), 'keep')
})

test('startup accepts the manager-supported SRI base64 form without rewriting the lock', async t => {
  const f = await fixture(t), installed = await f.install('test.sri')
  const lockPath = join(f.directory, 'plugins.lock.json'), lock = JSON.parse(await readFile(lockPath, 'utf8'))
  lock.plugins['test.sri'].integrity = `sha256-${Buffer.from(installed.integrity.slice(7), 'hex').toString('base64')}`
  const bytes = JSON.stringify(lock)
  await writeFile(lockPath, bytes)
  const runtime = await f.load()
  assert.deepEqual(runtime.report.outcomes, [{ id: 'test.sri', status: 'loaded' }])
  assert.equal(await readFile(lockPath, 'utf8'), bytes)
})

test('malformed hand-written skipped ids cannot echo source-like data in a report or error', async t => {
  const f = await fixture(t), id = 'PRIVATE\nnot-a-plugin-id'
  await mkdir(f.directory, { recursive: true })
  await writeFile(join(f.directory, 'plugins.json'), JSON.stringify({ enabled: [id] }))
  await writeFile(join(f.directory, 'plugins.lock.json'), JSON.stringify({ plugins: { [id]: { version: '1.0.0', integrity: `sha256-${'0'.repeat(64)}`, directory: `${id}@1.0.0` } } }))
  await assert.rejects(f.load(), error => {
    assert.ok(error instanceof TrustedPluginStartupError)
    assert.equal(error.code, 'state_invalid')
    assert.equal(error.message.includes('PRIVATE'), false)
    return true
  })
})

test('bundled snapshot does not accidentally resolve the host kernel from an ancestor node_modules', async t => {
  const f = await fixture(t)
  await f.install('test.unbundled', { top: "import { definePlugin } from '@guanxi/kernel'; void definePlugin;" })
  await assert.rejects(f.load(), errorCode('import_failed'))
  assert.equal(f.kernel.counters().fibers, 0)
})

test('CLI --safe-mode recovers malformed installed state without changing it', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { recursive: true }); await writeFile(join(f.directory, 'plugins.lock.json'), 'malformed')
  const child = spawn(process.execPath, [cli, '--port', '0', '--data-dir', join(f.base, 'data'), '--no-open', '--safe-mode'], {
    cwd: project, env: { ...process.env, GUANXI_PROVIDER_KEYS_FILE: '', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGKILL'))
  let output = '', errors = ''
  child.stderr.on('data', data => { errors += String(data) })
  const ready = new Promise<void>((resolveReady, reject) => {
    child.stdout.on('data', data => { output += String(data); if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) resolveReady() })
    child.once('exit', () => reject(new Error(`CLI stopped before ready: ${errors}`)))
  })
  await ready
  assert.equal(await readFile(join(f.directory, 'plugins.lock.json'), 'utf8'), 'malformed')
  const exited = once(child, 'exit'); child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])
  assert.equal(errors.includes('state_invalid'), false)
})

test('ordinary CLI startup consumes enabled plugins without a host-only option', { timeout: 30_000 }, async t => {
  const f = await fixture(t), marker = join(f.base, 'cli-addon')
  await f.install('test.cli', { top: "import { writeFileSync } from 'node:fs';", body: `writeFileSync(${JSON.stringify(marker)}, 'applied');` })
  const child = spawn(process.execPath, [cli, '--port', '0', '--data-dir', join(f.base, 'data'), '--no-open'], {
    cwd: project, env: { ...process.env, GUANXI_PROVIDER_KEYS_FILE: '', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGKILL'))
  let output = '', errors = ''
  child.stderr.on('data', data => { errors += String(data) })
  await new Promise<void>((resolveReady, reject) => {
    child.stdout.on('data', data => { output += String(data); if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) resolveReady() })
    child.once('exit', () => reject(new Error(`CLI stopped before ready: ${errors}`)))
  })
  assert.equal(await readFile(marker, 'utf8'), 'applied')
  const exited = once(child, 'exit'); child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])
})

test('CLI --safe-mode never pretends an existing node was restarted safely', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const node = await start({ port: 0, dataDir: join(f.base, 'data'), webDir: f.base })
  try {
    const child = spawn(process.execPath, [cli, '--port', String(node.port), '--data-dir', join(f.base, 'data'), '--no-open', '--safe-mode'], {
      cwd: project, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => child.kill('SIGKILL'))
    let output = '', errors = ''
    child.stdout.on('data', data => { output += String(data) }); child.stderr.on('data', data => { errors += String(data) })
    assert.deepEqual(await once(child, 'exit'), [1, null])
    assert.equal(output, '')
    assert.ok(errors.includes('Safe mode requires a stopped node'))
    assert.equal((await fetch(`${node.url}/api/health`)).status, 200, 'the existing listener was not stopped')
  } finally { await node.close() }
})

test('CLI --safe-mode discovers GUANXI_API_PORT before any startup data effects', { timeout: 30_000 }, async t => {
  const f = await fixture(t)
  const node = await start({ port: 0, dataDir: join(f.base, 'data'), webDir: f.base })
  try {
    await mkdir(f.directory, { recursive: true })
    const statePath = join(f.directory, 'plugins.lock.json')
    await writeFile(statePath, 'retained-malformed-state')
    const freshData = join(f.base, 'must-not-be-created')
    const child = spawn(process.execPath, [cli, '--data-dir', freshData, '--no-open', '--safe-mode'], {
      cwd: project, env: { ...process.env, GUANXI_API_PORT: String(node.port), PORT: '', HOST: '127.0.0.1',
        LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => child.kill('SIGKILL'))
    let output = '', errors = ''
    child.stdout.on('data', data => { output += String(data) }); child.stderr.on('data', data => { errors += String(data) })
    assert.deepEqual(await once(child, 'exit'), [1, null])
    assert.equal(output, '')
    assert.ok(errors.includes('Safe mode requires a stopped node'), errors)
    await assert.rejects(stat(freshData), { code: 'ENOENT' }, 'no second node opened a data directory before refusing')
    assert.equal(await readFile(statePath, 'utf8'), 'retained-malformed-state')
    assert.equal((await fetch(`${node.url}/api/health`)).status, 200)
  } finally { await node.close() }
})
