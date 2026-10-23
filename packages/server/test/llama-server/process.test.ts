import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RelayError } from '../../src/relay/types.ts'
import { LlamaServerError } from '../../src/runtime/llama-server/client.ts'
import { LlamaServerHost, type LlamaServerBoot } from '../../src/runtime/llama-server/process.ts'
import { startFakeLlama } from '../fixtures/fake-llama-server.ts'

const fakeBinary = fileURLToPath(new URL('../fixtures/fake-llama-server.ts', import.meta.url))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (predicate: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.fail('condition was not reached')
}
async function fixture(t: { after(fn: () => unknown): void }, behaviour = 'serve') {
  const directory = await mkdtemp(join(tmpdir(), 'guanxi-llama-process-'))
  const binary = join(directory, 'llama-server'), modelPath = join(directory, 'model.gguf')
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeBinary}" --fixture-behaviour ${behaviour} "$@"\n`); await chmod(binary, 0o755)
  await writeFile(modelPath, 'GGUF-fixture')
  const hosts: LlamaServerHost[] = []
  t.after(async () => { for (const host of hosts) await host.close(); await rm(directory, { recursive: true, force: true }) })
  const boot = (extra: Partial<Extract<LlamaServerBoot, { kind: 'spawn' }>> = {}): Extract<LlamaServerBoot, { kind: 'spawn' }> =>
    ({ kind: 'spawn', binary, modelPath, model: 'fixture', contextTokens: 8192, ...extra })
  const create = (extra: Partial<Extract<LlamaServerBoot, { kind: 'spawn' }>> = {}) => { const host = LlamaServerHost.create(boot(extra)); hosts.push(host); return host }
  const props = async (host: LlamaServerHost) => (await fetch((host.runtime as unknown as { host: string }).host + '/props')).json() as Promise<any>
  return { directory, binary, modelPath, boot, create, props }
}

test('an absent, unreadable, relative or non-executable binary or model is "not configured here": no throw, no process, no runtime', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'huge-00001-of-00004.gguf'), 'shard')
  const missing = [
    [{ binary: join(f.directory, 'nope') }, 'llama_server_binary_missing'],
    [{ binary: f.directory }, 'llama_server_binary_missing'],
    [{ binary: f.modelPath }, 'llama_server_binary_missing'],
    [{ binary: 'llama-server' }, 'llama_server_binary_missing'],
    [{ modelPath: join(f.directory, 'nope.gguf') }, 'llama_server_model_missing'],
    [{ modelPath: f.directory }, 'llama_server_model_missing'],
    [{ modelPath: 'model.gguf' }, 'llama_server_model_missing'],
    [{ modelPath: join(f.directory, 'huge-00001-of-00004.gguf') }, 'llama_server_model_unsupported'],
  ] as const
  for (const [patch, reason] of missing) {
    const host = f.create(patch)
    assert.deepEqual(host.state(), { state: 'unavailable', reason }, JSON.stringify(patch)); assert.equal(host.runtime, null)
    assert.throws(() => host.ready(), (error: unknown) => error instanceof RelayError && error.code === 'runtime_meter_unavailable')
    await host.settled(); await host.close()
  }
})

test('boot options are validated as policy: cloud or malformed models, empty windows and bad ports throw before anything starts', async t => {
  const f = await fixture(t)
  for (const patch of [{ model: 'fixture:cloud' }, { model: '../x' }, { contextTokens: 0 }, { contextTokens: 1.5 }, { port: 0 }, { port: 70000 }]) {
    assert.throws(() => LlamaServerHost.create(f.boot(patch)), /relay_(local_model_required|policy_invalid)/, JSON.stringify(patch))
  }
  assert.throws(() => LlamaServerHost.create({ kind: 'attach', baseUrl: 'http://192.168.1.2:8080', model: 'fixture' }), (error: unknown) => error instanceof LlamaServerError && error.code === 'llama_server_refused')
})

test('spawn starts the child with the fixed argv and allow-listed environment, becomes ready only when healthy, and serves the relay runtime', async t => {
  process.env.GUANXI_TEST_SECRET = 'must-not-be-inherited'; t.after(() => { delete process.env.GUANXI_TEST_SECRET })
  const f = await fixture(t), host = f.create()
  assert.equal(host.state().state, 'starting')
  assert.throws(() => host.ready(), (error: unknown) => error instanceof RelayError && error.code === 'runtime_meter_unavailable')
  await host.settled(); assert.deepEqual(host.state(), { state: 'ready' }); host.ready()
  const props = await f.props(host)
  assert.equal(await realpath(props.__cwd), await realpath(tmpdir()), 'the child does not run beside Guanxi\'s own files')
  const port = props.__argv[props.__argv.indexOf('--port') + 1]
  assert.deepEqual(props.__argv.slice(2), ['-m', await realpath(f.modelPath), '--alias', 'fixture:latest', '--host', '127.0.0.1', '--port', port, '-c', '8192',
    '-np', '1', '--jinja', '--no-context-shift', '--no-webui'])
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES',
    'PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING']) // added by the /bin/sh wrapper of the fixture or by macOS itself
  assert.deepEqual(props.__env.filter((name: string) => !allowed.has(name)), [], 'only allow-listed variables reach the child')
  assert.equal(props.__env.includes('GUANXI_TEST_SECRET'), false, 'the owner process environment does not leak into the child')
  const seen = await host.runtime!.observe('fixture:latest', new AbortController().signal)
  assert.equal(seen.contextTokens, 8192); assert.equal(seen.model, 'fixture:latest')
})

