/**
 * P2-K exact GGUF file/revision selection.
 *
 * Selection is an intent, not an install: it starts no download, checksum, local
 * `ollama create` or probe, and it is never persisted. Every call re-reads the bounded
 * repository facts through the same transport P2-J uses, so a selection can never
 * outlive — or trust a stale copy of — the inventory it is validated against.
 *
 * The fit preview is always computed from the file's *claimed* size, never a measured
 * install, and an unreported size yields an explicit unknown state rather than an
 * optimistic estimate.
 */
import type {
  HardwareInfo,
  HuggingFaceExactRevision,
  HuggingFaceReferencePreview,
  HuggingFaceRepositoryResult,
  HuggingFaceSelectionResult,
} from '@alamo/contract'
import { computeFit } from '../hardware/fit.ts'

/** The only shape this module needs from the transport: one bounded repository re-read. */
export interface HuggingFaceRepositoryReader {
  repository(input: {
    preview: HuggingFaceReferencePreview
    revision?: HuggingFaceExactRevision
    signal?: AbortSignal
  }): Promise<HuggingFaceRepositoryResult>
}

export interface SelectHuggingFaceGgufFileInput {
  huggingFace: HuggingFaceRepositoryReader
  hardware: HardwareInfo
  hardwareObservedAt: string
  preview: HuggingFaceReferencePreview
  revision: HuggingFaceExactRevision
  filePath: string
  contextLength: number
  signal?: AbortSignal
  now?: () => Date
}

export async function selectHuggingFaceGgufFile(
  input: SelectHuggingFaceGgufFileInput,
): Promise<HuggingFaceSelectionResult> {
  const {
    huggingFace, hardware, hardwareObservedAt, preview, revision, filePath,
    contextLength, signal, now = () => new Date(),
  } = input

  const read = await huggingFace.repository({ preview, revision, signal })
  if (read.state === 'failed') {
    return {
      state: 'failed',
      version: read.version,
      repository: null,
      selection: null,
      fit: null,
      reason: read.reason,
    }
  }

  const { repository } = read
  const refuse = (reason: 'repository_not_supported' | 'revision_not_exact' | 'revision_mismatch' | 'file_inventory_truncated' | 'file_inventory_malformed' | 'file_not_in_current_inventory'): HuggingFaceSelectionResult => ({
    state: 'refused',
    version: repository.version,
    repository,
    selection: null,
    fit: null,
    reason,
  })

  if (repository.verdict.state !== 'supported') return refuse('repository_not_supported')
  if (repository.revision.state !== 'exact_commit') return refuse('revision_not_exact')
  if (repository.revision.commit !== revision.commit) return refuse('revision_mismatch')
  if (repository.files.state === 'listed' && repository.files.truncated) {
    return refuse('file_inventory_truncated')
  }
  if (repository.files.state === 'listed' && repository.files.malformedEntries > 0) {
    return refuse('file_inventory_malformed')
  }

  // `supported` guarantees `files.state === 'listed'` with at least one GGUF entry
  // (huggingFaceRepositorySchema enforces this), but the exact requested path is
  // still looked up explicitly rather than assumed present.
  const file = repository.files.state === 'listed'
    ? repository.files.ggufFiles.find((candidate) => candidate.path === filePath) ?? null
    : null
  if (!file) return refuse('file_not_in_current_inventory')

  return {
    state: 'confirmed',
    version: repository.version,
    repository,
    selection: {
      identity: repository.identity,
      revision: repository.revision,
      filePath,
      sizeBytes: file.sizeBytes,
      sizeSource: file.sizeSource,
    },
    fit: file.sizeBytes === null
      ? {
          state: 'unknown',
          contextLength,
          basis: 'size_not_reported',
          verdict: null,
          reason: 'size_not_reported',
        }
      : hardware.usableMemoryBytes <= 0
        ? {
            state: 'unknown',
            contextLength,
            basis: 'hardware_capacity_unavailable',
            verdict: null,
            reason: 'hardware_capacity_unavailable',
          }
      : {
          state: 'calculated',
          contextLength,
          basis: 'reported_file_size_only',
          calculatedAt: now().toISOString(),
          hardware: {
            source: 'application_startup_hardware_probe',
            observedAt: hardwareObservedAt,
            confidence: 'estimated',
          },
          verdict: computeFit({
            contextLength,
            hardware,
            modelBytes: file.sizeBytes,
            // The claimed file size is the only size hint available before download;
            // it is never a measured install, so `computeFit` publishes it as a hint.
            vramHintBytes: file.sizeBytes,
            isCloud: false,
          }),
        },
    reason: null,
  }
}
