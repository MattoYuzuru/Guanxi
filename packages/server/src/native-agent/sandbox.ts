import { execFile, fork } from 'node:child_process'
import { existsSync, readFileSync, accessSync, realpathSync, constants } from 'node:fs'
import { mkdtemp, writeFile, rm, realpath, lstat, opendir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { join, sep, delimiter, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SandboxPolicy, CommandResult } from './sandbox-protocol.ts'
export { TOOL_OUTPUT_BYTES } from './sandbox-protocol.ts'
export type { SandboxPolicy, CommandResult } from './sandbox-protocol.ts'

// Capture trusted launcher bytes before any session can edit a working checkout.
const builtWorker = new URL('./sandbox-worker.js', import.meta.url)
const built = existsSync(builtWorker)
const runtimeUrl = import.meta.resolve('@anthropic-ai/sandbox-runtime')
const workerBytes = readFileSync(built ? builtWorker : new URL('./sandbox-worker.ts', import.meta.url), 'utf8')
  .replace(/(['"])@anthropic-ai\/sandbox-runtime\1/g, JSON.stringify(runtimeUrl))
const sources = built ? [] : ['sandbox-protocol.ts', 'execution-owner.ts', 'container-runner.ts'].map(name => ({ name, bytes: readFileSync(new URL(name, import.meta.url), 'utf8').replace(/(['"])@anthropic-ai\/sandbox-runtime\1/g, JSON.stringify(runtimeUrl)) }))
function resolveDockerBinary(): { path: string; protectedPaths: string[] } | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    const lexical = join(directory, 'docker')
    try {
      accessSync(lexical, constants.X_OK)
      const path = realpathSync(lexical)
      return { path, protectedPaths: [lexical, path] }
    } catch { /* Try the next trusted startup PATH directory. */ }
  }
  return null
}
// Resolve before a session can replace a PATH entry. Never re-resolve during cleanup.
const dockerBinary = resolveDockerBinary()

/** A fresh worker owns the runtime singleton, proxies and child process group. */
export async function sandboxCommand(policy: SandboxPolicy, command: string, signal?: AbortSignal, timeoutMs = 120_000, fixed = false): Promise<CommandResult> {
  signal?.throwIfAborted()
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('supervision_unavailable')
  let dockerEndpoint = ''
  if (process.platform === 'darwin') {
    const writable = [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])]
    if (dockerBinary && writable.some(root => dockerBinary.protectedPaths.some(path => path === root || path.startsWith(root + sep)))) throw new Error('container_runtime_protected')
  }
  if (process.platform === 'darwin' && !fixed) {
    const home = homedir()
    if (policy.roots.some(root => home === root || home.startsWith(root + sep))) throw new Error('container_home_root_denied')
    try {
      if (!dockerBinary) throw new Error('missing_docker')
      const exec = promisify(execFile)
      const context = process.env.DOCKER_CONTEXT || (await exec(dockerBinary.path, ['context', 'show'], { timeout: 5000 })).stdout.trim()
      dockerEndpoint = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST : (await exec(dockerBinary.path, ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], { timeout: 5000 })).stdout.trim()
      if (!dockerEndpoint.startsWith('unix://')) throw new Error('remote_runtime_denied')
      await exec(dockerBinary.path, ['--host', dockerEndpoint, 'info', '--format', '{{.OSType}}'], { timeout: 5000 })
    } catch { throw new Error('container_runtime_unavailable') }
  }
  // Path sandboxes cannot distinguish an inherited writable hardlink from its
  // other names outside the roots. Refuse such trees before granting writes.
  for (const root of [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])]) await rejectHardlinks(root, signal)
  const directory = await realpath(await mkdtemp(join(policy.runtimeBase ?? tmpdir(), 'sandbox-worker-')))
  const writable = [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])]
  if (writable.some(root => directory === root || directory.startsWith(root + sep))) {
    await rm(directory, { recursive: true, force: true }); throw new Error('runtime_overlaps_roots')
  }
  const networkDirectory = await realpath(await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'gx-proxy-')))
  if (writable.some(root => networkDirectory === root || networkDirectory.startsWith(root + sep))) {
    await Promise.all([directory, networkDirectory].map(path => rm(path, { recursive: true, force: true }))); throw new Error('runtime_overlaps_roots')
  }
  const worker = pathToFileURL(join(directory, built ? 'sandbox-worker.mjs' : 'sandbox-worker.ts'))
  await writeFile(worker, workerBytes, { mode: 0o400, flag: 'wx' })
  for (const source of sources) await writeFile(join(directory, source.name), source.bytes, { mode: 0o400, flag: 'wx' })
  const ownerName = `guanxi-exec-${randomUUID()}`
  const confirmContainerGone = async () => {
    if (!dockerEndpoint) return
    const exec = promisify(execFile)
    while (true) {
      try { await exec(dockerBinary!.path, ['--host', dockerEndpoint, 'rm', '--force', ownerName], { timeout: 15_000 }) } catch { /* May already have auto-removed. */ }
      try {
        const { stdout } = await exec(dockerBinary!.path, ['--host', dockerEndpoint, 'ps', '-aq', '--filter', `name=^/${ownerName}$`], { timeout: 15_000 })
        if (!stdout.trim()) return
      } catch { /* An unavailable daemon is not proof of teardown. */ }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { detached: true, execArgv: [], cwd: policy.scratch,
      env: { PATH: process.platform === 'darwin' ? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: networkDirectory, TMPDIR: networkDirectory, LANG: 'en_US.UTF-8' },
      // Runtime diagnostics may include command contents. They never enter plain logs.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let result: CommandResult | null = null
    let failure: string | null = null
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already exited */ } }
    const abort = () => { failure = 'sandbox_failed'; if (child.connected) child.send({ stop: true }) }
    const timer = setTimeout(abort, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('message', (message: { result?: CommandResult; error?: string }) => {
      if (message.result) result = message.result
      if (message.error) failure = message.error
    })
    child.once('error', () => { failure = 'sandbox_failed'; kill() })
    child.once('exit', async () => {
      kill()
      // Also covers a worker crash: killing a Docker CLI does not stop its container.
      await confirmContainerGone()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await Promise.all([directory, networkDirectory].map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)))
      if (!failure && result && !signal?.aborted) resolve(result)
      else reject(new Error(failure ?? 'sandbox_failed'))
    })
    child.send({ policy, command, fixed, dockerEndpoint, ownerName, directory, dockerPath: dockerBinary?.path ?? '' })
    if (signal?.aborted) abort()
  })
}

export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

async function rejectHardlinks(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const entry = await lstat(path)
  if (entry.isSymbolicLink()) return
  if (entry.isFile() && entry.nlink > 1) throw new Error('hardlinked_writable_file')
  if (entry.isDirectory()) {
    const directory = await opendir(path)
    for await (const item of directory) await rejectHardlinks(join(path, item.name), signal)
  }
}
