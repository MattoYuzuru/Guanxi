/**
 * Owner approval signing through the installed Secure Enclave helper (D-184). The private
 * P-256 key never reaches this process: the helper returns only its id, its public key and a
 * signature, after the owner passes Touch ID or the password. The node never invokes a shell and
 * caps both the helper's output and the time the owner has to answer.
 */
import { execFile } from 'node:child_process'
import { createPublicKey, sign, type KeyObject } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract'
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, exportPublicKey } from '@guanxi/ui/approval'

export { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE }
export const INSTALL_COMMAND = 'node packages/server/scripts/install-approval-signer.ts'

/** Where the installer puts the helper, under the owner's home directory. */
export function approvalSignerPath(home = homedir()): string {
  return join(
    home,
    'Library',
    'Application Support',
    PRODUCT_NAME,
    'approval-signer',
    `${PRODUCT_FILE_PREFIX}-approval-signer`,
  )
}

export type SignerUnavailableReason = 'platform_unsupported' | 'signing_key_missing' | 'signer_helper_missing'

export type SignerStatus =
  | { state: 'available'; keyId: string; publicKey: string }
  | { state: 'unavailable'; reason: SignerUnavailableReason }

export interface ApprovalSigner {
  /** Reads only key metadata through the helper; never touches the secret and never prompts. */
  status(): Promise<SignerStatus>
  /** Signs bytes with the owner key; the helper asks for the owner's presence. */
  sign(bytes: Buffer): Promise<{ signature: string; keyId: string }>
}

export type SignerErrorReason =
  | 'signing_key_missing'
  | 'signing_denied'
  | 'signing_timeout'
  | 'signing_key_invalid'
  | 'platform_unsupported'
  | 'signer_helper_missing'
  | 'payload_not_canonical'
  | 'payload_schema'

export class SignerError extends Error {
  readonly reason: SignerErrorReason

  constructor(reason: SignerErrorReason, message: string) {
    super(message)
    this.name = 'SignerError'
    this.reason = reason
  }
}

export function unavailableSigner(reason: SignerUnavailableReason): ApprovalSigner {
  return {
    status: async () => ({ state: 'unavailable', reason }),
    sign: async () => {
      throw new SignerError(reason, 'No approval signer on this node')
    },
  }
}

/** Test and tooling signer over an in-memory key. Production never constructs it. */
export function keyObjectSigner(privateKey: KeyObject): ApprovalSigner {
  const { keyId, publicKey } = exportPublicKey(createPublicKey(privateKey))
  return {
    status: async () => ({ state: 'available', keyId, publicKey }),
    sign: async (bytes) => ({
      signature: sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
      keyId,
    }),
  }
}

export interface HelperSignerOptions {
  helperPath: string
  service?: string
  account?: string
  /** How long the owner has to answer the helper's prompt. */
  timeoutMs?: number
  /** The command shown when the helper is not installed. */
  installCommand?: string
  /** Test seam: the helper reads its test key and fake authenticator from the environment. */
  env?: NodeJS.ProcessEnv
  /** Test seam: simulates the host platform so the unsupported guard runs on macOS too. */
  platform?: NodeJS.Platform
}

interface HelperResponse {
  ok?: unknown
  state?: unknown
  keyId?: unknown
  publicKey?: unknown
  signature?: unknown
  code?: unknown
  message?: unknown
}

function parseResponse(stdout: string): HelperResponse | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as HelperResponse) : null
  } catch {
    return null
  }
}

function mappedReason(code: string): SignerErrorReason {
  switch (code) {
    case 'signer_helper_missing':
      return 'signer_helper_missing'
    case 'signing_key_missing':
      return 'signing_key_missing'
    case 'signing_denied':
      return 'signing_denied'
    case 'platform_unsupported':
      return 'platform_unsupported'
    case 'payload_not_canonical':
      return 'payload_not_canonical'
    case 'payload_schema':
    case 'payload_id':
      return 'payload_schema'
    default:
      return 'signing_key_invalid'
  }
}

