/**
 * Server ownership for explicit positive user capability assertions (P2-I).
 *
 * A mutation is only allowed for the model that is installed right now: exactly
 * one canonical `/api/tags` match, the exact digest the caller rendered, and a
 * sourced local `/api/version`. The identity is re-observed at the mutation point,
 * so a stale client expectation or an identity that drifted becomes a controlled
 * conflict instead of a write addressed by model name.
 *
 * Nothing here loads, pulls, unloads or probes a model, enters Governor
 * admission, refreshes the catalog or creates a background Job.
 */
import type {
  ModelCapability,
  ModelCapabilityOverrideConflictReason,
  ModelCapabilityOverrideMutationBody,
  ModelCapabilityOverrideOutcome,
} from '@guanxi/contract'
import type { ModelService } from './service.ts'
import { normalizeOllamaModelReference } from '../runtime/observation-key.ts'
import {
  ModelCapabilityOverrideStore,
  modelCapabilityOverrideProjection,
  type ModelCapabilityOverrideIdentity,
} from '../store/capability-override.ts'

export interface ModelCapabilityOverrideDependencies {
  models(): Pick<ModelService, 'installedArtifacts' | 'runtimeVersion'>
  store: Pick<ModelCapabilityOverrideStore, 'listReadable' | 'write' | 'clear'>
  now?: () => Date
}

type IdentityObservation =
  | { state: 'exact'; identity: ModelCapabilityOverrideIdentity }
  | { state: 'conflict'; reason: ModelCapabilityOverrideConflictReason }

export class ModelCapabilityOverrideService {
  private readonly dependencies: ModelCapabilityOverrideDependencies

  constructor(dependencies: ModelCapabilityOverrideDependencies) {
    this.dependencies = dependencies
  }

  apply(
    name: string,
    request: ModelCapabilityOverrideMutationBody,
    signal: AbortSignal,
  ): Promise<ModelCapabilityOverrideOutcome> {
    return this.mutate(name, request, signal, (identity, capability) => {
      this.dependencies.store.write({
        identity,
        capability,
        now: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      })
      return 'applied'
    })
  }

  clear(
    name: string,
    request: ModelCapabilityOverrideMutationBody,
    signal: AbortSignal,
  ): Promise<ModelCapabilityOverrideOutcome> {
    return this.mutate(name, request, signal, (identity, capability) =>
      this.dependencies.store.clear({ identity, capability }).removed
        ? 'cleared'
        : 'absent',
    )
  }

  private async mutate(
    name: string,
    request: ModelCapabilityOverrideMutationBody,
    signal: AbortSignal,
    persist: (
      identity: ModelCapabilityOverrideIdentity,
      capability: ModelCapability,
    ) => 'applied' | 'cleared' | 'absent',
  ): Promise<ModelCapabilityOverrideOutcome> {
    const conflict = (
      reason: ModelCapabilityOverrideConflictReason,
    ): ModelCapabilityOverrideOutcome => ({
      state: 'conflict',
      capability: request.capability,
      reason,
      identity: null,
      overrides: [],
    })

    signal.throwIfAborted()
    // Observed at the mutation point on purpose: no cached descriptor identity is
    // reused, so a replaced artifact or a restarted runtime is seen here.
    const observed = await this.observeExactIdentity(name, signal)
    if (observed.state === 'conflict') return conflict(observed.reason)
    signal.throwIfAborted()

    const identity = observed.identity
    if (identity.artifactDigest !== request.expectedDigest) {
      return conflict('digest_expectation_mismatch')
    }
    if (identity.runtimeVersion !== request.expectedRuntimeVersion) {
      return conflict('runtime_expectation_mismatch')
    }

    // The write and the read-back are separate steps on purpose: a failed
    // projection after a committed write must not be reported as
    // `persistence_failed`, because that would claim nothing was written.
    let state: 'applied' | 'cleared' | 'absent'
    try {
      state = persist(identity, request.capability)
    } catch {
      return conflict('persistence_failed')
    }
    let overrides: ModelCapabilityOverrideOutcome['overrides'] = []
    try {
      overrides = this.dependencies.store
        .listReadable(identity)
        .records.map(modelCapabilityOverrideProjection)
    } catch {
      // The mutation did happen; the caller re-reads the descriptor for truth.
      overrides = []
    }
    return {
      state,
      capability: request.capability,
      identity: {
        provider: 'ollama',
        normalizedModelReference: identity.normalizedModelReference,
        artifactDigest: identity.artifactDigest,
        runtimeVersion: identity.runtimeVersion,
      },
      overrides,
    }
  }

  private async observeExactIdentity(
    name: string,
    signal: AbortSignal,
  ): Promise<IdentityObservation> {
    const normalized = normalizeOllamaModelReference(name)
    if (normalized === null) return { state: 'conflict', reason: 'invalid_model_reference' }

    const [installed, runtimeVersion] = await Promise.all([
      this.dependencies
        .models()
        .installedArtifacts(signal)
        .then((entries) => ({ state: 'available' as const, entries }))
        .catch((error: unknown) => {
          if (signal.aborted) throw error
          return { state: 'unavailable' as const, entries: [] }
        }),
      this.dependencies
        .models()
        .runtimeVersion(signal)
        .then((version) => ({ state: 'available' as const, version }))
        .catch((error: unknown) => {
          if (signal.aborted) throw error
          return { state: 'unavailable' as const, version: null }
        }),
    ])
    signal.throwIfAborted()

    if (installed.state === 'unavailable') {
      return { state: 'conflict', reason: 'provider_unavailable' }
    }
    const matches = installed.entries.filter(
      (entry) => normalizeOllamaModelReference(entry.name) === normalized,
    )
    if (matches.length === 0) return { state: 'conflict', reason: 'model_not_installed' }
    if (matches.length > 1) {
      return { state: 'conflict', reason: 'installed_reference_ambiguous' }
    }
    const digest = matches[0]!.digest.trim()
    if (digest.length === 0) {
      return { state: 'conflict', reason: 'installed_digest_missing' }
    }
    if (
      runtimeVersion.state === 'unavailable' ||
      runtimeVersion.version === null ||
      runtimeVersion.version.trim().length === 0
    ) {
      return { state: 'conflict', reason: 'runtime_version_unavailable' }
    }
    return {
      state: 'exact',
      identity: {
        provider: 'ollama',
        normalizedModelReference: normalized,
        artifactDigest: digest,
        runtimeVersion: runtimeVersion.version.trim(),
      },
    }
  }
}
