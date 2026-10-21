import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './fixture.ts'
import { RelayStore, RELAY_MIGRATION } from '../../src/relay/store.ts'
import { createHash } from 'node:crypto'
import { MIGRATIONS } from '../../src/store/db.ts'

test('relay migration is independent of user_version and F1 ledger; existing migrations are untouched', () => {
  const f=fixture()
  try {
    assert.equal(MIGRATIONS.length,31)
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version,31)
    assert.equal(f.db.prepare('SELECT version FROM relay_migrations').get()!.version,35)
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'federation%'").all().length,0)
    f.relay.note(f.attempt,'decision','immutable',[],null)
    assert.throws(()=>f.db.exec("UPDATE relay_notes SET payload='{}'"),/append only/)
    assert.throws(()=>f.db.exec('DELETE FROM relay_notes'),/append only/)
    assert.equal(createHash('sha256').update(JSON.stringify(MIGRATIONS.slice(0,29))).digest('hex'),'ba4e12d3bbceb99b098a6f5197e857a1535131aa19ddcdfc4db970428e23512e')
  } finally {f.close()}
})
test('failed relay DDL rolls back without marking the migration applied; retry preserves run rows', () => {
  const f=fixture()
  try {
    // Remove only newly initialized test-fixture tables and rerun the real migration.
    f.db.exec('DROP TABLE relay_seals; DROP TABLE relay_notes; DROP TABLE relay_runs; DROP TABLE relay_migrations; CREATE TABLE relay_notes(collision TEXT)')
    assert.throws(()=>new RelayStore(f.db,f.store,f.scrubber),/already exists/)
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='relay_migrations'").get(),undefined)
    f.db.exec('DROP TABLE relay_notes')
    new RelayStore(f.db,f.store,f.scrubber)
    assert.equal(f.db.prepare('SELECT version FROM relay_migrations').get()!.version,35)
    assert.equal(f.store.get(f.run.id).state,'working')
  } finally {f.close()}
})
