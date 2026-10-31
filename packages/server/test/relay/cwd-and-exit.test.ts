import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { GitRelayWorkspace } from '../../src/relay/workspace.ts'
import type { NativeToolContext } from '../../src/native-agent/tools.ts'
import { nativeTools } from '../../src/native-agent/tools.ts'
import type { sandboxCommand } from '../../src/native-agent/sandbox.ts'
import { commandOutput } from '../../src/native-agent/sandbox-protocol.ts'
import { fixture, plan } from './fixture.ts'

const git = async (root: string, args: string[]) => (await new Promise<string>((resolve, reject) => {
  execFile('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root }, (error, stdout) => error ? reject(error) : resolve(stdout))
})).trim()

/** A real /bin/sh in the scratch directory, as the K4 execution owner starts a command. `__killed__` marks a command the owner killed. */
const shell: typeof sandboxCommand = (policy, command) => new Promise(resolve => {
  if (command.includes('__killed__')) return resolve(commandOutput(null, [], [], false))
  execFile('/bin/sh', ['-c', command], { cwd: policy.scratch, env: { ...process.env, HOME: policy.scratch, TMPDIR: policy.scratch }, encoding: 'buffer' },
    (error, stdout, stderr) => resolve(commandOutput(error ? Number((error as { code?: unknown }).code ?? 1) : 0, [stdout], [stderr], false)))
})

async function setup(acceptance: string[] = ['true']) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'guanxi-relay-cwd-'))), repo = join(parent, 'checkout'), scratch = join(parent, 'runtime', 'scratch')
  await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(scratch, { recursive: true })
  await writeFile(join(repo, 'src', 'value.txt'), 'forty-two\n')
  await git(repo, ['init', '-q']); await git(repo, ['add', '.']); await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'fixture'])
  const p = { ...plan, base: await git(repo, ['rev-parse', 'HEAD']), items: [{ ...plan.items[0]!, acceptance, protectedPaths: [] }], protectedPaths: [] }
  const f = fixture(), handle = f.log.open(f.run.session_id, { kind: 'agent' })
  const context: NativeToolContext = {
    policy: { mode: 'full-access', roots: [repo], scratch, attachments: [], protectedPaths: [], domains: [], runtimeBase: join(parent, 'runtime') },
    log: f.log, handle, scrubber: f.scrubber, queue: () => {}, executeCommand: shell,
  }
  return { parent, repo, scratch, p, f, context, close: async () => { handle.close(); f.close(); await rm(parent, { recursive: true, force: true }) } }
}

test('a gate whose checkout cannot be entered is an infrastructure stop, not the item failing; an argv that exits 125 is still its own result', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    const issued: string[] = []
    // The sandbox loses the clean checkout between preparation and the command (the owner's temporary tree vanished).
    s.context.executeCommand = async (policy, command, ...rest) => {
      issued.push(command)
      await rm(policy.roots[0]!, { recursive: true, force: true })
      return shell(policy, command, ...rest)
    }
    await assert.rejects(w.verify(s.p, 'one'), /cwd_unavailable/)
    assert.equal(issued.length, 1)
    // The same exit code from the argv itself is a red gate: only a failed cd carries the marker.
    const p125 = { ...s.p, items: [{ ...s.p.items[0]!, acceptance: ['/bin/sh', '-c', 'exit 125'] }] }
    s.context.executeCommand = shell
    const red = await w.verify(p125, 'one')
    assert.equal(red.ok, false)
    assert.equal((JSON.parse(red.output) as { code: number }).code, 125)
    assert.equal((await w.verify(s.p, 'one')).ok, true)
  } finally { await s.close() }
})

test('a failed cd in a gate does not run the argv in the scratch directory', async () => {
  const s = await setup(['/bin/sh', '-c', 'echo ran > ran.marker']); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    s.context.executeCommand = async (policy, command, ...rest) => {
      await rm(policy.roots[0]!, { recursive: true, force: true })
      return shell(policy, command, ...rest)
    }
    await assert.rejects(w.verify(s.p, 'one'), /cwd_unavailable/)
    await assert.rejects(access(join(s.scratch, 'ran.marker')), 'the gate argv must not run after a failed cd')
  } finally { await s.close() }
})

test('a relay shell whose checkout cannot be entered answers cwd_unavailable instead of running or reporting the command\'s exit 1', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    const gone = join(s.parent, 'gone')
    s.context.executeCommand = (policy, command, ...rest) => shell(policy, command.replaceAll(s.repo, gone), ...rest)
    // Arbitrary and fixed commands alike: neither runs in the scratch directory, neither looks like the command's own exit 1.
    await assert.rejects(w.tool('shell', { command: 'echo ran > shell.marker' }), /cwd_unavailable/)
    await assert.rejects(w.tool('shell', { command: 'cat src/value.txt' }), /cwd_unavailable/)
    await assert.rejects(access(join(s.scratch, 'shell.marker')), 'the command must not run after a failed cd')
    // A command that really exits 125 is its own result, not the infrastructure code.
    s.context.executeCommand = shell
    const own = JSON.parse(await w.tool('shell', { command: 'exit 125' })) as { code: number }
    assert.equal(own.code, 125)
  } finally { await s.close() }
})

