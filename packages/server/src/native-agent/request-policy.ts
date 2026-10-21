import { isIP } from 'node:net'
import type { SandboxPolicy } from './sandbox-protocol.ts'

/** Reserve node ports on every address, avoiding a check/use DNS rebinding gap. */
export async function isNodeRequest(url: URL, ports: number[]): Promise<boolean> {
  return ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
}
export async function filterNativeRequest(request: Request, policy: SandboxPolicy, authorizeEgress: (request: Request) => Promise<boolean> = async () => false): Promise<{ action: 'allow' | 'deny' }> {
  const url = new URL(request.url)
  if (await isNodeRequest(url, policy.nodePorts ?? [])) return { action: 'deny' }
  // Recheck literals here: the upstream resolved-address guard skips IP hosts.
  // Also fail closed for old/internal policies with a port-less service entry.
  const serviceHost = isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
  if (serviceHost && !policy.domains.some(entry => {
    const match = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\]):([0-9]{1,5})$/.exec(entry)
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return false
    try { return new URL(`http://${entry}`).hostname === url.hostname && Number(match[1]) === Number(url.port || (url.protocol === 'https:' ? 443 : 80)) }
    catch { return false }
  })) return { action: 'deny' }
  if (policy.mode !== 'full-access' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return { action: 'deny' }
  return { action: await authorizeEgress(request) ? 'allow' : 'deny' }
}
