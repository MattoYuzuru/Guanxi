import { lookup } from 'node:dns/promises'
import { isIP, BlockList } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { ConnectionError } from './errors.ts'

export type EndpointResolver = (hostname: string) => Promise<{ address: string; family: number }[]>
const linkLocal = new BlockList()
linkLocal.addSubnet('169.254.0.0', 16, 'ipv4'); linkLocal.addSubnet('fe80::', 10, 'ipv6')
const privateNet = new BlockList()
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['0.0.0.0', 8]] as const) privateNet.addSubnet(address, prefix, 'ipv4')
privateNet.addSubnet('fc00::', 7, 'ipv6'); privateNet.addAddress('::1', 'ipv6'); privateNet.addAddress('::', 'ipv6')
const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4'); loopback.addAddress('::1', 'ipv6')
/** Resolve once, validate every answer and bind the actual socket lookup to the selected IP.
 * URL/Host/TLS servername remain the original authority. No redirect or environment proxy. */
export async function endpointFetch(url: string, init: RequestInit, allowPrivate: boolean,
  // undici's own fetch: Node 22's bundled fetch (undici 6) refuses an Agent from the undici package (UND_ERR_INVALID_ARG).
  transport: typeof fetch = undiciFetch as unknown as typeof fetch,
  resolve: EndpointResolver = hostname => lookup(hostname, { all: true })) {
  const target = new URL(url)
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host)
  init.signal?.throwIfAborted()
  const denied = () => { throw new ConnectionError('policy_denied', 'Provider endpoint network policy denied') }
  if (!addresses.length || target.username || target.password || target.search || target.hash || !['http:', 'https:'].includes(target.protocol)) denied()
  for (const { address, family } of addresses) {
    if (!isIP(address) || isIP(address) !== family) denied()
    const type = family === 6 ? 'ipv6' : 'ipv4'
    // BlockList also recognizes IPv4-mapped IPv6 forms.
    if (linkLocal.check(address, type) || !allowPrivate && privateNet.check(address, type)) denied()
    if (target.protocol === 'http:' && !(loopback.check(address, type) || allowPrivate && privateNet.check(address, type))) denied()
  }
  const pinned = addresses[0]!
  const agent = new Agent({ connect: { lookup: (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }])
    else callback(null, pinned.address, pinned.family)
  } } })
  try {
    return await transport(url, { ...init, redirect: 'error', dispatcher: agent } as unknown as RequestInit)
  } finally {
    // close drains an in-flight response; it does not interrupt streaming consumers.
    void agent.close().catch(() => agent.destroy())
  }
}
