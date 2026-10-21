/** Approval record format, canonical signing bytes and key-set rotation (D-138). */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  approvalPayload,
  approvalSigningBytes,
  canonicalJson,
  decisionDigest,
  revocationPayload,
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
  const unsigned = { at: '2026-10-20T12:00:00.000Z', sourceHash: HASH, snapshotHashes: { 'default.light': HASH }, comment: 'ok', keyId: signer.trusted.keyId, previous: null }
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

type Approved = ReviewRecord & { approval: NonNullable<ReviewRecord['approval']> }

function signRevocation(signer: ReturnType<typeof key>, id: string, unsigned: Omit<NonNullable<ReviewRecord['revocation']>, 'signature'>): string {
  return sign(null, approvalSigningBytes(revocationPayload(id, unsigned)), signer.privateKey).toString('base64')
}

function revocation(signer: ReturnType<typeof key>, record: Approved, at: string): NonNullable<ReviewRecord['revocation']> {
  const unsigned = { at, keyId: signer.trusted.keyId, previous: decisionDigest(record.id, 'approval', record.approval) }
  return { ...unsigned, signature: signRevocation(signer, record.id, unsigned) }
}

function approvedAfter(signer: ReturnType<typeof key>, previous: NonNullable<ReviewRecord['revocation']>, at = '2026-10-23T12:00:00.000Z'): Approved {
  const unsigned = { at, sourceHash: HASH, snapshotHashes: { 'default.light': HASH }, comment: 'again', keyId: signer.trusted.keyId, previous: decisionDigest('button', 'revocation', previous) }
  return { id: 'button', status: 'approved', approval: { ...unsigned, signature: signApprovalPayload(approvalPayload('button', unsigned), signer.privateKey) }, requests: [] }
}

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

  it('treats an approval followed by a signed revocation chained to it as revoked (GPT H2, N1)', () => {
    const record = approved(owner) as Approved
    const both = { ...record, revocation: revocation(owner, record, '2026-10-21T09:00:00.000Z') }
    assert.deepEqual(verifyRecordApproval(both, [owner.trusted]), { state: 'invalid', reason: 'revoked' })
    assert.equal(effectiveStatus(both, 'invalid', { sourceHash: HASH, snapshotHashes: { 'default.light': HASH } }), 'invalid')
    // A revocation that names no decision cannot be ordered against the approval.
    const loose = { ...both.revocation, previous: null }
    const unchained = { ...record, revocation: { ...loose, signature: signRevocation(owner, 'button', loose) } }
    assert.deepEqual(verifyRecordApproval(unchained, [owner.trusted]), { state: 'invalid', reason: 'unchained' })
    // An approval chained after the revocation is the owner's current decision and stays valid.
    const again = approvedAfter(owner, both.revocation)
    assert.equal(verifyRecordApproval({ ...again, revocation: both.revocation }, [owner.trusted]).state, 'valid')
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
    ['extensionless import', "import { plain } from '../../lib/plain'\nexport const usesPlain = plain", 'lib/plain.ts'],
    ['.js specifier for a .ts file', "import { js } from '../../lib/js-specifier.js'\nexport const usesJs = js", 'lib/js-specifier.ts'],
    ['directory index', "import { dir } from '../../lib/dir'\nexport const usesDir = dir", 'lib/dir/index.ts'],
    ['dynamic import', "export const load = () => import('../../lib/lazy')", 'lib/lazy.ts'],
    ['export-from', "export * from '../../lib/reexported'", 'lib/reexported.tsx'],
    ['transitive extensionless re-export', "import { deep } from '../../lib/via'\nexport const usesDeep = deep", 'lib/deep.ts'],
    // GPT N2: syntax the old regular expressions missed.
    ['import without spaces', "import{ plain }from'../../lib/plain'\nexport const usesPlain = plain", 'lib/plain.ts'],
    ['template-literal dynamic import', 'export const load = () => import(`../../lib/lazy`)', 'lib/lazy.ts'],
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

  it('refuses a computed dynamic import, which no hash can follow (GPT N2)', () => {
    const t = tree("const name = 'lazy'\nexport const load = () => import('../../lib/' + name)")
    try {
      assert.throws(() => componentSourceHash(t.dir), /computed dynamic import in components\/a\/a\.tsx/)
    } finally {
      t.dispose()
    }
  })

  const unbound: Array<[string, string, RegExp]> = [
    ['an import() of a missing module behind catch', "export const load = () => import('../../lib/missing').catch(() => null)", /unresolved dynamic-import '\.\.\/\.\.\/lib\/missing'/],
    ['a require() of a missing module behind try', "let x: unknown\ntry { x = require('../../lib/missing') } catch {}\nexport { x }", /unresolved require-call '\.\.\/\.\.\/lib\/missing'/],
    ['a template specifier with a substitution', "export const load = (name: string) => import(`../../lib/${name}.ts`)", /computed dynamic import in components\/a\/a\.tsx/],
    ['a fully computed template specifier', 'export const load = (name: string) => import(`${name}`)', /computed dynamic import in components\/a\/a\.tsx/],
  ]
  // GPT N10/N2: a computed import in a reachable module of any type the resolver loads.
  for (const extension of ['jsx', 'cts', 'cjs', 'mjs']) {
    it(`refuses a computed import in a reachable .${extension} module`, () => {
      const t = tree(`export { load } from '../../lib/loader.${extension}'`)
      try {
        writeFileSync(join(t.src, 'lib', `loader.${extension}`), 'export const load = (name) => import(`${name}`)\n')
        assert.throws(() => componentSourceHash(t.dir), new RegExp(`computed dynamic import in lib/loader\\.${extension}`))
      } finally {
        t.dispose()
      }
    })
  }

  for (const [name, code, expected] of unbound) {
    it(`refuses ${name}, which no hash can bind (GPT N10)`, () => {
      const t = tree(code)
      try {
        assert.throws(() => componentSourceHash(t.dir), expected)
      } finally {
        t.dispose()
      }
    })
  }

  it('fails closed on a local import it cannot resolve', () => {
    const t = tree("import '../../lib/missing-helper'")
    try {
      assert.throws(() => componentSourceHash(t.dir), /cannot resolve the component's dependencies: Could not resolve "\.\.\/\.\.\/lib\/missing-helper"/)
    } finally {
      t.dispose()
    }
  })
})

describe('the decision ledger across committed versions (GPT N1, N8, N9)', async () => {
  const { historyProblems } = await import('../g12-approval-integrity.ts')
  const { serialiseRecord } = await import('../../../catalog/approval/index.ts')
  const owner = key('owner')
  const keys = [owner.trusted]
  const v = (label: string, record: ReviewRecord) => ({ label, json: JSON.parse(serialiseRecord(record)) as unknown, trustedKeys: keys })
  const now = (record: ReviewRecord | null) =>
    record ? ({ label: 'the working tree', state: 'record', record, trustedKeys: keys } as const) : ({ label: 'the working tree', state: 'absent' } as const)
  const a1 = approved(owner) as Approved
  const r1: ReviewRecord = { ...a1, status: 'review', approval: null, revocation: revocation(owner, a1, '2026-10-21T09:00:00.000Z') }
  const a2 = { ...approvedAfter(owner, r1.revocation!, '2026-10-22T09:00:00.000Z'), revocation: r1.revocation }
  const r2: ReviewRecord = { ...a2, status: 'review', approval: null, revocation: revocation(owner, a2, '2026-10-23T09:00:00.000Z') }
  const a3 = { ...approvedAfter(owner, r2.revocation!, '2026-10-24T09:00:00.000Z'), revocation: r2.revocation }
  const deprecated: ReviewRecord = { ...a1, status: 'deprecated', deprecated: { at: '2026-10-22T09:00:00.000Z', replacement: null, note: 'old' } }
  const forged = (previous: string): Approved => {
    const unsigned = { ...a1.approval, previous, at: '2026-10-25T09:00:00.000Z' }
    const { signature: _drop, ...payload } = unsigned
    return { ...a1, approval: { ...payload, signature: signApprovalPayload(approvalPayload('button', payload), owner.privateKey) } }
  }

  it('verifies a long review cycle, on one branch and across the base and the branch (N9)', () => {
    const cycle = [v('c1', a1), v('c2', r1), v('c3', a2), v('c4', r2), v('c5', a3)]
    assert.deepEqual(historyProblems([cycle], now(a3)), [])
    assert.deepEqual(historyProblems([[v('main', a1)], cycle], now(a3)), [])
    // Agents' unsigned edits and a deprecation that keeps the approval stay allowed.
    assert.deepEqual(historyProblems([[v('c1', a1), v('c2', { ...a1, requests: [{ id: 'r', at: '2026-10-21T10:00:00.000Z', text: 'x', state: 'open' }] }), v('c3', deprecated)]], now(deprecated)), [])
  })

  it('fails on an unsigned approval in any committed version, even when the working tree restores the original (N8)', () => {
    const problems = historyProblems([[v('c1', a1), v('c2', { ...a1, approval: null }), v('c3', a1)]], now(a1))
    assert.match(problems.join('\n'), /c2: approval is invalid: unsigned_approval/)
  })

  it('fails on a committed approval whose signature is not even well formed (N8)', () => {
    const broken = { label: 'c2', json: { ...JSON.parse(serialiseRecord(a1)), approval: { ...a1.approval, signature: 'AAAA' } }, trustedKeys: keys }
    assert.match(historyProblems([[v('c1', a1), broken, v('c3', a1)]], now(a1)).join('\n'), /c2 has an unreadable review record, which held the signed approval/)
  })

  it('fails on a signed decision naming an unknown predecessor, committed or current (N8)', () => {
    const unrelated = forged(`sha256:${'c'.repeat(64)}`)
    assert.match(historyProblems([[v('c1', a1), v('c2', unrelated), v('c3', a1)]], now(a1)).join('\n'), /c2: the signed approval of 2026-10-25T09:00:00.000Z names a predecessor that no committed record holds/)
    assert.match(historyProblems([[]], now(unrelated)).join('\n'), /the working tree: the signed approval of .* names a predecessor that no committed record holds/)
  })

  it('fails on a decision that forks the chain or restores an older head (N8)', () => {
    const fork = forged(r1.revocation!.previous!) // chains to A1, skipping the owner's revocation
    assert.match(historyProblems([[v('c1', a1), v('c2', r1), v('c3', fork)]], now(fork)).join('\n'), /c3: the signed approval of .* does not descend from the owner's current decision, the signed revocation/)
    assert.match(historyProblems([[v('c1', a1), v('c2', r1)]], now(a1)).join('\n'), /the working tree: the signed approval of .* does not descend from the owner's current decision/)
  })

  it('keeps deprecations, signed revocations and records from being dropped (N1)', () => {
    assert.match(historyProblems([[v('main~1', deprecated), v('main', { ...a1, status: 'review', approval: null })]], now(a1)).join('\n'), /main removes the deprecation of 2026-10-22T09:00:00.000Z \(main~1\) without a newer signed decision/)
    assert.match(historyProblems([[v('main~2', a1), v('main~1', r1), v('main', { ...r1, revocation: null })]], now(a1)).join('\n'), /main drops the signed revocation of 2026-10-21T09:00:00.000Z \(main~1\)/)
    assert.match(historyProblems([[v('main~1', a1), v('main', r1)]], now(null)).join('\n'), /the working tree removes the review record, which holds the signed revocation of 2026-10-21T09:00:00.000Z \(main\)/)
  })
})

describe('G12 reads the committed history from git (GPT N1, N8, N9)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { historyFromGit, historyProblems } = await import('../g12-approval-integrity.ts')
  const { serialiseRecord } = await import('../../../catalog/approval/index.ts')
  const owner = key('owner')
  const a1 = approved(owner) as Approved
  const r1: ReviewRecord = { ...a1, status: 'review', approval: null, revocation: revocation(owner, a1, '2026-10-21T09:00:00.000Z') }
  const a2 = { ...approvedAfter(owner, r1.revocation!, '2026-10-22T09:00:00.000Z'), revocation: r1.revocation }
  const r2: ReviewRecord = { ...a2, status: 'review', approval: null, revocation: revocation(owner, a2, '2026-10-23T09:00:00.000Z') }
  const a3 = { ...approvedAfter(owner, r2.revocation!, '2026-10-24T09:00:00.000Z'), revocation: r2.revocation }

  function repository() {
    const repo = mkdtempSync(join(tmpdir(), 'guanxi-g12-history-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    const dir = join(repo, 'packages/ui/src/components/button')
    mkdirSync(join(repo, 'packages/ui/catalog'), { recursive: true })
    writeFileSync(join(repo, 'packages/ui/catalog/approval-keys.json'), JSON.stringify({ version: 1, keys: [owner.trusted], rotation: null }))
    const commit = (record: ReviewRecord | null, message: string) => {
      if (record) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'button.review.json'), serialiseRecord(record))
      } else rmSync(dir, { recursive: true, force: true })
      git('add', '-A')
      git('commit', '-q', '-m', message)
    }
    return { repo, git, commit, dispose: () => rmSync(repo, { recursive: true, force: true }) }
  }

  it('verifies a review cycle on a branch against main (N9)', () => {
    const r = repository()
    try {
      r.commit(a1, 'approve')
      r.git('checkout', '-q', '-b', 'feature')
      for (const [record, message] of [[r1, 'r1'], [a2, 'a2'], [r2, 'r2'], [a3, 'a3']] as const) r.commit(record, message)
      const history = historyFromGit(r.repo, r.git('rev-parse', 'main'), ['button']) as Record<string, Parameters<typeof historyProblems>[0]>
      assert.deepEqual(historyProblems(history['button']!, { label: 'the working tree', state: 'record', record: a3, trustedKeys: [owner.trusted] }), [])
    } finally {
      r.dispose()
    }
  })

  it('sees decisions committed on a merged side branch: a replay there fails (GPT N8/N1)', () => {
    const r = repository()
    try {
      r.commit(a1, 'approve on main')
      r.git('checkout', '-q', '-b', 'candidate')
      r.git('commit', '-q', '--allow-empty', '-m', 'unrelated work')
      r.git('checkout', '-q', '-b', 'side')
      r.commit(r1, 'owner requests changes')
      r.commit(a1, 'restore the old approval')
      r.git('checkout', '-q', 'candidate')
      r.git('merge', '-q', '--no-ff', 'side', '-m', 'merge side')
      const history = historyFromGit(r.repo, r.git('rev-parse', 'main'), ['button']) as Record<string, Parameters<typeof historyProblems>[0]>
      const problems = historyProblems(history['button']!, { label: 'the working tree', state: 'record', record: a1, trustedKeys: [owner.trusted] })
      assert.match(problems.join('\n'), /commit [0-9a-f]{7}: the signed approval of .* does not descend from the owner's current decision, the signed revocation of 2026-10-21T09:00:00.000Z/)
      assert.match(problems.join('\n'), /the working tree: the signed approval of .* does not descend from the owner's current decision, the signed revocation/)
    } finally {
      r.dispose()
    }
  })

  it('accepts a legitimate decision merged from a side branch, and fails sides whose decisions diverge (GPT N8/N1)', () => {
    const r = repository()
    try {
      r.commit(a1, 'approve on main')
      r.git('checkout', '-q', '-b', 'side')
      r.commit(r1, 'owner requests changes')
      r.commit(a2, 'owner approves again')
      r.git('checkout', '-q', 'main')
      r.git('merge', '-q', '--no-ff', 'side', '-m', 'merge side')
      const merged = historyFromGit(r.repo, r.git('rev-parse', 'HEAD'), ['button']) as Record<string, Parameters<typeof historyProblems>[0]>
      assert.deepEqual(historyProblems(merged['button']!, { label: 'the working tree', state: 'record', record: a2, trustedKeys: [owner.trusted] }), [])
      // Two branches each add a different decision to A2; merging them cannot keep both heads.
      r.git('checkout', '-q', '-b', 'left')
      r.commit(r2, 'left: request changes')
      r.git('checkout', '-q', 'main')
      r.git('checkout', '-q', '-b', 'right')
      const other: ReviewRecord = { ...a2, status: 'review', approval: null, revocation: revocation(owner, a2 as Approved, '2026-10-23T10:00:00.000Z') }
      r.commit(other, 'right: request changes differently')
      r.git('merge', '-q', '--no-ff', '-X', 'theirs', 'left', '-m', 'merge left into right')
      const diverged = historyFromGit(r.repo, r.git('rev-parse', 'HEAD'), ['button']) as Record<string, Parameters<typeof historyProblems>[0]>
      const now = JSON.parse(execFileSync('git', ['show', 'HEAD:packages/ui/src/components/button/button.review.json'], { cwd: r.repo, encoding: 'utf8' })) as ReviewRecord
      assert.match(historyProblems(diverged['button']!, { label: 'the working tree', state: 'record', record: now, trustedKeys: [owner.trusted] }).join('\n'), /merges decision histories that diverge/)
    } finally {
      r.dispose()
    }
  })

  it('finds a whole component folder removed after a signed decision, and fails closed when shallow (N8)', () => {
    const r = repository()
    try {
      r.commit(a1, 'approve')
      r.commit(r1, 'request changes')
      r.commit(null, 'remove the component')
      const history = historyFromGit(r.repo, r.git('rev-parse', 'HEAD'), []) as Record<string, Parameters<typeof historyProblems>[0]>
      assert.deepEqual(Object.keys(history), ['button'], 'the id comes from history, not from today\'s folders')
      assert.match(historyProblems(history['button']!, { label: 'the working tree', state: 'absent' }).join('\n'), /commit [0-9a-f]{7} removes the review record, which holds the signed revocation/)
      writeFileSync(join(r.repo, '.git', 'shallow'), `${r.git('rev-parse', 'HEAD~1')}\n`)
      assert.match((historyFromGit(r.repo, r.git('rev-parse', 'HEAD'), []) as { error: string }).error, /shallow/)
    } finally {
      r.dispose()
    }
  })
})
