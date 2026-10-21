/**
 * Ed25519 signing and verification of approval records (D-138, gate G12).
 */
import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import { keySetSigningBytes, publicKeyObject, type TrustedKey, type TrustedKeyFile } from './keys.ts'
import {
  approvalPayload,
  revocationPayload,
  type ApprovalPayload,
  type DecisionKind,
  type ReviewApproval,
  type ReviewRecord,
  type ReviewRevocation,
  type RevocationPayload,
} from './record.ts'

export type ApprovalInvalidReason =
  | 'unsigned_approval'
  | 'approval_on_non_approved_record'
  | 'untrusted_key'
  | 'bad_signature'
  | 'revoked'
  | 'unchained'

export type ApprovalVerdict =
  | { state: 'absent' }
  | { state: 'valid'; keyId: string }
  | { state: 'invalid'; reason: ApprovalInvalidReason }

/**
 * The chain link of a signed decision: sha256 over the canonical JSON of its signed payload
 * plus its signature. The payload carries the schema and component id, so a link never matches
 * another component's or another kind's decision.
 */
export function decisionDigest(id: string, kind: DecisionKind, decision: ReviewApproval | ReviewRevocation): string {
  const { signature, ...signed } = decision
  const payload =
    kind === 'approval' ? approvalPayload(id, signed as Omit<ReviewApproval, 'signature'>) : revocationPayload(id, signed as Omit<ReviewRevocation, 'signature'>)
  return `sha256:${createHash('sha256').update(canonicalJson({ ...payload, signature }), 'utf8').digest('hex')}`
}

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
  kind: DecisionKind
  at: string
  digest: string
  previous: string | null
}

function signedDecisions(record: ReviewRecord, trustedKeys: readonly TrustedKey[]): SignedDecision[] {
  const decisions: SignedDecision[] = []
  const { approval } = record
  if (approval) {
    const key = trustedKeys.find((candidate) => candidate.keyId === approval.keyId)
    const { signature, ...signed } = approval
    if (key && verifies(approvalSigningBytes(approvalPayload(record.id, signed)), key, signature)) {
      decisions.push({ kind: 'approval', at: approval.at, digest: decisionDigest(record.id, 'approval', approval), previous: approval.previous })
    }
  }
  const revocation = record.revocation ?? null
  if (revocation && verifyRecordRevocation(record, trustedKeys).state === 'valid') {
    decisions.push({ kind: 'revocation', at: revocation.at, digest: decisionDigest(record.id, 'revocation', revocation), previous: revocation.previous })
  }
  return decisions
}

export type DecisionChain =
  | { state: 'empty' }
  | { state: 'chained'; head: SignedDecision; /** digests the head reaches through `previous` */ reaches: string[] }
  | { state: 'unchained' }

/**
 * The record's validly signed decisions as a chain: with both an approval and a revocation,
 * one must name the other as `previous`; that one is the head (the owner's current decision).
 */
export function decisionChain(record: ReviewRecord, trustedKeys: readonly TrustedKey[]): DecisionChain {
  const decisions = signedDecisions(record, trustedKeys)
  if (decisions.length === 0) return { state: 'empty' }
  if (decisions.length === 1) {
    const [head] = decisions as [SignedDecision]
    return { state: 'chained', head, reaches: [head.digest, ...(head.previous ? [head.previous] : [])] }
  }
  const [a, b] = decisions as [SignedDecision, SignedDecision]
  const head = a.previous === b.digest ? a : b.previous === a.digest ? b : null
  if (!head) return { state: 'unchained' }
  const tail = head === a ? b : a
  return { state: 'chained', head, reaches: [head.digest, tail.digest, ...(tail.previous ? [tail.previous] : [])] }
}

export interface LifecycleVersion {
  /** Where this version comes from, for messages: a commit, the base branch, the working tree. */
  label: string
  /** The parsed record, or null when the file is absent at this version. */
  record: ReviewRecord | null
  trustedKeys: readonly TrustedKey[]
}

