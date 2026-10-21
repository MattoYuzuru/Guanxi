import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, link } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { sandboxCommand, quote, type SandboxPolicy } from '../../src/native-agent/sandbox.ts'
import { orientation } from '../../src/native-agent/orientation.ts'

async function fixture(t: { after(fn: () => unknown): void }) {
  // Colima shares the checkout; its default VM does not share macOS /private/tmp.
  await mkdir(join(process.cwd(), '.lane-data'), { recursive: true })
  const dir = await realpath(await mkdtemp(join(process.cwd(), '.lane-data', 'k4-sandbox-')))
  const scratch = join(dir, 'scratch'), root = join(dir, 'root'), other = join(dir, 'outside')
  await Promise.all([scratch, root, other].map(p => mkdir(p)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const policy: SandboxPolicy = { mode: 'read-only', scratch, runtimeBase: dir, roots: [root], attachments: [], protectedPaths: [join(root, 'protected')], domains: [] }
  return { dir, root, other, policy }
}
test('Read-only OS profile allows scratch and denies root/outside/protected writes and symlink escape', { timeout: 30000 }, async t => {
  const { root, other, policy } = await fixture(t)
  await writeFile(join(root, 'protected'), 'original')
  await writeFile(join(other, 'sentinel'), 'outside')
  await symlink(other, join(root, 'escape'))
  const result = await sandboxCommand(policy, `printf ok > ${quote(join(policy.scratch, 'ok'))}; printf bad > ${quote(join(root, 'new'))}; printf bad > ${quote(join(other, 'sentinel'))}; printf bad > ${quote(join(root, 'protected'))}; printf bad > ${quote(join(root, 'escape/sentinel'))}`)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(join(policy.scratch, 'ok'), 'utf8'), 'ok')
  assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'outside')
  assert.equal(await readFile(join(root, 'protected'), 'utf8'), 'original')
  await assert.rejects(readFile(join(root, 'new')))
})
test('Full access OS profile writes both roots but denies outside, symlink escape and protected paths', { timeout: 30000 }, async t => {
  const { root, other, policy } = await fixture(t)
  const second = join(policy.scratch, '../second'); await mkdir(second)
  await writeFile(join(root, 'protected'), 'original'); await writeFile(join(other, 'sentinel'), 'outside')
  await symlink(other, join(root, 'escape'))
  const full = { ...policy, mode: 'full-access' as const, roots: [root, second] }
  const good = await sandboxCommand(full, `printf yes > ${quote(join(root, 'new'))}; printf yes > ${quote(join(second, 'new'))}`)
  assert.equal(good.code, 0)
  assert.equal(await readFile(join(root, 'new'), 'utf8'), 'yes'); assert.equal(await readFile(join(second, 'new'), 'utf8'), 'yes')
  const bad = await sandboxCommand(full, `printf bad > ${quote(join(other, 'sentinel'))}; printf bad > ${quote(join(root, 'protected'))}; printf bad > ${quote(join(root, 'escape/sentinel'))}`)
  assert.notEqual(bad.code, 0)
  assert.equal(await readFile(join(other, 'sentinel'), 'utf8'), 'outside'); assert.equal(await readFile(join(root, 'protected'), 'utf8'), 'original')
})
test('Full access with zero roots writes only scratch; attachments are immutable', { timeout: 30000 }, async t => {
  const { root, other, policy } = await fixture(t)
  const attachment = join(other, 'attachment'); await writeFile(attachment, 'attached')
  const zero = { ...policy, mode: 'full-access' as const, roots: [], attachments: [attachment] }
  const result = await sandboxCommand(zero, `printf ok > ${quote(join(policy.scratch, 'ok'))}; printf bad > ${quote(join(root, 'new'))}; printf bad > ${quote(attachment)}`)
  assert.notEqual(result.code, 0); assert.equal(await readFile(join(policy.scratch, 'ok'), 'utf8'), 'ok')
  await assert.rejects(readFile(join(root, 'new'))); assert.equal(await readFile(attachment, 'utf8'), 'attached')
})
test('method proxy permits GET/HEAD/OPTIONS, blocks POST/PUT/DELETE, opaque tunnels and raw sockets; Full obeys allowlist', { timeout: 60000 }, async t => {
  const { policy } = await fixture(t)
  const methods: string[] = []
  const server = createServer((req, res) => { methods.push(req.method!); res.end('fixture') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise<void>(r => server.close(() => r())))
  const port = (server.address() as { port: number }).port
  policy.domains = [`127.0.0.1:${port}`]
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']) {
    const r = await sandboxCommand(policy, `curl --noproxy '' --max-time 3 -s -o /dev/null -w '%{http_code}' -X ${method} ${method === 'HEAD' ? '--head' : ''} http://127.0.0.1:${port}/`)
    assert.equal(r.stdout, ['GET', 'HEAD', 'OPTIONS'].includes(method) ? '200' : '403', `${method}: ${r.stderr}`)
  }
  assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS'])
  // TLS is terminated and filtered before any upstream request, even for HTTPS POST.
  const tlsPost = await sandboxCommand(policy, `curl --noproxy '' -k -s --max-time 3 -X POST -o /dev/null -w '%{http_code}' https://127.0.0.1:${port}/`)
  assert.equal(tlsPost.stdout, '403', tlsPost.stderr)
  assert.equal(methods.length, 3)
  const raw = await sandboxCommand(policy, `node -e ${quote(`const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('error',()=>{console.log('blocked')});s.on('connect',()=>{console.log('ESCAPED');s.end()});setTimeout(()=>s.destroy(),1000)`)} `)
  assert.equal(raw.stdout.trim(), 'blocked')
  const tunnel = await sandboxCommand(policy, `curl --noproxy '' --max-time 3 -s --max-time 3 --proxytunnel -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/`)
  assert.notEqual(tunnel.code, 0)
  const full = await sandboxCommand({ ...policy, mode: 'full-access' }, `curl --noproxy '' --max-time 3 -s -X POST http://127.0.0.1:${port}/`)
  assert.equal(full.stdout, 'fixture'); assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS', 'POST'])
  const denied = await sandboxCommand({ ...policy, mode: 'full-access', domains: [] }, `curl --noproxy '' --max-time 3 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/`)
  assert.equal(denied.stdout, '403'); assert.equal(methods.length, 4)
})
test('orientation UTF-8 byte upper bound never exceeds 300, even with long/unicode paths and many roots', () => {
  for (const mode of ['read-only', 'full-access'] as const) {
    const text = orientation({ mode, scratch: '界'.repeat(500), roots: Array(100000).fill('/very/long/path'), attachments: [], protectedPaths: [], domains: [] })
    assert.ok(Buffer.byteLength(text) <= 300)
    assert.match(text, /AGENTS.md/); assert.match(text, /budget/)
  }
})
test('editing a writable checkout cannot replace the next trusted sandbox launcher', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  await writeFile(join(root, 'protected'), 'original')
  const { copyFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  for (const file of ['sandbox.ts', 'sandbox-worker.ts', 'sandbox-protocol.ts', 'execution-owner.ts', 'container-runner.ts']) await copyFile(new URL(`../../src/native-agent/${file}`, import.meta.url), join(root, file))
  await symlink(new URL('../../../../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
  const { sandboxCommand: cloned } = await import(pathToFileURL(join(root, 'sandbox.ts')).href)
  const full = { ...policy, mode: 'full-access' as const, roots: [root] }
  const poison = "process.send({result:{code:0,stdout:'ESCAPED',stderr:'',truncated:false}},()=>process.exit(0))"
  const altered = await cloned(full, `printf %s ${quote(poison)} > ${quote(join(root, 'sandbox-worker.ts'))}`)
  assert.equal(altered.code, 0)
  assert.equal(await readFile(join(root, 'sandbox-worker.ts'), 'utf8'), poison)
  const next = await cloned(full, 'printf safe')
  assert.equal(next.stdout, 'safe')
  assert.equal(await readFile(join(root, 'protected'), 'utf8'), 'original')
})

test('Full access refuses pre-existing hardlinks that could mutate files outside roots', { timeout: 30000 }, async t => {
  const { policy, root, other } = await fixture(t)
  const target = join(other, 'sentinel')
  await writeFile(target, 'safe')
  await link(target, join(root, 'alias'))
  await assert.rejects(sandboxCommand({ ...policy, mode: 'full-access' }, `printf bad > ${quote(join(root, 'alias'))}`), /hardlinked_writable_file/)
  assert.equal(await readFile(target, 'utf8'), 'safe')
})
test('long session scratch paths support actual writes, reads and scratch-local TMPDIR', { timeout: 30000 }, async t => {
  const { dir, policy } = await fixture(t)
  const scratch = join(dir, 'data-directory-with-a-long-but-valid-name', 'scratch', '11111111-1111-4111-8111-111111111111')
  await mkdir(scratch, { recursive: true })
  assert.ok(Buffer.byteLength(scratch) > 104)
  const result = await sandboxCommand({ ...policy, scratch }, 'printf worked > "$TMPDIR/value"; /bin/cat "$TMPDIR/value"')
  assert.equal(result.code, 0); assert.equal(result.stdout, 'worked')
  assert.equal(await readFile(join(scratch, 'value'), 'utf8'), 'worked')
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function started(path: string) {
  const until = Date.now() + 15_000
  while (true) {
    try { if ((await readFile(path, 'utf8')).trim() === 'ready') return } catch { /* not started */ }
    assert.ok(Date.now() < until, 'sandbox workload must actually start')
    await pause(10)
  }
}
function descendants(scratch: string, wait: boolean) {
  const launch = ['setsid', 'nohup', 'double'].map(kind => {
    const body = `printf ready > ${quote(join(scratch, kind + '-ready'))}; sleep 1; printf LEAK > ${quote(join(scratch, kind + '-late'))}`
    const child = `sh -c ${quote(body)} >/dev/null 2>&1`
    return kind === 'double' ? `((${child} &) >/dev/null 2>&1 &)\n` : `${kind} ${child} &\n`
  }).join('')
  return launch + ['setsid', 'nohup', 'double'].map(kind => `while [ ! -f ${quote(join(scratch, kind + '-ready'))} ]; do sleep 0.01; done;`).join('\n') +
    `printf ready > ${quote(join(scratch, 'ready'))}; ${wait ? 'sleep 30' : 'printf returned'}`
}
async function noLateWrites(scratch: string) {
  await pause(1200)
  for (const kind of ['setsid', 'nohup', 'double']) {
    assert.equal(await readFile(join(scratch, kind + '-ready'), 'utf8'), 'ready', `${kind} must have started`)
    await assert.rejects(readFile(join(scratch, kind + '-late')), { code: 'ENOENT' }, `${kind} survived namespace teardown`)
  }
}
test('completion kills setsid, nohup and double-forked descendants before a second writer is admitted', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const result = await sandboxCommand(policy, descendants(policy.scratch, false))
  assert.equal(result.code, 0); assert.equal(result.stdout, 'returned')
  const second = await sandboxCommand(policy, `printf second > ${quote(join(policy.scratch, 'second'))}`)
  assert.equal(second.code, 0); assert.equal(await readFile(join(policy.scratch, 'second'), 'utf8'), 'second')
  await noLateWrites(policy.scratch)
})
test('cancellation kills every detached descendant before settlement', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const abort = new AbortController()
  const running = sandboxCommand(policy, descendants(policy.scratch, true), abort.signal)
  const rejected = assert.rejects(running, /sandbox_failed/)
  await started(join(policy.scratch, 'ready')); abort.abort()
  await rejected
  await noLateWrites(policy.scratch)
})
test('timeout kills every detached descendant before settlement', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  // The timeout must occur after the children start, before their attempted write.
  const command = descendants(policy.scratch, true).replaceAll('sleep 1;', 'sleep 4;')
  const rejected = assert.rejects(sandboxCommand(policy, command, undefined, 2500), /sandbox_failed/)
  await started(join(policy.scratch, 'ready')); await rejected
  await pause(4200)
  await noLateWrites(policy.scratch)
})
test('Unix sockets and local binding are denied inside arbitrary execution', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const script = `const net=require('node:net'); for(const address of [${JSON.stringify(join(policy.scratch, 'socket'))}, {host:'127.0.0.1',port:0}]) { const s=net.createServer(); s.on('error',()=>console.log('blocked')); s.listen(address,()=>{console.log('ESCAPED');s.close()}) }`
  const result = await sandboxCommand(policy, `node -e ${quote(script)}`)
  assert.equal(result.code, 0); assert.equal(result.stdout, 'blocked\nblocked\n')
})

