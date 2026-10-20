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
    assert.deepEqual(verifyKeySetChange({ keys: [base.trusted] }, { keys: [base.trusted] }), { state: 'unchanged' })
    assert.deepEqual(verifyKeySetChange({ keys: [base.trusted] }, { keys: [] }), { state: 'bootstrap' })
    const keys = [base.trusted, added.trusted]
    assert.deepEqual(verifyKeySetChange({ keys }, { keys: [base.trusted] }), { state: 'invalid', reason: 'unsigned_change' })
    const byAdded = signKeySet(keys, added.trusted.keyId, added.privateKey)
    assert.deepEqual(verifyKeySetChange({ keys, rotation: byAdded }, { keys: [base.trusted] }), {
      state: 'invalid',
      reason: 'untrusted_rotation_key',
    })
    const forged = { signedBy: base.trusted.keyId, signature: byAdded.signature }
    assert.deepEqual(verifyKeySetChange({ keys, rotation: forged }, { keys: [base.trusted] }), {
      state: 'invalid',
      reason: 'bad_rotation_signature',
    })
    const rotation = signKeySet(keys, base.trusted.keyId, base.privateKey)
    assert.deepEqual(verifyKeySetChange({ keys, rotation }, { keys: [base.trusted] }), {
      state: 'rotated',
      signedBy: base.trusted.keyId,
    })
  })
})
