import { lookup } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import type { SandboxPolicy } from './sandbox-protocol.ts'

const addressKey = (address: string) => address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
/** The domain allowlist never authorizes the node's control-plane listeners. */
export async function isNodeRequest(url: URL, ports: number[]): Promise<boolean> {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!ports.includes(port)) return false
  const host = addressKey(url.hostname)
  const local = new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => addressKey(entry.address))))
  const isLocal = (address: string) => address === '::1' || address.startsWith('127.') || address === '0.0.0.0' || address === '::' || local.has(address)
  if (host === 'localhost' || host.endsWith('.localhost') || isLocal(host)) return true
  try { return (await lookup(host, { all: true })).some(entry => isLocal(addressKey(entry.address))) }
  catch { return true } // No destination evidence: fail closed on a node port.
}
export async function filterNativeRequest(request: Request, policy: SandboxPolicy, authorizeEgress: (request: Request) => Promise<boolean> = async () => false): Promise<{ action: 'allow' | 'deny' }> {
  if (await isNodeRequest(new URL(request.url), policy.nodePorts ?? [])) return { action: 'deny' }
  if (policy.mode !== 'full-access' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return { action: 'deny' }
  return { action: await authorizeEgress(request) ? 'allow' : 'deny' }
}
