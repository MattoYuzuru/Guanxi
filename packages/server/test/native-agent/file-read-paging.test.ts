import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NativeOutputs } from '../../src/native-agent/outputs.ts'
import { commandOutput, TOOL_OUTPUT_BYTES } from '../../src/native-agent/sandbox-protocol.ts'
import type { sandboxCommand } from '../../src/native-agent/sandbox.ts'
import { nativeTools } from '../../src/native-agent/tools.ts'

const scrubber = { scrub: <T>(value: T): T => value, isReady: () => true }
/** Runs the very command string the tool built, in a shell, and reports it like the sandbox does (a 64 KiB cap per result). The real
 * sandbox is exercised separately below; this stand-in lets a test see exactly which command was issued. */
const shell: typeof sandboxCommand = (_policy, command) => new Promise(resolve => {
  execFile('/bin/sh', ['-c', command], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => resolve(commandOutput(error ? Number((error as { code?: unknown }).code ?? 1) : 0, [stdout], [stderr], false)))
})
type Page = Partial<{ more: boolean; nextOffset: number; offset: number; code: number; stderr: string; truncated: boolean; stdout: string }> & { error?: string }
async function setup(t: { after(fn: () => unknown): void }, extra: { pageBytes?: number; real?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-file-read-')), root = join(dir, 'root'), scratch = join(dir, 'scratch')
  await mkdir(root); await mkdir(scratch)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tools = nativeTools({ policy: { mode: 'read-only', roots: [root], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: dir }, log: {} as never, handle: { sessionId: 'paging' } as never,
    scrubber: scrubber as never, queue() {}, ...(extra.real ? {} : { executeCommand: shell }), ...(extra.pageBytes === undefined ? {} : { pageBytes: extra.pageBytes }) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.find(tool => tool.name === name)!.execute('call', args as never) as { content: Array<{ text: string }>; details: { code?: string } | null; isError?: boolean }
    return { text: result.content.map(c => c.text).join(''), error: result.isError ? result.details?.code : undefined }
  }
  const read = async (args: Record<string, unknown>): Promise<Page> => { const r = await call('file_read', args); return r.error ? { error: r.error } : JSON.parse(r.text) as Page }
  return { dir, root, call, read, tools }
}
/** Pages through a file with the cursor the tool returns and nothing else. */
async function readAll(read: (args: Record<string, unknown>) => Promise<any>, path: string, limit = 10_000) {
  const pages: any[] = []
  for (let offset = 0; pages.length < limit;) {
    const page = await read({ path, offset: String(offset) })
    assert.equal(page.error, undefined)
    pages.push(page)
    if (!page.more) return pages
    assert.ok(page.nextOffset > offset, 'a page always advances the cursor')
    offset = page.nextOffset
  }
  assert.fail('the cursor never reached the end')
}

test('file_read returns the whole of a small file with an explicit cursor, the old fields kept and the text last', async t => {
  const f = await setup(t), text = 'line one\nline two "quoted"\n'
  await writeFile(join(f.root, 'small.txt'), text)
  const page = await f.read({ path: join(f.root, 'small.txt') })
  assert.deepEqual(page, { more: false, nextOffset: Buffer.byteLength(text), offset: 0, code: 0, stderr: '', truncated: false, stdout: text })
  assert.deepEqual(Object.keys(page), ['more', 'nextOffset', 'offset', 'code', 'stderr', 'truncated', 'stdout'], 'a reader that cuts the tail keeps the cursor')
  assert.deepEqual(await f.read({ path: join(f.root, 'small.txt'), offset: '5' }), { more: false, nextOffset: Buffer.byteLength(text), offset: 5, code: 0, stderr: '', truncated: false, stdout: text.slice(5) })
  assert.equal((await f.read({ path: join(f.root, 'small.txt'), offset: 5 })).stdout, text.slice(5), 'a model that sends the offset as a number is understood')
  assert.deepEqual(await f.read({ path: join(f.root, 'small.txt'), offset: String(Buffer.byteLength(text)) }), { more: false, nextOffset: Buffer.byteLength(text), offset: Buffer.byteLength(text), code: 0, stderr: '', truncated: false, stdout: '' }, 'the end of the file is an empty last page')
})

test('with a page budget every page fits it, ends on a character boundary and the pages are exactly the file', async t => {
  const f = await setup(t, { pageBytes: 700 })
  const text = Array.from({ length: 400 }, (_, i) => `row ${i}: "quoted" \\ backslash 界✓😀 tab\there\n`).join('')
  await writeFile(join(f.root, 'big.txt'), text)
  const pages = await readAll(f.read, join(f.root, 'big.txt'))
  assert.ok(pages.length > 20)
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 700, `${Buffer.byteLength(JSON.stringify(page))} bytes`)
  assert.equal(pages.map(p => p.stdout).join(''), text)
  assert.equal(pages.at(-1).nextOffset, Buffer.byteLength(text)); assert.equal(pages.at(-1).more, false)
  assert.ok(pages.slice(0, -1).every(p => p.more === true))
  // The same budget through tool_output_read: an artifact is paged to the budget too.
  const outputs = new NativeOutputs(f.dir, 'artifact', scrubber as never), big = text.repeat(4), reference = JSON.parse(await outputs.bound(big)) as { artifact: string; truncated: boolean }
  assert.equal(reference.truncated, true)
  let offset = 0, assembled = ''
  for (let i = 0; i < 2000; i++) {
    const body = await outputs.read(reference.artifact, offset, 700), page = JSON.parse(body) as { nextOffset: number; truncated: boolean; text: string }
    assert.ok(Buffer.byteLength(body) <= 700); assembled += page.text; offset = page.nextOffset
    if (!page.truncated) break
  }
  assert.equal(assembled, big)
  await assert.rejects(outputs.read(reference.artifact, 0, 30), /page_too_small/)
})

test('a file larger than one sandbox result is read to its end by following nextOffset (the model never saw the end of a 1000-line SPEC.md)', async t => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${String(i).padStart(4, '0')} of the specification, 界\n`).join('')
  assert.ok(Buffer.byteLength(text) > 2 * TOOL_OUTPUT_BYTES)
  // Without a page budget the existing behaviour is unchanged: a result over the tool output limit becomes an artifact reference.
  const plain = await setup(t)
  await writeFile(join(plain.root, 'SPEC.md'), text)
  const reference = JSON.parse((await plain.call('file_read', { path: join(plain.root, 'SPEC.md') })).text) as { truncated: boolean; artifact?: string }
  assert.equal(reference.truncated, true); assert.match(reference.artifact ?? '', /^[a-f0-9]{64}$/)
  // With one (the relay passes the executor's per-turn bound) the cursor walks the whole file, past the 64 KiB the sandbox returns at once.
  const f = await setup(t, { pageBytes: 5000 })
  await writeFile(join(f.root, 'SPEC.md'), text)
  const pages = await readAll(f.read, join(f.root, 'SPEC.md'))
  assert.ok(pages.length > 25); assert.ok(pages.every(p => Buffer.byteLength(JSON.stringify(p)) <= 5000))
  assert.equal(pages.map(p => p.stdout).join(''), text); assert.equal(pages.at(-1).nextOffset, Buffer.byteLength(text))
  assert.ok(pages.slice(0, -1).every(p => p.more && p.truncated), 'every page but the last says there is more'); assert.equal(pages.at(-1).truncated, false)
  // A page read past the sandbox's first result starts exactly where the cursor says.
  const late = await f.read({ path: join(f.root, 'SPEC.md'), offset: String(3 * TOOL_OUTPUT_BYTES / 2) })
  assert.equal(late.stdout!.slice(0, 4), Buffer.from(text).subarray(3 * TOOL_OUTPUT_BYTES / 2, 3 * TOOL_OUTPUT_BYTES / 2 + 4).toString('utf8').slice(0, 4))
})

test('an offset that is not a byte position this tool returned is refused with a fixed code, and an offset at or past the end is an empty last page', async t => {
  const f = await setup(t)
  await writeFile(join(f.root, 'u.txt'), '界界界')   // three bytes per character
  for (const offset of ['abc', '-1', '1.5', '1e3', 'NaN', '0x10', ' 5', '5 ', '007x']) assert.deepEqual(await f.read({ path: join(f.root, 'u.txt'), offset }), { error: 'invalid_offset' }, offset)
  assert.deepEqual(await f.read({ path: join(f.root, 'u.txt'), offset: '1' }), { error: 'invalid_offset' }, 'inside a character')
  assert.equal((await f.read({ path: join(f.root, 'u.txt'), offset: '3' })).stdout, '界界')
  assert.deepEqual((await f.read({ path: join(f.root, 'u.txt'), offset: '99' })).stdout, '')
  assert.equal((await f.call('file_read', { path: join(f.root, 'missing.txt') })).error, 'tool_denied_or_failed')
  assert.equal((await f.call('file_read', { path: '/etc/hosts' })).error, 'path_denied', 'outside every allowed root')
  const tiny = await setup(t, { pageBytes: 20 })
  await writeFile(join(tiny.root, 'x.txt'), 'content')
  assert.deepEqual(await tiny.read({ path: join(tiny.root, 'x.txt') }), { error: 'page_too_small' })
})

test('the real sandbox serves the same pages: offset 0 reads the file, a later offset starts there', async t => {
  const f = await setup(t, { real: true, pageBytes: 4096 })
  const text = Array.from({ length: 600 }, (_, i) => `sandbox row ${i} 界\n`).join('')
  await writeFile(join(f.root, 'real.txt'), text)
  const pages = await readAll(f.read, join(f.root, 'real.txt'), 200)
  assert.ok(pages.length >= 2); assert.equal(pages.map(p => p.stdout).join(''), text)
  assert.ok(pages.every(p => Buffer.byteLength(JSON.stringify(p)) <= 4096))
})
