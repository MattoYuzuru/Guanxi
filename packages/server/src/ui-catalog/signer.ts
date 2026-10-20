/**
 * Owner approval signing (D-138). The private Ed25519 key lives in the owner's macOS keychain
 * as a generic password whose access list trusts no application, so every read shows a macOS
 * prompt the owner must allow. The node reads it only to sign one approval and never caches,
 * logs or returns it. Tests use a throwaway key from a temp directory, never the keychain.
 */
import { execFile } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto'
import { exportPublicKey } from '@guanxi/ui/approval'

export const KEYCHAIN_SERVICE = 'guanxi.ui-approval'
export const KEYCHAIN_ACCOUNT = 'owner-approval-key'

export type SignerUnavailableReason = 'platform_unsupported' | 'signing_key_missing'

export type SignerStatus =
  | { state: 'available'; keyId: string }
  | { state: 'unavailable'; reason: SignerUnavailableReason }

export interface ApprovalSigner {
  /** Reads only key metadata; never touches the secret and never prompts. */
  status(): Promise<SignerStatus>
  /** Signs bytes with the owner key; may show a keychain prompt. */
  sign(bytes: Buffer): Promise<{ signature: string; keyId: string }>
}

export type SignerErrorReason =
  | 'signing_key_missing'
  | 'signing_denied'
  | 'signing_timeout'
  | 'signing_key_invalid'
  | 'platform_unsupported'

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
  const { keyId } = exportPublicKey(createPublicKey(privateKey))
  return {
    status: async () => ({ state: 'available', keyId }),
    sign: async (bytes) => ({ signature: sign(null, bytes, privateKey).toString('base64'), keyId }),
  }
}

interface ExecResult {
  code: number
  stdout: string
  timedOut: boolean
}

function run(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
        reject(error)
        return
      }
      const code = error ? ((error as { code?: number }).code ?? 1) : 0
      resolve({ code, stdout: String(stdout), timedOut: Boolean(error && (error as { killed?: boolean }).killed) })
    })
  })
}

export interface KeychainSignerOptions {
  /** Path of the macOS `security` tool; tests point it at a fake. */
  securityPath?: string
  /** A specific keychain file; omitted means the user's default search list. */
  keychain?: string
  service?: string
  account?: string
  platform?: NodeJS.Platform
  /** How long the owner has to answer the keychain prompt. */
  promptTimeoutMs?: number
}

/** `security find-generic-password` exit status for "item not found". */
const ITEM_NOT_FOUND = 44

export function keychainSigner(options: KeychainSignerOptions = {}): ApprovalSigner {
  const security = options.securityPath ?? '/usr/bin/security'
  const service = options.service ?? KEYCHAIN_SERVICE
  const account = options.account ?? KEYCHAIN_ACCOUNT
  const platform = options.platform ?? process.platform
  const keychainArgs = options.keychain ? [options.keychain] : []
  const lookup = ['find-generic-password', '-s', service, '-a', account]

  return {
    async status() {
      if (platform !== 'darwin') return { state: 'unavailable', reason: 'platform_unsupported' }
      const result = await run(security, [...lookup, ...keychainArgs], 10_000)
      if (result.code === ITEM_NOT_FOUND) return { state: 'unavailable', reason: 'signing_key_missing' }
      if (result.code !== 0) return { state: 'unavailable', reason: 'signing_key_missing' }
      // The key id is stored in the item's comment ("icmt"); it is public, the secret is not.
      const match = /"icmt"<blob>="(ed25519:[0-9a-f]{32})"/.exec(result.stdout)
      if (!match?.[1]) return { state: 'unavailable', reason: 'signing_key_missing' }
      return { state: 'available', keyId: match[1] }
    },

    async sign(bytes) {
      if (platform !== 'darwin') throw new SignerError('platform_unsupported', 'Keychain signing needs macOS')
      const result = await run(security, [...lookup, '-w', ...keychainArgs], options.promptTimeoutMs ?? 120_000)
      if (result.code === ITEM_NOT_FOUND) throw new SignerError('signing_key_missing', 'No approval key in the keychain')
      if (result.timedOut) throw new SignerError('signing_timeout', 'Nobody answered the keychain prompt in time')
      if (result.code !== 0) throw new SignerError('signing_denied', 'The keychain did not release the approval key')
      // The secret also lives in `result.stdout` until it is collected; the buffer is cleared
      // so it is not kept longer than this call, which is the most Node allows.
      const der = Buffer.from(result.stdout.trim(), 'base64')
      let privateKey: KeyObject
      try {
        privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      } catch {
        throw new SignerError('signing_key_invalid', 'The keychain item is not a PKCS#8 Ed25519 key')
      } finally {
        der.fill(0)
      }
      if (privateKey.asymmetricKeyType !== 'ed25519') {
        throw new SignerError('signing_key_invalid', 'The keychain key is not Ed25519')
      }
      const { keyId } = exportPublicKey(createPublicKey(privateKey))
      return { signature: sign(null, bytes, privateKey).toString('base64'), keyId }
    },
  }
}
