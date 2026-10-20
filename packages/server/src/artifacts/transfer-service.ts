import {
  ARTIFACT_TRANSFER_POLICY_VERSION,
  artifactTransferPolicySchema,
  type ArtifactScope,
  type ArtifactTransferPolicy,
  type Attachment,
} from '@guanxi/contract'
import {
  ArtifactStore,
  ArtifactStoreError,
  type ArtifactDownloadHeaders,
  type AttachmentWriteMetadata,
} from '../store/artifacts.ts'

export const DEFAULT_ARTIFACT_TRANSFER_MAX_BYTES = 32 * 1024 * 1024
export const DEFAULT_ARTIFACT_TRANSFER_ACTIVE = 1
export const DEFAULT_ARTIFACT_TRANSFER_QUEUED = 8

type PolicySource = ArtifactTransferPolicy['source']

export type ArtifactTransferPolicyOptions =
  | {
      state: 'enabled'
      maxBytes: number
      maxActiveTransfers: number
      maxQueuedTransfers: number
      source?: PolicySource
    }
  | { state: 'disabled'; source?: PolicySource }
  | { state: 'unknown'; source?: PolicySource }

export interface ArtifactTransferServiceOptions {
  store: ArtifactStore
  policy?: ArtifactTransferPolicyOptions
  now?: () => Date
}

export type ArtifactTransferErrorCode =
  | 'policy_unavailable'
  | 'admission_full'
  | 'aborted'

export class ArtifactTransferError extends Error {
  readonly code: ArtifactTransferErrorCode

  constructor(code: ArtifactTransferErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactTransferError'
    this.code = code
  }
}

interface AdmissionWaiter {
  signal: AbortSignal
  resolve: (lease: TransferLease) => void
  reject: (error: ArtifactTransferError) => void
  onAbort: () => void
}

interface TransferLease {
  release(): void
}

class TransferAdmission {
  private active = 0
  private readonly waiters: AdmissionWaiter[] = []
  private readonly maxActive: number
  private readonly maxQueued: number

  constructor(
    maxActive: number,
    maxQueued: number,
  ) {
    this.maxActive = maxActive
    this.maxQueued = maxQueued
  }

  diagnostics(): { active: number; queued: number; maxActive: number; maxQueued: number } {
    return {
      active: this.active,
      queued: this.waiters.length,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    }
  }

  acquire(signal: AbortSignal): Promise<TransferLease> {
    if (signal.aborted) {
      return Promise.reject(new ArtifactTransferError('aborted', 'Artifact transfer was cancelled'))
    }
    if (this.active < this.maxActive) {
      this.active += 1
      return Promise.resolve(this.lease())
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new ArtifactTransferError('admission_full', 'Artifact transfer admission is full'),
      )
    }
    return new Promise<TransferLease>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort)
          reject(new ArtifactTransferError('aborted', 'Artifact transfer was cancelled'))
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private lease(): TransferLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active -= 1
        this.promote()
      },
    }
  }

  private promote(): void {
    while (this.active < this.maxActive) {
      const waiter = this.waiters.shift()
      if (!waiter) return
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(new ArtifactTransferError('aborted', 'Artifact transfer was cancelled'))
        continue
      }
      this.active += 1
      waiter.resolve(this.lease())
    }
  }
}