/**
 * Lifecycle barriers survive every committed change (N1): a version may drop the owner's
 * current signed decision only for a newer signed decision that chains to it, and may drop a
 * deprecation only for a newer signed decision. An unsigned edit therefore cannot reset the
 * state an old approval would need to come back. Returns the problems (none when allowed).
 */
export function lifecycleTransition(before: LifecycleVersion, after: LifecycleVersion): string[] {
  if (!before.record) return []
  const previous = decisionChain(before.record, before.trustedKeys)
  const deprecation = before.record.deprecated ?? null
  if (previous.state !== 'chained' && deprecation === null) return []
  if (!after.record) {
    return [`${after.label} removes the review record, which holds ${previous.state === 'chained' ? `the signed ${previous.head.kind} of ${previous.head.at}` : `the deprecation of ${deprecation!.at}`} (${before.label})`]
  }
  const problems: string[] = []
  const next = decisionChain(after.record, after.trustedKeys)
  if (previous.state === 'chained' && (next.state !== 'chained' || !next.reaches.includes(previous.head.digest))) {
    problems.push(`${after.label} drops the signed ${previous.head.kind} of ${previous.head.at} (${before.label}) without a signed decision that chains to it`)
  }
  if (deprecation !== null && JSON.stringify(after.record.deprecated ?? null) !== JSON.stringify(deprecation)) {
    const newer =
      next.state === 'chained' &&
      (previous.state !== 'chained' || next.head.digest !== previous.head.digest) &&
      Date.parse(next.head.at) > Date.parse(deprecation.at)
    if (!newer) problems.push(`${after.label} removes the deprecation of ${deprecation.at} (${before.label}) without a newer signed decision`)
  }
  return problems
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
  // A deprecation keeps the approval it supersedes, so the chain stays intact.
  if (record.status !== 'approved' && record.status !== 'deprecated') {
    return { state: 'invalid', reason: 'approval_on_non_approved_record' }
  }
  const key = trustedKeys.find((candidate) => candidate.keyId === approval.keyId)
  if (!key) return { state: 'invalid', reason: 'untrusted_key' }
  const { signature, ...signed } = approval
  if (!verifies(approvalSigningBytes(approvalPayload(record.id, signed)), key, signature)) {
    return { state: 'invalid', reason: 'bad_signature' }
  }
  // The head of the decision chain wins: a revocation that chains to this approval revokes it.
  const chain = decisionChain(record, trustedKeys)
  if (chain.state === 'unchained') return { state: 'invalid', reason: 'unchained' }
  if (chain.state === 'chained' && chain.head.kind === 'revocation') return { state: 'invalid', reason: 'revoked' }
  return { state: 'valid', keyId: key.keyId }
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
      reason:
        | 'unsigned_change'
        | 'untrusted_rotation_key'
        | 'bad_rotation_signature'
        | 'stale_rotation_version'
        | 'version_changed_without_rotation'
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
  const version = current.version ?? 0
  const baseVersion = base.version ?? 0
  if (sameKeys(current.keys, base.keys)) {
    if (version === baseVersion) return { state: 'unchanged' }
    // The version is part of the trust state: resetting or bumping it unsigned would let an
    // old rotation (signed for a lower version) apply again later.
    if (!current.rotation || base.keys.length === 0) return { state: 'invalid', reason: 'version_changed_without_rotation' }
  } else if (base.keys.length === 0) {
    return { state: 'bootstrap' }
  }
  const rotation = current.rotation
  if (!rotation) return { state: 'invalid', reason: 'unsigned_change' }
  const signer = base.keys.find((key) => key.keyId === rotation.signedBy)
  if (!signer) return { state: 'invalid', reason: 'untrusted_rotation_key' }
  if (version <= baseVersion) return { state: 'invalid', reason: 'stale_rotation_version' }
  return verifies(keySetSigningBytes(current.keys, version), signer, rotation.signature)
    ? { state: 'rotated', signedBy: signer.keyId }
    : { state: 'invalid', reason: 'bad_rotation_signature' }
}
