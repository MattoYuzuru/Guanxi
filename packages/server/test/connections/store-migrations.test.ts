import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ConnectionStore } from '../../src/connections/store.ts'
import type { EgressScrubber } from '../../src/egress/types.ts'

/** The store never uses the scrubber before it refuses a lane-only database. */
const scrubber = { scrub: <T>(value: T) => value } as unknown as EgressScrubber

test('refuses a lane-only database where version 4 has no dotenv family column', t => {
  const dir = mkdtempSync(join(tmpdir(), 'guanxi-k3-lane-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'connections.sqlite')
  const lane = new DatabaseSync(path)
  lane.exec(`
    CREATE TABLE k3_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO k3_migrations VALUES(1),(2),(3),(4);
    CREATE TABLE connections(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE costs(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id),
      request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(connection_id,request_id));
    CREATE TABLE vault_keys(account_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL);
    CREATE TABLE vault_secrets(ref TEXT PRIMARY KEY, account_id TEXT NOT NULL, ciphertext TEXT NOT NULL);
    CREATE TABLE vault_node_keys(account_id TEXT PRIMARY KEY, wrapped TEXT NOT NULL);
    CREATE TABLE vault_node_secrets(connection_id TEXT PRIMARY KEY REFERENCES connections(id), account_id TEXT NOT NULL,
      ref TEXT NOT NULL REFERENCES vault_secrets(ref), ciphertext TEXT NOT NULL);
    CREATE TABLE dotenv_imports(account_id TEXT NOT NULL, provider TEXT NOT NULL, endpoint TEXT NOT NULL,
      connection_id TEXT NOT NULL REFERENCES connections(id), PRIMARY KEY(account_id,provider,endpoint));
    CREATE TABLE removed_connections(connection_id TEXT PRIMARY KEY REFERENCES connections(id),
      account_id TEXT NOT NULL, removed_at TEXT NOT NULL);
  `)
  lane.close()

  assert.throws(() => new ConnectionStore(path, scrubber), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error & { code?: string }).code, 'lane_data_dir_incompatible')
    assert.ok(error.message.includes(dir), 'the message names the data directory')
    assert.match(error.message, /pre-merge K3 lane build/u)
    assert.match(error.message, /discard/iu)
    return true
  })

  // No repair: the lane schema and its migration rows are exactly as they were.
  const reopened = new DatabaseSync(path)
  t.after(() => reopened.close())
  const columns = reopened.prepare('PRAGMA table_info(dotenv_imports)').all() as { name: string }[]
  assert.equal(columns.some(column => column.name === 'family'), false)
  assert.deepEqual(reopened.prepare('SELECT version FROM k3_migrations ORDER BY version').all().map(row => row.version), [1, 2, 3, 4])
})
