import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeTools } from '../../src/native-agent/tools.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'
import { ProjectIndex } from '../../src/indexing/service.ts'
import { ResourceGovernor } from '../../src/runtime/resource-governor.ts'
import { directSymbols, installedServers } from '../../src/indexing/lsp.ts'
import type { NativeToolContext } from '../../src/native-agent/tools.ts'
import type { SandboxPolicy, sandboxCommand } from '../../src/native-agent/sandbox.ts'

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-x1-tools-')))
  const root = join(dir, 'root'), data = join(dir, 'data'), scratch = join(dir, 'scratch')
  await Promise.all([root, data, scratch].map(p => mkdir(p)))
  await writeFile(join(root, 'a.ts'), 'export function Orbit() {}')
  const scrubber = new SecretScrubber(), governor = new ResourceGovernor()
  const policy: SandboxPolicy = { mode: 'read-only', roots: [root], scratch, runtimeBase: data, attachments: [], protectedPaths: [], domains: [] }
  return { dir, root, data, scratch, scrubber, governor, policy, async close() { await governor.close(); await rm(dir, { recursive: true, force: true }) } }
}
test('native search and repo.map tools use immutable roots, provenance, exact counts and complete output budgets', async () => {
  const f = await fixture()
  const index = new ProjectIndex({ dataDir: f.data, scrubber: f.scrubber, governor: f.governor, settings: { ftsMinFiles: 1, pollMs: 60_000 }, headroom: async () => ({ allowed: false } as never) })
  try {
    const tools = nativeTools({ policy: f.policy, log: null, handle: { sessionId: 'fixture' }, scrubber: f.scrubber, index, queue() {} } as unknown as NativeToolContext)
    const call = async (name: string, args: Record<string, string>) => tools.find(t => t.name === name)!.execute('fixture', args)
    const search = await call('search', { path: '.', text: 'Orbit' })
    const value = JSON.parse((search.content[0] as { text: string }).text)
    assert.equal(search.isError, undefined)
    assert.equal(value.hits.length, 1); assert.equal(value.hits[0].path, 'a.ts')
    assert.equal(value.provenance.commit, null)
    assert.equal(value.provenance.indexAgeMs, null)
    assert.equal(value.provenance.coverage.eligible, 1)
    const map = await call('repo_map', { path: '.', budget: '800' })
    const text = (map.content[0] as { text: string }).text
    assert.ok(Buffer.byteLength(text) <= 800)
    assert.equal(JSON.parse(text).tokenBound, 800)
    const denied = await call('search', { path: f.data, text: 'Orbit' })
    assert.equal(denied.isError, true)
    assert.equal((denied.content[0] as { text: string }).text, 'path_denied')
    const tooSmall = await call('repo_map', { path: '.', budget: '10' })
    assert.equal(tooSmall.isError, true)
    assert.deepEqual(installedServers(''), {})
  } finally { await index.close(); await f.close() }
})

test('index failures surface their stable error code to the model', async () => {
  const f = await fixture()
  try {
    const index = {
      track: async () => {},
      search: async () => { throw new Error('index_sandbox_unavailable') },
      map: async () => { throw new Error('index_budget_too_small') },
      status: () => ({}),
    } as unknown as ProjectIndex
    const tools = nativeTools({ policy: f.policy, log: null, handle: { sessionId: 'fixture' }, scrubber: f.scrubber, index, queue() {} } as unknown as NativeToolContext)
    const map = await tools.find(t => t.name === 'repo_map')!.execute('fixture', { path: '.', budget: '10' })
    assert.equal(map.isError, true)
    assert.equal((map.content[0] as { text: string }).text, 'index_budget_too_small')
    assert.deepEqual(map.details, { code: 'index_budget_too_small' })
    const search = await tools.find(t => t.name === 'search')!.execute('fixture', { path: '.', text: 'Orbit' })
    assert.equal(search.isError, true)
    assert.equal((search.content[0] as { text: string }).text, 'index_sandbox_unavailable')
  } finally { await f.close() }
})

