import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { auditRatchet, ledgerErrors, ledgerPath, policyPath, snapshotHash } from './ratchet.mjs'

async function repository(t, allowance, policy = { corrections: [] }) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-ratchet-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Gate Test', GIT_AUTHOR_EMAIL: 'gate@example.invalid', GIT_COMMITTER_NAME: 'Gate Test', GIT_COMMITTER_EMAIL: 'gate@example.invalid' } }).trim()
  const save = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), JSON.stringify(value, null, 2) + '\n') }
  const commit = message => { git('add', '.'); git('commit', '-qm', message) }
  git('init', '-q', '--initial-branch=main')
  await save(ledgerPath, allowance); await save(policyPath, policy); commit('Initial freeze')
  return { root, git, save, commit }
}

test('H1: two independent shrinks merge without a false growth finding', async t => {
  const initial = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`G5|packages/web/src/file${i}.tsx|bg-red-500`, 2]))
  const repo = await repository(t, initial)
  const first = Object.keys(initial)[0], last = Object.keys(initial).at(-1)
  repo.git('checkout', '-qb', 'lane-a')
  await repo.save(ledgerPath, { ...initial, [first]: 1 }); repo.commit('Shrink A')
  repo.git('checkout', '-qb', 'lane-b', 'main')
  await repo.save(ledgerPath, { ...initial, [last]: 1 }); repo.commit('Shrink B')
  repo.git('checkout', '-q', 'lane-a'); repo.git('merge', '--no-ff', '-m', 'Merge both shrinks', 'lane-b')
  const merged = { ...initial, [first]: 1, [last]: 1 }
  assert.deepEqual(auditRatchet(repo.root, merged, { corrections: [] }), [])
  // Restoring either removed occurrence must still fail after the merge.
  assert.ok(auditRatchet(repo.root, { ...merged, [first]: 2 }, { corrections: [] }).some(e => e.includes('allowance grew')))
})

test('H1: a merge restoring an occurrence removed by either parent fails', async t => {
  const key = 'G6|packages/web/src/index.css|color:red'
  const repo = await repository(t, { [key]: 2 })
  repo.git('checkout', '-qb', 'shrink'); await repo.save(ledgerPath, { [key]: 1 }); repo.commit('Shrink')
  repo.git('checkout', '-q', 'main'); await repo.save('unrelated.json', {}); repo.commit('Other lane')
  repo.git('merge', '--no-ff', '--no-commit', 'shrink')
  await repo.save(ledgerPath, { [key]: 2 }); repo.commit('Incorrectly restore at merge')
  assert.ok(auditRatchet(repo.root, { [key]: 2 }, { corrections: [] }).some(e => e.includes('allowance grew')))
})

test('M9: moved/split allowances preserve their exact value and cannot create a count', () => {
  const old = 'G5|packages/web/src/old.tsx|bg-red-500'
  const a = 'G5|packages/web/src/new/a.tsx|bg-red-500', b = 'G5|packages/web/src/new/b.tsx|bg-red-500'
  assert.deepEqual(ledgerErrors({ [old]: 3 }, { [a]: 1, [b]: 2 }), [])
  assert.ok(ledgerErrors({ [old]: 3 }, { [a]: 1, [b]: 3 }).length)
  assert.ok(ledgerErrors({ [old]: 3 }, { [a.replace('red', 'blue')]: 3 }).length)
  assert.ok(ledgerErrors({ [old]: 3 }, { [old]: 2, [a]: 1 }).length)
})

test('L2: rewriting or removing a committed correction cannot bless growth', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500', initial = { [key]: 1 }, after = { [key]: 2 }
  const correction = { id: 1, authorized: 'Test fixture', fromSHA256: snapshotHash({}), toSHA256: snapshotHash(initial) }
  const policy = { corrections: [correction] }
  const repo = await repository(t, initial, policy)
  const forged = { corrections: [{ ...correction, fromSHA256: snapshotHash(initial), toSHA256: snapshotHash(after) }] }
  assert.ok(auditRatchet(repo.root, after, forged).some(e => e.includes('policy changed')))
  await repo.save(policyPath, forged); await repo.save(ledgerPath, after); repo.commit('Forge policy')
  assert.ok(auditRatchet(repo.root, after, forged).some(e => e.includes('policy changed')))
  assert.ok(auditRatchet(repo.root, after, { corrections: [] }).some(e => e.includes('policy changed')))
})

test('H1/L2 self-review: deleting and recreating the ledger cannot reset the freeze', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500'
  const repo = await repository(t, { [key]: 1 })
  repo.git('rm', '-q', ledgerPath); repo.commit('Delete the ledger')
  await repo.save(ledgerPath, { [key]: 2 }); repo.commit('Recreate a larger ledger')
  assert.ok(auditRatchet(repo.root, { [key]: 2 }, { corrections: [] }).some(e => e.includes('ledger removed')))
})

