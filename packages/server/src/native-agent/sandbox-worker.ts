/** Trusted launcher only. This file is a separate build entry, never a tool. */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { TOOL_OUTPUT_BYTES, type SandboxPolicy, type CommandResult } from './sandbox-protocol.ts'

process.once('disconnect', () => { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } })
process.once('message', async ({ policy, command }: { policy: SandboxPolicy; command: string }) => {
  try {
    // Windows requires machine-wide provisioning; refuse until Guanxi validates that profile.
    if (!['darwin', 'linux'].includes(process.platform)) throw new Error('unsupported_sandbox')
    const literal = (path: string) => ({ path, literal: true as const })
    const system = process.platform === 'darwin'
      ? ['/bin', '/usr', '/System', '/Library/Apple', '/private/etc', '/private/var/select', '/dev', '/opt/homebrew/Cellar', '/opt/homebrew/opt']
      : ['/bin', '/usr', '/lib', '/lib64', '/etc', '/dev', '/proc/self']
    const read = [...system, dirname(realpathSync(process.execPath)), policy.scratch, ...policy.roots, ...policy.attachments]
    const installedRuntime = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))
    const modules = installedRuntime.split('/node_modules/')[0] + '/node_modules'
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: policy.domains, deniedDomains: [], strictAllowlist: true,
        allowUnixSockets: [], allowLocalBinding: false, allowAllUnixSockets: false,
        // The HTTP parser observes HTTPS too. No raw CONNECT or SOCKS escape.
        tlsTerminate: {}, refuseOpaqueTunnels: true, requireHostMatch: true,
        filterRequest: async request => ({ action: policy.mode === 'full-access' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'allow' : 'deny' }),
      },
      filesystem: { denyRead: ['/', ...(policy.hiddenPaths ?? [])].map(literal), allowRead: read.map(literal),
        allowWrite: [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])].map(literal),
        // Cancel upstream convenience grants. Stdio devices are the only exceptions.
        denyWrite: [...getDefaultWritePaths().filter(path => !path.startsWith('/dev/')), modules, dirname(realpathSync(process.execPath)), ...policy.protectedPaths, ...policy.attachments].map(literal),
      },
      allowPty: false, enableWeakerNetworkIsolation: false, enableWeakerNestedSandbox: false,
    }
    await SandboxManager.initialize(config, undefined, false)
    const wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/sh')
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', wrapped], { cwd: policy.scratch,
        env: { ...process.env, OPENSSL_CONF: '/dev/null', PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', TMPDIR: policy.scratch }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', bytes = 0, truncated = false
      const append = (channel: 'stdout' | 'stderr', data: Buffer) => {
        const remaining = Math.max(0, TOOL_OUTPUT_BYTES - bytes)
        const text = data.subarray(0, remaining).toString('utf8')
        bytes += data.length
        truncated ||= data.length > remaining
        if (channel === 'stdout') stdout += text
        else stderr += text
      }
      child.stdout.on('data', data => append('stdout', data))
      child.stderr.on('data', data => append('stderr', data))
      child.once('error', reject)
      child.once('close', code => resolve({ code, stdout, stderr, truncated }))
    })
    await SandboxManager.reset()
    process.send?.({ result }, () => process.exit(0))
  } catch {
    await SandboxManager.reset().catch(() => undefined)
    process.send?.({ error: true }, () => process.exit(1))
  }
})
