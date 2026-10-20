/**
 * Ed25519 signing and verification of approval records (D-138, gate G12).
 */
import { sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import { keySetSigningBytes, publicKeyObject, type TrustedKey, type TrustedKeyFile } from './keys.ts'
import { approvalPayload, type ApprovalPayload, type ReviewRecord } from './record.ts'

export type ApprovalInvalidReason =
  | 'unsigned_approval'
  | 'approval_on_non_approved_record'
  | 'untrusted_key'
  | 'bad_signature'

export type ApprovalVerdict =
  | { state: 'absent' }
  | { state: 'valid'; keyId: string }
  | { state: 'invalid'; reason: ApprovalInvalidReason }

export function approvalSigningBytes(payload: ApprovalPayload): Buffer {
  return Buffer.from(canonicalJson(payload), 'utf8')
}

export function signApprovalPayload(payload: ApprovalPayload, privateKey: KeyObject): string {
  return sign(null, approvalSigningBytes(payload), privateKey).toString('base64')
}

export function verifyRecordApproval(
  record: ReviewRecord,
  trustedKeys: readonly TrustedKey[],
): ApprovalVerdict {
  const { approval } = record
  if (approval === null) {
    return record.status === 'approved'
      ? { state: 'invalid', reason: 'unsigned_approval' }
      : { state: 'absent' }
  }
  if (record.status !== 'approved') {
    return { state: 'invalid', reason: 'approval_on_non_approved_record' }
  }
  const key = trustedKeys.find((candidate) => candidate.keyId === approval.keyId)
  if (!key) return { state: 'invalid', reason: 'untrusted_key' }
  const { signature, ...signed } = approval
  let ok = false
  try {
    ok = verify(
      null,
      approvalSigningBytes(approvalPayload(record.id, signed)),
      publicKeyObject(key),
      Buffer.from(signature, 'base64'),
    )
  } catch {
    ok = false
  }
  return ok ? { state: 'valid', keyId: key.keyId } : { state: 'invalid', reason: 'bad_signature' }
}

export function signKeySet(keys: readonly TrustedKey[], signedBy: string, privateKey: KeyObject) {
  return { signedBy, signature: sign(null, keySetSigningBytes(keys), privateKey).toString('base64') }
}

export type KeySetVerdict =
  | { state: 'unchanged' }
  | { state: 'rotated'; signedBy: string }
  | { state: 'bootstrap' }
  | { state: 'invalid'; reason: 'unsigned_change' | 'untrusted_rotation_key' | 'bad_rotation_signature' }

function sameKeys(a: readonly TrustedKey[], b: readonly TrustedKey[]): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/**
 * The trusted key set may change only on the base branch itself, or with a rotation signed by
 * a key that the base branch already trusts. Adding the first key on a branch ("bootstrap")
 * is reported separately: only the owner can confirm it, by merging it into the base branch.
 */
export function verifyKeySetChange(current: TrustedKeyFile, base: TrustedKeyFile): KeySetVerdict {
  if (sameKeys(current.keys, base.keys)) return { state: 'unchanged' }
  if (base.keys.length === 0) return { state: 'bootstrap' }
  const rotation = current.rotation
  if (!rotation) return { state: 'invalid', reason: 'unsigned_change' }
  const signer = base.keys.find((key) => key.keyId === rotation.signedBy)
  if (!signer) return { state: 'invalid', reason: 'untrusted_rotation_key' }
  let ok = false
  try {
    ok = verify(null, keySetSigningBytes(current.keys), publicKeyObject(signer), Buffer.from(rotation.signature, 'base64'))
  } catch {
    ok = false
  }
  return ok ? { state: 'rotated', signedBy: signer.keyId } : { state: 'invalid', reason: 'bad_rotation_signature' }
}
