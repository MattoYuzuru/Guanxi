import { Agent, fetch as undiciFetch } from 'undici'
import { loopbackBase, Ms1LiveError } from './config.ts'

const ROUTE_PREFIX = '/api/federation/'
const SLOW = new Set(['attempts/runtime/observe', 'attempts/runtime/count', 'attempts/offers'].map(route => ROUTE_PREFIX + route))

/** The transport of a `FederationChannel` between two nodes whose only link is an operator-made SSH port forward.
 *
 * The channel hands over a logical URL; this maps its path to the one configured loopback origin and to nothing else. It
 * follows no redirect and has a deadline. Every request is already signed and bound to the peer's key by the channel, so
 * the forward is a pipe, not a trust anchor: but F1 requires a private authenticated link, and `ssh -L/-R` is that link.
 * The peer's Host allowlist names its own listening port, so the forwarded port must equal it (see the runbook). */
export function loopbackTransport(options: { base: string; timeoutMs: number; messageTimeoutMs?: number; fetch?: typeof fetch }): (request: Request) => Promise<Response> {
  const base = loopbackBase(options.base, 'peer.url')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Ms1LiveError('timeout_invalid', 'link.requestTimeoutMs')
  const messageTimeoutMs = options.messageTimeoutMs ?? options.timeoutMs
  if (!Number.isSafeInteger(messageTimeoutMs) || messageTimeoutMs <= 0) throw new Ms1LiveError('timeout_invalid', 'link.messageTimeoutMs')
  // Node's fetch stops waiting for response headers after 300 s by default, shorter than the slow routes' own deadline
  // (15 minutes): an undici Agent sized to the longest deadline, paired with undici's own fetch (Node 22 refuses a foreign Agent).
  const longest = Math.max(options.timeoutMs, messageTimeoutMs) + 5_000
  const dispatcher = options.fetch ? undefined : new Agent({ headersTimeout: longest, bodyTimeout: longest })
  const transport: typeof fetch = options.fetch ?? ((url: string | URL, init?: RequestInit) =>
    undiciFetch(url, { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch
  return async request => {
    const url = new URL(request.url)
    // A logical URL for anything but the federation API is a bug in the caller, never a request to forward.
    if (!url.pathname.startsWith(ROUTE_PREFIX)) throw new Ms1LiveError('route_not_federation')
    // Only an observation (which may hash the model file), a count (which may tokenize a whole window) and an offer (which waits
    // in the executor's governor queue for its reservation) may take minutes; every other message is short by nature.
    const slow = SLOW.has(url.pathname)
    return transport(base + url.pathname + url.search, {
      method: request.method, headers: request.headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.text() }),
      redirect: 'error', signal: AbortSignal.timeout(slow ? options.timeoutMs : messageTimeoutMs),
    })
  }
}
