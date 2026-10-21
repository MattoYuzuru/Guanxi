import { createHash, randomBytes } from 'node:crypto'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'

/** Test doubles implement this boundary without ever opening the owner's keychain. */
export interface VaultKeychain { key(accountId: string, create: boolean, purpose: 'session' | 'node'): Buffer }

/** The node key must never share the interactive wrapping-key namespace. */
export function keychainService(databasePath: string, purpose: 'session' | 'node'): string {
  const namespace = createHash('sha256').update(databasePath).digest('hex')
  return `${PRODUCT_FILE_PREFIX}.vault.${namespace}${purpose === 'node' ? '.node' : ''}`
}

/** Existing secrets require registration-only keychain access at apply; empty vaults stay lazy. */
export async function osKeychain(databasePath: string): Promise<VaultKeychain> {
  if (process.platform === 'linux') {
    // keyring's prebuilt Linux artifact statically links libdbus (AFL/GPL),
    // outside ADR-0016. Do not load or ship it as an approved backend.
    throw new Error('An approved OS keychain backend is required on Linux')
  }
  const keyringPackage = '@napi-rs/keyring'
  const { Entry } = await import(keyringPackage) as typeof import('@napi-rs/keyring')
  return {
    key(accountId, create, purpose) {
      const entry = new Entry(keychainService(databasePath, purpose), accountId)
      let encoded = entry.getPassword()
      if (!encoded && create) {
        encoded = randomBytes(32).toString('base64')
        entry.setPassword(encoded)
      }
      if (!encoded) throw new Error('Vault wrapping key unavailable')
      const key = Buffer.from(encoded, 'base64')
      if (key.length !== 32) throw new Error('Invalid vault wrapping key')
      return key
    },
  }
}
