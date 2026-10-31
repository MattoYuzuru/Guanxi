/**
 * Remote-bind admission for the remote security profile (ADR-0027 decision 7).
 *
 * This module is pure: it does not start a listener or read files. `start()` reaches it through
 * `admitBind()` in `remote-profile.ts`. Loopback stays the default; any other bind must satisfy
 * every requirement.
 */
import { isIP } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
  | 'tls_hostname_invalid'
  | 'tls_files_unreadable'
  | 'accounts_required'
  | 'allowed_roots_required'
  | 'allowed_roots_must_be_absolute'
  | 'allowed_roots_must_not_be_root'
  | 'allowed_roots_duplicate'
  | 'allowed_roots_nested'
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

const RFC1123_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const NUMERIC_LABEL = /^[0-9]+$/u
const HEX_INTEGER_LABEL = /^0x[0-9a-f]+$/u

/**
 * A canonical TLS hostname: RFC 1123 labels, no trailing dot, a non-numeric last label, and
 * neither the single name `localhost` nor a bare integer/hex host (e.g. `2130706433`).
 */
function isCanonicalHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname === 'localhost') return false
  const labels = hostname.split('.')
  if (!labels.every(label => RFC1123_LABEL.test(label))) return false
  const last = labels[labels.length - 1]!
  return !NUMERIC_LABEL.test(last) && !HEX_INTEGER_LABEL.test(last)
}

/** True when one normalized root is an ancestor of another. Equal paths are duplicates, not nested. */
function hasNestedRoots(roots: string[]): boolean {
  return roots.some((root, rootIndex) => roots.some((other, otherIndex) => {
    if (rootIndex === otherIndex) return false
    const path = relative(other, root)
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  }))
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
 * present: usable TLS with a canonical hostname, accounts, absolute unique non-nested allowed
 * roots and a node credential. Every unmet requirement is reported, not only the first.
 * `platform` is injectable for deterministic case-insensitive filesystem tests.
 */
export function assertBindAllowed(config: RemoteBindConfig, platform: NodeJS.Platform = process.platform): void {
  if (isLoopbackHost(config.host)) return

  const missing: RemoteBindRequirement[] = []

  if (config.tls === null) {
    missing.push('tls_required')
  } else {
    if (config.tls.certPath.trim() === '' || config.tls.keyPath.trim() === '') missing.push('tls_required')
    const hostname = unbracket(config.tls.hostname.trim()).toLowerCase()
    if (hostname === '') missing.push('tls_hostname_required')
    else if (isIP(hostname) !== 0) missing.push('tls_hostname_ip_forbidden') // WebAuthn forbids IPs
    else if (!isCanonicalHostname(hostname)) missing.push('tls_hostname_invalid')
  }

  if (!config.accountsEnabled) missing.push('accounts_required')

  if (config.allowedRoots.length === 0) {
    missing.push('allowed_roots_required')
  } else {
    if (config.allowedRoots.some(root => root.length === 0 || !isAbsolute(root))) {
      missing.push('allowed_roots_must_be_absolute')
    }
    const caseInsensitive = platform === 'darwin' || platform === 'win32'
    const resolved = config.allowedRoots.map(root => {
      const path = resolve(root)
      return caseInsensitive ? path.toLowerCase() : path
    })
    if (resolved.includes(caseInsensitive ? resolve('/').toLowerCase() : resolve('/'))) {
      missing.push('allowed_roots_must_not_be_root')
    }
    if (new Set(resolved).size !== resolved.length) missing.push('allowed_roots_duplicate')
    if (hasNestedRoots(resolved)) missing.push('allowed_roots_nested')
  }

  if (!config.nodeCredentialConfigured) missing.push('node_credential_required')

  if (missing.length > 0) throw new RemoteBindError(config.host, missing)
}
