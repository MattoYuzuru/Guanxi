/**
 * Writes component review records for the in-app catalog (D-138). One owner per record: this
 * process serialises writes per component and replaces the file atomically. Approvals are
 * signed with the owner key and verified against the committed trusted keys before they are
 * written, so the node never writes a record that gate G12 would reject.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  UiCatalogReadOnlyReason,
  UiCatalogReviewCapability,
  UiComponentReview,
  UiComponentReviewBody,
} from '@guanxi/contract'
import {
  COMPONENT_ID_PATTERN,
  SourceHashError,
  approvalPayload,
  approvalSigningBytes,
  componentSnapshotHashes,
  componentSourceHash,
  effectiveStatus,
  loadTrustedKeys,
  parseReviewRecord,
  decisionChain,
  decisionDigest,
  revocationPayload,
  sameSnapshotHashes,
  serialiseRecord,
  uiPaths,
  verifyRecordApproval,
  type ReviewRecord,
  type TrustedKey,
} from '@guanxi/ui/approval'
import { SignerError, type ApprovalSigner } from './signer.ts'

export type UiCatalogErrorCode =
  | 'component_not_found'
  | 'approvals_read_only'
  | 'review_conflict'
  | 'approval_signer_unavailable'

export class UiCatalogError extends Error {
  readonly code: UiCatalogErrorCode
  readonly reason: string

  constructor(code: UiCatalogErrorCode, reason: string, message: string) {
    super(message)
    this.name = 'UiCatalogError'
    this.code = code
    this.reason = reason
  }
}

export interface UiCatalogReviewOptions {
  /** `packages/ui` of the source checkout, or null when the node is not running from one. */
  uiRoot: string | null
  /** Bundled release build: the catalog is read-only whatever the filesystem says. */
  release: boolean
  signer: ApprovalSigner
  now?: () => Date
}

