/** Trusted launcher only. This file is a separate build entry, never a tool. */
import { realpathSync, accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { SandboxManager, getDefaultWritePaths, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { filterNativeRequest } from './request-policy.ts'
import { linuxBindingFilter, type SandboxPolicy } from './sandbox-protocol.ts'
import { LinuxExecutionOwner, FixedExecutionOwner, ContainerExecutionOwner, type ExecutionOwner } from './execution-owner.ts'

let owner: ExecutionOwner | undefined
let stopped = false
process.on('message', (message: { stop?: boolean }) => { if (message.stop) { stopped = true; void owner?.stop().catch(() => undefined) } })
process.once('disconnect', () => { stopped = true; void owner?.stop().catch(() => undefined).finally(() => process.exit(1)) })
process.once('message', async ({ policy, command, fixed, dockerEndpoint, ownerName, directory, dockerPath }: { policy: SandboxPolicy; command: string; fixed: boolean; dockerEndpoint: string; ownerName: string; directory: string; dockerPath: string }) => {
  try {
    // Windows requires machine-wide provisioning; refuse until Guanxi validates that profile.
    if (!['darwin', 'linux'].includes(process.platform) || !SandboxManager.isSupportedPlatform()) throw new Error('unsupported_sandbox')
    const literal = (path: string) => ({ path, literal: true as const })
    const system = process.platform === 'darwin'
      ? ['/bin', '/usr', '/System', '/Library/Apple', '/private/etc', '/private/var/select', '/dev', '/opt/homebrew/Cellar', '/opt/homebrew/opt']
      : ['/bin', '/usr', '/lib', '/lib64', '/etc', '/dev', '/proc/self']
    const read = [...system, dirname(realpathSync(process.execPath)), policy.scratch, ...policy.roots, ...policy.attachments]
    const installedRuntime = fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))
    const modules = installedRuntime.split('/node_modules/')[0] + '/node_modules'
    const trustedDeny = [modules, dirname(realpathSync(process.execPath))]
    if (process.platform === 'darwin') trustedDeny.push(...system.filter(path => path !== '/dev'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/sbin', '/sbin')
    const seccomp = join(dirname(installedRuntime), '..', 'vendor', 'seccomp', process.arch, 'apply-seccomp')
    if (process.platform === 'linux') { accessSync(seccomp, constants.X_OK); read.push(seccomp) }
    const bindingFilter = join(directory ?? policy.scratch, 'network-bind.bpf')
    if (process.platform === 'linux') {
      if (!execFileSync('/usr/bin/setpriv', ['--help'], { encoding: 'utf8' }).includes('--seccomp-filter')) throw new Error('supervision_unavailable')
      await writeFile(bindingFilter, linuxBindingFilter(process.arch), { mode: 0o400, flag: 'wx' }); read.push(bindingFilter)
    }
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: policy.domains, deniedDomains: [], strictAllowlist: true,
        allowUnixSockets: [], allowLocalBinding: false, allowAllUnixSockets: false,
        // The HTTP parser observes HTTPS too. No raw CONNECT or SOCKS escape.
        tlsTerminate: {}, refuseOpaqueTunnels: true, requireHostMatch: true,
        filterRequest: request => filterNativeRequest(request, policy),
      },
      filesystem: { denyRead: ['/', ...(policy.hiddenPaths ?? [])].map(literal), allowRead: read.map(literal),
        allowWrite: [policy.scratch, ...(policy.mode === 'full-access' ? policy.roots : [])].map(literal),
        // Cancel upstream convenience grants. Stdio devices are the only exceptions.
        denyWrite: [...getDefaultWritePaths().filter(path => !path.startsWith('/dev/')), ...system.filter(path => !['/dev', '/proc/self'].includes(path)), ...trustedDeny, ...policy.roots.map(root => `${root}/node_modules`), ...policy.protectedPaths, ...policy.attachments].map(literal),
      },
      allowPty: false, enableWeakerNetworkIsolation: false, enableWeakerNestedSandbox: false,
      ...(process.platform === 'linux' ? { seccomp: { applyPath: seccomp } } : {}),
    }
    const dependencies = await SandboxManager.checkDependenciesAsync()
    if (dependencies.errors.length || dependencies.warnings.length) throw new Error('sandbox_dependencies')
    await SandboxManager.initialize(config, undefined, false)
    if (!SandboxManager.isSandboxingEnabled()) throw new Error('sandbox_unavailable')
    if (process.platform === 'linux') {
      await SandboxManager.waitForNetworkInitialization()
      const networkReads = [SandboxManager.getLinuxHttpSocketPath(), SandboxManager.getLinuxSocksSocketPath(), SandboxManager.getMitmCA()?.trustBundlePath].filter((path): path is string => !!path)
      SandboxManager.updateConfig({ ...config, filesystem: { ...config.filesystem, allowRead: [...read, ...networkReads].map(literal) } })
    }
    const quotePath = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    owner = process.platform === 'linux' ? new LinuxExecutionOwner(bindingFilter) : fixed ? new FixedExecutionOwner() : new ContainerExecutionOwner({ ...policy, protectedPaths: [...policy.protectedPaths, ...trustedDeny] }, dockerEndpoint, ownerName, directory, dockerPath)
    if (stopped) throw new Error('sandbox_failed')
    const result = await owner.execute(`export HOME=${quotePath(policy.scratch)} TMPDIR=${quotePath(policy.scratch)}; ${command}`)
    await SandboxManager.reset()
    process.send?.({ result }, () => process.exit(0))
  } catch (error) {
    await owner?.stop().catch(() => undefined)
    await SandboxManager.reset().catch(() => undefined)
    process.send?.({ error: error instanceof Error && ['container_runtime_unavailable', 'container_path_unsupported', 'supervision_unavailable', 'cleanup_unconfirmed'].includes(error.message) ? error.message : 'sandbox_failed' }, () => process.exit(1))
  }
})
