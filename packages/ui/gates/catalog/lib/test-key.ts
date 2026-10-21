/**
 * Throwaway P-256 keys for tests and seeded violations: generated into a fresh temp
 * directory and read back from there. Never the owner keychain, never the Secure Enclave.
 *
 * `sign()` uses ECDSA over SHA-256 in IEEE P1363 form (the 64-byte r‖s signature approvals
 * carry), exactly like the production verifier expects.
 */
import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportPublicKey, type TrustedKey } from '../../../catalog/approval/index.ts'

export interface TestKey {
  privateKey: KeyObject
  trusted: TrustedKey
  dir: string
  /** The raw 32-byte private scalar, the representation the Swift test build loads. */
  rawPath: string
  dispose(): void
  sign(bytes: Buffer): string
}

export function p256TestKey(note = 'throwaway test key'): TestKey {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-approval-test-key-'))
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const path = join(dir, 'approval-test-key.pem')
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const rawPath = join(dir, 'approval-test-key.raw')
  const jwk = privateKey.export({ format: 'jwk' })
  if (typeof jwk.d !== 'string') throw new Error('P-256 private key has no raw scalar')
  writeFileSync(rawPath, Buffer.from(jwk.d, 'base64url'), { mode: 0o600 })
  const loaded = createPrivateKey(readFileSync(path, 'utf8'))
  const { keyId, publicKey: der } = exportPublicKey(publicKey)
  return {
    privateKey: loaded,
    trusted: { keyId, algorithm: 'p256', publicKey: der, addedAt: '2026-10-20T00:00:00.000Z', note },
    dir,
    rawPath,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
    sign: (bytes) => sign('sha256', bytes, { key: loaded, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  }
}
