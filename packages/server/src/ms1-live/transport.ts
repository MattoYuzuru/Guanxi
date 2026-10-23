import { loopbackBase, Ms1LiveError } from './config.ts'

const ROUTE_PREFIX = '/api/federation/'

/** The transport of a `FederationChannel` between two nodes whose only link is an operator-made SSH port forward.
 *
 * The channel hands over a logical URL; this maps its path to the one configured loopback origin and to nothing else. It
 * follows no redirect and has a deadline. Every request is already signed and bound to the peer's key by the channel, so
 * the forward is a pipe, not a trust anchor: but F1 requires a private authenticated link, and `ssh -L/-R` is that link.
 * The peer's Host allowlist names its own listening port, so the forwarded port must equal it (see the runbook). */
export function loopbackTransport(options: { base: string; timeoutMs: number; fetch?: typeof fetch }): (request: Request) => Promise<Response> {
  const base = loopbackBase(options.base, 'peer.url')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Ms1LiveError('timeout_invalid', 'link.requestTimeoutMs')
  const transport = options.fetch ?? globalThis.fetch
  return async request => {
    const url = new URL(request.url)
    // A logical URL for anything but the federation API is a bug in the caller, never a request to forward.
    if (!url.pathname.startsWith(ROUTE_PREFIX)) throw new Ms1LiveError('route_not_federation')
    return transport(base + url.pathname + url.search, {
      method: request.method, headers: request.headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.text() }),
      redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs),
    })
  }
}
