/**
 * Ed25519 signing and verification of approval records (D-138, gate G12).
 */
import { sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import { keySetSigningBytes, publicKeyObject, type TrustedKey, type TrustedKeyFile } from './keys.ts'
import {
  approvalPayload,
  revocationPayload,
  type ApprovalPayload,
  type ReviewRecord,
  type RevocationPayload,
} from './record.ts'

export type ApprovalInvalidReason =
  | 'unsigned_approval'
  | 'approval_on_non_approved_record'
  | 'untrusted_key'
  | 'bad_signature'

export type ApprovalVerdict =
  | { state: 'absent' }
  | { state: 'valid'; keyId: string }
  | { state: 'invalid'; reason: ApprovalInvalidReason }

export function approvalSigningBytes(payload: ApprovalPayload | RevocationPayload): Buffer {
  return Buffer.from(canonicalJson(payload), 'utf8')
}

function verifies(bytes: Buffer, key: TrustedKey, signature: string): boolean {
  try {
    return verify(null, bytes, publicKeyObject(key), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export type RevocationVerdict = { state: 'absent' } | { state: 'valid'; keyId: string } | { state: 'invalid' }

export function verifyRecordRevocation(record: ReviewRecord, trustedKeys: readonly TrustedKey[]): RevocationVerdict {
  const revocation = record.revocation ?? null
  if (revocation === null) return { state: 'absent' }
  const key = trustedKeys.find((candidate) => candidate.keyId === revocation.keyId)
  if (!key) return { state: 'invalid' }
  const { signature, ...signed } = revocation
  return verifies(approvalSigningBytes(revocationPayload(record.id, signed)), key, signature)
    ? { state: 'valid', keyId: key.keyId }
    : { state: 'invalid' }
}

export interface SignedDecision {
  kind: 'approval' | 'revocation'
  at: string
}

/** The newest owner-signed decision in a record (a revocation wins a tie), or null. */
export function latestSignedDecision(record: ReviewRecord, trustedKeys: readonly TrustedKey[]): SignedDecision | null {
  const decisions: SignedDecision[] = []
  if (record.approval && verifyRecordApproval(record, trustedKeys).state === 'valid') {
    decisions.push({ kind: 'approval', at: record.approval.at })
  }
  if (record.revocation && verifyRecordRevocation(record, trustedKeys).state === 'valid') {
    decisions.push({ kind: 'revocation', at: record.revocation.at })
  }
  decisions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.kind === 'revocation' ? -1 : 1))
  return decisions[0] ?? null
}

/**
 * True when `approvalAt` cannot follow `newest` on the base: it is older than a base approval,
 * or not newer than a base revocation (an approval restored over the owner's change request).
 */
export function approvalPrecedes(approvalAt: string, newest: SignedDecision): boolean {
  const approval = Date.parse(approvalAt)
  const decision = Date.parse(newest.at)
  return newest.kind === 'revocation' ? approval <= decision : approval < decision
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
  return verifies(approvalSigningBytes(approvalPayload(record.id, signed)), key, signature)
    ? { state: 'valid', keyId: key.keyId }
    : { state: 'invalid', reason: 'bad_signature' }
}

export function signKeySet(keys: readonly TrustedKey[], version: number, signedBy: string, privateKey: KeyObject) {
  return { signedBy, signature: sign(null, keySetSigningBytes(keys, version), privateKey).toString('base64') }
}

export type KeySetVerdict =
  | { state: 'unchanged' }
  | { state: 'rotated'; signedBy: string }
  | { state: 'bootstrap' }
  | {
      state: 'invalid'
      reason: 'unsigned_change' | 'untrusted_rotation_key' | 'bad_rotation_signature' | 'stale_rotation_version'
    }

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
  const version = current.version ?? 0
  if (version <= (base.version ?? 0)) return { state: 'invalid', reason: 'stale_rotation_version' }
  return verifies(keySetSigningBytes(current.keys, version), signer, rotation.signature)
    ? { state: 'rotated', signedBy: signer.keyId }
    : { state: 'invalid', reason: 'bad_rotation_signature' }
}
