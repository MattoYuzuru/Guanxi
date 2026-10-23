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
async function setup(t: { after(fn: () => unknown): void }, extra: { pageBytes?: number; real?: boolean; scrubber?: typeof scrubber } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-file-read-')), root = join(dir, 'root'), scratch = join(dir, 'scratch')
  await mkdir(root); await mkdir(scratch)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tools = nativeTools({ policy: { mode: 'read-only', roots: [root], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: dir }, log: {} as never, handle: { sessionId: 'paging' } as never,
    scrubber: (extra.scrubber ?? scrubber) as never, queue() {}, ...(extra.real ? {} : { executeCommand: shell }), ...(extra.pageBytes === undefined ? {} : { pageBytes: extra.pageBytes }) })
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

test('a cursor is issued only when the text is the file\'s own bytes: redaction or an invalid byte refuses paging, and the whole remainder is always returned', async t => {
  const redacting = { scrub: <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('TOPSECRETVALUE', '[REDACTED]')) as T, isReady: () => true }
  const secret = `${'a'.repeat(300)}TOPSECRETVALUE${'b'.repeat(300)}`
  const whole = await setup(t, { scrubber: redacting }), paged = await setup(t, { scrubber: redacting, pageBytes: 400 })
  await writeFile(join(whole.root, 's.txt'), secret); await writeFile(join(paged.root, 's.txt'), secret)
  // Redaction changes a length, so a position in the redacted text is not a position in the file.
  assert.equal((await whole.read({ path: join(whole.root, 's.txt') })).stdout, secret.replace('TOPSECRETVALUE', '[REDACTED]'))
  assert.equal((await whole.read({ path: join(whole.root, 's.txt') })).more, false)
  // Only the page that reaches the redaction is affected: the page before it is exact, the page that would start in it has no honest cursor.
  const before = await paged.read({ path: join(paged.root, 's.txt') })
  assert.equal(before.more, true); assert.equal(before.nextOffset, Buffer.byteLength(before.stdout!)); assert.ok(secret.startsWith(before.stdout!)); assert.ok(before.nextOffset! <= 300)
  assert.deepEqual(await paged.read({ path: join(paged.root, 's.txt'), offset: '300' }), { error: 'page_cursor_unavailable' })
  // The K4 session has no budget: a big file with a secret in it is what it always was (an artifact reference), not an error.
  const k4 = await setup(t, { scrubber: redacting })
  await writeFile(join(k4.root, 'big.txt'), `${'a'.repeat(100)}TOPSECRETVALUE${'b\n'.repeat(60_000)}`)
  const reference = JSON.parse((await k4.call('file_read', { path: join(k4.root, 'big.txt') })).text) as { truncated: boolean; artifact?: string }
  assert.equal(reference.truncated, true); assert.match(reference.artifact ?? '', /^[a-f0-9]{64}$/)
  // The artifact holds the whole result: its cursor is null because it cannot be trusted past the redaction.
  let artifactText = ''
  for (let from = 0; ;) {
    const page = JSON.parse((await k4.call('tool_output_read', { artifact: reference.artifact, offset: String(from) })).text) as { text: string; nextOffset: number; truncated: boolean }
    artifactText += page.text; from = page.nextOffset
    if (!page.truncated) break
  }
  assert.equal((JSON.parse(artifactText) as { nextOffset: unknown; more: boolean }).nextOffset, null); assert.equal((JSON.parse(artifactText) as { more: boolean }).more, true)
  // Small budget: every page before the redaction is exact and ends in front of it.
  const slim = await setup(t, { scrubber: redacting, pageBytes: 200 })
  await writeFile(join(slim.root, 's.txt'), secret)
  let walkedText = '', cursor = 0
  for (;;) {
    const page = await slim.read({ path: join(slim.root, 's.txt'), offset: String(cursor) })
    if (page.error) { assert.equal(page.error, 'page_cursor_unavailable'); break }
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 200); walkedText += page.stdout; cursor = page.nextOffset!
  }
  assert.equal(walkedText, 'a'.repeat(300), 'the pages end exactly in front of the redacted region')
  // An invalid byte decodes to three bytes of text: pages before it are exact, the page that holds it has no honest cursor.
  const bytes = Buffer.concat([Buffer.from('a'.repeat(300)), Buffer.from([0xff]), Buffer.from('b'.repeat(300))])
  const bad = await setup(t, { pageBytes: 400 }), plain = await setup(t)
  await writeFile(join(bad.root, 'b.bin'), bytes); await writeFile(join(plain.root, 'b.bin'), bytes)
  const first = await bad.read({ path: join(bad.root, 'b.bin') })
  assert.equal(first.more, true); assert.ok(!first.stdout!.includes('\uFFFD')); assert.equal(first.nextOffset, Buffer.byteLength(first.stdout!))
  assert.equal(first.nextOffset, 300, 'the page ends in front of the invalid byte')
  assert.deepEqual(await bad.read({ path: join(bad.root, 'b.bin'), offset: String(first.nextOffset) }), { error: 'invalid_offset' }, 'the bytes there are not a character, so file_read cannot continue across them')
  assert.equal((await plain.read({ path: join(plain.root, 'b.bin') })).more, false)
  // A file that really holds U+FFFD is readable from a cursor that points at it, and an offset inside a character is still refused.
  const real = await setup(t)
  await writeFile(join(real.root, 'r.txt'), `${'x'.repeat(60)}\uFFFDyyyyy`)
  assert.deepEqual((await real.read({ path: join(real.root, 'r.txt'), offset: '60' })).stdout, '\uFFFDyyyyy')
  assert.deepEqual(await real.read({ path: join(real.root, 'r.txt'), offset: '61' }), { error: 'invalid_offset' })
  // With a budget, a file that really holds U+FFFD is paged across it (its bytes are compared with the file's), and a file with an invalid
  // byte is paged up to it.
  const across = await setup(t, { pageBytes: 300 }), fffd = `${'x'.repeat(50)}\uFFFD${'y'.repeat(600)}\uFFFDz`
  await writeFile(join(across.root, 'f.txt'), fffd)
  const walked = await readAll(across.read, join(across.root, 'f.txt'))
  assert.equal(walked.map(p => p.stdout).join(''), fffd); assert.ok(walked.length >= 3)
  // A budget that cannot hold one character is an error, not an empty page that never advances.
  const tiny = await setup(t, { pageBytes: 90 })
  await writeFile(join(tiny.root, 'k.txt'), '界'.repeat(50))
  assert.deepEqual(await tiny.read({ path: join(tiny.root, 'k.txt') }), { error: 'page_too_small' })
  // A budget that leaves room for the envelope but not for one character must not return an empty page that never advances.
  const kanji = new NativeOutputs(tiny.dir, 'kanji', scrubber as never), stored = JSON.parse(await kanji.bound('界'.repeat(30_000))) as { artifact: string; bytes: number }
  const envelope = Buffer.byteLength(JSON.stringify({ artifact: stored.artifact, offset: 0, nextOffset: 0, bytes: stored.bytes, truncated: true, text: '' }))
  await assert.rejects(kanji.read(stored.artifact, 0, envelope + 1), /page_too_small/)
  assert.equal((JSON.parse(await kanji.read(stored.artifact, 0, envelope + 3)) as { nextOffset: number }).nextOffset, 3, 'one character is the smallest page')
})

test('the real sandbox serves the same pages: offset 0 reads the file, a later offset starts there', async t => {
  const f = await setup(t, { real: true, pageBytes: 4096 })
  const text = Array.from({ length: 600 }, (_, i) => `sandbox row ${i} 界\n`).join('')
  await writeFile(join(f.root, 'real.txt'), text)
  const pages = await readAll(f.read, join(f.root, 'real.txt'), 200)
  assert.ok(pages.length >= 2); assert.equal(pages.map(p => p.stdout).join(''), text)
  assert.ok(pages.every(p => Buffer.byteLength(JSON.stringify(p)) <= 4096))
  // The byte check that tells a real U+FFFD from a mid-character offset runs in the sandbox too.
  await writeFile(join(f.root, 'fffd.txt'), `${'x'.repeat(10)}\uFFFDyy`)
  assert.equal((await f.read({ path: join(f.root, 'fffd.txt'), offset: '10' })).stdout, '\uFFFDyy')
  assert.deepEqual(await f.read({ path: join(f.root, 'fffd.txt'), offset: '11' }), { error: 'invalid_offset' })
})