test('Full access cannot overwrite a dependency tree but can write an unprotected sibling', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  await writeFile(join(root, 'protected'), 'original')
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'sentinel'), 'dependency')
  const result = await sandboxCommand({ ...policy, mode: 'full-access' }, `printf safe > ${quote(join(root, 'control'))}; printf bad > ${quote(join(root, 'node_modules', 'sentinel'))}`)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(join(root, 'control'), 'utf8'), 'safe')
  assert.equal(await readFile(join(root, 'node_modules', 'sentinel'), 'utf8'), 'dependency')
})
test('macOS without a reachable runtime refuses arbitrary shell and retains fixed commands', { skip: process.platform !== 'darwin' }, async t => {
  const { policy } = await fixture(t)
  const host = process.env.DOCKER_HOST, context = process.env.DOCKER_CONTEXT
  try {
    delete process.env.DOCKER_CONTEXT
    process.env.DOCKER_HOST = 'unix:///nonexistent-guanxi-fixture.sock'
    await assert.rejects(sandboxCommand(policy, 'printf MUST_NOT_RUN'), /container_runtime_unavailable/)
    const fixed = await sandboxCommand(policy, '/bin/pwd', undefined, 5000, true)
    assert.equal(fixed.code, 0); assert.equal(fixed.stdout.trim(), policy.scratch)
  } finally {
    if (host === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = host
    if (context === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = context
  }
})
test('protected nested paths cannot be replaced by renaming their writable ancestors', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  const parent = join(root, 'parent'); await mkdir(parent)
  await writeFile(join(parent, 'protected'), 'original')
  const full = { ...policy, mode: 'full-access' as const, protectedPaths: [join(parent, 'protected')] }
  const attempt = await sandboxCommand(full, `mv ${quote(parent)} ${quote(join(root, 'moved'))} && mkdir ${quote(parent)} && printf bad > ${quote(join(parent, 'protected'))}`)
  assert.notEqual(attempt.code, 0)
  assert.equal(await readFile(join(parent, 'protected'), 'utf8'), 'original')
  await assert.rejects(readFile(join(root, 'moved', 'protected')), { code: 'ENOENT' })
  assert.equal((await sandboxCommand(full, `printf safe > ${quote(join(parent, 'sibling'))}`)).code, 0)
  assert.equal(await readFile(join(parent, 'sibling'), 'utf8'), 'safe')
})
test('macOS workload cannot access the trusted runner descriptors or memory and output is capped', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const script = `const fs=require('node:fs'); const pid=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).find(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[1]==='/run/owner.cjs'}catch{return false}});if(!pid)throw Error('runner missing');for(const file of ['fd/1','mem']){try{fs.openSync('/proc/'+pid+'/'+file,'w');console.log('ESCAPED')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;console.log('blocked')}}`
  const denied = await sandboxCommand(policy, `node -e ${quote(script)}`)
  assert.equal(denied.code, 0); assert.equal(denied.stdout, 'blocked\nblocked\n')
  const large = await sandboxCommand(policy, `node -e ${quote(`process.stdout.write('a'.repeat(100000))`)}`)
  assert.equal(large.code, 0); assert.equal(large.truncated, true)
  assert.equal(Buffer.byteLength(large.stdout) + Buffer.byteLength(large.stderr), 65536)
})
test('nested roots and ancestor pins never reopen a read-only protected directory', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  const parent = join(root, 'parent'), nested = join(parent, 'nested')
  await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'sentinel'), 'original')
  const full = { ...policy, mode: 'full-access' as const, roots: [root, nested], protectedPaths: [parent, join(nested, 'sentinel')] }
  const denied = await sandboxCommand(full, `printf good > ${quote(join(root, 'control'))}; printf bad > ${quote(join(nested, 'sentinel'))}; printf bad > ${quote(join(nested, 'new'))}`)
  assert.notEqual(denied.code, 0)
  assert.equal(await readFile(join(root, 'control'), 'utf8'), 'good')
  assert.equal(await readFile(join(nested, 'sentinel'), 'utf8'), 'original')
  await assert.rejects(readFile(join(nested, 'new')), { code: 'ENOENT' })
})
test('command output preserves split UTF-8 and bounds decoded invalid bytes', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const unicode = await sandboxCommand(policy, `node -e ${quote(`const b=Buffer.from('界'.repeat(30000)); for(let i=0;i<b.length;i+=4096)process.stdout.write(b.subarray(i,i+4096))`)}`)
  assert.equal(unicode.code, 0); assert.equal(unicode.truncated, true)
  assert.ok(Buffer.byteLength(unicode.stdout) <= 65536)
  assert.equal(unicode.stdout.includes('\ufffd'), false)
  assert.equal(unicode.stdout, '界'.repeat(Math.floor(65536 / 3)))
  const invalid = await sandboxCommand(policy, `node -e ${quote(`process.stdout.write(Buffer.alloc(50000,255))`)}`)
  assert.equal(invalid.code, 0); assert.equal(invalid.truncated, true)
  assert.ok(Buffer.byteLength(invalid.stdout) + Buffer.byteLength(invalid.stderr) <= 65536)
})
