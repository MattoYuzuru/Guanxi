import { randomBytes, randomUUID } from 'node:crypto'
import { nodeIdentitySchema, type NodeIdentity } from '@guanxi/contract/federation'
import type { Db } from '../store/db.ts'
import { FederationError, hash, publicKey } from './crypto.ts'

export class DeviceEnrollment {
  private readonly db: Db
  private readonly local: NodeIdentity
  private readonly now: () => number
  private readonly trust: (identity: NodeIdentity) => void
  private readonly assertOpen: () => void
  constructor(db: Db, local: NodeIdentity, now: () => number, trust: (identity: NodeIdentity) => void, assertOpen: () => void) {
    this.db = db; this.local = local; this.now = now; this.trust = trust; this.assertOpen = assertOpen
  }
  begin(key: string) {
    this.assertOpen()
    publicKey(key)
    const device_code = randomBytes(32).toString('base64url')
    const user_code = randomBytes(8).toString('hex').toUpperCase()
    this.db.prepare('INSERT INTO federation_devices VALUES (?,?,?,?,?,?,?,NULL)').run(
      hash(device_code), hash(user_code), key, this.now() + 600_000, this.now() + 5_000, 5_000, 'pending')
    return { device_code, user_code, verification_uri: '/federation/device', expires_in: 600, interval: 5 }
  }
  /** Host-only authority; never exposed on the node channel or trusted from request JSON. */
  approve(userCode: string, options: Omit<NodeIdentity, 'id' | 'publicKey'>): NodeIdentity {
    this.assertOpen()
    if (!this.local.admin) throw new FederationError('admin_required', 403)
    const row = this.db.prepare('SELECT * FROM federation_devices WHERE user_hash=?').get(hash(userCode))
    if (!row || row.state !== 'pending' || (row.expires_at as number) <= this.now()) throw new FederationError('expired_token', 400)
    if (options.accountId !== this.local.accountId) throw new FederationError('owner_mismatch', 403)
    const identity = nodeIdentitySchema.parse({ ...options, id: randomUUID(), publicKey: row.public_key })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.trust(identity)
      this.db.prepare("UPDATE federation_devices SET state='approved',identity=? WHERE user_hash=?").run(JSON.stringify(identity), hash(userCode))
      this.db.exec('COMMIT'); return identity
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  deny(userCode: string): void {
    this.assertOpen()
    if (!this.local.admin) throw new FederationError('admin_required', 403)
    this.db.prepare("UPDATE federation_devices SET state='denied' WHERE user_hash=? AND state='pending'").run(hash(userCode))
  }
  poll(deviceCode: string): NodeIdentity {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM federation_devices WHERE device_hash=?').get(hash(deviceCode))
    if (!row) throw new FederationError('invalid_grant', 400)
    if ((row.expires_at as number) <= this.now() || row.state === 'consumed') throw new FederationError('expired_token', 400)
    if (row.state === 'denied') throw new FederationError('access_denied', 403)
    if ((row.next_poll as number) > this.now()) {
      this.db.prepare('UPDATE federation_devices SET interval_ms=interval_ms+5000,next_poll=? WHERE device_hash=?')
        .run(this.now() + (row.interval_ms as number) + 5_000, hash(deviceCode))
      throw new FederationError('slow_down', 400)
    }
    this.db.prepare('UPDATE federation_devices SET next_poll=? WHERE device_hash=?').run(this.now() + (row.interval_ms as number), hash(deviceCode))
    if (row.state !== 'approved') throw new FederationError('authorization_pending', 400)
    this.db.prepare("UPDATE federation_devices SET state='consumed' WHERE device_hash=?").run(hash(deviceCode))
    return nodeIdentitySchema.parse(JSON.parse(row.identity as string))
  }
}
