import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { sandboxCommand, quote, type SandboxPolicy } from '../../src/native-agent/sandbox.ts'
import { orientation } from '../../src/native-agent/orientation.ts'

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'k4-sandbox-')))
  const scratch = join(dir, 'scratch'), root = join(dir, 'root'), other = join(dir, 'outside')
  await Promise.all([scratch, root, other].map(p => mkdir(p)))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const policy: SandboxPolicy = { mode: 'read-only', scratch, roots: [root], attachments: [], protectedPaths: [join(root, 'protected')], domains: [] }
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
  const raw = await sandboxCommand(policy, `${quote(process.execPath)} -e ${quote(`const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('error',()=>{console.log('blocked')});s.on('connect',()=>{console.log('ESCAPED');s.end()});setTimeout(()=>s.destroy(),1000)`)} `)
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
  const { copyFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  for (const file of ['sandbox.ts', 'sandbox-worker.ts', 'sandbox-protocol.ts']) await copyFile(new URL(`../../src/native-agent/${file}`, import.meta.url), join(root, file))
  await symlink(new URL('../../../../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
  const { sandboxCommand: cloned } = await import(pathToFileURL(join(root, 'sandbox.ts')).href)
  const full = { ...policy, mode: 'full-access' as const, roots: [root] }
  const poison = "process.send({result:{code:0,stdout:'ESCAPED',stderr:'',truncated:false}},()=>process.exit(0))"
  const altered = await cloned(full, `printf %s ${quote(poison)} > ${quote(join(root, 'sandbox-worker.ts'))}`)
  assert.equal(altered.code, 0)
  assert.equal(await readFile(join(root, 'sandbox-worker.ts'), 'utf8'), poison)
  const next = await cloned(full, 'printf safe')
  assert.equal(next.stdout, 'safe')
})

test('Full access refuses pre-existing hardlinks that could mutate files outside roots', { timeout: 30000 }, async t => {
  const { policy, root, other } = await fixture(t)
  const target = join(other, 'sentinel')
  await writeFile(target, 'safe')
  await link(target, join(root, 'alias'))
  await assert.rejects(sandboxCommand({ ...policy, mode: 'full-access' }, `printf bad > ${quote(join(root, 'alias'))}`), /hardlinked_writable_file/)
  assert.equal(await readFile(target, 'utf8'), 'safe')
})