test('a fixed read that exits non-zero returns its code and scrubbed output to the relay model; real failures keep their codes', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    s.f.scrubber.register('secret://fixture/relay', 'synthetic-relay-secret')
    const missing = JSON.parse(await w.tool('shell', { command: 'cat src/missing.txt' })) as { code: number; stderr: string }
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /missing\.txt/)
    const listed = JSON.parse(await w.tool('shell', { command: 'ls src/nowhere' })) as { code: number }
    assert.notEqual(listed.code, 0)
    // The output of a command that ran is scrubbed before the model sees it.
    await writeFile(join(s.repo, 'src', 'secret.txt'), 'synthetic-relay-secret\n')
    const leaked = JSON.parse(await w.tool('shell', { command: 'cat src/secret.txt src/missing.txt' })) as { code: number; stdout: string }
    assert.equal(leaked.code, 1)
    assert.equal(leaked.stdout.includes('synthetic-relay-secret'), false)
    // A command with no exit code (killed by the owner) and a sandbox refusal keep their fixed codes on the fixed path too.
    await assert.rejects(w.tool('shell', { command: 'cat src/__killed__' }), /tool_failed/)
    s.context.executeCommand = async () => { throw new Error('container_runtime_unavailable') }
    await assert.rejects(w.tool('shell', { command: 'cat src/value.txt' }), /container_runtime_unavailable/)
    s.context.executeCommand = async () => { throw new Error('cleanup_unconfirmed') }
    await assert.rejects(w.tool('shell', { command: 'cat src/value.txt' }), /cleanup_unconfirmed/)
  } finally { await s.close() }
})

test('wrapper output on stderr before the failed-cd line does not hide the failure', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    // A sandbox or guard wrapper that warns on stderr before the shell runs (bwrap, setpriv, the container guard).
    const noisy = (rewrite: (command: string) => string): typeof sandboxCommand => async (policy, command, ...rest) => {
      const result = await shell(policy, rewrite(command), ...rest)
      return { ...result, stderr: 'wrapper: warning before the shell\nsecond wrapper line\n' + result.stderr }
    }
    s.context.executeCommand = noisy(command => command.replaceAll(s.repo, join(s.parent, 'gone')))
    await assert.rejects(w.tool('shell', { command: 'echo ran' }), /cwd_unavailable/)
    s.context.executeCommand = async (policy, command, ...rest) => {
      await rm(policy.roots[0]!, { recursive: true, force: true })
      return noisy(value => value)(policy, command, ...rest)
    }
    await assert.rejects(w.verify(s.p, 'one'), /cwd_unavailable/)
  } finally { await s.close() }
})

test('a command that prints the marker words and exits 125 keeps its own result: only this call\'s exact line counts', async () => {
  const s = await setup(); try {
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    for (const printed of ['cwd_unavailable', 'cwd_unavailable:', 'cwd_unavailable:0123456789abcdef0123456789abcdef', 'cwd_unavailable_x']) {
      const command = `echo ${printed} >&2; exit 125`
      const ran = JSON.parse(await w.tool('shell', { command })) as { code: number; stderr: string }
      assert.equal(ran.code, 125, printed)
      assert.match(ran.stderr, /cwd_unavailable/)
      const red = await w.verify({ ...s.p, items: [{ ...s.p.items[0]!, acceptance: ['/bin/sh', '-c', command] }] }, 'one')
      assert.equal(red.ok, false, printed)
      assert.equal((JSON.parse(red.output) as { code: number }).code, 125, printed)
    }
  } finally { await s.close() }
})

test('the shell result is scrubbed by the command wrapper itself and size-bounded', async () => {
  const s = await setup(); try {
    // A scrubber that only redacts structured results: the outer text bound (which scrubs strings) cannot cover for the command wrapper's own scrub.
    const real = s.f.scrubber
    real.register('secret://fixture/relay', 'synthetic-relay-secret')
    s.context.scrubber = Object.assign(Object.create(real), { scrub: (value: unknown) => typeof value === 'string' ? value : real.scrub(value) })
    const w = await GitRelayWorkspace.create(s.repo, s.p, s.context)
    const leaked = JSON.parse(await w.tool('shell', { command: 'echo synthetic-relay-sec""ret; echo synthetic-relay-sec""ret >&2; exit 4' })) as { code: number; stdout: string; stderr: string }
    assert.equal(leaked.code, 4)
    assert.equal(leaked.stdout.includes('synthetic-relay-secret') || leaked.stderr.includes('synthetic-relay-secret'), false)
    // Output past the bound is not returned whole: the result is an artifact reference with a short excerpt, and the code is not lost.
    const big = await w.tool('shell', { command: "head -c 200000 /dev/zero | tr '\\0' x; exit 3" })
    assert.ok(Buffer.byteLength(big) < 64 * 1024, `bounded result was ${Buffer.byteLength(big)} bytes`)
    const bounded = JSON.parse(big) as { truncated: boolean; bytes: number; artifact: string; excerpt: string; readWith: string }
    assert.equal(bounded.truncated, true)
    assert.ok(bounded.excerpt.length <= 8 * 1024)
    assert.equal(bounded.readWith, 'tool_output_read')
    const page = JSON.parse(await w.tool('tool_output_read', { artifact: bounded.artifact, offset: '0' })) as { text: string }
    assert.match(page.text, /"code":3/)
  } finally { await s.close() }
})

test('without a relay checkout the native shell keeps a non-zero exit of a fixed read as tool_failed', async () => {
  const s = await setup(); try {
    const tool = nativeTools({ ...s.context, executeCommand: shell, policy: { ...s.context.policy, mode: 'read-only', roots: [s.repo] } }).find(t => t.name === 'shell')!
    const result = await tool.execute('call', { command: `cat ${join(s.repo, 'nope.txt')}` } as never) as { isError?: boolean; details: { code?: string } | null }
    assert.deepEqual([result.isError, result.details?.code], [true, 'tool_failed'])
  } finally { await s.close() }
})
