/**
 * Throwaway Ed25519 keys for tests and seeded violations: generated into a fresh temp
 * directory and read back from there. Never the owner keychain.
 */
import { generateKeyPairSync, createPrivateKey, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportPublicKey, type TrustedKey } from '../../../catalog/approval/index.ts'

export interface TestKey {
  privateKey: KeyObject
  trusted: TrustedKey
  dir: string
  dispose(): void
}

export function createTestKey(note = 'throwaway test key'): TestKey {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-approval-test-key-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const path = join(dir, 'approval-test-key.pem')
  writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const loaded = createPrivateKey(readFileSync(path, 'utf8'))
  const { keyId, publicKey: der } = exportPublicKey(publicKey)
  return {
    privateKey: loaded,
    trusted: { keyId, algorithm: 'ed25519', publicKey: der, addedAt: '2026-10-20T00:00:00.000Z', note },
    dir,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
