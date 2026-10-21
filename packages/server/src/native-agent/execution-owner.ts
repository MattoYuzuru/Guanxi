import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createConnection, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { lstat, writeFile, copyFile, realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { containerRunner } from './container-runner.ts'
import { TOOL_OUTPUT_BYTES, commandOutput, type SandboxPolicy, type CommandResult } from './sandbox-protocol.ts'

const exec = promisify(execFile)
export const CONTAINER_IMAGE = 'guanxi-native-execution:k4-v1'

/** Settlement includes confirmed namespace teardown; callers retain writer ownership until then. */
export interface ExecutionOwner {
  execute(command: string): Promise<CommandResult>
  stop(): Promise<void>
}

export class LinuxExecutionOwner implements ExecutionOwner {
  private child?: ChildProcess
  private stopped = false
  private bindingFilter: string
  constructor(bindingFilter: string) { this.bindingFilter = bindingFilter }
  async stop() {
    this.stopped = true
    if (this.child?.pid) { try { this.child.kill('SIGKILL') } catch { /* exited */ } }
  }
  async execute(command: string): Promise<CommandResult> {
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const guarded = `/usr/bin/setpriv --no-new-privs --seccomp-filter ${quote(this.bindingFilter)} /bin/sh -c ${quote(command)}`
    const wrapped = await SandboxManager.wrapWithSandbox(guarded, '/bin/sh')
    // Do not silently accept a weaker upstream profile (including host /proc).
    if (!wrapped.includes('--unshare-pid') || !wrapped.includes('--die-with-parent') || !/--proc\s+['"]?\/proc/.test(wrapped)) throw new Error('supervision_unavailable')
    if (this.stopped) throw new Error('sandbox_failed')
    // Explicit exec makes bubblewrap's parent the worker on every POSIX shell.
    return collect(this.child = spawn('/bin/sh', ['-c', `exec ${wrapped}`], { stdio: ['ignore', 'pipe', 'pipe'] }))
  }
}

/** Fixed, trusted commands only; Seatbelt remains the macOS no-runtime fast path. */
export class FixedExecutionOwner implements ExecutionOwner {
  private child?: ChildProcess
  private stopped = false
  async stop() { this.stopped = true; if (this.child?.pid) { try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* exited */ } } }
  async execute(command: string) {
    const wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/sh')
    if (this.stopped) throw new Error('sandbox_failed')
    return collect(this.child = spawn('/bin/sh', ['-c', wrapped], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
}

export class ContainerExecutionOwner implements ExecutionOwner {
  private stopped = false
  private created = false
  private creation?: Promise<unknown>
  private sockets = new Map<number, Socket>()
  private policy: SandboxPolicy
  private endpoint: string
  private name: string
  private directory: string
  constructor(policy: SandboxPolicy, endpoint: string, name: string, directory: string) {
    this.policy = policy; this.endpoint = endpoint; this.name = name; this.directory = directory
  }
  private docker(args: string[]) { return exec('docker', ['--host', this.endpoint, ...args], { timeout: 15_000, maxBuffer: 256 * 1024 }) }
  async stop() {
    this.stopped = true
    // No settlement on an uncertain daemon response. Keep ownership while retrying.
    if (!this.created) return
    await this.creation?.catch(() => undefined)
    while (true) {
      try {
        await this.docker(['rm', '--force', this.name])
        this.created = false
        break
      } catch {
        try {
          const { stdout } = await this.docker(['ps', '-aq', '--filter', `name=^/${this.name}$`])
          if (!stdout.trim()) { this.created = false; break }
        } catch { /* Runtime unavailable: retain ownership until it can confirm teardown. */ }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    for (const socket of this.sockets.values()) socket.destroy()
    this.sockets.clear()
  }
  async execute(command: string): Promise<CommandResult> {
    const { policy } = this
    let image: string
    try { image = (await this.docker(['image', 'inspect', '--format', '{{.Id}}', CONTAINER_IMAGE])).stdout.trim() }
    catch { throw new Error('container_runtime_unavailable') }
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('container_runtime_unavailable')
    const runner = join(this.directory, 'container.cjs')
    await writeFile(runner, containerRunner, { mode: 0o444, flag: 'wx' })
    const ca = join(this.directory, 'egress-ca.pem')
    await copyFile(SandboxManager.getMitmCA()!.trustBundlePath, ca)
    const uid = process.getuid!(), gid = process.getgid!()
    if (!uid) throw new Error('supervision_unavailable')
    const args = ['create', '--name', this.name, '--rm', '--init', '--interactive', '--network', 'none',
      '--read-only', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
      '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--user', '0:0', '--workdir', '/run']
    const mounts = new Map<string, { source: string; readonly: boolean }>()
    const mount = (source: string, target: string, readonly: boolean) => {
      if (source.includes(',') || target.includes(',')) throw new Error('container_path_unsupported')
      mounts.set(target, { source, readonly: readonly || mounts.get(target)?.readonly === true })
    }
    // Parent mounts precede children. Scratch is the sole writable mount with zero roots.
    for (const root of [...new Set([...policy.roots, ...policy.attachments, policy.scratch])].sort((a, b) => a.length - b.length)) {
      mount(root, root, root !== policy.scratch && (policy.mode !== 'full-access' || !policy.roots.includes(root)))
    }
    const writable = [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])]
    const dependencies: string[] = []
    for (const root of policy.roots) {
      const path = join(root, 'node_modules')
      try { dependencies.push(await realpath(path)) } catch { /* absent dependency tree */ }
    }
    for (const path of [...policy.protectedPaths, ...policy.attachments, ...dependencies]) {
      if (!writable.some(root => path === root || path.startsWith(root + sep))) continue
      let cover = path
      while (true) {
        try { await lstat(cover); break } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(cover) === cover) throw error
          cover = dirname(cover)
        }
      }
      // An absent deny path conservatively makes its nearest existing parent read-only.
      mount(cover, cover, true)
      for (let ancestor = dirname(cover); writable.some(root => ancestor.startsWith(root + sep)); ancestor = dirname(ancestor)) {
        // Pin every ancestor so a workload cannot rename it and recreate a denied name.
        mount(ancestor, ancestor, false)
      }
    }
    mount(runner, '/run/owner.cjs', true); mount(ca, '/run/egress-ca.pem', true)
    for (const [target, { source, readonly }] of [...mounts].sort(([a], [b]) => a.length - b.length)) {
      const inheritedReadonly = [...mounts].some(([ancestor, entry]) => entry.readonly && target.startsWith(ancestor + sep))
      args.push('--mount', `type=bind,source=${source},target=${target}${readonly || inheritedReadonly ? ',readonly' : ''}`)
    }
    args.push('--entrypoint', '/usr/local/bin/node', image, '/run/owner.cjs')
    if (this.stopped) throw new Error('sandbox_failed')
    // Mark before create: stop during create must also remove a late-created container.
    this.created = true
    try {
      await (this.creation = this.docker(args))
      if (this.stopped) throw new Error('sandbox_failed')
      const child = spawn('docker', ['--host', this.endpoint, 'start', '--attach', '--interactive', this.name], { stdio: ['pipe', 'pipe', 'ignore'] })
      const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n') }
      child.stdin.on('error', () => {})
      let result: CommandResult | undefined
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        const message = JSON.parse(line)
        if (message.type === 'open') {
          const socket = createConnection({ host: '127.0.0.1', port: SandboxManager.getProxyPort()! })
          this.sockets.set(message.id, socket)
          socket.on('data', data => send({ type: 'data', id: message.id, data: data.toString('base64') }))
          socket.on('end', () => send({ type: 'end', id: message.id }))
          socket.on('error', () => send({ type: 'end', id: message.id }))
          socket.on('close', () => this.sockets.delete(message.id))
        }
        if (message.type === 'data') this.sockets.get(message.id)?.write(Buffer.from(message.data, 'base64'))
        if (message.type === 'end') this.sockets.get(message.id)?.end()
        if (message.type === 'output') {
          const data = Buffer.from(message.data, 'base64')
          if (message.channel === 'stdout') stdout.push(data); else stderr.push(data)
        }
        if (message.type === 'result') result = commandOutput(message.code, stdout, stderr, message.truncated)
      })
      send({ type: 'start', command, scratch: policy.scratch, uid, gid, limit: TOOL_OUTPUT_BYTES, auth: `srt:${SandboxManager.getProxyAuthToken()}` })
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()) })
      if (!result || this.stopped) throw new Error('sandbox_failed')
      return result
    } finally { await this.stop() }
  }
}

async function collect(child: ChildProcess): Promise<CommandResult> {
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let bytes = 0, truncated = false
  for (const channel of ['stdout', 'stderr'] as const) child[channel]!.on('data', (data: Buffer) => {
    const remaining = Math.max(0, TOOL_OUTPUT_BYTES - bytes)
    bytes += data.length; truncated ||= data.length > remaining
    if (remaining) {
      if (channel === 'stdout') stdout.push(data.subarray(0, remaining)); else stderr.push(data.subarray(0, remaining))
    }
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(commandOutput(code, stdout, stderr, truncated)))
  })
}
