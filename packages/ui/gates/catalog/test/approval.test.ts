/** Approval record format, canonical signing bytes and key-set rotation (D-138). */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  approvalPayload,
  canonicalJson,
  exportPublicKey,
  parseReviewRecord,
  parseTrustedKeys,
  signApprovalPayload,
  signKeySet,
  verifyKeySetChange,
  verifyRecordApproval,
  type ReviewRecord,
  type TrustedKey,
} from '../../../catalog/approval/index.ts'
import { effectiveStatus } from '../../../catalog/approval/status.ts'

function key(note: string) {
  const pair = generateKeyPairSync('ed25519')
  const { keyId, publicKey } = exportPublicKey(pair.publicKey)
  const trusted: TrustedKey = { keyId, algorithm: 'ed25519', publicKey, addedAt: '2026-10-20T00:00:00.000Z', note }
  return { ...pair, trusted }
}

const HASH = `sha256:${'a'.repeat(64)}`

function approved(signer: ReturnType<typeof key>, overrides: Partial<NonNullable<ReviewRecord['approval']>> = {}): ReviewRecord {
  const unsigned = { at: '2026-10-20T12:00:00.000Z', sourceHash: HASH, snapshotHashes: { 'default.light': HASH }, comment: 'ok', keyId: signer.trusted.keyId }
  return {
    id: 'button',
    status: 'approved',
    approval: { ...unsigned, signature: signApprovalPayload(approvalPayload('button', unsigned), signer.privateKey), ...overrides },
    requests: [],
  }
}

describe('canonical JSON', () => {
  it('sorts keys at every level and is stable', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 'é' }], c: null } }), '{"a":{"c":null,"d":[2,{"y":"é","z":1}]},"b":1}')
    assert.throws(() => canonicalJson({ a: Number.NaN }))
  })
})

describe('approval verification', () => {
  const owner = key('owner')
  const other = key('other')

  it('accepts a record signed by a trusted key', () => {
    assert.deepEqual(verifyRecordApproval(approved(owner), [owner.trusted]), { state: 'valid', keyId: owner.trusted.keyId })
  })

  it('rejects a signature by a key that is not trusted, even if it is internally valid', () => {
    assert.deepEqual(verifyRecordApproval(approved(other), [owner.trusted]), { state: 'invalid', reason: 'untrusted_key' })
  })

  it('rejects a record whose key id is relabelled to a trusted key', () => {
    const forged = approved(other)
    forged.approval = { ...forged.approval!, keyId: owner.trusted.keyId }
    assert.deepEqual(verifyRecordApproval(forged, [owner.trusted]), { state: 'invalid', reason: 'bad_signature' })
  })

  it('rejects approvals on records that are not approved and approved records without one', () => {
    const record = approved(owner)
    assert.deepEqual(verifyRecordApproval({ ...record, status: 'review' }, [owner.trusted]), {
      state: 'invalid',
      reason: 'approval_on_non_approved_record',
    })
    assert.deepEqual(verifyRecordApproval({ ...record, approval: null }, [owner.trusted]), {
      state: 'invalid',
      reason: 'unsigned_approval',
    })
  })

  it('derives stale from hashes and invalid from signatures', () => {
    const record = approved(owner)
    const current = { sourceHash: HASH, snapshotHashes: { 'default.light': HASH } }
    assert.equal(effectiveStatus(record, 'valid', current), 'approved')
    assert.equal(effectiveStatus(record, 'valid', { ...current, sourceHash: `sha256:${'b'.repeat(64)}` }), 'stale')
    assert.equal(effectiveStatus(record, 'valid', { ...current, snapshotHashes: {} }), 'stale')
    assert.equal(effectiveStatus(record, 'invalid', current), 'invalid')
    assert.equal(effectiveStatus({ ...record, status: 'draft', approval: null }, 'absent', current), 'draft')
  })

  it('rejects unknown fields so nothing unsigned can hide in a record', () => {
    const parsed = parseReviewRecord({ ...approved(owner), approvedBy: 'owner' }, 'button')
    assert.equal(parsed.ok, false)
    const nested = approved(owner) as unknown as { approval: Record<string, unknown> }
    nested.approval['owner'] = true
    assert.equal(parseReviewRecord(nested, 'button').ok, false)
    assert.equal(parseReviewRecord(approved(owner), 'badge').ok, false)
  })
})

