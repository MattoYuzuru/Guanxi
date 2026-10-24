import { ConnectionError } from './errors.ts'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  connectionSchema, createConnectionSchema, connectionCostSchema,
  type Connection, type CreateConnection, type ConnectionCost, type ConnectionBalance, type ConnectionFact,
} from '@guanxi/contract'
import type { EgressScrubber } from '../egress/types.ts'

/** A pre-merge lane build used version 4 for `removed_connections`; that data directory is never repaired. */
export const LANE_DATA_DIR_INCOMPATIBLE = 'lane_data_dir_incompatible'
export class LaneDataDirError extends Error {
  readonly code = LANE_DATA_DIR_INCOMPATIBLE
  constructor(path: string) {
    super(`The data directory ${dirname(path)} was written by a pre-merge K3 lane build: k3_migrations has version 4 ` +
      'but dotenv_imports has no family column. Discard this lane-only data directory; there is no repair.')
    this.name = 'LaneDataDirError'
  }
}

/** A separate database keeps K3 migrations independent of K2 and legacy user_version. */
export class ConnectionStore {
  readonly db: DatabaseSync
  private readonly scrubber: EgressScrubber
  constructor(path: string, scrubber: EgressScrubber) {
    this.scrubber = scrubber

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS k3_migrations(version INTEGER PRIMARY KEY);
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT version FROM k3_migrations WHERE version=1').get()) {
        this.db.exec(`
          CREATE TABLE connections(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX connections_account ON connections(account_id);
          CREATE TABLE costs(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id), request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(connection_id,request_id));
          CREATE TABLE vault_keys(account_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL);
          CREATE TABLE vault_secrets(ref TEXT PRIMARY KEY, account_id TEXT NOT NULL, ciphertext TEXT NOT NULL);
          INSERT INTO k3_migrations VALUES(1);
        `)
      }
      if (!this.db.prepare('SELECT version FROM k3_migrations WHERE version=2').get()) {
        this.db.exec(`
          CREATE TABLE vault_node_keys(account_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL);
          CREATE TABLE vault_node_secrets(connection_id TEXT PRIMARY KEY REFERENCES connections(id), account_id TEXT NOT NULL, ref TEXT NOT NULL REFERENCES vault_secrets(ref), ciphertext TEXT NOT NULL);
          INSERT INTO k3_migrations VALUES(2);
        `)
      }
      if (!this.db.prepare('SELECT version FROM k3_migrations WHERE version=3').get()) {
        this.db.exec(`CREATE TABLE dotenv_imports(account_id TEXT NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL,
          connection_id TEXT NOT NULL REFERENCES connections(id), PRIMARY KEY(account_id,provider,endpoint));
          INSERT INTO k3_migrations VALUES(3);`)
      }
      if (!this.db.prepare('SELECT version FROM k3_migrations WHERE version=4').get()) {
        // Append the dotenv name family to the identity. Legacy rows had one openai
        // identity for both names; treat them as the official OPENAI_API_KEY family.
        this.db.exec(`
          CREATE TABLE dotenv_imports_v4(account_id TEXT NOT NULL, provider TEXT NOT NULL, family TEXT NOT NULL, endpoint TEXT NOT NULL,
            connection_id TEXT NOT NULL REFERENCES connections(id), PRIMARY KEY(account_id,provider,family,endpoint));
          INSERT INTO dotenv_imports_v4(account_id,provider,family,endpoint,connection_id)
            SELECT account_id, provider, CASE WHEN provider='openai' THEN 'OPENAI_API_KEY' ELSE provider END, endpoint, connection_id
            FROM dotenv_imports;
          DROP TABLE dotenv_imports;
          ALTER TABLE dotenv_imports_v4 RENAME TO dotenv_imports;
          INSERT INTO k3_migrations VALUES(4);`)
      }
      // A lane build recorded version 4 for its own table. Migrations are append-only, so version 4
      // cannot run again and the missing column would fail every later import: refuse instead of repairing.
      if (this.db.prepare('SELECT version FROM k3_migrations WHERE version=4').get()) {
        const columns = this.db.prepare('PRAGMA table_info(dotenv_imports)').all() as { name?: unknown }[]
        if (!columns.some(column => column.name === 'family')) throw new LaneDataDirError(path)
      }
      if (!this.db.prepare('SELECT version FROM k3_migrations WHERE version=5').get()) {
        // A separate table keeps the connection row (and the append-only cost ledger) intact while
        // hiding the connection from every snapshot and picker. The vault record stays for redaction.
        this.db.exec(`CREATE TABLE IF NOT EXISTS removed_connections(connection_id TEXT PRIMARY KEY REFERENCES connections(id),
          account_id TEXT NOT NULL, removed_at TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS removed_connections_account ON removed_connections(account_id);
          INSERT INTO k3_migrations VALUES(5);`)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) chmodSync(file, 0o600)
  }
  list(accountId: string): Connection[] {
    return this.db.prepare(`SELECT data FROM connections WHERE account_id=?
      AND id NOT IN (SELECT connection_id FROM removed_connections WHERE account_id=?) ORDER BY rowid`).all(accountId, accountId)
      .map(row => connectionSchema.parse(JSON.parse(String(row.data))))
  }
  get(accountId: string, id: string): Connection {
    const row = this.db.prepare(`SELECT data FROM connections WHERE account_id=? AND id=?
      AND id NOT IN (SELECT connection_id FROM removed_connections WHERE account_id=?)`).get(accountId, id, accountId)
    if (!row) throw new ConnectionError('connection_not_found', 'Connection not found')
    return connectionSchema.parse(JSON.parse(String(row.data)))
  }
  /** The marked auto row including its removal state; `list()` alone cannot tell a removed row from no row. */
  findAutoLocalOllama(accountId: string): { connection: Connection; removed: boolean } | undefined {
    const rows = this.db.prepare(`SELECT connections.data,
        CASE WHEN removed_connections.connection_id IS NULL THEN 0 ELSE 1 END AS removed
      FROM connections LEFT JOIN removed_connections
        ON removed_connections.connection_id=connections.id AND removed_connections.account_id=connections.account_id
      WHERE connections.account_id=? ORDER BY connections.rowid`).all(accountId)
    for (const row of rows) {
      const connection = connectionSchema.parse(JSON.parse(String(row.data)))
      if (connection.kind === 'local_runtime' && connection.provider === 'ollama' &&
        connection.facts.origin?.value === 'local_runtime_auto') return { connection, removed: Number(row.removed) === 1 }
    }
  }
  /** Soft removal: the row and its cost ledger survive, but the connection leaves every list and picker.
   * The dotenv mapping is dropped so a later import creates a new connection; vault records remain so the
   * scrubber still redacts historical output. */
  remove(accountId: string, id: string): { id: string } {
    const row = this.get(accountId, id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR REPLACE INTO removed_connections VALUES(?,?,?)')
        .run(id, accountId, new Date().toISOString())
      this.db.prepare('DELETE FROM dotenv_imports WHERE account_id=? AND connection_id=?').run(accountId, id)
      // The node-key copy exists only for unattended dispatch; a removed connection must not keep it.
      this.db.prepare('DELETE FROM vault_node_secrets WHERE account_id=? AND connection_id=?').run(accountId, id)
      const safe = connectionSchema.parse(this.scrubber.scrub({ ...row, secretRef: null }))
      this.db.prepare('UPDATE connections SET data=? WHERE id=? AND account_id=?')
        .run(JSON.stringify(safe), id, accountId)
      this.db.exec('COMMIT')
      return { id }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  create(accountId: string, input: CreateConnection, endpoint?: { baseUrl: string; allowPrivate?: boolean }): Connection {
    const data = createConnectionSchema.parse(input)
    const row = connectionSchema.parse({ ...data, ...endpoint, id: randomUUID(), accountId,
      secretRef: null, facts: {
        health: { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' },
        billing: { value: null, source: 'not_observed', observedAt: null, confidence: 'unknown' },
        route: { value: data.auth === 'cli_login' ? 'official_cli' : data.kind, source: 'connection_configuration', observedAt: new Date().toISOString(), confidence: 'high' },
      }, balance: null, createdAt: new Date().toISOString() })
    this.db.prepare('INSERT INTO connections VALUES(?,?,?)').run(row.id, accountId, JSON.stringify(this.scrubber.scrub(row)))
    return this.get(accountId, row.id)
  }
  private write(row: Connection): Connection {
    const safe = connectionSchema.parse(this.scrubber.scrub(row))
    this.db.prepare('UPDATE connections SET data=? WHERE id=? AND account_id=?')
      .run(JSON.stringify(safe), safe.id, safe.accountId)
    return safe
  }
  /** Trusted import only; no HTTP mutation exposes this owner network consent. */
  setImportedNetworkPolicy(accountId: string, id: string, allowPrivate: boolean): Connection {
    const row = this.get(accountId, id)
    if (!row.baseUrl) throw new ConnectionError('validation_failed', 'Custom endpoint required')
    return this.write({ ...row, allowPrivate })
  }
  /** Trusted import only: replace or clear an owner-pinned API root and its network consent. */
  setImportedEndpoint(accountId: string, id: string,
    endpoint: { baseUrl?: string; allowPrivate?: boolean }, name?: string): Connection {
    const row = this.get(accountId, id)
    const next: Connection = { ...row, ...(name === undefined ? {} : { name }) }
    if (endpoint.baseUrl === undefined) {
      delete next.baseUrl
      delete next.allowPrivate
    } else {
      next.baseUrl = endpoint.baseUrl
      next.allowPrivate = endpoint.allowPrivate ?? false
    }
    return this.write(next)
  }
  setUnattended(accountId: string, id: string, unattended: boolean): Connection {
    return this.write({ ...this.get(accountId, id), unattended })
  }
  setSecret(accountId: string, id: string, secretRef: string): Connection {
    return this.write({ ...this.get(accountId, id), secretRef })
  }
  observe(accountId: string, id: string, facts: Record<string, ConnectionFact>, balance?: ConnectionBalance): Connection {
    const row = this.get(accountId, id)
    return this.write({ ...row, facts: { ...row.facts, ...facts }, balance: balance ?? row.balance })
  }
  record(input: Omit<ConnectionCost, 'id'>): ConnectionCost {
    this.get(input.accountId, input.connectionId)
    const row = connectionCostSchema.parse(this.scrubber.scrub({ ...input, id: randomUUID() }))
    this.db.prepare('INSERT OR IGNORE INTO costs VALUES(?,?,?,?,?)').run(row.id, row.accountId, row.connectionId, row.requestId, JSON.stringify(row))
    const stored = this.db.prepare('SELECT data FROM costs WHERE connection_id=? AND request_id=?').get(row.connectionId, row.requestId)!
    const existing = connectionCostSchema.parse(JSON.parse(String(stored.data)))
    if (JSON.stringify({ ...existing, id: '' }) !== JSON.stringify({ ...row, id: '' })) throw new Error('Conflicting usage receipt')
    return existing
  }
  /** Every append-only receipt, including spend on connections hidden from the public projection. */
  receipts(accountId: string): ConnectionCost[] {
    return this.db.prepare('SELECT data FROM costs WHERE account_id=? ORDER BY rowid').all(accountId)
      .map(row => connectionCostSchema.parse(JSON.parse(String(row.data))))
  }
  /** Public cost projection: a removed connection's history stays in the ledger but leaves the snapshot. */
  costs(accountId: string): ConnectionCost[] {
    const removed = new Set(this.db.prepare('SELECT connection_id FROM removed_connections WHERE account_id=?')
      .all(accountId).map(row => String(row.connection_id)))
    return this.receipts(accountId).filter(cost => !removed.has(cost.connectionId))
  }
  close() { this.db.close() }
}
