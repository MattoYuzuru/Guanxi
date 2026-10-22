/**
 * Committed owner approval public keys (`packages/ui/catalog/approval-keys.json`). The private
 * P-256 key never enters the repository and never leaves the Secure Enclave; only the signing
 * helper can use it (D-184).
 */
import { createHash, createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { canonicalJson } from './canonical.ts'

export interface TrustedKey {
  keyId: string
  algorithm: 'p256'
  /** Base64 of the DER-encoded SubjectPublicKeyInfo. */
  publicKey: string
  addedAt: string
  note?: string
}

/** A change of the key set signed by a key from the previous (base) set. */
export interface KeySetRotation {
  signedBy: string
  signature: string
}

export interface TrustedKeyFile {
  $comment?: string
  /** Increases with every change of `keys`; rotations sign it, so an old rotation cannot be replayed. */
  version?: number
  keys: TrustedKey[]
  rotation?: KeySetRotation | null
}

export const KEY_ROTATION_SCHEMA = 'guanxi.ui-approval-keys/1'

export function keyIdForPublicKey(spkiDer: Uint8Array): string {
  return `p256:${createHash('sha256').update(spkiDer).digest('hex').slice(0, 32)}`
}

export function publicKeyObject(key: TrustedKey): KeyObject {
  return createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' })
}

export function exportPublicKey(publicKey: KeyObject): { keyId: string; publicKey: string } {
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return { keyId: keyIdForPublicKey(der), publicKey: der.toString('base64') }
}

/** Bytes a rotation signature covers: the new version and the canonical key list. */
export function keySetSigningBytes(keys: readonly TrustedKey[], version: number): Buffer {
  return Buffer.from(canonicalJson({ schema: KEY_ROTATION_SCHEMA, version, keys }), 'utf8')
}

export type TrustedKeysResult = { ok: true; file: TrustedKeyFile } | { ok: false; errors: string[] }

export function parseTrustedKeys(value: unknown): TrustedKeysResult {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['trusted keys file is not an object'] }
  }
  const file = value as Record<string, unknown>
  for (const key of Object.keys(file)) {
    if (!['$comment', 'version', 'keys', 'rotation'].includes(key)) errors.push(`unknown field "${key}"`)
  }
  if (!Array.isArray(file['keys'])) return { ok: false, errors: [...errors, 'keys is not an array'] }
  if (file['version'] !== undefined && (!Number.isInteger(file['version']) || (file['version'] as number) < 0)) {
    errors.push('version must be a non-negative integer')
  }
  const seen = new Set<string>()
  for (const [index, entry] of (file['keys'] as unknown[]).entries()) {
    const key = entry as Partial<TrustedKey>
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`keys[${index}] is not an object`)
      continue
    }
    if (key.algorithm !== 'p256') errors.push(`keys[${index}].algorithm must be p256`)
    if (typeof key.addedAt !== 'string') errors.push(`keys[${index}].addedAt is missing`)
    try {
      const object = publicKeyObject(key as TrustedKey)
      if (object.asymmetricKeyType !== 'ec' || object.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        errors.push(`keys[${index}] is not a P-256 key`)
      }
      const { keyId } = exportPublicKey(object)
      if (key.keyId !== keyId) errors.push(`keys[${index}].keyId does not match its public key (${keyId})`)
    } catch {
      errors.push(`keys[${index}].publicKey is not a DER SubjectPublicKeyInfo in base64`)
    }
    if (typeof key.keyId === 'string') {
      if (seen.has(key.keyId)) errors.push(`keys[${index}].keyId is duplicated`)
      seen.add(key.keyId)
    }
  }
  const rotation = file['rotation']
  if (rotation !== undefined && rotation !== null) {
    const r = rotation as Partial<KeySetRotation>
    if (typeof r.signedBy !== 'string' || typeof r.signature !== 'string') {
      errors.push('rotation must be null or { signedBy, signature }')
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, file: value as TrustedKeyFile }
}

export function loadTrustedKeys(path: string): TrustedKeysResult {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, errors: [`cannot read ${path}: ${(error as Error).message}`] }
  }
  return parseTrustedKeys(json)
}