function buildPolicy(
  options: ArtifactTransferPolicyOptions | undefined,
  observedAt: string,
): ArtifactTransferPolicy {
  if (options?.state === 'disabled') {
    return artifactTransferPolicySchema.parse({
      policyVersion: ARTIFACT_TRANSFER_POLICY_VERSION,
      state: 'disabled',
      source: options.source ?? 'application_configuration',
      observedAt,
      maxBytes: null,
      maxActiveTransfers: null,
      maxQueuedTransfers: null,
      rangeRequests: 'unsupported',
      modelCapability: 'not_applicable',
      reason: 'disabled_by_configuration',
    })
  }
  if (options?.state === 'unknown') {
    return artifactTransferPolicySchema.parse({
      policyVersion: ARTIFACT_TRANSFER_POLICY_VERSION,
      state: 'unknown',
      source: options.source ?? 'application_configuration',
      observedAt,
      maxBytes: null,
      maxActiveTransfers: null,
      maxQueuedTransfers: null,
      rangeRequests: 'unsupported',
      modelCapability: 'not_applicable',
      reason: 'configuration_invalid',
    })
  }
  const candidate = {
    policyVersion: ARTIFACT_TRANSFER_POLICY_VERSION,
    state: 'enabled' as const,
    source: options?.source ?? (
      options === undefined ? 'server_default_storage_policy' : 'application_configuration'
    ),
    observedAt,
    maxBytes: options?.maxBytes ?? DEFAULT_ARTIFACT_TRANSFER_MAX_BYTES,
    maxActiveTransfers: options?.maxActiveTransfers ?? DEFAULT_ARTIFACT_TRANSFER_ACTIVE,
    maxQueuedTransfers: options?.maxQueuedTransfers ?? DEFAULT_ARTIFACT_TRANSFER_QUEUED,
    rangeRequests: 'unsupported' as const,
    modelCapability: 'not_applicable' as const,
    reason: null,
  }
  const parsed = artifactTransferPolicySchema.safeParse(candidate)
  if (parsed.success) return parsed.data
  return artifactTransferPolicySchema.parse({
    policyVersion: ARTIFACT_TRANSFER_POLICY_VERSION,
    state: 'unknown',
    source: 'application_configuration',
    observedAt,
    maxBytes: null,
    maxActiveTransfers: null,
    maxQueuedTransfers: null,
    rangeRequests: 'unsupported',
    modelCapability: 'not_applicable',
    reason: 'configuration_invalid',
  })
}

export class ArtifactTransferService {
  readonly policy: ArtifactTransferPolicy
  private readonly store: ArtifactStore
  private readonly admission: TransferAdmission | null

  constructor(options: ArtifactTransferServiceOptions) {
    this.store = options.store
    this.policy = buildPolicy(options.policy, (options.now ?? (() => new Date()))().toISOString())
    this.admission = this.policy.state === 'enabled'
      ? new TransferAdmission(
          this.policy.maxActiveTransfers,
          this.policy.maxQueuedTransfers,
        )
      : null
  }

  diagnostics(): {
    active: number
    queued: number
    maxActive: number | null
    maxQueued: number | null
  } {
    return this.admission?.diagnostics() ?? {
      active: 0,
      queued: 0,
      maxActive: null,
      maxQueued: null,
    }
  }

  list(scope: ArtifactScope, limit: number): { attachments: Attachment[]; truncated: boolean } {
    return this.store.listAttachments(scope, limit)
  }

  get(id: string, scope: ArtifactScope): Attachment | null {
    return this.store.getAttachment(id, scope)
  }

  async upload(
    metadata: AttachmentWriteMetadata,
    content: Uint8Array | AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Attachment> {
    return this.withPermit(signal, (maxBytes) => (
      this.store.createAttachment(metadata, content, { maxBytes, signal })
    ))
  }

  async download(
    id: string,
    scope: ArtifactScope,
    signal: AbortSignal,
  ): Promise<{
    attachment: Attachment
    content: Uint8Array
    headers: ArtifactDownloadHeaders
  }> {
    return this.withPermit(signal, async (maxBytes) => {
      const attachment = this.store.getAttachment(id, scope)
      if (!attachment) {
        throw new ArtifactStoreError('not_found', 'Attachment is unavailable in this scope')
      }
      const read = await this.store.read(id, scope, { maxBytes, signal })
      return { attachment, content: read.content, headers: read.headers }
    })
  }

  private async withPermit<T>(
    signal: AbortSignal,
    operation: (maxBytes: number) => Promise<T>,
  ): Promise<T> {
    if (this.policy.state !== 'enabled' || this.admission === null) {
      throw new ArtifactTransferError(
        'policy_unavailable',
        'Artifact byte transfer is unavailable by storage policy',
      )
    }
    const lease = await this.admission.acquire(signal)
    try {
      if (signal.aborted) {
        throw new ArtifactTransferError('aborted', 'Artifact transfer was cancelled')
      }
      return await operation(this.policy.maxBytes)
    } finally {
      lease.release()
    }
  }
}
