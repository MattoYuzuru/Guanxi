import { fork } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm, realpath, lstat, opendir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
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
const protocolBytes = built ? '' : readFileSync(new URL('./sandbox-protocol.ts', import.meta.url), 'utf8')

/** A fresh worker owns the runtime singleton, proxies and child process group. */
export async function sandboxCommand(policy: SandboxPolicy, command: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<CommandResult> {
  signal?.throwIfAborted()
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
  if (!built) await writeFile(join(directory, 'sandbox-protocol.ts'), protocolBytes, { mode: 0o400, flag: 'wx' })
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { detached: true, execArgv: [], cwd: policy.scratch,
      env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: networkDirectory, TMPDIR: networkDirectory, LANG: 'en_US.UTF-8' },
      // Runtime diagnostics may include command contents. They never enter plain logs.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    let result: CommandResult | null = null
    let failure = false
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already exited */ } }
    const abort = () => { failure = true; kill() }
    const timer = setTimeout(abort, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    child.on('message', (message: { result?: CommandResult; error?: boolean }) => {
      if (message.result) result = message.result
      if (message.error) failure = true
    })
    child.once('error', () => { failure = true; kill() })
    child.once('exit', async () => {
      kill() // Kill remaining members of this group; detached descendants need a supervisor.
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await Promise.all([directory, networkDirectory].map(path => rm(path, { recursive: true, force: true }).catch(() => undefined)))
      if (!failure && result && !signal?.aborted) resolve(result)
      else reject(new Error('sandbox_failed'))
    })
    child.send({ policy, command })
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