test('IX0 search remains available with the index plugin absent and without an OS grep binary', async () => {
  const f = await fixture()
  try {
    let commands = 0
    const tools = nativeTools({ policy: f.policy, log: null, handle: { sessionId: 'fixture' }, scrubber: f.scrubber, queue() {}, executeCommand: async () => { commands++; throw new Error('no executables') } } as unknown as NativeToolContext)
    const result = await tools.find(t => t.name === 'search')!.execute('fixture', { path: '.', text: 'Orbit' })
    assert.equal(result.isError, undefined)
    const value = JSON.parse((result.content[0] as { text: string }).text)
    assert.equal(value.hits.length, 1)
    assert.equal(value.engine, 'node-grep')
    assert.equal(value.provenance.coverage.indexed, 0)
    assert.equal(commands, 0)
  } finally { await f.close() }
})

test('direct LSP uses stdio initialization and nested document symbols under a read-only zero-egress execution policy', async () => {
  const f = await fixture()
  try {
    const server = join(f.dir, 'fixture-lsp.cjs')
    await writeFile(server, String.raw`
let buffer=Buffer.alloc(0), initialized=false, opened=false;
const send=m=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));process.stdout.write('Content-Length: '+b.length+'\r\n\r\n');process.stdout.write(b)};
process.stdin.on('data',d=>{buffer=Buffer.concat([buffer,d]);while(true){const h=buffer.indexOf('\r\n\r\n');if(h<0)return;const n=Number(/Content-Length: (\d+)/.exec(buffer.subarray(0,h).toString())[1]);if(buffer.length<h+4+n)return;const m=JSON.parse(buffer.subarray(h+4,h+4+n));buffer=buffer.subarray(h+4+n);
if(m.method==='initialize'){initialized=m.params.rootUri.startsWith('file:');send({id:m.id,result:{capabilities:{documentSymbolProvider:true}}})}
if(m.method==='textDocument/didOpen')opened=m.params.textDocument.text.includes('Orbit');
if(m.method==='textDocument/documentSymbol')send({id:m.id,result:[{name:initialized&&opened?'Orbit':'BROKEN',kind:12,range:{start:{line:0,character:0}},children:[{name:'child',kind:6,selectionRange:{start:{line:1,character:0}}}]}]});
}})
`)
    let calls = 0
    const execute: typeof sandboxCommand = async (policy, command, signal, timeout, fixed) => {
      calls++
      assert.equal(policy.mode, 'read-only'); assert.deepEqual(policy.domains, [])
      assert.equal(fixed, false); assert.equal(timeout, 10_000)
      // Only a newly created protocol fixture is executed here. Production uses
      // ExecutionOwner; this test makes no OS containment claim.
      const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', command.replace("'/usr/local/bin/node'", `'${process.execPath}'`)], { signal, timeout: 12_000 })
      return { code: 0, stdout, stderr, truncated: false }
    }
    const result = await directSymbols({ ...f.policy, mode: 'full-access', domains: ['example.invalid'] }, f.root, join(f.root, 'a.ts'), execute, f.scrubber, undefined, { typescript: [process.execPath, [server]] })
    assert.deepEqual(result, [{ name: 'Orbit', kind: 'lsp:12', line: 1 }, { name: 'child', kind: 'lsp:6', line: 2 }])
    assert.equal(calls, 1)
    const missing = await directSymbols(f.policy, f.root, join(f.root, 'a.ts'), execute, f.scrubber, undefined, {})
    assert.equal(missing, null); assert.equal(calls, 1)
    const invalid = await directSymbols(f.policy, f.root, join(f.root, 'a.ts'), async () => ({ code: 0, stdout: '[{"name":"x"}]', stderr: '', truncated: false }), f.scrubber, undefined, { typescript: ['/fixture', []] })
    assert.equal(invalid, null)
  } finally { await f.close() }
})

test('an individual read-only attachment remains searchable without admitting its siblings', async () => {
  const f = await fixture()
  try {
    const attachment = join(f.dir, 'one.attachment')
    await writeFile(attachment, 'attachedNeedle')
    await writeFile(join(f.dir, 'sibling.txt'), 'siblingNeedle')
    const tools = nativeTools({ policy: { ...f.policy, roots: [], attachments: [attachment] }, log: null, handle: { sessionId: 'fixture' }, scrubber: f.scrubber, queue() {} } as unknown as NativeToolContext)
    const result = await tools.find(t => t.name === 'search')!.execute('fixture', { path: attachment, text: 'Needle' })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text).hits.map((h: { text: string }) => h.text), ['attachedNeedle'])
    const denied = await tools.find(t => t.name === 'search')!.execute('fixture', { path: join(f.dir, 'sibling.txt'), text: 'Needle' })
    assert.equal(denied.isError, true)
  } finally { await f.close() }
})
