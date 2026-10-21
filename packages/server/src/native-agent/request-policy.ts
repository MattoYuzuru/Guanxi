import type { SandboxPolicy } from './sandbox-protocol.ts'

/** Reserve node ports on every address, avoiding a check/use DNS rebinding gap. */
export async function isNodeRequest(url: URL, ports: number[]): Promise<boolean> {
  return ports.includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
}
export async function filterNativeRequest(request: Request, policy: SandboxPolicy, authorizeEgress: (request: Request) => Promise<boolean> = async () => false): Promise<{ action: 'allow' | 'deny' }> {
  if (await isNodeRequest(new URL(request.url), policy.nodePorts ?? [])) return { action: 'deny' }
  if (policy.mode !== 'full-access' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return { action: 'deny' }
  return { action: await authorizeEgress(request) ? 'allow' : 'deny' }
}