describe('trusted key set', () => {
  const base = key('base')
  const added = key('added')

  it('rejects a key whose id does not match its public key', () => {
    const parsed = parseTrustedKeys({ keys: [{ ...base.trusted, keyId: added.trusted.keyId }] })
    assert.equal(parsed.ok, false)
  })

  it('allows an unchanged set, flags a bootstrap and requires a rotation signed by a base key', () => {
    const baseFile = { version: 1, keys: [base.trusted] }
    assert.deepEqual(verifyKeySetChange({ version: 1, keys: [base.trusted] }, baseFile), { state: 'unchanged' })
    assert.deepEqual(verifyKeySetChange({ version: 1, keys: [base.trusted] }, { keys: [] }), { state: 'bootstrap' })
    const keys = [base.trusted, added.trusted]
    assert.deepEqual(verifyKeySetChange({ version: 2, keys }, baseFile), { state: 'invalid', reason: 'unsigned_change' })
    const byAdded = signKeySet(keys, 2, added.trusted.keyId, added.privateKey)
    assert.deepEqual(verifyKeySetChange({ version: 2, keys, rotation: byAdded }, baseFile), {
      state: 'invalid',
      reason: 'untrusted_rotation_key',
    })
    const forged = { signedBy: base.trusted.keyId, signature: byAdded.signature }
    assert.deepEqual(verifyKeySetChange({ version: 2, keys, rotation: forged }, baseFile), {
      state: 'invalid',
      reason: 'bad_rotation_signature',
    })
    const rotation = signKeySet(keys, 2, base.trusted.keyId, base.privateKey)
    assert.deepEqual(verifyKeySetChange({ version: 2, keys, rotation }, baseFile), {
      state: 'rotated',
      signedBy: base.trusted.keyId,
    })
  })

  it('rejects an unsigned version reset that would re-enable an old rotation (GPT H1)', () => {
    const keys = [base.trusted, added.trusted]
    const oldRotation = signKeySet(keys, 2, base.trusted.keyId, base.privateKey)
    const mainNow = { version: 3, keys: [base.trusted] }
    // Step 1: same keys, version reset to 0 (or omitted), no signature.
    assert.deepEqual(verifyKeySetChange({ version: 0, keys: [base.trusted] }, mainNow), {
      state: 'invalid',
      reason: 'version_changed_without_rotation',
    })
    assert.deepEqual(verifyKeySetChange({ keys: [base.trusted] }, mainNow), {
      state: 'invalid',
      reason: 'version_changed_without_rotation',
    })
    // Step 2 (had step 1 been accepted onto main): the old v2 rotation must still not apply.
    assert.deepEqual(verifyKeySetChange({ version: 2, keys, rotation: oldRotation }, { version: 3, keys: [base.trusted] }), {
      state: 'invalid',
      reason: 'stale_rotation_version',
    })
    // An unsigned version bump on unchanged keys is refused too; a signed one is a rotation.
    assert.deepEqual(verifyKeySetChange({ version: 4, keys: [base.trusted] }, mainNow), {
      state: 'invalid',
      reason: 'version_changed_without_rotation',
    })
    const bump = signKeySet([base.trusted], 4, base.trusted.keyId, base.privateKey)
    assert.deepEqual(verifyKeySetChange({ version: 4, keys: [base.trusted], rotation: bump }, mainNow), {
      state: 'rotated',
      signedBy: base.trusted.keyId,
    })
  })

  it('rejects a replayed rotation once the base moved past its version', () => {
    const keys = [base.trusted, added.trusted]
    // main: v1 [base] → v2 [base, added] (rotation by base) → v3 [base] (added revoked).
    const oldRotation = signKeySet(keys, 2, base.trusted.keyId, base.privateKey)
    const mainNow = { version: 3, keys: [base.trusted] }
    assert.deepEqual(verifyKeySetChange({ version: 2, keys, rotation: oldRotation }, mainNow), {
      state: 'invalid',
      reason: 'stale_rotation_version',
    })
  })
})

describe('component source hash', async () => {
  const { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { componentSourceHash } = await import('../../../catalog/approval/hash.ts')

  function tree() {
    const src = join(mkdtempSync(join(tmpdir(), 'guanxi-hash-')), 'src')
    const write = (path: string, text: string) => {
      mkdirSync(join(src, path, '..'), { recursive: true })
      writeFileSync(join(src, path), text)
    }
    write('components/a/a.tsx', "import '../b/b.css'\nimport { x } from '../../lib/x.ts'\nimport { t } from '../../i18n/messages.ts'\nexport const A = x + t\n")
    write('components/a/a.docs.md', '# A\n')
    write('components/a/a.review.json', '{}\n')
    write('components/b/b.css', '.b { color: var(--x); }\n')
    write('lib/x.ts', 'export const x = 1\n')
    write('i18n/messages.ts', "export const t = 'a'\n")
    return { src, dir: join(src, 'components', 'a'), write, dispose: () => rmSync(join(src, '..'), { recursive: true, force: true }) }
  }

  it('ignores junk, symlinks, its own docs and review record, and the message catalog', () => {
    const t = tree()
    try {
      const before = componentSourceHash(t.dir)
      writeFileSync(join(t.dir, '.DS_Store'), 'finder')
      writeFileSync(join(t.dir, 'a.tsx.orig'), 'merge leftover')
      writeFileSync(join(t.dir, '.a.review.json.123.abcd.tmp'), '{}')
      symlinkSync('/etc/hosts', join(t.dir, 'linked.tsx'))
      appendFileSync(join(t.dir, 'a.docs.md'), 'more docs\n')
      appendFileSync(join(t.dir, 'a.review.json'), '\n')
      appendFileSync(join(t.src, 'i18n', 'messages.ts'), "export const u = 'b'\n")
      assert.equal(componentSourceHash(t.dir), before)
    } finally {
      t.dispose()
    }
  })

  it('changes when the component, a shared file it imports, or a nested docs file changes', () => {
    const t = tree()
    try {
      const seen = new Set([componentSourceHash(t.dir)])
      for (const path of ['components/b/b.css', 'lib/x.ts', 'components/a/a.tsx']) {
        appendFileSync(join(t.src, path), '\n/* changed */\n')
        seen.add(componentSourceHash(t.dir))
      }
      t.write('components/a/nested/extra.docs.md', 'nested docs are part of the component\n')
      seen.add(componentSourceHash(t.dir))
      assert.equal(seen.size, 5)
    } finally {
      t.dispose()
    }
  })

  it('hashes CRLF and LF checkouts the same', () => {
    const t = tree()
    try {
      const lf = componentSourceHash(t.dir)
      t.write('components/a/a.tsx', "import '../b/b.css'\r\nimport { x } from '../../lib/x.ts'\r\nimport { t } from '../../i18n/messages.ts'\r\nexport const A = x + t\r\n")
      assert.equal(componentSourceHash(t.dir), lf)
    } finally {
      t.dispose()
    }
  })
})
