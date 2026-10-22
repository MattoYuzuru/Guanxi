/**
 * Remote-bind admission for the remote security profile (ADR-0027 decision 7).
 *
 * This module is pure: it does not start a listener and is intentionally not imported by the
 * server boot yet. Loopback stays the default; any other bind must satisfy every requirement.
 */
import { isIP } from 'node:net'
import { isAbsolute, resolve } from 'node:path'

export interface RemoteBindConfig {
  host: string
  tls: { certPath: string; keyPath: string; hostname: string } | null
  accountsEnabled: boolean
  allowedRoots: string[]
  nodeCredentialConfigured: boolean
}

/** Stable codes for each unmet part of the remote security profile. */
export type RemoteBindRequirement =
  | 'tls_required'
  | 'tls_hostname_required'
  | 'tls_hostname_ip_forbidden'
  | 'accounts_required'
  | 'allowed_roots_required'
  | 'allowed_roots_must_be_absolute'
  | 'allowed_roots_duplicate'
  | 'node_credential_required'

/** A refused remote bind that lists every unmet requirement. */
export class RemoteBindError extends Error {
  readonly code = 'remote_bind_forbidden'
  readonly host: string
  readonly missing: RemoteBindRequirement[]

  constructor(host: string, missing: RemoteBindRequirement[]) {
    super(`Remote bind to ${host} refused; missing: ${missing.join(', ')}`)
    this.name = 'RemoteBindError'
    this.host = host
    this.missing = [...missing]
  }
}

function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** `127.0.0.0/8`, `::1` and `localhost` are loopback and always admitted. */
function isLoopbackHost(host: string): boolean {
  const candidate = host.toLowerCase()
  // Brackets are valid only for IPv6; do not let `[localhost]` or `[127.0.0.1]` through.
  if (candidate === 'localhost' || candidate === '::1' || candidate === '[::1]') return true
  return isIP(candidate) === 4 && candidate.split('.')[0] === '127'
}

/**
 * Throw a `RemoteBindError` unless the bind is loopback or the full remote security profile is
 * present: usable TLS with a non-IP hostname, accounts, absolute unique allowed roots and a node
 * credential. Every unmet requirement is reported, not only the first.
 */
export function assertBindAllowed(config: RemoteBindConfig): void {
  if (isLoopbackHost(config.host)) return

  const missing: RemoteBindRequirement[] = []

  if (config.tls === null) {
    missing.push('tls_required')
  } else {
    if (config.tls.certPath.trim() === '' || config.tls.keyPath.trim() === '') missing.push('tls_required')
    const hostname = unbracket(config.tls.hostname.trim()).toLowerCase()
    if (hostname === '') missing.push('tls_hostname_required')
    else if (isIP(hostname) !== 0) missing.push('tls_hostname_ip_forbidden') // WebAuthn forbids IPs
  }

  if (!config.accountsEnabled) missing.push('accounts_required')

  if (config.allowedRoots.length === 0) {
    missing.push('allowed_roots_required')
  } else {
    if (config.allowedRoots.some(root => root.length === 0 || !isAbsolute(root))) {
      missing.push('allowed_roots_must_be_absolute')
    }
    if (new Set(config.allowedRoots.map(root => resolve(root))).size !== config.allowedRoots.length) {
      missing.push('allowed_roots_duplicate')
    }
  }

  if (!config.nodeCredentialConfigured) missing.push('node_credential_required')

  if (missing.length > 0) throw new RemoteBindError(config.host, missing)
}