function helperError(response: HelperResponse): SignerError {
  const code = typeof response.code === 'string' ? response.code : 'unknown'
  const message = typeof response.message === 'string' ? response.message : `The approval signer helper refused the request (${code})`
  return new SignerError(mappedReason(code), message)
}

function invoke(
  options: Required<Pick<HelperSignerOptions, 'helperPath' | 'timeoutMs' | 'installCommand'>> & {
    request: Record<string, unknown>
    env?: NodeJS.ProcessEnv
  },
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.helperPath,
      [],
      { timeout: options.timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8', env: options.env },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
            reject(new SignerError('signer_helper_missing', `The approval signer helper is not installed. Run: ${options.installCommand}`))
            return
          }
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new SignerError('signing_key_invalid', 'The approval signer helper wrote more than 64 KiB'))
            return
          }
          if ((error as { killed?: boolean }).killed) {
            reject(new SignerError('signing_timeout', 'Nobody answered the approval prompt in time'))
            return
          }
          const response = parseResponse(stdout)
          if (response && response.ok === false) {
            reject(helperError(response))
            return
          }
          reject(new SignerError('signing_key_invalid', `The approval signer helper failed (${stderr.trim() || error.message})`))
          return
        }
        const response = parseResponse(stdout)
        if (!response || typeof response.ok !== 'boolean') {
          reject(new SignerError('signing_key_invalid', 'The approval signer helper returned no JSON object'))
          return
        }
        if (response.ok === false) {
          reject(helperError(response))
          return
        }
        resolve(response)
      },
    )
    // The helper may exit before reading its request (for example a missing binary or an early
    // refusal); an EPIPE here must not become an unhandled stream error.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(options.request))
  })
}

export function helperSigner(options: HelperSignerOptions): ApprovalSigner {
  const service = options.service ?? KEYCHAIN_SERVICE
  const account = options.account ?? KEYCHAIN_ACCOUNT
  const timeoutMs = options.timeoutMs ?? 120_000
  const installCommand = options.installCommand ?? INSTALL_COMMAND
  const platform = options.platform ?? process.platform
  const request = (body: Record<string, unknown>) =>
    invoke({ helperPath: options.helperPath, timeoutMs, installCommand, request: body, env: options.env })

  return {
    async status() {
      // The helper is a macOS Secure Enclave binary; another host must report the platform
      // boundary instead of trying to execute it and calling a missing file an install problem.
      if (platform !== 'darwin') return { state: 'unavailable', reason: 'platform_unsupported' }
      try {
        const response = await request({ op: 'status', service, account })
        if (response.state === 'missing') return { state: 'unavailable', reason: 'signing_key_missing' }
        if (response.state !== 'available' || typeof response.keyId !== 'string' || typeof response.publicKey !== 'string') {
          throw new SignerError('signing_key_invalid', 'The approval signer helper returned no usable key metadata')
        }
        return { state: 'available', keyId: response.keyId, publicKey: response.publicKey }
      } catch (error) {
        if (error instanceof SignerError) {
          if (error.reason === 'signer_helper_missing') return { state: 'unavailable', reason: 'signer_helper_missing' }
          if (error.reason === 'signing_key_missing') return { state: 'unavailable', reason: 'signing_key_missing' }
          if (error.reason === 'platform_unsupported') return { state: 'unavailable', reason: 'platform_unsupported' }
        }
        throw error
      }
    },

    async sign(bytes) {
      // Refuse before the helper is invoked: on another host this is a platform boundary,
      // not a missing installation or a failed authentication.
      if (platform !== 'darwin') throw new SignerError('platform_unsupported', 'Approval signing needs macOS with a Secure Enclave')
      const response = await request({ op: 'sign', service, account, payload: bytes.toString('utf8') })
      if (typeof response.keyId !== 'string' || typeof response.signature !== 'string') {
        throw new SignerError('signing_key_invalid', 'The approval signer helper returned no signature')
      }
      // Return a fresh object: nothing else from the helper response leaves this function.
      return { keyId: response.keyId, signature: response.signature }
    },
  }
}
