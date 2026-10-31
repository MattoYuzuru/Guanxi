import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeTools } from '../../src/native-agent/tools.ts'
import type { sandboxCommand } from '../../src/native-agent/sandbox.ts'
import { commandOutput } from '../../src/native-agent/sandbox-protocol.ts'

const scrubber = { scrub: <T>(value: T): T => value, isReady: () => true }

async function setup(t: { after(fn: () => unknown): void }, executeCommand: typeof sandboxCommand) {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-tool-errors-')), scratch = join(dir, 'scratch')
  await mkdir(scratch)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tool = nativeTools({
    policy: { mode: 'read-only', roots: [], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: dir },
    log: {} as never, handle: { sessionId: 'tool-errors' } as never, scrubber: scrubber as never, queue() {}, executeCommand,
  }).find(value => value.name === 'shell')!
  return async (command: string) => {
    const result = await tool.execute('call', { command } as never) as { content: Array<{ text: string }>; details: { code?: string } | null; isError?: boolean }
    return { text: result.content.map(part => part.text).join('\n'), code: result.isError ? result.details?.code : undefined }
  }
}

test('a fixed internal code reaches the model and trace, while free text stays behind the generic code', async t => {
  const calls: string[] = []
  const call = await setup(t, async (_policy, command) => {
    calls.push(command)
    if (command === 'missing') return commandOutput(1, [Buffer.from('')], [Buffer.from('node:test could not find the file')], false)
    throw new Error(command)
  })
  // `tool_failed` was outside the old allow-list, so a real command failure read as a denial.
  assert.deepEqual(await call('missing'), { text: 'tool_failed', code: 'tool_failed' })
  // Fixed K4 refusals are preserved with no change.
  for (const code of ['container_home_root_denied', 'container_runtime_unavailable', 'path_denied', 'sandbox_failed', 'index_unavailable']) {
    assert.deepEqual(await call(code), { text: code, code }, code)
  }
  // An OS/provider message can contain a path or a command; it is never returned.
  for (const message of ['permission denied: /Users/someone/private', 'ENOENT: no such file or directory', 'node --test test/01-money.test.mjs']) {
    assert.deepEqual(await call(message), { text: 'tool_denied_or_failed', code: 'tool_denied_or_failed' }, message)
  }
  assert.deepEqual(calls, ['missing', 'container_home_root_denied', 'container_runtime_unavailable', 'path_denied', 'sandbox_failed', 'index_unavailable',
    'permission denied: /Users/someone/private', 'ENOENT: no such file or directory', 'node --test test/01-money.test.mjs'])
})