test('close stops only the child this host started, and a stubborn child is killed after the grace period', async t => {
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' }); t.after(() => { bystander.kill() })
  const f = await fixture(t), host = f.create(); await host.settled()
  const pid = (await f.props(host)).__pid as number
  assert.ok(alive(pid) && alive(bystander.pid!))
  await host.close()
  assert.equal(alive(pid), false, 'the owned child is gone when close returns')
  assert.equal(alive(bystander.pid!), true, 'an unrelated process is never signalled')
  assert.deepEqual(host.state(), { state: 'unavailable', reason: 'llama_server_closed' })
  await host.close()
  const stubborn = await fixture(t, 'ignore-term'), slow = stubborn.create({ stopGraceMs: 200 }); await slow.settled()
  const stubbornPid = (await stubborn.props(slow)).__pid as number
  await slow.close()
  assert.equal(alive(stubbornPid), false)
})

test('a child that never reports healthy times out unavailable and is stopped; a child that exits is unavailable and not restarted', async t => {
  // The child must answer /props before the host's startup timeout kills it, so the window has to outlast a
  // `node` start on a busy machine (the full parallel suite): 600 ms was shorter than that and failed under load.
  const never = await fixture(t, 'never-ready'), waiting = never.create({ startupTimeoutMs: 4_000, stopGraceMs: 500 })
  const pid = (await (async () => { await until(async () => { try { return !!(await never.props(waiting)).__pid } catch { return false } }); return (await never.props(waiting)).__pid })()) as number
  assert.equal(waiting.state().state, 'starting')
  await waiting.settled()
  assert.deepEqual(waiting.state(), { state: 'unavailable', reason: 'llama_server_start_timeout' })
  assert.equal(alive(pid), false)
  const gone = await fixture(t, 'exit'), exited = gone.create(); await exited.settled()
  await until(() => exited.state().state === 'unavailable')
  assert.deepEqual(exited.state(), { state: 'unavailable', reason: 'llama_server_exited', detail: 'exit:3' }, 'the exit code is kept, since output is discarded')
  await assert.rejects(exited.runtime!.observe('fixture:latest', new AbortController().signal), /runtime_meter_unavailable/)
})

test('a child that dies after becoming ready makes the relay unavailable at once and is not silently restarted', async t => {
  const f = await fixture(t), host = f.create(); await host.settled()
  const pid = (await f.props(host)).__pid as number
  process.kill(pid, 'SIGKILL')
  await until(() => host.state().state === 'unavailable')
  assert.deepEqual(host.state(), { state: 'unavailable', reason: 'llama_server_exited', detail: 'signal:SIGKILL' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(host.state().state, 'unavailable'); assert.throws(() => host.ready(), /runtime_meter_unavailable/)
})

test('closing while the child is still loading stops it and never reports ready', async t => {
  const f = await fixture(t, 'never-ready'), host = f.create({ stopGraceMs: 500 })
  await until(async () => { try { return !!(await f.props(host)).__pid } catch { return false } })
  const pid = (await f.props(host)).__pid as number
  await host.close()
  assert.equal(alive(pid), false); assert.deepEqual(host.state(), { state: 'unavailable', reason: 'llama_server_closed' })
})

test('attach mode uses an existing loopback server, is ready immediately, and never signals or stops it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guanxi-llama-attach-')); t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir, { recursive: true }); const modelPath = join(dir, 'm.gguf'); await writeFile(modelPath, 'GGUF-attached')
  const fake = await startFakeLlama({ alias: 'fixture', modelPath }); t.after(() => fake.close())
  const kill = t.mock.method(process, 'kill', () => true)
  const host = LlamaServerHost.create({ kind: 'attach', baseUrl: fake.url, model: 'fixture' })
  assert.deepEqual(host.state(), { state: 'ready' })
  assert.equal((await host.runtime!.observe('fixture:latest', new AbortController().signal)).model, 'fixture:latest')
  await host.close()
  assert.equal(kill.mock.callCount(), 0, 'no signal was sent to any process')
  kill.mock.restore()
  assert.equal((await fetch(fake.url + '/health')).status, 200, 'the externally owned server keeps running')
  const down = LlamaServerHost.create({ kind: 'attach', baseUrl: 'http://127.0.0.1:1', model: 'fixture' })
  await assert.rejects(down.runtime!.observe('fixture:latest', new AbortController().signal), /runtime_meter_unavailable/)
  await down.close()
})
