import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MIGRATIONS, openDb } from '../src/store/db.ts'
import { DURABLE_RUN_TABLES, downgradeDurableRunsToV29 } from './fixtures/session-log-migration.ts'
import { orderedRows } from './fixtures/table-rows.ts'

// Digest of all 29 shipped migrations, independently derived at the R1 base 1f2ab87.
const BASE_DIGEST = "ba4e12d3bbceb99b098a6f5197e857a1535131aa19ddcdfc4db970428e23512e"
test('migration 30 preserves all 29 applied migrations and their data, and failed DDL rolls back/retries', (t) => {
  assert.equal(createHash('sha256').update(JSON.stringify(MIGRATIONS.slice(0, 29))).digest('hex'), BASE_DIGEST)
  assert.equal(MIGRATIONS.length, 31)
  assert.equal(createHash('sha256').update(MIGRATIONS[29]!).digest('hex'), 'e5cbd182c1330e519734be3d4b911877839dd8deb85359d088cf7fb66aeafe0d')
  assert.equal(createHash('sha256').update(MIGRATIONS[30]!).digest('hex'), 'c1f12b50a21d8a10dd6f6ad31948dd191b658a8541cbec2765597f0b6ebe7353')
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r1-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'node.db')
  const db = openDb(path)
  db.prepare("INSERT INTO settings VALUES ('fixture','preserved')").run()
  downgradeDurableRunsToV29(db)
  const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
  const snapshot = (connection: DatabaseSync) => JSON.stringify(tableNames.map((name) => [name, orderedRows(connection, name)]))
  const before = snapshot(db)
  db.exec('CREATE TABLE promises (collision TEXT)'); db.close()
  assert.throws(() => openDb(path), /Миграция 30/u)
  const repair = new DatabaseSync(path)
  assert.equal((repair.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 29)
  assert.equal(repair.prepare("SELECT name FROM sqlite_master WHERE name='durable_runs'").get(), undefined)
  repair.exec('DROP TABLE promises'); assert.equal(snapshot(repair), before); repair.close()
  const upgraded = openDb(path)
  assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 31)
  assert.equal(snapshot(upgraded), before)
  for (const table of DURABLE_RUN_TABLES) assert.equal((upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0)
  upgraded.close()
  const reopened = openDb(path); assert.equal(snapshot(reopened), before); reopened.close()
})

test('migration 31 upgrades an applied v30 lease without rewriting it; a failed upgrade rolls back and retries', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'guanxi-r1-lease-bound-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'node.db')
  const seed = openDb(path)
  seed.exec('ALTER TABLE leases DROP COLUMN regrant_after; PRAGMA user_version=30')
  seed.prepare("INSERT INTO leases VALUES ('prior',1,7,'prior-holder',123456,0)").run()
  const before = { ...seed.prepare("SELECT * FROM leases WHERE key='prior'").get() }
  seed.exec('ALTER TABLE leases ADD COLUMN regrant_after TEXT')
  seed.close()
  assert.throws(() => openDb(path), /Миграция 31/u)
  const repair = new DatabaseSync(path)
  assert.equal((repair.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30)
  repair.exec('ALTER TABLE leases DROP COLUMN regrant_after'); repair.close()
  const upgraded = openDb(path)
  assert.deepEqual({ ...upgraded.prepare("SELECT * FROM leases WHERE key='prior'").get() }, { ...before, regrant_after: 0 })
  assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 31)
  upgraded.close()
})
