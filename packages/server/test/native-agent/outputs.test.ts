import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeOutputs } from '../../src/native-agent/outputs.ts'
import { TOOL_OUTPUT_BYTES } from '../../src/native-agent/sandbox-protocol.ts'
import { SecretScrubber } from '../../src/egress/scrubber.ts'

test('all-tool output policy stores scrubbed content by hash, bounds escaped output and pages only its own session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4-outputs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const scrubber = new SecretScrubber()
  const secret = 'fixture-output-secret'
  scrubber.register('secret://fixture/output', secret)
  const outputs = new NativeOutputs(dir, 'one', scrubber)
  assert.equal(await outputs.bound('small'), 'small')
  const original = secret + '\0界🙂'.repeat(20_000)
  const bounded = await outputs.bound(original)
  assert.ok(Buffer.byteLength(bounded) <= TOOL_OUTPUT_BYTES)
  const reference = JSON.parse(bounded)
  assert.equal(reference.truncated, true); assert.match(reference.artifact, /^[a-f0-9]{64}$/)
  assert.equal(bounded.includes(secret), false)
  const sessions = await readdir(join(dir, 'native-output'))
  const stored = await readFile(join(dir, 'native-output', sessions[0]!, reference.artifact), 'utf8')
  assert.equal(stored.includes(secret), false); assert.equal(stored, scrubber.scrub(original))
  assert.equal((await readdir(join(dir, 'native-output', sessions[0]!))).length, 1)
  assert.equal((JSON.parse(await outputs.bound(original))).artifact, reference.artifact)
  const pages: string[] = []
  let offset = 0
  while (true) {
    const text = await outputs.read(reference.artifact, offset)
    assert.ok(Buffer.byteLength(text) <= TOOL_OUTPUT_BYTES)
    const page = JSON.parse(text)
    pages.push(page.text); assert.ok(page.nextOffset > offset); offset = page.nextOffset
    if (!page.truncated) break
  }
  assert.equal(pages.join(''), stored)
  await assert.rejects(new NativeOutputs(dir, 'two', scrubber).read(reference.artifact, 0), { code: 'ENOENT' })
  await assert.rejects(outputs.read('../escape', 0), /path_denied/)
  const late = 'late-fixture-value'
  const lateReference = JSON.parse(await outputs.bound('a'.repeat(8190) + late + 'b'.repeat(70_000)))
  scrubber.register('secret://fixture/late', late)
  const latePages: string[] = []
  offset = 0
  while (true) {
    const page = JSON.parse(await outputs.read(lateReference.artifact, offset))
    latePages.push(page.text); offset = page.nextOffset
    if (!page.truncated) break
  }
  assert.equal(latePages.join(''), scrubber.scrub('a'.repeat(8190) + late + 'b'.repeat(70_000)))
  assert.equal(latePages.join('').includes(late), false)
})
