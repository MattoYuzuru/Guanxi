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

  it('treats an approval followed by a signed revocation in the same record as revoked (GPT H2)', async () => {
    const { revocationPayload, approvalSigningBytes } = await import('../../../catalog/approval/index.ts')
    const { sign } = await import('node:crypto')
    const record = approved(owner)
    const at = '2026-10-21T09:00:00.000Z'
    const revocation = {
      at,
      keyId: owner.trusted.keyId,
      signature: sign(null, approvalSigningBytes(revocationPayload('button', { at, keyId: owner.trusted.keyId })), owner.privateKey).toString('base64'),
    }
    const both = { ...record, revocation }
    assert.deepEqual(verifyRecordApproval(both, [owner.trusted]), { state: 'invalid', reason: 'revoked' })
    assert.equal(effectiveStatus(both, 'invalid', { sourceHash: HASH, snapshotHashes: { 'default.light': HASH } }), 'invalid')
    // An approval newer than the revocation is the owner's latest decision and stays valid.
    const earlier = '2026-10-19T09:00:00.000Z'
    const older = {
      at: earlier,
      keyId: owner.trusted.keyId,
      signature: sign(null, approvalSigningBytes(revocationPayload('button', { at: earlier, keyId: owner.trusted.keyId })), owner.privateKey).toString('base64'),
    }
    assert.equal(verifyRecordApproval({ ...record, revocation: older }, [owner.trusted]).state, 'valid')
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

describe('component source hash covers what the component runs (GPT H3)', async () => {
  const { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { componentSourceHash } = await import('../../../catalog/approval/hash.ts')

  function tree(imports: string) {
    const src = join(mkdtempSync(join(tmpdir(), 'guanxi-hash-forms-')), 'src')
    const write = (path: string, text: string) => {
      mkdirSync(join(src, path, '..'), { recursive: true })
      writeFileSync(join(src, path), text)
    }
    write('components/a/a.tsx', `${imports}\nexport const A = 1\n`)
    write('lib/plain.ts', 'export const plain = 1\n')
    write('lib/js-specifier.ts', 'export const js = 1\n')
    write('lib/dir/index.ts', 'export const dir = 1\n')
    write('lib/lazy.ts', 'export const lazy = 1\n')
    write('lib/reexported.tsx', 'export const re = 1\n')
    write('lib/deep.ts', 'export const deep = 1\n')
    write('lib/via.ts', "export { deep } from './deep'\n")
    write('styles/base.css', '.gx-focusable:focus-visible { outline: var(--x) solid; }\n')
    write('styles/tailwind-reference.css', "@import 'tailwindcss';\n")
    write('../generated/tokens.css', ':root { --x: red; }\n')
    write('../generated/theme.css', '@theme inline { --color-x: var(--x); }\n')
    write('../fonts/fonts.css', "@font-face { font-family: 'X'; src: url('./x.woff2'); }\n")
    write('../fonts/sans/x.woff2', 'font bytes')
    return { src, dir: join(src, 'components', 'a'), dispose: () => rmSync(join(src, '..'), { recursive: true, force: true }) }
  }

  const forms: Array<[string, string, string]> = [
    ['extensionless import', "import { plain } from '../../lib/plain'", 'lib/plain.ts'],
    ['.js specifier for a .ts file', "import { js } from '../../lib/js-specifier.js'", 'lib/js-specifier.ts'],
    ['directory index', "import { dir } from '../../lib/dir'", 'lib/dir/index.ts'],
    ['dynamic import', "export const load = () => import('../../lib/lazy')", 'lib/lazy.ts'],
    ['export-from', "export * from '../../lib/reexported'", 'lib/reexported.tsx'],
    ['transitive extensionless re-export', "import { deep } from '../../lib/via'", 'lib/deep.ts'],
    ['shared focus styles', '', 'styles/base.css'],
    ['the Tailwind reference', '', 'styles/tailwind-reference.css'],
    ['generated tokens (outside src)', '', '../generated/tokens.css'],
    ['the generated Tailwind theme', '', '../generated/theme.css'],
    ['font declarations', '', '../fonts/fonts.css'],
    ['a font file', '', '../fonts/sans/x.woff2'],
  ]

  for (const [name, imports, changed] of forms) {
    it(`changes when a dependency reached by ${name} changes`, () => {
      const t = tree(imports)
      try {
        const before = componentSourceHash(t.dir)
        appendFileSync(join(t.src, changed), '\n// behaviour changed\n')
        assert.notEqual(componentSourceHash(t.dir), before)
      } finally {
        t.dispose()
      }
    })
  }

  it('fails closed on a local import it cannot resolve', () => {
    const t = tree("import '../../lib/missing-helper'")
    try {
      assert.throws(() => componentSourceHash(t.dir), /cannot resolve '\.\.\/\.\.\/lib\/missing-helper'/)
    } finally {
      t.dispose()
    }
  })
})
