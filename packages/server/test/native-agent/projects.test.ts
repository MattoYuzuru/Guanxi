import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeProjectRoots } from '../../src/native-agent/projects.ts'
import type { NativeHost } from '../../src/native-agent/service.ts'

test('sidecar initializes or adopts schema v1 without losing existing overrides and refuses future versions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'k4-projects-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const host = { projects: { list: () => [{ id: 'p', filesystemBindings: [] }] } } as unknown as NativeHost
  for (const legacy of [false, true]) {
    const path = join(dir, `${legacy}.sqlite`)
    const seed = new DatabaseSync(path)
    if (legacy) seed.exec(`CREATE TABLE project_roots (project_id TEXT PRIMARY KEY, workspace_ids TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; INSERT INTO project_roots VALUES ('p', '["w"]', 'fixture')`)
    seed.close()
    const store = new NativeProjectRoots(path, host)
    assert.equal(store.get('p')!.filesystemBindings.length, legacy ? 1 : 0)
    store.close()
    const db = new DatabaseSync(path)
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1)
    db.close()
    new NativeProjectRoots(path, host).close()
  }
  const future = join(dir, 'future.sqlite'), db = new DatabaseSync(future)
  db.exec('PRAGMA user_version = 2'); db.close()
  assert.throws(() => new NativeProjectRoots(future, host), /native_projects_schema_unsupported/)
  const inspect = new DatabaseSync(future)
  assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version, 2)
  assert.equal(inspect.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'project_roots'").get()!.n, 0)
  inspect.close()
})