test('H3/L2: two exact corrections are allowed; changed snapshots and a third correction fail', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500', one = { [key]: 1 }, two = { [key]: 2 }, three = { [key]: 3 }
  const correction = (id, before, after) => ({ id, authorized: 'Test fixture', fromSHA256: snapshotHash(before), toSHA256: snapshotHash(after) })
  const repo = await repository(t, one)
  const first = { corrections: [correction(1, one, two)] }
  await repo.save(policyPath, first); await repo.save(ledgerPath, two); repo.commit('Correction one')
  const second = { corrections: [...first.corrections, correction(2, two, three)] }
  assert.deepEqual(auditRatchet(repo.root, three, second), [])
  await repo.save(policyPath, second); await repo.save(ledgerPath, three); repo.commit('Correction two')
  assert.deepEqual(auditRatchet(repo.root, three, second), [])
  assert.ok(auditRatchet(repo.root, { [key]: 4 }, second).some(e => e.includes('allowance grew')))
  assert.ok(auditRatchet(repo.root, { [key]: 4 }, { corrections: [...second.corrections, correction(3, three, { [key]: 4 })] }).some(e => e.includes('policy')))
})

test('H3/L2 self-review: a correction cannot be replayed after its occurrences retire', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500'
  const one = { [key]: 1 }, two = { [key]: 2 }, three = { [key]: 3 }
  const correction = (id, before, after) => ({ id, fromSHA256: snapshotHash(before), toSHA256: snapshotHash(after) })
  const repo = await repository(t, one)
  const first = { corrections: [correction(1, one, two)] }
  await repo.save(policyPath, first); await repo.save(ledgerPath, two); repo.commit('First correction')
  const second = { corrections: [...first.corrections, correction(2, two, three)] }
  await repo.save(policyPath, second); await repo.save(ledgerPath, three); repo.commit('Second correction')
  assert.deepEqual(auditRatchet(repo.root, three, second), [])
  await repo.save(ledgerPath, two); repo.commit('Retire the corrected occurrence')
  assert.deepEqual(auditRatchet(repo.root, two, second), [])
  assert.ok(auditRatchet(repo.root, three, second).some(e => e.includes('allowance grew')))
  await repo.save(ledgerPath, three); repo.commit('Replay correction two')
  assert.ok(auditRatchet(repo.root, three, second).some(e => e.includes('allowance grew')))
})

test('N2: introduced corrections bind both snapshots on working-tree and committed edges', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500'
  const one = { [key]: 1 }, two = { [key]: 2 }, three = { [key]: 3 }
  for (const [before, declaredBefore, declaredAfter] of [[one, one, two], [two, one, three]]) {
    const repo = await repository(t, before)
    const policy = { corrections: [{ id: 1, fromSHA256: snapshotHash(declaredBefore), toSHA256: snapshotHash(declaredAfter) }] }
    // A legitimate-looking new entry cannot exempt an edge with a different source or target.
    assert.ok(auditRatchet(repo.root, three, policy).some(e => e.includes('allowance grew')), 'working-tree hash mismatch')
    await repo.save(policyPath, policy); await repo.save(ledgerPath, three); repo.commit('Mismatched correction edge')
    assert.ok(auditRatchet(repo.root, three, policy).some(e => e.includes('allowance grew')), 'committed hash mismatch')
  }
})

test('N3: a depth-one clone fails closed until full ratchet history is fetched', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500'
  const policy = { corrections: [] }, initial = { [key]: 1 }, grown = { [key]: 2 }
  const repo = await repository(t, initial, policy)
  await repo.save(ledgerPath, grown); repo.commit('Illegal growth hidden beyond shallow boundary')
  const clone = join(repo.root, 'shallow')
  repo.git('clone', '-q', '--depth=1', pathToFileURL(repo.root).href, clone)
  assert.equal(execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: clone, encoding: 'utf8' }).trim(), 'true')
  assert.ok(auditRatchet(clone, grown, policy).some(e => /shallow.*git fetch --unshallow/i.test(e)))
  execFileSync('git', ['fetch', '-q', '--unshallow'], { cwd: clone })
  assert.ok(auditRatchet(clone, grown, policy).some(e => e.includes('allowance grew')))
})

test('H3/L2 self-review: the same correction cannot originate independently on two branches', async t => {
  const key = 'G5|packages/web/src/fixture.tsx|bg-red-500'
  const before = { [key]: 1 }, after = { [key]: 2 }
  const policy = { corrections: [{ id: 1, fromSHA256: snapshotHash(before), toSHA256: snapshotHash(after) }] }
  const repo = await repository(t, before)
  repo.git('checkout', '-qb', 'first')
  await repo.save(policyPath, policy); await repo.save(ledgerPath, after); repo.commit('First introduction')
  repo.git('checkout', '-qb', 'second', 'main')
  await repo.save(policyPath, policy); await repo.save(ledgerPath, after); repo.commit('Second introduction')
  repo.git('checkout', '-q', 'first'); repo.git('merge', '--no-ff', '-m', 'Merge introductions', 'second')
  assert.ok(auditRatchet(repo.root, after, policy).some(e => e.includes('introduced more than once')))
})

test('L8 legacy audit ignores Git replacement grafts that hide growth', async t => {
  const key = 'G5|packages/web/src/a.tsx|bg-red-500'
  const repo = await repository(t, { [key]: 1 })
  await repo.save(ledgerPath, { [key]: 2 }); repo.commit('Forbidden growth')
  await repo.save(ledgerPath, { [key]: 1 }); repo.commit('Shrink again')
  repo.git('replace', '--graft', 'HEAD')
  assert.ok(auditRatchet(repo.root, { [key]: 1 }, { corrections: [] }).some(e => e.includes('grew')), 'Git replacement must not hide a historical increase')
})
