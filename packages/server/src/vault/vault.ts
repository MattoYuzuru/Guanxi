import { MIN_SECRET_LENGTH } from '../connections/egress.ts'
import { ConnectionError } from '../connections/errors.ts'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ConnectionStore } from '../connections/store.ts'
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
  private readonly nodeSessions = new Map<string, Buffer>()
  private readonly registered = new Set<SecretRef>()
  private readonly db: DatabaseSync
  private readonly store: ConnectionStore
  private readonly keychain: () => Promise<VaultKeychain>
  private readonly scrubber: EgressScrubber
  readonly policy: Readonly<VaultPolicy>
  constructor(store: ConnectionStore, keychain: () => Promise<VaultKeychain>,
    scrubber: EgressScrubber, policy: VaultPolicy) {
    this.db = store.db
    this.store = store
    this.keychain = keychain
    this.scrubber = scrubber
    this.policy = Object.freeze({ ...policy })
  }
  private assertOpen() { if (this.closed) throw new Error('Vault closed') }
  get unattendedAvailable() { return this.policy.ownerDevice && this.policy.nodeKeyOptIn }
  unlocked(accountId: string) { return this.sessions.has(accountId) }
  private async dataKey(accountId: string, node = false, create = true): Promise<Buffer> {
    try { return await this.readDataKey(accountId, node, create) }
    catch (error) {
      if (this.closed) throw new Error('Vault closed')
      if (error instanceof ConnectionError) throw error
      throw new ConnectionError('vault_locked', 'Vault wrapping key unavailable')
    }
  }
  private async readDataKey(accountId: string, node: boolean, create: boolean): Promise<Buffer> {
    this.assertOpen()
    const table = node ? 'vault_node_keys' : 'vault_keys'
    const aad = `${node ? 'node-key' : 'key'}:${accountId}`
    const row = this.db.prepare(`SELECT wrapped FROM ${table} WHERE account_id=?`).get(accountId)
    if (!row && !create) throw new ConnectionError('policy_denied', 'Unattended credential unavailable')
    const pending = this.keychain()
    const keychain = await new Promise<VaultKeychain>((resolve, reject) => {
      const abort = () => reject(new Error('Vault closed'))
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      void pending.then(resolve, reject).finally(() => this.lifetime.signal.removeEventListener('abort', abort))
    })
    this.assertOpen()
    const wrapping = keychain.key(accountId, !row, node ? 'node' : 'session')
    try {
      if (row) return open(wrapping, String(row.wrapped), aad)
      const key = randomBytes(32)
      // Synchronous after await: a concurrent unlock reads the existing winner.
      const winner = this.db.prepare(`SELECT wrapped FROM ${table} WHERE account_id=?`).get(accountId)
      if (winner) { key.fill(0); return open(wrapping, String(winner.wrapped), aad) }
      this.db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(accountId, seal(wrapping, key, aad))
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
    let key: Buffer | undefined
    let nodeKey: Buffer | undefined
    try {
      key = await this.dataKey(accountId)
      if (this.unattendedAvailable) nodeKey = await this.dataKey(accountId, true)
      this.assertOpen()
      if (this.generations.get(accountId) !== generation) throw new Error('Vault unlock cancelled')
      this.registerAll(accountId, key)
      this.publishScrubbingReady()
      this.sessions.get(accountId)?.fill(0)
      this.sessions.set(accountId, key)
      this.nodeSessions.get(accountId)?.fill(0)
      if (nodeKey) this.nodeSessions.set(accountId, nodeKey)
    } catch {
      key?.fill(0); nodeKey?.fill(0)
      if (this.closed) throw new Error('Vault closed')
      throw new ConnectionError('vault_locked', 'Vault could not be unlocked')
    }
  }
  lock(accountId: string) {
    this.assertOpen()
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1)
    this.sessions.get(accountId)?.fill(0)
    this.sessions.delete(accountId)
    this.nodeSessions.get(accountId)?.fill(0)
    this.nodeSessions.delete(accountId)
  }
  put(accountId: string, value: string): string {
    this.assertOpen()
    const key = this.sessions.get(accountId)
    if (!key) throw new ConnectionError('vault_locked', 'Vault is locked')
    if (value.length < MIN_SECRET_LENGTH) throw new ConnectionError('validation_failed', 'Secret is too short')
    const ref: SecretRef = `secret://${accountId}/${randomUUID()}`
    this.scrubber.register(ref, value)
    this.registered.add(ref)
    const plaintext = Buffer.from(value)
    try { this.db.prepare('INSERT INTO vault_secrets VALUES(?,?,?)').run(ref, accountId, seal(key, plaintext, ref)) }
    finally { plaintext.fill(0) }
    return ref
  }
  /** Registration-only keychain access: never opens an injection session or uses the node key. */
  async registerForScrubbing() {
    this.assertOpen()
    for (const row of this.db.prepare('SELECT DISTINCT account_id FROM vault_secrets').all()) {
      const accountId = String(row.account_id)
      const key = await this.dataKey(accountId, false, false)
      try { this.assertOpen(); this.registerAll(accountId, key) } finally { key.fill(0) }
    }
    this.publishScrubbingReady()
  }
  private publishScrubbingReady() {
    if (this.scrubbingReady) this.scrubber.ready('vault')
  }
  get scrubbingReady(): boolean {
    if (this.closed) return false
    return this.db.prepare('SELECT ref FROM vault_secrets').all()
      .every(row => this.registered.has(String(row.ref) as SecretRef))
  }
  /** K3 dispatch guard; K2 receives readiness through the scrubber push API. */
  assertScrubbingReady(_accountId: string) {
    this.assertOpen()
    if (!this.scrubbingReady) throw new ConnectionError('egress_unavailable', 'Unlock the vault before model access; egress registration incomplete')
  }
  /** Only an unlocked session can grant a node-encrypted copy of this connection's key. */
  prepareUnattended(accountId: string, connectionId: string, enabled: boolean, ref?: string) {
    this.assertOpen()
    if (!enabled) {
      this.db.prepare('DELETE FROM vault_node_secrets WHERE account_id=? AND connection_id=?').run(accountId, connectionId)
      return
    }
    if (!this.unattendedAvailable) throw new ConnectionError('policy_denied', 'Unattended access disabled')
    const session = this.sessions.get(accountId)
    const node = this.nodeSessions.get(accountId)
    if (!session || !node) throw new ConnectionError('vault_locked', 'Vault is locked')
    const secretRef = ref ?? this.store.get(accountId, connectionId).secretRef
    if (!secretRef) return
    const row = this.db.prepare('SELECT ciphertext FROM vault_secrets WHERE ref=? AND account_id=?').get(secretRef, accountId)
    if (!row) throw new ConnectionError('policy_denied', 'Connection credential unavailable')
    const plaintext = open(session, String(row.ciphertext), secretRef)
    try {
      this.db.prepare('INSERT OR REPLACE INTO vault_node_secrets VALUES(?,?,?,?)').run(
        connectionId, accountId, secretRef, seal(node, plaintext, `node:${accountId}:${connectionId}:${secretRef}`))
    } finally { plaintext.fill(0) }
  }
  async inject<T>(accountId: string, connectionId: string, background: boolean, use: (value: string) => Promise<T>): Promise<T> {
    this.assertOpen()
    // Authorization is always read from persistence, never from a caller-supplied row.
    const connection = this.store.get(accountId, connectionId)
    const ref = connection.secretRef
    if (!ref?.startsWith(`secret://${accountId}/`)) throw new ConnectionError('policy_denied', 'Connection credential unavailable')
    if (background && (!connection.unattended || !this.unattendedAvailable)) throw new ConnectionError('policy_denied', 'Unattended access disabled')
    const key = background ? await this.dataKey(accountId, true, false) : this.sessions.get(accountId)
    if (!key) throw new ConnectionError('vault_locked', 'Vault is locked')
    try {
      this.assertOpen()
      // Recheck after the asynchronous keychain read (consent may have been revoked).
      const current = this.store.get(accountId, connectionId)
      if (current.secretRef !== ref || (background && !current.unattended)) throw new ConnectionError('policy_denied', 'Connection credential unavailable')
      const row = background
        ? this.db.prepare('SELECT ciphertext FROM vault_node_secrets WHERE connection_id=? AND account_id=? AND ref=?').get(connectionId, accountId, ref)
        : this.db.prepare('SELECT ciphertext FROM vault_secrets WHERE ref=? AND account_id=?').get(ref, accountId)
      if (!row) throw new ConnectionError('policy_denied', 'Connection credential unavailable')
      const plaintext = open(key, String(row.ciphertext), background ? `node:${accountId}:${connectionId}:${ref}` : ref)
      try {
        this.scrubber.register(ref as SecretRef, plaintext.toString())
        this.registered.add(ref as SecretRef)
        return await use(plaintext.toString())
      } finally { plaintext.fill(0) }
    } finally { if (background) key.fill(0) }
  }
  close() {
    if (this.closed) return
    for (const account of this.sessions.keys()) this.lock(account)
    this.closed = true
    this.lifetime.abort()
    // The long-lived scrubber must still redact historical output between activations.
    this.registered.clear()
  }
}
