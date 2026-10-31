/**
 * Boot-time admission of the remote security profile (ADR-0027 decision 7).
 *
 * `admitBind()` joins the start options to the pure `assertBindAllowed()` guard and loads the TLS
 * material. `start()` calls it before any file, database or listener exists, so a refused bind
 * leaves nothing behind. The entry points turn a refusal into one message and one exit code.
 */
import { readFileSync } from 'node:fs'
import type { AccountsAdapter } from './route-authz.ts'
import { RemoteBindError, assertBindAllowed, type RemoteBindRequirement } from './remote-guard.ts'

/** Exit code of a refused remote bind (`EX_CONFIG`, sysexits.h). */
export const REMOTE_BIND_EXIT_CODE = 78

/** The remote security profile as the host supplies it to `start()`. */
export interface RemoteProfileOptions {
  /** One canonical hostname (own domain or `*.ts.net`); WebAuthn forbids IP addresses. */
  tls: { certPath: string; keyPath: string; hostname: string }
  /** Absolute, unique, non-nested roots this node may serve. */
  allowedRoots: string[]
  /** Principal, resource and grant source. Its presence is what "accounts enabled" means. */
  accounts: AccountsAdapter
}

/** Loaded TLS material and its canonical hostname. */
export interface AdmittedTls {
  cert: Buffer
  key: Buffer
  hostname: string
}

/**
 * Throws `RemoteBindError` unless the bind is loopback or the profile is complete, and unless a
 * supplied TLS pair is readable. Returns the TLS material when a profile was supplied.
 * The node credential is the federation identity and private key of the start options.
 */
export function admitBind(
  host: string,
  remote: RemoteProfileOptions | undefined,
  nodeCredentialConfigured: boolean,
  platform: NodeJS.Platform = process.platform,
): AdmittedTls | null {
  let missing: RemoteBindRequirement[] = []
  try {
    assertBindAllowed({
      host,
      tls: remote ? { ...remote.tls } : null,
      accountsEnabled: typeof remote?.accounts?.principal === 'function',
      allowedRoots: remote ? [...remote.allowedRoots] : [],
      nodeCredentialConfigured,
    }, platform)
  } catch (error) {
    if (!(error instanceof RemoteBindError)) throw error
    missing = [...error.missing]
  }

  let tls: AdmittedTls | null = null
  if (remote && !missing.includes('tls_required')) {
    try {
      tls = {
        cert: readFileSync(remote.tls.certPath),
        key: readFileSync(remote.tls.keyPath),
        hostname: remote.tls.hostname.trim().toLowerCase(),
      }
    } catch {
      missing.push('tls_files_unreadable')
    }
  }
  if (missing.length > 0) throw new RemoteBindError(host, missing)
  return tls
}

/** The one line printed on a refused remote bind. It names codes only, never paths or secrets. */
export function remoteBindRefusalMessage(error: RemoteBindError): string {
  return `guanxi: refusing to listen on ${error.host}: the remote security profile is incomplete ` +
    `(${error.missing.join(', ')}). Listen on 127.0.0.1, or supply TLS, accounts, allowed roots and a node credential.`
}
