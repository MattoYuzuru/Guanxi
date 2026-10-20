import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Connection } from '@guanxi/contract'
import type { EgressScrubber, SecretRef } from '../connections/egress.ts'
import type { VaultKeychain } from './keychain.ts'

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') })
}
function open(key: Buffer, ciphertext: string, aad: string): Buffer {
  const data = JSON.parse(ciphertext)
  if (data.v !== 1) throw new Error('Unsupported vault version')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data.body, 'base64')), decipher.final()])
}
export interface VaultPolicy { ownerDevice: boolean; nodeKeyOptIn: boolean }

export class Vault {
  private readonly lifetime = new AbortController()
  private closed = false
  private readonly generations = new Map<string, number>()
  private readonly sessions = new Map<string, Buffer>()
  private readonly registered = new Set<SecretRef>()
  private readonly db: DatabaseSync
  private readonly keychain: () => Promise<VaultKeychain>
  private readonly scrubber: EgressScrubber
  readonly policy: Readonly<VaultPolicy>
  constructor(db: DatabaseSync, keychain: () => Promise<VaultKeychain>,
    scrubber: EgressScrubber, policy: VaultPolicy) {
    this.db = db
    this.keychain = keychain
    this.scrubber = scrubber
    this.policy = Object.freeze({ ...policy })
  }
  private assertOpen() { if (this.closed) throw new Error('Vault closed') }
  get unattendedAvailable() { return this.policy.ownerDevice && this.policy.nodeKeyOptIn }
  unlocked(accountId: string) { return this.sessions.has(accountId) }
  private async dataKey(accountId: string): Promise<Buffer> {
    this.assertOpen()
    const row = this.db.prepare('SELECT wrapped FROM vault_keys WHERE account_id=?').get(accountId)
    const pending = this.keychain()
    const keychain = await new Promise<VaultKeychain>((resolve, reject) => {
      const abort = () => reject(new Error('Vault closed'))
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      void pending.then(resolve, reject).finally(() => this.lifetime.signal.removeEventListener('abort', abort))
    })
    this.assertOpen()
    const wrapping = keychain.key(accountId, !row)
    try {
      if (row) return open(wrapping, String(row.wrapped), `key:${accountId}`)
      const key = randomBytes(32)
      // Synchronous after await: a concurrent unlock reads the existing winner.
      const winner = this.db.prepare('SELECT wrapped FROM vault_keys WHERE account_id=?').get(accountId)
      if (winner) { key.fill(0); return open(wrapping, String(winner.wrapped), `key:${accountId}`) }
      this.db.prepare('INSERT INTO vault_keys VALUES(?,?)').run(accountId, seal(wrapping, key, `key:${accountId}`))
      return key
    } finally { wrapping.fill(0) }
  }
  private registerAll(accountId: string, key: Buffer) {
    for (const row of this.db.prepare('SELECT ref,ciphertext FROM vault_secrets WHERE account_id=?').all(accountId)) {
      const plaintext = open(key, String(row.ciphertext), String(row.ref))
      try { this.scrubber.register(String(row.ref) as SecretRef, plaintext.toString()); this.registered.add(String(row.ref) as SecretRef) }
      finally { plaintext.fill(0) }
    }
  }
  async unlock(accountId: string) {
    this.assertOpen()
    const generation = (this.generations.get(accountId) ?? 0) + 1
    this.generations.set(accountId, generation)
    const key = await this.dataKey(accountId)
    try {
      this.assertOpen()
      if (this.generations.get(accountId) !== generation) throw new Error('Vault unlock cancelled')
      this.registerAll(accountId, key)
      this.sessions.get(accountId)?.fill(0)
      this.sessions.set(accountId, key)
    } catch { key.fill(0); throw new Error('Vault could not be unlocked') }
  }
  lock(accountId: string) {
    this.assertOpen()
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1)
    this.sessions.get(accountId)?.fill(0)
    this.sessions.delete(accountId)
  }
  put(accountId: string, value: string): string {
    this.assertOpen()
    const key = this.sessions.get(accountId)
    if (!key) throw new Error('Vault is locked')
    if (!value) throw new Error('Empty secret')
    const ref: SecretRef = `secret://${accountId}/${randomUUID()}`
    this.scrubber.register(ref, value)
    this.registered.add(ref)
    const plaintext = Buffer.from(value)
    try { this.db.prepare('INSERT INTO vault_secrets VALUES(?,?,?)').run(ref, accountId, seal(key, plaintext, ref)) }
    finally { plaintext.fill(0) }
    return ref
  }
  /** Refuse unsanitized context after restart if secrets have not been registered yet. */
  assertScrubbingReady(accountId: string) {
    this.assertOpen()
    const rows = this.db.prepare('SELECT ref FROM vault_secrets WHERE account_id=?').all(accountId)
    if (rows.some(row => !this.registered.has(String(row.ref) as SecretRef))) throw new Error('Unlock the vault before model access')
  }
  async inject<T>(connection: Connection, background: boolean, use: (value: string) => Promise<T>): Promise<T> {
    this.assertOpen()
    if (!connection.secretRef?.startsWith(`secret://${connection.accountId}/`)) throw new Error('Connection credential unavailable')
    if (background && (!connection.unattended || !this.unattendedAvailable)) throw new Error('Unattended access disabled')
    let key = this.sessions.get(connection.accountId)
    let ephemeral = false
    if (!key) {
      if (!background) throw new Error('Vault is locked')
      key = await this.dataKey(connection.accountId)
      ephemeral = true
    }
    try {
      this.assertOpen()
      this.registerAll(connection.accountId, key)
      const row = this.db.prepare('SELECT ciphertext FROM vault_secrets WHERE ref=? AND account_id=?').get(connection.secretRef, connection.accountId)
      if (!row) throw new Error('Connection credential unavailable')
      const plaintext = open(key, String(row.ciphertext), connection.secretRef)
      try { return await use(plaintext.toString()) } finally { plaintext.fill(0) }
    } finally { if (ephemeral) key.fill(0) }
  }
  close() {
    if (this.closed) return
    for (const account of this.sessions.keys()) this.lock(account)
    this.closed = true
    this.lifetime.abort()
    for (const ref of this.registered) this.scrubber.unregister(ref)
    this.registered.clear()
  }
}