function newRecord(id: string): ReviewRecord {
  return { $schema: '../../../catalog/review.schema.json', id, status: 'draft', approval: null, requests: [] }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

export class UiCatalogReviewService {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => Date
  private readonly options: UiCatalogReviewOptions
  /** The real path of packages/ui when the node started: every write stays below it (N4). */
  private readonly anchor: string | null

  constructor(options: UiCatalogReviewOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.anchor = options.uiRoot === null ? null : realpathSync(options.uiRoot)
  }

  /** Static capability: never reads the secret, so it never prompts the owner. */
  async capability(): Promise<UiCatalogReviewCapability> {
    const observedAt = this.now().toISOString()
    const readOnly = (reason: UiCatalogReadOnlyReason, keyId: string | null = null) => ({
      writable: false,
      reason,
      keyId,
      observedAt,
    })
    if (this.options.release) return readOnly('release_build')
    if (this.options.uiRoot === null) return readOnly('not_source_checkout')
    let status: Awaited<ReturnType<ApprovalSigner['status']>>
    try {
      status = await this.options.signer.status()
    } catch {
      // The keychain tool could not run at all: report the key as unavailable, not a 500.
      return readOnly('signing_key_missing')
    }
    if (status.state === 'unavailable') return readOnly(status.reason)
    let trusted: string[]
    try {
      trusted = this.trustedKeyIds()
    } catch {
      trusted = []
    }
    if (!trusted.includes(status.keyId)) return readOnly('signing_key_untrusted', status.keyId)
    return { writable: true, reason: null, keyId: status.keyId, observedAt }
  }

  get(id: string): UiComponentReview {
    const uiRoot = this.requireCheckout()
    const { record } = this.readRecord(uiRoot, id)
    return this.project(uiRoot, id, record)
  }

  submit(id: string, body: UiComponentReviewBody): Promise<UiComponentReview> {
    if (this.options.release) {
      return Promise.reject(new UiCatalogError('approvals_read_only', 'release_build', 'Release builds are read-only'))
    }
    const uiRoot = this.requireCheckout()
    this.requireComponent(uiRoot, id)
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => this.submitLocked(uiRoot, id, body))
    this.locks.set(id, next)
    void next.finally(() => {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }).catch(() => undefined)
    return next
  }

  private async submitLocked(uiRoot: string, id: string, body: UiComponentReviewBody): Promise<UiComponentReview> {
    const paths = uiPaths(uiRoot)
    const original = existsSync(paths.reviewFile(id)) ? readFileSync(paths.reviewFile(id), 'utf8') : null
    const { record } = this.readRecord(uiRoot, id)
    if (record.status === 'deprecated') {
      throw new UiCatalogError('review_conflict', 'deprecated', 'Deprecated components are not reviewed')
    }
    const sourceHash = this.sourceHash(paths.componentDir(id))
    const snapshotHashes = componentSnapshotHashes(paths.snapshots, id)
    if (sourceHash !== body.expectedSourceHash) {
      throw new UiCatalogError('review_conflict', 'source_changed', 'The component changed since it was shown')
    }
    if (!sameSnapshotHashes(snapshotHashes, body.expectedSnapshotHashes)) {
      throw new UiCatalogError('review_conflict', 'snapshots_changed', 'The visual baselines changed since they were shown')
    }
    const at = this.now().toISOString()
    let next: ReviewRecord

    const trusted = this.trustedKeys()
    // Each signed decision chains to the owner's current one (N1), so no later unsigned edit
    // can drop it without G12 noticing.
    const chain = decisionChain(record, trusted)
    if (chain.state === 'unchained') {
      throw new UiCatalogError('review_conflict', 'record_changed', 'The record holds signed decisions that do not chain')
    }
    const previous = chain.state === 'chained' ? chain.head.digest : null
    if (body.decision === 'approve') {
      const keyId = await this.trustedSignerKey(trusted)
      const unsigned = { at, sourceHash, snapshotHashes, comment: body.comment.trim(), keyId, previous }
      const signed = await this.sign(approvalSigningBytes(approvalPayload(id, unsigned)), keyId)
      next = {
        ...record,
        status: 'approved',
        approval: { ...unsigned, signature: signed.signature },
        requests: record.requests.map((request) =>
          request.state === 'open' ? { ...request, state: 'resolved' as const } : request,
        ),
      }
      if (verifyRecordApproval(next, trusted).state !== 'valid') {
        throw new UiCatalogError('approval_signer_unavailable', 'signature_rejected', 'The new approval did not verify')
      }
    } else {
      // Requesting changes on an owner-approved record is itself signed, so an agent cannot
      // undo it later by restoring the old approval (G12 compares with the base branch).
      let revocation = record.revocation ?? null
      if (verifyRecordApproval(record, trusted).state === 'valid' && record.approval) {
        const keyId = await this.trustedSignerKey(trusted)
        const unsigned = { at, keyId, previous: decisionDigest(id, 'approval', record.approval) }
        revocation = { ...unsigned, signature: (await this.sign(approvalSigningBytes(revocationPayload(id, unsigned)), keyId)).signature }
      }
      next = {
        ...record,
        status: record.status === 'draft' ? 'draft' : 'review',
        approval: null,
        ...(revocation ? { revocation } : {}),
        requests: [
          ...record.requests,
          { id: `r-${Date.parse(at).toString(36)}-${randomBytes(3).toString('hex')}`, at, text: body.comment.trim(), state: 'open' },
        ],
      }
    }

    // The keychain prompt can take a while: if anyone rewrote the record meanwhile, do not
    // overwrite their change; the owner reloads and decides again.
    this.requireComponent(uiRoot, id)
    const now = existsSync(paths.reviewFile(id)) ? readFileSync(paths.reviewFile(id), 'utf8') : null
    if (now !== original) {
      throw new UiCatalogError('review_conflict', 'record_changed', 'The review record changed while it was being signed')
    }
    this.writeRecord(paths.reviewFile(id), next)
    return this.project(uiRoot, id, next)
  }

  /** The keychain key id, refused before any prompt when the repository does not trust it. */
  private async trustedSignerKey(trusted: TrustedKey[]): Promise<string> {
    const status = await this.options.signer.status()
    if (status.state === 'unavailable') {
      throw new UiCatalogError('approval_signer_unavailable', status.reason, 'No owner approval key on this node')
    }
    if (!trusted.some((key) => key.keyId === status.keyId)) {
      throw new UiCatalogError('approval_signer_unavailable', 'signing_key_untrusted', 'The keychain key is not trusted by the repository')
    }
    return status.keyId
  }

  private async sign(bytes: Buffer, keyId: string): Promise<{ signature: string }> {
    let signed: { signature: string; keyId: string }
    try {
      signed = await this.options.signer.sign(bytes)
    } catch (error) {
      if (error instanceof SignerError) throw new UiCatalogError('approval_signer_unavailable', error.reason, error.message)
      throw error
    }
    if (signed.keyId !== keyId) {
      throw new UiCatalogError('approval_signer_unavailable', 'signing_key_mismatch', 'The keychain key does not match its recorded id')
    }
    return signed
  }

  private project(uiRoot: string, id: string, record: ReviewRecord): UiComponentReview {
    const paths = uiPaths(uiRoot)
    const current = {
      sourceHash: this.sourceHash(paths.componentDir(id)),
      snapshotHashes: componentSnapshotHashes(paths.snapshots, id),
    }
    const verdict = verifyRecordApproval(record, this.trustedKeys())
    const signature = verdict.state === 'invalid' ? 'invalid' : verdict.state === 'valid' ? 'valid' : 'absent'
    return {
      id,
      record,
      current,
      signature,
      signatureReason: verdict.state === 'invalid' ? verdict.reason : null,
      status: effectiveStatus(record, signature, current),
      observedAt: this.now().toISOString(),
    }
  }

  private sourceHash(dir: string): string {
    try {
      return componentSourceHash(dir)
    } catch (error) {
      if (error instanceof SourceHashError) throw new UiCatalogError('review_conflict', 'source_unresolvable', error.message)
      throw error
    }
  }

  private requireCheckout(): string {
    if (this.options.uiRoot === null) {
      throw new UiCatalogError('approvals_read_only', 'not_source_checkout', 'The node is not running from a source checkout')
    }
    return this.options.uiRoot
  }

  /**
   * The component folder, its implementation and its record must be real entries below the
   * checkout's packages/ui as it was when the node started: no symlink anywhere from there down
   * (src, src/components, the folder, the files), and the folder's real path must be the
   * anchored one, so a symlinked components root cannot move the writer (N4). Checked when the
   * request arrives and again right before the write (the keychain prompt takes time).
   */
  private requireComponent(uiRoot: string, id: string): void {
    const missing = () => new UiCatalogError('component_not_found', 'unknown_component', `No component "${id}"`)
    if (!COMPONENT_ID_PATTERN.test(id) || this.anchor === null) throw missing()
    const paths = uiPaths(uiRoot)
    const dir = paths.componentDir(id)
    const entry = (path: string) => (existsSync(path) || isLink(path) ? lstatSync(path) : null)
    if (realpathSync(uiRoot) !== this.anchor) throw missing()
    for (const ancestor of [join(uiRoot, 'src'), paths.components, dir]) {
      const stat = entry(ancestor)
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw missing()
    }
    if (realpathSync(dir) !== join(this.anchor, 'src', 'components', id)) throw missing()
    const implementation = entry(join(dir, `${id}.tsx`))
    if (!implementation || implementation.isSymbolicLink() || !implementation.isFile()) throw missing()
    const record = entry(paths.reviewFile(id))
    if (record && (record.isSymbolicLink() || !record.isFile())) throw missing()
  }

  private readRecord(uiRoot: string, id: string): { record: ReviewRecord; exists: boolean } {
    this.requireComponent(uiRoot, id)
    const file = uiPaths(uiRoot).reviewFile(id)
    if (!existsSync(file)) return { record: newRecord(id), exists: false }
    let json: unknown
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new UiCatalogError('review_conflict', 'record_invalid', 'The review record is not valid JSON')
    }
    const parsed = parseReviewRecord(json, id)
    if (!parsed.ok) {
      throw new UiCatalogError('review_conflict', 'record_invalid', `The review record is invalid: ${parsed.errors.join('; ')}`)
    }
    return { record: parsed.record, exists: true }
  }

  private writeRecord(file: string, record: ReviewRecord): void {
    // A dot-prefixed .tmp name is junk to the source hash even if a crash leaves it behind.
    const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      writeFileSync(temp, serialiseRecord(record), { flag: 'wx' })
      renameSync(temp, file)
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp)
      throw error
    }
  }

  private trustedKeys() {
    if (this.options.uiRoot === null) return []
    const loaded = loadTrustedKeys(uiPaths(this.options.uiRoot).trustedKeys)
    if (!loaded.ok) {
      throw new UiCatalogError('review_conflict', 'trusted_keys_invalid', `Trusted keys are invalid: ${loaded.errors.join('; ')}`)
    }
    return loaded.file.keys
  }

  private trustedKeyIds(): string[] {
    return this.trustedKeys().map((key) => key.keyId)
  }
}
