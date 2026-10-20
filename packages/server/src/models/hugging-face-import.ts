/**
 * P2-M server-owned staged GGUF import.
 *
 * This is deliberately a connection/process-owned operation, not a durable Job.
 * The browser supplies only a server-issued artifact UUID and a normalized target.
 * The service reopens and verifies the owned inode, uploads it as an Ollama SHA-256
 * blob, calls documented `/api/create`, reconciles `/api/tags`, and delegates the
 * runtime check to the existing controlled completion probe.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  HUGGING_FACE_IMPORT_VERSION,
  huggingFaceImportProvenanceSchema,
  type CompletionProbeEvidence,
  type HuggingFaceImportBody,
  type HuggingFaceImportFailureReason,
  type HuggingFaceImportStreamEvent,
  type HuggingFaceImportTargetObservation,
} from '@guanxi/contract'
import type { CompletionProbeService } from '../runtime/completion-probe.ts'
import {
  OllamaError,
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
  type OllamaClient,
} from '../ollama/client.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import {
  inspectGguf,
  type HuggingFaceDownloadService,
  type ManagedHuggingFaceArtifact,
} from './hugging-face-download.ts'

export const HUGGING_FACE_IMPORT_CONNECT_TIMEOUT_MS = 10_000
export const HUGGING_FACE_IMPORT_IDLE_TIMEOUT_MS = 30_000
export const HUGGING_FACE_IMPORT_OVERALL_TIMEOUT_MS = 30 * 60_000
export const HUGGING_FACE_IMPORT_RECONCILE_TIMEOUT_MS = 10_000
export const HUGGING_FACE_IMPORT_MAX_CREATE_FRAMES = 128
export const HUGGING_FACE_IMPORT_MAX_FRAME_BYTES = 16 * 1024

const OVERALL_TIMEOUT = 'hf-import-overall-timeout'
const FILE_BUFFER_BYTES = 1024 * 1024

type ImportRequest = HuggingFaceImportBody & { targetModelName: string }
type ExactTarget = Extract<HuggingFaceImportTargetObservation, { state: 'exact' }>

interface Attempt {
  createStartedAt?: string
  createTerminalAt?: string
  installed?: ExactTarget
}

export interface HuggingFaceImportDependencies {
  downloads: Pick<HuggingFaceDownloadService, 'artifact' | 'discard'>
  ollama(): Pick<
    OllamaClient,
    'host' | 'tags' | 'blobExists' | 'pushBlob' | 'createModelFromBlob'
  >
  completionProbe: Pick<CompletionProbeService, 'execute'>
  now?: () => Date
  overallTimeoutMs?: number
  reconcileTimeoutMs?: number
}

class ImportFailure extends Error {
  readonly reason: HuggingFaceImportFailureReason

  constructor(reason: HuggingFaceImportFailureReason) {
    super(reason)
    this.reason = reason
  }
}

interface VerifiedArtifact {
  record: ManagedHuggingFaceArtifact
  handle: FileHandle
  size: number
  digest: string
}

export class HuggingFaceImportService {
  private readonly dependencies: HuggingFaceImportDependencies
  private readonly activeKeys = new Set<string>()
  private readonly activeArtifacts = new Set<string>()
  private readonly activeTargets = new Set<string>()
  private readonly attempts = new Map<string, Attempt>()

  constructor(dependencies: HuggingFaceImportDependencies) {
    this.dependencies = dependencies
  }

  async *import(
    request: ImportRequest,
    requestSignal: AbortSignal,
  ): AsyncGenerator<HuggingFaceImportStreamEvent> {
    let seq = 0
    const emit = <T extends HuggingFaceImportStreamEvent>(value: Omit<T, 'seq'>): T => (
      { ...value, seq: seq++ } as T
    )
    const key = `${request.artifactId}\n${request.targetModelName}`
    const previous = this.attempts.get(key)
    if (!isLoopbackOllamaHost(this.dependencies.ollama().host)) {
      yield emit({
        type: 'failed',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'failed',
          reason: 'remote_provider_not_allowed',
          target: null,
          probe: null,
        },
      })
      return
    }
    if (
      this.activeKeys.has(key)
      || this.activeArtifacts.has(request.artifactId)
      || this.activeTargets.has(request.targetModelName)
    ) {
      yield emit({
        type: 'conflict',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'conflict',
          reason: 'duplicate_active',
          target: await this.reconcileTarget(request.targetModelName),
        },
      })
      return
    }

    this.activeKeys.add(key)
    this.activeArtifacts.add(request.artifactId)
    this.activeTargets.add(request.targetModelName)
    const attempt = previous ?? {}
    const controller = new AbortController()
    const abortFromRequest = () => controller.abort(
      requestSignal.reason ?? 'hf-import-request-cancelled',
    )
    if (requestSignal.aborted) abortFromRequest()
    else requestSignal.addEventListener('abort', abortFromRequest, { once: true })
    const overallTimer = setTimeout(
      () => controller.abort(OVERALL_TIMEOUT),
      this.dependencies.overallTimeoutMs ?? HUGGING_FACE_IMPORT_OVERALL_TIMEOUT_MS,
    )
    let verified: VerifiedArtifact | null = null
    let createStarted = attempt.createStartedAt !== undefined

    try {
      yield emit({
        type: 'state',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'preparing',
          phase: 'validating_artifact',
        },
      })
      verified = await this.verifyArtifact(request.artifactId, controller.signal)

      // A prior call may have crossed the create boundary without producing a
      // trustworthy terminal result. Reconcile it; never issue a second create.
      if (!attempt.installed && attempt.createStartedAt !== undefined) {
        yield emit({
          type: 'state',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'verifying',
            phase: 'observing_installation',
          },
        })
        const reconciled = await this.reconcileTarget(request.targetModelName)
        if (reconciled.state === 'exact') {
          attempt.installed = reconciled
        } else {
          yield emit({
            type: 'conflict',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'conflict',
              reason: reconciled.state === 'ambiguous' ? 'target_ambiguous' : 'outcome_unknown',
              target: reconciled,
            },
          })
          return
        }
      }

      if (!attempt.installed) {
        yield emit({
          type: 'state',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'preparing',
            phase: 'checking_target',
          },
        })
        const initial = await this.observeTarget(request.targetModelName, controller.signal)
        if (initial.state === 'exact') {
          yield emit({
            type: 'conflict',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'conflict',
              reason: 'target_preexisting',
              target: initial,
            },
          })
          return
        }
        if (initial.state === 'ambiguous') {
          yield emit({
            type: 'conflict',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'conflict',
              reason: 'target_ambiguous',
              target: initial,
            },
          })
          return
        }
        if (initial.state === 'unavailable') throw new ImportFailure('provider_unavailable')

        const blobDigest = `sha256:${verified.digest}`
        yield emit({
          type: 'state',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'importing',
            phase: 'checking_blob',
          },
        })
        const blobExists = await this.dependencies.ollama().blobExists(
          blobDigest,
          controller.signal,
        )
        if (!blobExists) {
          yield emit({
            type: 'state',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'importing',
              phase: 'uploading_blob',
            },
          })
          const body = Readable.toWeb(verified.handle.createReadStream({
            start: 0,
            end: Math.max(0, verified.size - 1),
            autoClose: false,
          })) as ReadableStream<Uint8Array>
          try {
            await this.dependencies.ollama().pushBlob(
              blobDigest,
              body,
              verified.size,
              controller.signal,
              this.dependencies.overallTimeoutMs ?? HUGGING_FACE_IMPORT_OVERALL_TIMEOUT_MS,
            )
          } catch (error) {
            if (controller.signal.aborted) throw error
            throw new ImportFailure('blob_upload_failed')
          }
        }

        // Narrow the no-overwrite race immediately before `/api/create`.
        const beforeCreate = await this.observeTarget(request.targetModelName, controller.signal)
        if (beforeCreate.state !== 'absent') {
          yield emit({
            type: 'conflict',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'conflict',
              reason: beforeCreate.state === 'ambiguous'
                ? 'target_ambiguous'
                : beforeCreate.state === 'exact'
                  ? 'target_changed'
                  : 'outcome_unknown',
              target: beforeCreate,
            },
          })
          return
        }

        yield emit({
          type: 'state',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'importing',
            phase: 'creating_model',
          },
        })
        attempt.createStartedAt = this.now()
        this.attempts.set(key, attempt)
        createStarted = true
        await this.createModel(
          request.targetModelName,
          blobDigest,
          controller.signal,
        )
        attempt.createTerminalAt = this.now()

        yield emit({
          type: 'state',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'verifying',
            phase: 'observing_installation',
          },
        })
        const installed = await this.reconcileTarget(request.targetModelName)
        if (controller.signal.aborted) {
          yield emit(this.cancelledAfterCreate(installed))
          return
        }
        if (installed.state === 'ambiguous') {
          yield emit({
            type: 'conflict',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'conflict',
              reason: 'target_ambiguous',
              target: installed,
            },
          })
          return
        }
        if (installed.state !== 'exact') {
          yield emit({
            type: 'failed',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'failed',
              reason: 'installation_missing',
              target: installed,
              probe: null,
            },
          })
          return
        }
        attempt.installed = installed
      }

      const installed = attempt.installed!
      if (controller.signal.aborted) {
        yield emit(this.cancelledAfterCreate(installed))
        return
      }
      yield emit({
        type: 'state',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'probing',
          phase: 'running_completion_probe',
        },
      })
      const probe = await this.dependencies.completionProbe.execute(
        request.targetModelName,
        {
          capability: 'completion',
          expectedDigest: installed.digest,
          contextLength: request.contextLength,
          force: true,
        },
        controller.signal,
      )
      if (controller.signal.aborted) {
        yield emit(this.cancelledAfterCreate(installed))
        return
      }
      if (
        probe.status !== 'verified'
        || probe.historical
        || probe.basis.state !== 'exact'
        || probe.basis.normalizedModelReference !== installed.normalizedModelReference
        || probe.basis.artifactDigest !== installed.digest
        || probe.basis.contextLength !== request.contextLength
      ) {
        yield emit({
          type: 'failed',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'failed',
            reason: 'probe_not_verified',
            target: installed,
            probe,
          },
        })
        return
      }

      const provenance = huggingFaceImportProvenanceSchema.parse({
        version: HUGGING_FACE_IMPORT_VERSION,
        source: verified.record.provenance,
        targetModelName: request.targetModelName,
        create: {
          endpoint: '/api/create',
          input: 'uploaded_sha256_blob_files_map',
          terminalStatus: 'success',
          startedAt: attempt.createStartedAt,
          terminalAt: attempt.createTerminalAt,
        },
        installation: {
          source: 'ollama_api_tags',
          normalizedModelReference: installed.normalizedModelReference,
          digest: installed.digest,
          runtimeVersion: probe.basis.runtimeVersion,
          observedAt: installed.observedAt,
        },
        probe,
        staging: {
          artifactId: request.artifactId,
          retention: 'deleted_after_verified_success',
        },
        completedAt: this.now(),
      })
      // Construct and validate terminal provenance before retiring the exact
      // owned staging artifact. This remains connection/process-owned evidence.
      try {
        if (!await this.dependencies.downloads.discard(request.artifactId)) {
          throw new ImportFailure('filesystem_error')
        }
      } catch (error) {
        if (error instanceof ImportFailure) throw error
        throw new ImportFailure('filesystem_error')
      }
      this.attempts.delete(key)
      yield emit({
        type: 'completed',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'completed',
          provenance,
        },
      })
    } catch (error) {
      const observation = createStarted
        ? await this.reconcileTarget(request.targetModelName)
        : null
      if (controller.signal.aborted) {
        if (createStarted) {
          yield emit(this.cancelledAfterCreate(observation!))
        } else if (controller.signal.reason === OVERALL_TIMEOUT) {
          yield emit({
            type: 'failed',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'failed',
              reason: 'overall_timeout',
              target: observation,
              probe: null,
            },
          })
        } else {
          yield emit({
            type: 'cancelled',
            data: {
              version: HUGGING_FACE_IMPORT_VERSION,
              state: 'cancelled',
              reason: cancellationReason(controller.signal),
            },
          })
        }
        return
      }
      if (createStarted && observation?.state === 'exact') {
        attempt.installed = observation
        yield emit({
          type: 'conflict',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'conflict',
            reason: 'target_changed',
            target: observation,
          },
        })
        return
      }
      if (createStarted && observation && observation.state !== 'absent') {
        yield emit({
          type: 'conflict',
          data: {
            version: HUGGING_FACE_IMPORT_VERSION,
            state: 'conflict',
            reason: observation.state === 'ambiguous' ? 'target_ambiguous' : 'outcome_unknown',
            target: observation,
          },
        })
        return
      }
      yield emit({
        type: 'failed',
        data: {
          version: HUGGING_FACE_IMPORT_VERSION,
          state: 'failed',
          reason: classifyFailure(error),
          target: observation,
          probe: null,
        },
      })
    } finally {
      clearTimeout(overallTimer)
      requestSignal.removeEventListener('abort', abortFromRequest)
      await verified?.handle.close().catch(() => {})
      this.activeKeys.delete(key)
      this.activeArtifacts.delete(request.artifactId)
      this.activeTargets.delete(request.targetModelName)
    }
  }

  private async verifyArtifact(id: string, signal: AbortSignal): Promise<VerifiedArtifact> {
    signal.throwIfAborted()
    const record = this.dependencies.downloads.artifact(id)
    if (!record) throw new ImportFailure('artifact_not_found')
    const root = resolve(record.rootDir)
    const expectedPath = join(root, `${id}.gguf`)
    if (resolve(record.path) !== expectedPath) throw new ImportFailure('artifact_changed')

    let rootBefore
    let entryBefore
    try {
      ;[rootBefore, entryBefore] = await Promise.all([lstat(root), lstat(expectedPath)])
    } catch {
      throw new ImportFailure('artifact_not_found')
    }
    if (
      !rootBefore.isDirectory()
      || rootBefore.isSymbolicLink()
      || !entryBefore.isFile()
      || entryBefore.isSymbolicLink()
    ) throw new ImportFailure('artifact_changed')

    let handle: FileHandle
    try {
      handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      throw new ImportFailure('artifact_changed')
    }
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile()
        || opened.dev !== entryBefore.dev
        || opened.ino !== entryBefore.ino
        || opened.dev !== record.device
        || opened.ino !== record.inode
        || opened.size !== entryBefore.size
      ) throw new ImportFailure('artifact_changed')
      if (opened.size !== record.provenance.observedSizeBytes) {
        throw new ImportFailure('artifact_changed')
      }

      const hash = createHash('sha256')
      const header = new Uint8Array(8)
      const buffer = Buffer.allocUnsafe(FILE_BUFFER_BYTES)
      let position = 0
      let headerBytes = 0
      while (position < opened.size) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, opened.size - position),
          position,
        )
        if (bytesRead <= 0) throw new ImportFailure('artifact_changed')
        const chunk = buffer.subarray(0, bytesRead)
        if (headerBytes < header.byteLength) {
          const copied = Math.min(header.byteLength - headerBytes, bytesRead)
          header.set(chunk.subarray(0, copied), headerBytes)
          headerBytes += copied
        }
        hash.update(chunk)
        position += bytesRead
      }
      let format
      try {
        format = inspectGguf(header.subarray(0, headerBytes))
      } catch {
        throw new ImportFailure('artifact_corrupt')
      }
      const digest = hash.digest('hex')
      if (
        digest !== record.provenance.checksum.observedDigest
        || format.version !== record.provenance.format.version
      ) throw new ImportFailure('artifact_corrupt')

      const [rootAfter, entryAfter] = await Promise.all([lstat(root), lstat(expectedPath)])
      if (
        rootAfter.dev !== rootBefore.dev
        || rootAfter.ino !== rootBefore.ino
        || entryAfter.dev !== opened.dev
        || entryAfter.ino !== opened.ino
        || entryAfter.size !== opened.size
        || entryAfter.isSymbolicLink()
      ) throw new ImportFailure('artifact_changed')
      return { record, handle, size: opened.size, digest }
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  }

  private async observeTarget(
    normalizedTarget: string,
    signal: AbortSignal,
  ): Promise<HuggingFaceImportTargetObservation> {
    try {
      const tags = await this.dependencies.ollama().tags(signal)
      const observedAt = this.now()
      const matches = tags.models.filter(
        (model) => normalizeOllamaModelReference(model.name) === normalizedTarget,
      )
      if (matches.length === 0) return { state: 'absent', observedAt }
      if (matches.length !== 1 || matches[0]!.digest.trim().length === 0) {
        return { state: 'ambiguous', observedAt }
      }
      return {
        state: 'exact',
        normalizedModelReference: normalizedTarget,
        digest: matches[0]!.digest,
        observedAt,
      }
    } catch {
      if (signal.aborted) throw signal.reason
      return { state: 'unavailable', observedAt: this.now() }
    }
  }

  private async reconcileTarget(target: string): Promise<HuggingFaceImportTargetObservation> {
    const signal = AbortSignal.timeout(
      this.dependencies.reconcileTimeoutMs ?? HUGGING_FACE_IMPORT_RECONCILE_TIMEOUT_MS,
    )
    try {
      return await this.observeTarget(target, signal)
    } catch {
      return { state: 'unavailable', observedAt: this.now() }
    }
  }

  private async createModel(
    target: string,
    blobDigest: string,
    signal: AbortSignal,
  ): Promise<void> {
    let rank = 0
    let sawParsing = false
    let sawBlob = false
    let sawManifest = false
    let sawTerminal = false
    for await (const frame of this.dependencies.ollama().createModelFromBlob(
      target,
      'model.gguf',
      blobDigest,
      signal,
      {
        connectTimeoutMs: HUGGING_FACE_IMPORT_CONNECT_TIMEOUT_MS,
        loadTimeoutMs: HUGGING_FACE_IMPORT_IDLE_TIMEOUT_MS,
        streamIdleTimeoutMs: HUGGING_FACE_IMPORT_IDLE_TIMEOUT_MS,
        maxLineBytes: HUGGING_FACE_IMPORT_MAX_FRAME_BYTES,
        maxFrames: HUGGING_FACE_IMPORT_MAX_CREATE_FRAMES,
      },
    )) {
      if (sawTerminal || typeof frame.error === 'string') {
        if (typeof frame.error === 'string') throw new ImportFailure('create_provider_error')
        throw new ImportFailure('create_protocol_error')
      }
      let nextRank: number
      if (frame.status === 'parsing GGUF') {
        sawParsing = true
        nextRank = 1
      } else if (frame.status === `using existing layer ${blobDigest}`) {
        sawBlob = true
        nextRank = 2
      } else if (frame.status === 'writing manifest') {
        sawManifest = true
        nextRank = 3
      } else if (frame.status === 'success') {
        sawTerminal = true
        nextRank = 4
      } else {
        throw new ImportFailure('create_protocol_error')
      }
      if (nextRank !== rank + 1) throw new ImportFailure('create_protocol_error')
      rank = nextRank
    }
    if (!sawParsing || !sawBlob || !sawManifest || !sawTerminal) {
      throw new ImportFailure('create_protocol_error')
    }
  }

  private cancelledAfterCreate(
    target: HuggingFaceImportTargetObservation,
  ): Omit<Extract<HuggingFaceImportStreamEvent, { type: 'conflict' }>, 'seq'> {
    return {
      type: 'conflict',
      data: {
        version: HUGGING_FACE_IMPORT_VERSION,
        state: 'conflict',
        reason: target.state === 'exact' ? 'cancelled_after_create' : 'outcome_unknown',
        target,
      },
    }
  }

  private now(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString()
  }
}

export function isLoopbackOllamaHost(host: string): boolean {
  try {
    const url = new URL(host)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function cancellationReason(
  signal: AbortSignal,
): 'user_requested' | 'connection_closed' | 'request_cancelled' {
  if (signal.reason === 'hf-import-user-cancelled') return 'user_requested'
  if (signal.reason === 'hf-import-connection-closed') return 'connection_closed'
  return 'request_cancelled'
}

function classifyFailure(error: unknown): HuggingFaceImportFailureReason {
  if (error instanceof ImportFailure) return error.reason
  if (error instanceof OllamaTimeoutError) {
    return error.phase === 'connect' ? 'connect_timeout' : 'stream_idle_timeout'
  }
  if (error instanceof OllamaProtocolError) return 'create_protocol_error'
  if (error instanceof OllamaUnavailableError) return 'provider_unavailable'
  if (error instanceof OllamaError) return 'create_provider_error'
  return 'filesystem_error'
}
