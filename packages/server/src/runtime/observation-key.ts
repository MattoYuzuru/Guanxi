import { createHash } from 'node:crypto'
import type {
  HardwareInfo,
  ModelObservationKey,
  ModelObservationKeyUnavailableReason,
  RunningModel,
} from '@guanxi/contract'

export interface InstalledArtifactIdentity {
  name: string
  digest: string
}

export interface CompleteObservationKeyInput {
  normalizedModelReference: string
  artifactDigest: string
  contextLength: number
  runtimeVersion: string | null
  runtimeHost: string
  hardware: HardwareInfo
}

export interface RuntimeObservationKeyInput {
  running: RunningModel
  runningRows: readonly RunningModel[]
  installed: readonly InstalledArtifactIdentity[] | null
  runtimeVersion: string | null
  runtimeHost: string
  hardware: HardwareInfo
}

const unavailable = (
  reason: ModelObservationKeyUnavailableReason,
): ModelObservationKey => ({ state: 'unavailable', version: 1, reason })

function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Normalize only syntax Ollama makes implicit; never normalize family or digest. */
export function normalizeOllamaModelReference(input: string): string | null {
  const normalized = input.normalize('NFKC').trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\\') ||
    /\s|[^a-z0-9._:/@-]/u.test(normalized)
  ) {
    return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null
  }
  if (normalized.includes('@')) return normalized

  const lastSlash = normalized.lastIndexOf('/')
  return normalized.lastIndexOf(':') > lastSlash ? normalized : `${normalized}:latest`
}

function isLoopbackRuntime(host: string): boolean {
  try {
    const hostname = new URL(host).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function buildCompleteObservationKey(
  input: CompleteObservationKeyInput,
): ModelObservationKey {
  const normalizedReference = normalizeOllamaModelReference(input.normalizedModelReference)
  if (!normalizedReference) return unavailable('invalid_model_reference')
  const digest = input.artifactDigest.trim()
  if (!digest) return unavailable('runtime_digest_missing')
  if (!Number.isSafeInteger(input.contextLength) || input.contextLength <= 0) {
    return unavailable('runtime_context_missing')
  }
  const runtimeVersion = input.runtimeVersion?.trim() ?? ''
  if (!runtimeVersion) return unavailable('runtime_version_unavailable')
  if (
    !isLoopbackRuntime(input.runtimeHost) ||
    input.hardware.platform !== 'darwin' ||
    input.hardware.arch !== 'arm64' ||
    input.hardware.accelerator !== 'metal' ||
    !input.hardware.unifiedMemory ||
    !Number.isSafeInteger(input.hardware.totalMemoryBytes) ||
    input.hardware.totalMemoryBytes <= 0
  ) {
    return unavailable('hardware_fingerprint_unavailable')
  }

  const runtimeBackendBase = {
    runtime: 'ollama' as const,
    version: runtimeVersion,
    source: 'ollama_api_version' as const,
  }
  const hardwareBase = {
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    accelerator: 'metal' as const,
    unifiedMemory: true as const,
    totalMemoryBytes: input.hardware.totalMemoryBytes,
    source: 'local_runtime_profile' as const,
    totalMemorySource: 'node_os_totalmem' as const,
  }
  const components = {
    provider: 'ollama' as const,
    normalizedModelReference: normalizedReference,
    artifactDigest: digest,
    contextLength: input.contextLength,
    runtimeBackend: {
      ...runtimeBackendBase,
      fingerprint: fingerprint(runtimeBackendBase),
    },
    hardware: {
      ...hardwareBase,
      fingerprint: fingerprint(hardwareBase),
    },
  }
  return {
    state: 'complete',
    version: 1,
    id: fingerprint({ version: 1, components }),
    components,
  }
}

/** Resolve one `/api/ps` row against the complete installed-artifact sample. */
export function resolveRuntimeObservationKey(
  input: RuntimeObservationKeyInput,
): ModelObservationKey {
  const normalizedReference = normalizeOllamaModelReference(input.running.name)
  if (!normalizedReference) return unavailable('invalid_model_reference')
  const matchingRuntimeRows = input.runningRows.filter(
    (row) => normalizeOllamaModelReference(row.name) === normalizedReference,
  )
  if (matchingRuntimeRows.length !== 1) return unavailable('runtime_reference_ambiguous')
  if (!input.running.digest?.trim()) return unavailable('runtime_digest_missing')
  if (
    input.running.contextLength === null ||
    !Number.isSafeInteger(input.running.contextLength) ||
    input.running.contextLength <= 0
  ) {
    return unavailable('runtime_context_missing')
  }
  if (input.installed === null) return unavailable('installed_source_unavailable')
  const installedMatches = input.installed.filter(
    (entry) => normalizeOllamaModelReference(entry.name) === normalizedReference,
  )
  if (installedMatches.length === 0) return unavailable('installed_reference_missing')
  if (installedMatches.length !== 1) return unavailable('installed_reference_ambiguous')
  if (installedMatches[0]!.digest !== input.running.digest) {
    return unavailable('installed_digest_mismatch')
  }
  return buildCompleteObservationKey({
    normalizedModelReference: normalizedReference,
    artifactDigest: input.running.digest,
    contextLength: input.running.contextLength,
    runtimeVersion: input.runtimeVersion,
    runtimeHost: input.runtimeHost,
    hardware: input.hardware,
  })
}
