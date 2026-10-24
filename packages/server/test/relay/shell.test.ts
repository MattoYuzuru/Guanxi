import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { GitRelayWorkspace } from '../../src/relay/workspace.ts'
import type { NativeToolContext } from '../../src/native-agent/tools.ts'
import type { sandboxCommand } from '../../src/native-agent/sandbox.ts'
import { commandOutput } from '../../src/native-agent/sandbox-protocol.ts'
import { fixture, plan } from './fixture.ts'

const git = async (root: string, args: string[]) => (await new Promise<string>((resolve, reject) => {
  execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root }, (error, stdout) => error ? reject(error) : resolve(stdout))
})).trim()

/** The K4 execution owner's contract: the command starts in the sandbox scratch with HOME/TMPDIR there.
 * A relay command must therefore name the checkout itself (the acceptance gate does), or `node --test
 * test/…` would be resolved in the empty scratch directory. */
const sandbox: typeof sandboxCommand = (policy, command, _signal, _timeout, fixed) => new Promise(resolve => {
  execFile('/bin/sh', ['-c', command], { cwd: policy.scratch, env: { ...process.env, HOME: policy.scratch, TMPDIR: policy.scratch }, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    (error, stdout, stderr) => resolve(commandOutput(error ? Number((error as { code?: unknown }).code ?? 1) : 0, [stdout], [stderr], false)))
})

test('a relay shell runs in its checkout, so node --test and fixed reads resolve the plan files', async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-relay-shell-'))), repo = join(parent, 'checkout'), scratch = join(parent, 'runtime', 'scratch')
  await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(join(repo, 'test'), { recursive: true }); await mkdir(scratch, { recursive: true })
  await writeFile(join(repo, 'src', 'value.mjs'), 'export const value = 42\n')
  await writeFile(join(repo, 'test', 'value.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('value', () => assert.equal(value, 42))\n")
  await git(repo, ['init', '-q']); await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'fixture'])
  const p = { ...plan, base: await git(repo, ['rev-parse', 'HEAD']), items: [{ ...plan.items[0]!, acceptance: ['node', '--test', 'test/value.test.mjs'], protectedPaths: [] }], protectedPaths: [] }
  const f = fixture(), handle = f.log.open(f.run.session_id, { kind: 'agent' })
  const issued: Array<{ command: string; fixed: boolean }> = []
  const context: NativeToolContext = {
    policy: { mode: 'full-access', roots: [repo], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: join(parent, 'runtime') },
    log: f.log, handle, scrubber: f.scrubber, queue: () => {},
    executeCommand: (policy, command, signal, timeout, fixed, scrubber) => {
      issued.push({ command, fixed: !!fixed })
      return sandbox(policy, command, signal, timeout, fixed, scrubber)
    },
  }
  try {
    const w = await GitRelayWorkspace.create(repo, p, context)
    const tested = JSON.parse(await w.tool('shell', { command: 'node --test test/value.test.mjs' })) as { code: number; stdout: string }
    assert.equal(tested.code, 0, tested.stdout)
    const read = JSON.parse(await w.tool('shell', { command: 'cat test/value.test.mjs' })) as { code: number; stdout: string }
    assert.equal(read.code, 0)
    assert.match(read.stdout, /import test from 'node:test'/)
    assert.deepEqual(issued.map(issue => issue.fixed), [false, true], 'node --test is arbitrary execution; cat keeps the fixed-command path')
    // A command that exits non-zero is a result the relay model must read (a red test shows which assertion failed),
    // not an opaque failure: the exit code and the scrubbed output come back.
    const failed = JSON.parse(await w.tool('shell', { command: 'echo boom >&2; exit 3' })) as { code: number; stderr: string }
    assert.equal(failed.code, 3)
    assert.match(failed.stderr, /boom/)
  } finally { handle.close(); f.close(); await rm(parent, { recursive: true, force: true }) }
})
