/**
 * Writes component review records for the in-app catalog (D-138). One owner per record: this
 * process serialises writes per component and replaces the file atomically. Approvals are
 * signed with the owner key and verified against the committed trusted keys before they are
 * written, so the node never writes a record that gate G12 would reject.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  UiCatalogReadOnlyReason,
  UiCatalogReviewCapability,
  UiComponentReview,
  UiComponentReviewBody,
} from '@guanxi/contract'
import {
  COMPONENT_ID_PATTERN,
  approvalPayload,
  approvalSigningBytes,
  componentSnapshotHashes,
  componentSourceHash,
  effectiveStatus,
  loadTrustedKeys,
  parseReviewRecord,
  sameSnapshotHashes,
  uiPaths,
  verifyRecordApproval,
  type ReviewRecord,
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

const RECORD_SCHEMA = '../../../catalog/review.schema.json'

function newRecord(id: string): ReviewRecord {
  return { $schema: RECORD_SCHEMA, id, status: 'draft', approval: null, requests: [] }
}

function serialise(record: ReviewRecord): string {
  const ordered: Record<string, unknown> = {
    $schema: record.$schema ?? RECORD_SCHEMA,
    id: record.id,
    status: record.status,
    approval: record.approval,
  }
  if (record.deprecated !== undefined) ordered['deprecated'] = record.deprecated
  ordered['requests'] = record.requests
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export class UiCatalogReviewService {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => Date
  private readonly options: UiCatalogReviewOptions

  constructor(options: UiCatalogReviewOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
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
    const status = await this.options.signer.status()
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
    const { record } = this.readRecord(uiRoot, id)
    if (record.status === 'deprecated') {
      throw new UiCatalogError('review_conflict', 'deprecated', 'Deprecated components are not reviewed')
    }
    const sourceHash = componentSourceHash(paths.componentDir(id))
    const snapshotHashes = componentSnapshotHashes(paths.snapshots, id)
    if (sourceHash !== body.expectedSourceHash) {
      throw new UiCatalogError('review_conflict', 'source_changed', 'The component changed since it was shown')
    }
    if (!sameSnapshotHashes(snapshotHashes, body.expectedSnapshotHashes)) {
      throw new UiCatalogError('review_conflict', 'snapshots_changed', 'The visual baselines changed since they were shown')
    }
    const at = this.now().toISOString()
    let next: ReviewRecord

    if (body.decision === 'approve') {
      const status = await this.options.signer.status()
      if (status.state === 'unavailable') {
        throw new UiCatalogError('approval_signer_unavailable', status.reason, 'No owner approval key on this node')
      }
      const trusted = this.trustedKeys()
      if (!trusted.some((key) => key.keyId === status.keyId)) {
        throw new UiCatalogError('approval_signer_unavailable', 'signing_key_untrusted', 'The keychain key is not trusted by the repository')
      }
      const unsigned = { at, sourceHash, snapshotHashes, comment: body.comment.trim(), keyId: status.keyId }
      let signed: { signature: string; keyId: string }
      try {
        signed = await this.options.signer.sign(approvalSigningBytes(approvalPayload(id, unsigned)))
      } catch (error) {
        if (error instanceof SignerError) {
          throw new UiCatalogError('approval_signer_unavailable', error.reason, error.message)
        }
        throw error
      }
      if (signed.keyId !== status.keyId) {
        throw new UiCatalogError('approval_signer_unavailable', 'signing_key_mismatch', 'The keychain key does not match its recorded id')
      }
      next = {
        ...record,
        status: 'approved',
        approval: { ...unsigned, signature: signed.signature },
        requests: record.requests.map((request) =>
          request.state === 'open' ? { ...request, state: 'resolved' as const } : request,
        ),
      }
      const verdict = verifyRecordApproval(next, trusted)
      if (verdict.state !== 'valid') {
        throw new UiCatalogError('approval_signer_unavailable', 'signature_rejected', 'The new approval did not verify')
      }
    } else {
      next = {
        ...record,
        status: record.status === 'draft' ? 'draft' : 'review',
        approval: null,
        requests: [
          ...record.requests,
          { id: `r-${Date.parse(at).toString(36)}-${randomBytes(3).toString('hex')}`, at, text: body.comment.trim(), state: 'open' },
        ],
      }
    }

    this.writeRecord(paths.reviewFile(id), next)
    return this.project(uiRoot, id, next)
  }

  private project(uiRoot: string, id: string, record: ReviewRecord): UiComponentReview {
    const paths = uiPaths(uiRoot)
    const current = {
      sourceHash: componentSourceHash(paths.componentDir(id)),
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

  private requireCheckout(): string {
    if (this.options.uiRoot === null) {
      throw new UiCatalogError('approvals_read_only', 'not_source_checkout', 'The node is not running from a source checkout')
    }
    return this.options.uiRoot
  }

  private requireComponent(uiRoot: string, id: string): void {
    if (!COMPONENT_ID_PATTERN.test(id) || !existsSync(join(uiPaths(uiRoot).componentDir(id), `${id}.tsx`))) {
      throw new UiCatalogError('component_not_found', 'unknown_component', `No component "${id}"`)
    }
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
      writeFileSync(temp, serialise(record), { flag: 'wx' })
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
