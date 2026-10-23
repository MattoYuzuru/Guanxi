import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, link } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { networkInterfaces } from 'node:os'
import { nativeAgentInputSchema } from '@guanxi/contract'
import { sandboxCommand as rawSandboxCommand, quote, type SandboxPolicy } from '../../src/native-agent/sandbox.ts'
import { orientation } from '../../src/native-agent/orientation.ts'
import { CONTAINER_IMAGE } from '../../src/native-agent/execution-owner.ts'

import { SecretScrubber } from '../../src/egress/scrubber.ts'
const fixtureScrubber = new SecretScrubber()
const sandboxCommand: typeof rawSandboxCommand = (policy, command, signal, timeout, fixed, scrubber = fixtureScrubber) => rawSandboxCommand(policy, command, signal, timeout, fixed, scrubber)

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
test('IP service probes refuse port-less unspecified/LAN policies and reach only the named port', { timeout: 60000 }, async t => {
  const { policy } = await fixture(t)
  const reached: string[] = [], denied: string[] = []
  const allowed = createServer((req, res) => { reached.push(req.url!); res.end('fixture') })
  const other = createServer((req, res) => { denied.push(req.url!); res.end('ESCAPED') })
  for (const server of [allowed, other]) {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve) })
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  }
  const port = (allowed.address() as { port: number }).port, otherPort = (other.address() as { port: number }).port
  const lan = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
  assert.ok(lan, 'the LAN-IP probe needs a non-loopback IPv4 interface')
  for (const mode of ['read-only', 'full-access'] as const) for (const host of ['0.0.0.0', lan]) {
    const input = { projectId: 'p', connectionId: 'c', model: 'm', prompt: 'p', mode }
    assert.throws(() => nativeAgentInputSchema.parse({ ...input, domains: [host] }), /explicit TCP port/, `${mode}: port-less ${host} refused before dispatch`)
    const { domains } = nativeAgentInputSchema.parse({ ...input, domains: [`${host}:${port}`] })
    const path = `/${mode}/${host}`
    const curl = "curl --noproxy '' -s --max-time 3 -o /dev/null -w '%{http_code} '"
    const result = await sandboxCommand({ ...policy, mode, domains }, `${curl} http://${host}:${port}${path}; ${curl} http://${host}:${otherPort}${path}`)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, '200 403 ', `${mode}: ${host} must reach only its named port`)
    assert.equal(reached.filter(value => value === path).length, 1, 'exactly one request reaches the granted service')
    assert.deepEqual(denied, [], 'zero requests reach the unnamed service')
  }
  assert.equal(reached.length, 4)
})
test('editing a writable checkout cannot replace the next trusted sandbox launcher', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  await writeFile(join(root, 'protected'), 'original')
  const { copyFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  for (const file of ['sandbox.ts', 'sandbox-worker.ts', 'sandbox-protocol.ts', 'execution-owner.ts', 'container-runner.ts', 'request-policy.ts', 'egress-ipc.ts', 'cleanup.ts']) await copyFile(new URL(`../../src/native-agent/${file}`, import.meta.url), join(root, file))
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

test('arbitrary execution can spawn children with piped stdio, including node --test per-file subprocesses', { timeout: 60000 }, async t => {
  const { policy } = await fixture(t)
  // libuv builds child stdio pipes from an anonymous AF_UNIX stream socketpair.
  const spawnProbe = `const cp=require('node:child_process');const sync=cp.spawnSync('echo',['piped'],{stdio:'pipe'});if(sync.error)throw sync.error;const both=cp.execFileSync('cat',{input:'both-ways'}).toString();console.log(String(sync.stdout).trim()+' '+both)`
  const suite = (name: string) => `import test from 'node:test'
import { appendFileSync } from 'node:fs'
test('${name}', () => appendFileSync('pids', [process.pid, process.ppid].join(' ') + String.fromCharCode(10)))
`
  const directory = join(policy.scratch, 'fixture'), report = join(policy.scratch, 'tap.txt')
  const command = `node -e ${quote(spawnProbe)} && mkdir ${quote(directory)} && cd ${quote(directory)} && printf %s ${quote(suite('first'))} > first.test.mjs && printf %s ${quote(suite('second'))} > second.test.mjs && node --test --test-reporter=tap > ${quote(report)}; echo "node-test-exit=$?"; cat ${quote(report)}; cat pids`
  const result = await sandboxCommand(policy, command)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /^piped both-ways$/m)
  assert.match(result.stdout, /node-test-exit=0/)
  assert.match(result.stdout, /^# pass 2$/m); assert.match(result.stdout, /^# fail 0$/m)
  assert.doesNotMatch(result.stdout + result.stderr, /EPERM/)
  const files = result.stdout.split('\n').filter(line => /^\d+ \d+$/.test(line)).map(line => line.split(' ').map(Number))
  assert.equal(files.length, 2, 'both files ran'); assert.notEqual(files[0]![0], files[1]![0], 'each file in its own process')
  assert.equal(files[0]![1], files[1]![1], 'one runner parent'); assert.ok(files.every(([pid, parent]) => pid !== parent))
})
test('a workload that spawns piped children still cannot listen, bind or connect to a Unix socket', { timeout: 60000 }, async t => {
  const { policy, root } = await fixture(t)
  const { createServer: createUnixServer } = await import('node:net')
  let connections = 0
  const server = createUnixServer(socket => { connections++; socket.end() })
  const socketPath = join(root, 'pipes.sock')
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const script = `const cp=require('node:child_process'),net=require('node:net');
if(cp.spawnSync('true',{stdio:'pipe'}).error)throw new Error('children unavailable');
const log=(...a)=>console.log(a.join(' '));
const listen=net.createServer();listen.on('error',e=>log('listen',e.code));listen.listen({host:'127.0.0.1',port:0},()=>{log('listen ESCAPED');listen.close()});
const unix=net.connect(${JSON.stringify(socketPath)});unix.on('connect',()=>{log('connect ESCAPED');unix.end()});unix.on('error',e=>log('connect',e.code))`
  const result = await sandboxCommand(policy, `node -e ${quote(script)}`)
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n').sort(), ['connect EPERM', 'listen EPERM'])
  assert.equal(connections, 0, 'the host listener saw no connection')
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
test('worker crash tears down every descendant before the next command settles', { timeout: 30000 }, async t => {
  const { dir, policy } = await fixture(t)
  const { copyFile } = await import('node:fs/promises'), { pathToFileURL } = await import('node:url')
  const launcher = join(dir, 'launcher'); await mkdir(launcher)
  for (const file of ['sandbox-worker.ts', 'sandbox-protocol.ts', 'execution-owner.ts', 'container-runner.ts', 'request-policy.ts', 'egress-ipc.ts', 'cleanup.ts']) await copyFile(new URL(`../../src/native-agent/${file}`, import.meta.url), join(launcher, file))
  await symlink(new URL('../../../../node_modules', import.meta.url).pathname, join(launcher, 'node_modules'))
  const source = await readFile(new URL('../../src/native-agent/sandbox.ts', import.meta.url), 'utf8')
  const hook = `if (signal?.aborted) abort(); const crashTimer = setInterval(() => { if (existsSync(${JSON.stringify(join(policy.scratch, 'ready'))})) { clearInterval(crashTimer); child.kill('SIGKILL') } }, 10); child.once('exit', () => clearInterval(crashTimer))`
  assert.ok(source.includes('if (signal?.aborted) abort()'))
  await writeFile(join(launcher, 'sandbox.ts'), source.replace('if (signal?.aborted) abort()', hook))
  const { sandboxCommand: crashing } = await import(pathToFileURL(join(launcher, 'sandbox.ts')).href)
  await assert.rejects(crashing(policy, descendants(policy.scratch, true)), /sandbox_failed/)
  assert.equal((await sandboxCommand(policy, 'printf next')).stdout, 'next')
  await noLateWrites(policy.scratch)
})
test('arbitrary execution cannot connect to a Unix socket exposed inside a selected root', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  const { createServer } = await import('node:net')
  let connections = 0
  const server = createServer(socket => { connections++; socket.end() })
  const socketPath = join(root, 's.sock')
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const command = `const s=require('node:net').connect(${JSON.stringify(socketPath)});s.on('connect',()=>{console.log('ESCAPED');s.end()});s.on('error',()=>console.log('blocked'))`
  const denied = await sandboxCommand(policy, `node -e ${quote(command)}`)
  assert.equal(denied.code, 0); assert.equal(denied.stdout, 'blocked\n'); assert.equal(connections, 0)
})

async function fixtureLauncher(dir: string, transformWorker: (source: string) => string, transformSandbox: (source: string) => string = source => source) {
  const { copyFile } = await import('node:fs/promises'), { pathToFileURL } = await import('node:url')
  const launcher = join(dir, 'fixture-launcher'); await mkdir(launcher)
  for (const file of ['sandbox.ts', 'sandbox-protocol.ts', 'execution-owner.ts', 'container-runner.ts', 'request-policy.ts', 'egress-ipc.ts', 'cleanup.ts']) await copyFile(new URL(`../../src/native-agent/${file}`, import.meta.url), join(launcher, file))
  await writeFile(join(launcher, 'sandbox.ts'), transformSandbox(await readFile(join(launcher, 'sandbox.ts'), 'utf8')))
  await symlink(new URL('../../../../node_modules', import.meta.url).pathname, join(launcher, 'node_modules'))
  const source = await readFile(new URL('../../src/native-agent/sandbox-worker.ts', import.meta.url), 'utf8')
  await writeFile(join(launcher, 'sandbox-worker.ts'), transformWorker(source))
  return (await import(pathToFileURL(join(launcher, 'sandbox.ts')).href)).sandboxCommand as typeof sandboxCommand
}
test('HTTPS verifies both certificate legs and applies the read-only method policy before forwarding', { timeout: 90000 }, async t => {
  const { dir, policy } = await fixture(t)
  const certificatePath = join(dir, 'fixture-server-ca.pem'), keyPath = join(dir, 'fixture-server-key.pem')
  // A temporary local issuer avoids public network access and any change to the host trust store.
  // The key stays outside every granted root and is never returned by the command under test.
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', keyPath, '-out', certificatePath])
  const methods: string[] = []
  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (req, res) => {
    methods.push(req.method!); res.end('https fixture')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  policy.domains = [`localhost:${port}`, `127.0.0.1:${port}`]
  const curl = "curl --noproxy '' -sS --max-time 5 -o /dev/null -w '%{http_code}'"
  // The ordinary worker does not trust this issuer. A TLS failure must forward no HTTP request.
  const untrusted = await sandboxCommand(policy, `${curl} https://localhost:${port}/`)
  assert.equal(untrusted.stdout, '502', untrusted.stderr)
  assert.deepEqual(methods, [])
  const launch = await fixtureLauncher(dir, source => source, source => {
    const expected = "HOME: networkDirectory, TMPDIR: networkDirectory, LANG: 'en_US.UTF-8'"
    assert.equal(source.split(expected).length, 2, 'fixture changes only the worker trust input')
    // Node reads this public CA at worker startup. Production TLS verification and all proxy
    // policy code stay intact; the sandboxed client trusts only the runtime's normal MITM bundle.
    return source.replace(expected, `${expected}, NODE_EXTRA_CA_CERTS: ${JSON.stringify(certificatePath)}`)
  })
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']) {
    const result = await launch(policy, `${curl} -X ${method} ${method === 'HEAD' ? '--head' : ''} https://localhost:${port}/`, undefined, undefined, undefined, fixtureScrubber)
    assert.equal(result.code, 0, `${method}: ${result.stderr}`)
    assert.equal(result.stdout, ['GET', 'HEAD', 'OPTIONS'].includes(method) ? '200' : '403', `${method}: ${result.stderr}`)
  }
  assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS'], 'blocked HTTPS methods reach upstream zero times')
  const full = await launch({ ...policy, mode: 'full-access' }, `${curl} -X POST https://localhost:${port}/`, undefined, undefined, undefined, fixtureScrubber)
  assert.equal(full.code, 0, full.stderr); assert.equal(full.stdout, '200')
  assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS', 'POST'])
  const wrongName = await launch(policy, `${curl} https://127.0.0.1:${port}/`, undefined, undefined, undefined, fixtureScrubber)
  assert.equal(wrongName.stdout, '502', wrongName.stderr)
  assert.deepEqual(methods, ['GET', 'HEAD', 'OPTIONS', 'POST'], 'a trusted issuer does not bypass upstream hostname checks')
})
test('trusted executable/dependency deny-write grants reach both execution backends', { timeout: 30000 }, async t => {
  const { dir, root, policy } = await fixture(t)
  const install = join(root, 'fixture-node-install'); await mkdir(install)
  await writeFile(join(install, 'node'), 'fixture executable')
  await writeFile(join(root, 'protected'), 'original')
  const launch = await fixtureLauncher(dir, source => {
    const expected = 'const trustedDeny = [modules, dirname(realpathSync(process.execPath))]'
    assert.ok(source.includes(expected))
    return source.replace(expected, `const trustedDeny = [${JSON.stringify(install)}]`)
  })
  const result = await launch({ ...policy, mode: 'full-access' }, `printf control > ${quote(join(root, 'control'))}; printf bad > ${quote(join(install, 'node'))}`)
  assert.notEqual(result.code, 0)
  assert.equal(await readFile(join(root, 'control'), 'utf8'), 'control')
  assert.equal(await readFile(join(install, 'node'), 'utf8'), 'fixture executable')
  const nested = join(install, 'nested'); await mkdir(nested)
  await writeFile(join(nested, 'library'), 'fixture library')
  const control = join(dir, 'control-root'); await mkdir(control)
  const nestedResult = await launch({ ...policy, mode: 'full-access', roots: [nested, control], protectedPaths: [] }, `printf control > ${quote(join(control, 'control'))}; printf bad > ${quote(join(nested, 'library'))}`)
  assert.notEqual(nestedResult.code, 0)
  assert.equal(await readFile(join(control, 'control'), 'utf8'), 'control')
  assert.equal(await readFile(join(nested, 'library'), 'utf8'), 'fixture library')
})
test('the actual ephemeral CA key is unreadable while its public trust bundle is readable', { timeout: 30000 }, async t => {
  const { dir, policy } = await fixture(t)
  const launch = await fixtureLauncher(dir, source => {
    const expected = "    owner = process.platform === 'linux'"
    assert.ok(source.includes(expected))
    // Test metadata/permissions only. Never open, print or log private key bytes.
    return source.replace(expected, `    command = 'test -r ' + quotePath(process.platform === 'linux' ? SandboxManager.getMitmCA()!.trustBundlePath : '/run/egress-ca.pem') + ' && test ! -r ' + quotePath(SandboxManager.getMitmCA()!.keyPath) + ' && printf isolated'\n${expected}`)
  })
  const result = await launch(policy, 'fixture substituted after proxy initialization')
  assert.equal(result.code, 0); assert.equal(result.stdout, 'isolated')
})
test('macOS refuses a writable root that could replace its pinned Docker CLI before cleanup', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { dir, root, other, policy } = await fixture(t)
  const { execFileSync } = await import('node:child_process')
  const realDocker = await realpath(execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim())
  const cli = join(root, 'docker'), marker = join(other, 'host-execution')
  const original = `#!/bin/sh\nexec ${quote(realDocker)} "$@"\n`
  await writeFile(cli, original, { mode: 0o700 })
  const launch = await fixtureLauncher(dir, source => source, source => {
    const expected = 'const dockerBinary = resolveDockerBinary()'
    assert.ok(source.includes(expected))
    return source.replace(expected, `const dockerBinary = ${JSON.stringify({ path: cli, protectedPaths: [cli] })}`)
  })
  // If the guard is removed, replacing this fixture CLI writes only a temporary marker,
  // then delegates real cleanup, so the regression cannot strand a container.
  const replacement = `#!/bin/sh\nprintf ESCAPED > ${quote(marker)}\nexec ${quote(realDocker)} "$@"\n`
  for (const fixed of [false, true]) await assert.rejects(launch({ ...policy, mode: 'full-access', protectedPaths: [] }, `printf %s ${quote(replacement)} > ${quote(cli)}`, undefined, 5000, fixed), /container_runtime_protected/)
  assert.equal(await readFile(cli, 'utf8'), original)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})


test('macOS workload has only lo and cannot reach a reachable non-loopback host fixture', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const { networkInterfaces } = await import('node:os')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
  assert.ok(host, 'a non-loopback host address is required for this isolation assertion')
  let connections = 0
  const server = (await import('node:net')).createServer(socket => { connections++; socket.end() })
  await new Promise<void>(resolve => server.listen(0, host, resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const probe = `const s=require('node:net').connect(${port},${JSON.stringify(host)});s.on('connect',()=>{console.log('connected');s.end()});s.on('error',()=>console.log('blocked'));s.setTimeout(1500,()=>{console.log('blocked');s.destroy()})`
  // Prove the host fixture is reachable from an ordinary Colima container first.
  const control = await promisify(execFile)('docker', ['run', '--rm', '--network', 'bridge', '--entrypoint', 'node', CONTAINER_IMAGE, '-e', probe], { timeout: 10000 })
  assert.equal(control.stdout, 'connected\n'); assert.equal(connections, 1)
  const isolated = await sandboxCommand(policy, `node -e ${quote(`console.log(require('node:fs').readdirSync('/sys/class/net').sort().join(','));${probe}`)}`)
  assert.equal(isolated.code, 0)
  assert.equal(isolated.stdout, 'lo\nblocked\n')
  assert.equal(connections, 1, 'the raw sandbox connection must never reach the fixture')
})

test('even allowlisted loopback cannot reach API or web control-plane ports in either mode', { timeout: 30000 }, async t => {
  const { policy } = await fixture(t)
  const seen: string[] = []
  const servers = [createServer((req, res) => { seen.push(req.method!); res.end('ESCAPED') }), createServer((req, res) => { seen.push(req.method!); res.end('ESCAPED') })]
  for (const server of servers) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  }
  const ports = servers.map(server => (server.address() as { port: number }).port)
  for (const mode of ['read-only', 'full-access'] as const) {
    const denied = await sandboxCommand({ ...policy, mode, nodePorts: ports, domains: ports.flatMap(port => [`localhost:${port}`, `127.0.0.1:${port}`]) },
      ports.flatMap(port => ['localhost', '127.0.0.1'].map(host => `curl --noproxy '' -s --max-time 3 -o /dev/null -w '%{http_code} ' http://${host}:${port}/api/agent`)).join('; '))
    assert.equal(denied.stdout, '403 403 403 403 ')
    assert.deepEqual(seen, [])
  }
})

test('daemon loss during cancellation settles with cleanup_unconfirmed and retains a root quarantine', { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
  const { dir, policy } = await fixture(t)
  const fake = join(dir, 'docker'), marker = join(dir, 'started')
  await writeFile(fake, `#!/bin/sh
if [ "$1" = context ]; then if [ "$2" = show ]; then printf fixture; else printf unix:///fixture; fi; exit 0; fi
case "$3" in
  context) printf 'unix:///fixture';;
  info) printf linux;;
  image) printf 'sha256:${'a'.repeat(64)}';;
  create) exit 0;;
  start) touch ${quote(marker)}; exec sleep 30;;
  *) exec sleep 30;;
esac
`, { mode: 0o700 })
  const launch = await fixtureLauncher(dir, s => s, s => s.replace('const dockerBinary = resolveDockerBinary()', `const dockerBinary = {path:${JSON.stringify(fake)},protectedPaths:[]}`))
  const abort = new AbortController()
  const running = launch({ ...policy, mode: 'full-access' }, 'sleep 30', abort.signal)
  const rejected = assert.rejects(running, /cleanup_unconfirmed/)
  while (true) { try { await readFile(marker); break } catch { await pause(10) } }
  const began = Date.now(); abort.abort(); await rejected
  assert.ok(Date.now() - began < 9000, 'stop must settle while the daemon stays unavailable')
  const entries = await (await import('node:fs/promises')).readdir(join(dir, 'native-cleanup'))
  assert.equal(entries.length, 1)
  const { assertRootsClean } = await import('../../src/native-agent/cleanup.ts')
  assert.throws(() => assertRootsClean(dir, policy.roots), /cleanup_unconfirmed/)
})

test('egress denies URLs and headers the live scrubber changes, including late registration and readiness loss', { timeout: 30000 }, async t => {
  const { policy, root } = await fixture(t)
  const scrubber = new SecretScrubber()
  // Synthetic fixture only: no real credential is read, stored or sent.
  const value = 'synthetic egress fixture'
  await writeFile(join(root, 'value'), value)
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(req.url!)
    if (req.url === '/register') scrubber.register('secret://fixture-egress', value)
    res.end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const curl = `curl --noproxy '' -s --max-time 3 -o /dev/null -w '%{http_code} '`
  const result = await rawSandboxCommand({ ...policy, domains: [`127.0.0.1:${port}`] },
    `value=$(cat ${quote(join(root, 'value'))}); ${curl} http://127.0.0.1:${port}/register; ${curl} 'http://127.0.0.1:${port}/?value=synthetic%20egress%20fixture'; ${curl} -H "X-Fixture: $value" http://127.0.0.1:${port}/header; ${curl} http://127.0.0.1:${port}/clean`,
    undefined, undefined, false, scrubber)
  assert.equal(result.stdout, '200 403 403 200 ')
  assert.deepEqual(seen, ['/register', '/clean'])
  scrubber.expect('pending-fixture')
  const denied = await rawSandboxCommand({ ...policy, domains: [`127.0.0.1:${port}`] }, `${curl} http://127.0.0.1:${port}/not-ready`, undefined, undefined, false, scrubber)
  assert.equal(denied.stdout, '403 ')
  const absent = await rawSandboxCommand({ ...policy, domains: [`127.0.0.1:${port}`] }, `${curl} http://127.0.0.1:${port}/no-scrubber`)
  assert.equal(absent.stdout, '403 ')
  assert.deepEqual(seen, ['/register', '/clean'])
})

test('fork error followed by close without exit settles and does not hold unload forever', { timeout: 3000 }, async t => {
  const { dir, policy } = await fixture(t)
  const launch = await fixtureLauncher(dir, s => s, source => `import {EventEmitter} from 'node:events'
function fixtureFork(..._args: unknown[]) {
  const child = Object.assign(new EventEmitter(), {connected:false,pid:undefined,send(){}})
  setImmediate(()=>{child.emit('error',new Error('fixture spawn failure'));child.emit('close',null)})
  return child
}
` + source.replace('const child = fork(worker,', 'const child = fixtureFork(worker,'))
  await assert.rejects(launch(policy, 'printf MUST_NOT_RUN', undefined, 50, true), /sandbox_failed/)
})

test('interrupted container create retains quarantine even if the daemon currently reports no container', { skip: process.platform !== 'darwin', timeout: 5000 }, async t => {
  const { dir, policy } = await fixture(t)
  const fake = join(dir, 'docker'), marker = join(dir, 'creating')
  await writeFile(fake, `#!/bin/sh
if [ "$1" = context ]; then if [ "$2" = show ]; then printf fixture; else printf unix:///fixture; fi; exit 0; fi
case "$3" in
  info) printf linux;;
  image) printf 'sha256:${'a'.repeat(64)}';;
  create) touch ${quote(marker)}; exec sleep 30;;
  rm|ps) exit 0;;
  *) exit 1;;
esac
`, { mode: 0o700 })
  const launch = await fixtureLauncher(dir, s => s, s => s.replace('const dockerBinary = resolveDockerBinary()', `const dockerBinary = {path:${JSON.stringify(fake)},protectedPaths:[]}`))
  const abort = new AbortController()
  const running = launch({ ...policy, mode: 'full-access' }, 'printf MUST_NOT_START', abort.signal)
  const rejected = assert.rejects(running, /cleanup_unconfirmed/)
  while (true) { try { await readFile(marker); break } catch { await pause(10) } }
  abort.abort(); await rejected
  assert.equal((await (await import('node:fs/promises')).readdir(join(dir, 'native-cleanup'))).length, 1)
})
