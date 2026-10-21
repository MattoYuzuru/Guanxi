import { replicaEntrySchema, streamBindingSchema, type NodeIdentity, type ReplicaEntry,
  type StreamBinding } from '@guanxi/contract/federation'
import type { SessionEvent } from '@guanxi/contract'
import type { Db } from '../store/db.ts'
import type { SessionLog } from '../session-log/log.ts'
import { canonical, FederationError, hash, signValue, validSignature } from './crypto.ts'

const ZERO_HASH = '0'.repeat(64)
export function replicaBody(entry: { binding: StreamBinding; seq: number; previousHash: string; event: SessionEvent }) {
  return { domain: 'guanxi.federation.replica.v1', binding: entry.binding, seq: entry.seq, previousHash: entry.previousHash, event: entry.event }
}
export function replicaAllowed(identity: NodeIdentity, owner: string): boolean {
  return identity.trust === 'owner_device' && identity.accountId === owner && identity.scopes.includes('replicas')
}
export class Replicas {
  private readonly db: Db
  private readonly local: NodeIdentity
  #key: string
  private readonly log: SessionLog
  private readonly peer: (id: string) => NodeIdentity
  private readonly clean: (value: unknown) => void
  constructor(db: Db, local: NodeIdentity, key: string, log: SessionLog, peer: (id: string) => NodeIdentity, clean: (value: unknown) => void) { this.db = db; this.local = local; this.#key = key; this.log = log; this.peer = peer; this.clean = clean }
  /** Explicit host-approved pins. No peer can assign a home or change an epoch by gossip. */
  bind(input: StreamBinding): void {
    const binding = streamBindingSchema.parse(input)
    this.clean(binding)
    if (binding.kind === 'session' && binding.streamId !== binding.sessionId) throw new FederationError('stream_mismatch')
    const home = this.peer(binding.homeNodeId)
    if (!replicaAllowed(home, binding.ownerAccountId) || !replicaAllowed(this.local, binding.ownerAccountId)) throw new FederationError('replica_forbidden', 403)
    if (binding.homeNodeId !== this.local.id && this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(binding.sessionId)) throw new FederationError('home_conflict')
    const old = this.db.prepare('SELECT binding FROM federation_streams WHERE id=?').get(binding.streamId)
    if (old && old.binding !== canonical(binding)) throw new FederationError('home_conflict')
    this.db.prepare('INSERT OR IGNORE INTO federation_streams VALUES (?,?)').run(binding.streamId, canonical(binding))
  }
  binding(id: string): StreamBinding {
    const row = this.db.prepare('SELECT binding FROM federation_streams WHERE id=?').get(id)
    if (!row) throw new FederationError('unknown_stream', 404)
    return streamBindingSchema.parse(JSON.parse(row.binding as string))
  }
  export(peer: NodeIdentity, streamId: string, after = 0): ReplicaEntry[] {
    const binding = this.binding(streamId)
    if (!replicaAllowed(peer, binding.ownerAccountId) || !replicaAllowed(this.local, binding.ownerAccountId)) return []
    if (binding.homeNodeId !== this.local.id) throw new FederationError('not_home')
    const events = this.log.readAll(binding.sessionId, 'remote_agent').filter((e) => binding.kind === 'session' ||
      (e.type === 'run.lifecycle' && e.data.runId === binding.streamId))
    let previousHash = ZERO_HASH
    return events.map((event, index) => {
      // K2 applies current readiness/withholding/read redaction. Never read raw SQL payloads.
      const body = replicaBody({ binding, seq: index + 1, previousHash, event: this.log.outward(binding.sessionId, event) })
      this.clean(body)
      const digest = hash(body)
      const result = replicaEntrySchema.parse({ binding: body.binding, seq: body.seq, previousHash: body.previousHash, event: body.event, hash: digest, signature: signValue(this.#key, { hash: digest }) })
      previousHash = digest; return result
    }).filter((e) => e.seq > after)
  }
  ingest(sender: NodeIdentity, entries: readonly ReplicaEntry[]): void {
    this.clean(null)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const input of entries) {
        const entry = replicaEntrySchema.parse(input)
        const binding = this.binding(entry.binding.streamId)
        if (canonical(binding) !== canonical(entry.binding)) throw new FederationError('home_conflict')
        if (!replicaAllowed(sender, binding.ownerAccountId) || !replicaAllowed(this.local, binding.ownerAccountId)) throw new FederationError('replica_forbidden', 403)
        if (binding.homeNodeId === this.local.id) throw new FederationError('home_is_writer')
        const home = this.peer(binding.homeNodeId)
        if (!replicaAllowed(home, binding.ownerAccountId)) throw new FederationError('replica_forbidden', 403)
        if (entry.event.sessionId !== binding.sessionId || (binding.kind === 'run' &&
          (entry.event.type !== 'run.lifecycle' || entry.event.data.runId !== binding.streamId))) throw new FederationError('stream_mismatch')
        this.clean(entry)
        if (hash(replicaBody(entry)) !== entry.hash || !validSignature(home.publicKey, { hash: entry.hash }, entry.signature)) throw new FederationError('invalid_replica', 403)
        const existing = this.db.prepare('SELECT hash FROM federation_replicas WHERE stream_id=? AND seq=?').get(binding.streamId, entry.seq)
        if (existing) {
          if (existing.hash !== entry.hash) throw new FederationError('replica_conflict')
          continue
        }
        const head = this.db.prepare('SELECT seq,hash FROM federation_replicas WHERE stream_id=? ORDER BY seq DESC LIMIT 1').get(binding.streamId)
        if (entry.seq !== (head ? head.seq as number : 0) + 1 || entry.previousHash !== (head?.hash ?? ZERO_HASH)) throw new FederationError('replica_gap')
        this.db.prepare('INSERT INTO federation_replicas VALUES (?,?,?,?)').run(binding.streamId, entry.seq, entry.hash, canonical(entry))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  read(streamId: string): SessionEvent[] {
    const binding = this.binding(streamId)
    if (!replicaAllowed(this.local, binding.ownerAccountId)) throw new FederationError('replica_forbidden', 403)
    this.clean(null)
    return this.db.prepare('SELECT data FROM federation_replicas WHERE stream_id=? ORDER BY seq').all(streamId).map((row) => {
      const entry = replicaEntrySchema.parse(JSON.parse(row.data as string))
      // A new vault registration can withhold old replicas. Signed history is never rewritten.
      this.clean(entry); return entry.event
    })
  }
}
