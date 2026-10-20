import { createHash, randomBytes } from 'node:crypto'
import { PRODUCT_FILE_PREFIX } from '@guanxi/contract'

/** Test doubles implement this boundary without ever opening the owner's keychain. */
export interface VaultKeychain { key(accountId: string, create: boolean, purpose: 'session' | 'node'): Buffer }

/** Constructed lazily: boot, list and ordinary tests never prompt the OS keychain. */
export async function osKeychain(databasePath: string): Promise<VaultKeychain> {
  if (process.platform === 'linux') {
    // keyring's prebuilt Linux artifact statically links libdbus (AFL/GPL),
    // outside ADR-0016. Do not load or ship it as an approved backend.
    throw new Error('An approved OS keychain backend is required on Linux')
  }
  const keyringPackage = '@napi-rs/keyring'
  const { Entry } = await import(keyringPackage) as typeof import('@napi-rs/keyring')
  const namespace = createHash('sha256').update(databasePath).digest('hex')
  return {
    key(accountId, create, purpose) {
      const entry = new Entry(`${PRODUCT_FILE_PREFIX}.vault.${namespace}${purpose === 'node' ? '.node' : ''}`, accountId)
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
