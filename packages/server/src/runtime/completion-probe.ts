import {
  completionProbeEvidenceSchema,
  type CompletionProbeBasis,
  type CompletionProbeBody,
  type CompletionProbeEvidence,
  type LocalModel,
} from '@guanxi/contract'
import { ModelContextLimitExceededError, type ModelService } from '../models/service.ts'
import {
  OllamaError,
  OllamaProtocolError,
  OllamaTimeoutError,
  OllamaUnavailableError,
  type OllamaClient,
} from '../ollama/client.ts'
import type { OllamaChatChunk } from '../ollama/types.ts'
import {
  COMPLETION_PROBE_DEFINITION_VERSION,
  COMPLETION_PROBE_KEY_VERSION,
  CompletionProbeStore,
  completionProbeKey,
  type CompletionProbeIdentity,
  type CompletionProbeRecord,
  type StoredCompletionProbeOutcome,
} from '../store/completion-probe.ts'
import {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  operationOwner,
  type AdmissionTicket,
  type ResourceGovernor,
  type ResourceLease,
} from './resource-governor.ts'
import { normalizeOllamaModelReference } from './observation-key.ts'

export const COMPLETION_PROBE_KEEP_ALIVE = '2m' as const
export const COMPLETION_PROBE_DEADLINE_MS = 45_000
export const COMPLETION_PROBE_CONNECT_TIMEOUT_MS = 10_000
export const COMPLETION_PROBE_LOAD_TIMEOUT_MS = 30_000
export const COMPLETION_PROBE_RESPONSE_TIMEOUT_MS = 5_000
export const COMPLETION_PROBE_MAX_RESPONSE_BYTES = 1_024
export const COMPLETION_PROBE_NUM_PREDICT = 8

const FIXED_PROBE_PROMPT = 'Reply with exactly OK.'
const REQUEST_CANCELLED = 'completion_probe_request_cancelled'
const REQUEST_TIMEOUT = 'completion_probe_request_timeout'

type ProbeExecutionOutcome = StoredCompletionProbeOutcome

export interface CompletionProbeDependencies {
  governor: ResourceGovernor
  models(): Pick<ModelService, 'listLocal' | 'installedArtifacts' | 'runtimeVersion'>
  ollama(): Pick<OllamaClient, 'chatStream'>
  store: Pick<CompletionProbeStore, 'read' | 'write'>
  now?: () => Date
  deadlineMs?: number
}

interface ExactIdentityObservation {
  identity: CompletionProbeIdentity
  basis: Extract<CompletionProbeBasis, { state: 'exact' }>
}

interface InitialSelection {
  model: LocalModel
  exact: ExactIdentityObservation
}

type StoredDegradedReason = Exclude<
  StoredCompletionProbeOutcome['reason'],
  'terminal_response'
>

export class CompletionProbeService {
  private readonly dependencies: CompletionProbeDependencies
  private readonly active = new Set<string>()

  constructor(dependencies: CompletionProbeDependencies) {
    this.dependencies = dependencies
  }

  async execute(
    name: string,
    request: CompletionProbeBody,
    requestSignal: AbortSignal,
  ): Promise<CompletionProbeEvidence> {
    const controller = new AbortController()
    const abortFromRequest = () => controller.abort(REQUEST_CANCELLED)
    if (requestSignal.aborted) abortFromRequest()
    else requestSignal.addEventListener('abort', abortFromRequest, { once: true })
    const timer = setTimeout(
      () => controller.abort(REQUEST_TIMEOUT),
      this.dependencies.deadlineMs ?? COMPLETION_PROBE_DEADLINE_MS,
    )
    try {
      return await this.executeBounded(name, request, controller)
    } finally {
      clearTimeout(timer)
      requestSignal.removeEventListener('abort', abortFromRequest)
    }
  }

  private async executeBounded(
    name: string,
    request: CompletionProbeBody,
    controller: AbortController,
  ): Promise<CompletionProbeEvidence> {
    const now = this.dependencies.now ?? (() => new Date())
    const observedAt = now().toISOString()
    const signal = controller.signal
    const unavailableBasis = (reason: Extract<CompletionProbeBasis, { state: 'unavailable' }>['reason']): CompletionProbeBasis => ({
      state: 'unavailable',
      keyVersion: COMPLETION_PROBE_KEY_VERSION,
      probeDefinitionVersion: COMPLETION_PROBE_DEFINITION_VERSION,
      reason,
    })
    const early = (
      status: 'skipped' | 'unknown' | 'cancelled',
      reason: Extract<CompletionProbeEvidence, { status: typeof status }>['reason'],
      basis: CompletionProbeBasis,
    ): CompletionProbeEvidence =>
      completionProbeEvidenceSchema.parse({
        status,
        reason,
        capability: 'completion',
        source: 'runtime_probe',
        confidence: 'unknown',
        observedAt,
        completedAt: now().toISOString(),
        durationMs: elapsedMs(observedAt, now()),
        basis,
        historical: false,
      })

    if (signal.aborted) {
      return early('cancelled', cancellationReason(signal), unavailableBasis('invalid_model_reference'))
    }

    let initial: InitialSelection
    try {
      const models = await this.dependencies.models().listLocal(
        request.contextLength,
        signal,
      )
      if (signal.aborted) {
        return early('cancelled', cancellationReason(signal), unavailableBasis('invalid_model_reference'))
      }
      const matches = models.filter((model) => model.name === name)
      if (matches.length !== 1) {
        return early('skipped', 'model_not_installed', unavailableBasis('installed_reference_ambiguous'))
      }
      const model = matches[0]!
      if (model.isCloud) {
        return early('skipped', 'cloud_model', unavailableBasis('installed_digest_missing'))
      }
      if (model.fit.level === 'red') {
        return early('skipped', 'fit_red', unavailableBasis('installed_digest_missing'))
      }
      if (model.fit.level === 'unknown') {
        return early('skipped', 'fit_unknown', unavailableBasis('installed_digest_missing'))
      }
      if (
        model.contextLimit.state === 'declared' &&
        request.contextLength > model.contextLimit.value
      ) {
        return early('skipped', 'context_limit_exceeded', unavailableBasis('installed_digest_missing'))
      }
      const exact = await this.observeExactIdentity(name, request.contextLength, signal)
      if (signal.aborted) {
        return early('cancelled', cancellationReason(signal), unavailableBasis('runtime_version_unavailable'))
      }
      if (!exact || exact.identity.artifactDigest !== request.expectedDigest) {
        return early('skipped', 'identity_unavailable', unavailableBasis('installed_digest_missing'))
      }
      initial = { model, exact }
    } catch (error) {
      if (signal.aborted) {
        return early('cancelled', cancellationReason(signal), unavailableBasis('invalid_model_reference'))
      }
      if (error instanceof ModelContextLimitExceededError) {
        return early('skipped', 'context_limit_exceeded', unavailableBasis('installed_digest_missing'))
      }
      return early('unknown', 'identity_unavailable', unavailableBasis('runtime_version_unavailable'))
    }

    const key = initial.exact.basis.id
    if (!request.force) {
      try {
        const cached = this.dependencies.store.read(initial.exact.identity)
        if (cached) return evidenceFromRecord(cached, true)
      } catch {
        return this.evidence({
          status: 'degraded',
          reason: 'persistence_failed',
          confidence: 'degraded',
          observedAt,
          completedAt: now().toISOString(),
          basis: initial.exact.basis,
          historical: false,
        })
      }
    }
    if (this.active.has(key)) {
      return early('skipped', 'probe_in_progress', initial.exact.basis)
    }
    this.active.add(key)
    try {
      return await this.runExact(initial, controller, observedAt)
    } finally {
      this.active.delete(key)
    }
  }

  private async runExact(
    initial: InitialSelection,
    controller: AbortController,
    observedAt: string,
  ): Promise<CompletionProbeEvidence> {
    const now = this.dependencies.now ?? (() => new Date())
    let ticket: AdmissionTicket | undefined
    let lease: ResourceLease | undefined
    let outcome: ProbeExecutionOutcome

    try {
      try {
        ticket = this.dependencies.governor.enqueue({
          owner: operationOwner('model_probe'),
          operation: 'model_probe',
          model: { provider: 'ollama', name: initial.model.name },
          requestedContext: initial.exact.identity.contextLength,
          priority: 'normal',
          enqueuedAt: now().toISOString(),
        })
        lease = await this.dependencies.governor.acquire(ticket, {
          signal: controller.signal,
          abortOwner: () => controller.abort(RESOURCE_GOVERNOR_CLOSE_REASON),
        })
        outcome = await this.callProvider(
          initial.model.name,
          initial.exact.identity.contextLength,
          controller.signal,
        )
      } catch (error) {
        if (controller.signal.aborted || isAbort(error)) {
          return this.evidence({
            status: 'cancelled',
            reason: cancellationReason(controller.signal),
            confidence: 'unknown',
            observedAt,
            completedAt: now().toISOString(),
            basis: initial.exact.basis,
            historical: false,
          })
        }
        outcome = classifyProviderError(error)
      } finally {
        lease?.release()
        if (!lease && ticket) this.dependencies.governor.cancel(ticket)
      }

      const completedAt = now().toISOString()
      let after: ExactIdentityObservation | null = null
      try {
        after = await this.observeExactIdentity(
          initial.model.name,
          initial.exact.identity.contextLength,
          controller.signal,
        )
      } catch {
        after = null
      }
      if (controller.signal.aborted) {
        return this.evidence({
          status: 'cancelled',
          reason: cancellationReason(controller.signal),
          confidence: 'unknown',
          observedAt,
          completedAt,
          basis: initial.exact.basis,
          historical: false,
        })
      }
      if (!after || after.basis.id !== initial.exact.basis.id) {
        return this.evidence({
          status: 'degraded',
          reason: 'identity_changed',
          confidence: 'degraded',
          observedAt,
          completedAt,
          basis: initial.exact.basis,
          historical: false,
        })
      }

      const durationMs = elapsedMs(observedAt, new Date(completedAt))
      try {
        const stored = this.dependencies.store.write({
          identity: initial.exact.identity,
          outcome,
          observedAt,
          completedAt,
          durationMs,
        })
        return evidenceFromRecord(stored, false)
      } catch {
        return this.evidence({
          status: 'degraded',
          reason: 'persistence_failed',
          confidence: 'degraded',
          observedAt,
          completedAt,
          basis: initial.exact.basis,
          historical: false,
        })
      }
    } finally {
      // Lease/ticket cleanup is handled by the inner finally; the request-owned
      // deadline and listener are released by execute().
    }
  }

  private async callProvider(
    name: string,
    contextLength: number,
    signal: AbortSignal,
  ): Promise<ProbeExecutionOutcome> {
    let sawTerminal = false
    let visibleBytes = 0
    let sawVisibleContent = false
    for await (const raw of this.dependencies.ollama().chatStream(
      {
        model: name,
        messages: [{ role: 'user', content: FIXED_PROBE_PROMPT }],
        keep_alive: COMPLETION_PROBE_KEEP_ALIVE,
        options: {
          num_ctx: contextLength,
          num_predict: COMPLETION_PROBE_NUM_PREDICT,
          temperature: 0,
          seed: 0,
        },
      },
      signal,
      {
        connectTimeoutMs: COMPLETION_PROBE_CONNECT_TIMEOUT_MS,
        loadTimeoutMs: COMPLETION_PROBE_LOAD_TIMEOUT_MS,
        streamIdleTimeoutMs: COMPLETION_PROBE_RESPONSE_TIMEOUT_MS,
      },
    )) {
      const chunk = raw as OllamaChatChunk & { error?: unknown }
      if (typeof chunk.error === 'string') {
        return degraded('provider_error')
      }
      if (typeof chunk.done !== 'boolean') return degraded('runtime_protocol')
      const content = chunk.message?.content
      if (content !== undefined && typeof content !== 'string') {
        return degraded('runtime_protocol')
      }
      if (typeof content === 'string') {
        visibleBytes += Buffer.byteLength(content, 'utf8')
        if (/\S/u.test(content)) sawVisibleContent = true
        if (visibleBytes > COMPLETION_PROBE_MAX_RESPONSE_BYTES) {
          return degraded('runtime_protocol')
        }
      }
      if (chunk.done) {
        sawTerminal = true
        break
      }
    }
    if (!sawTerminal) return degraded('runtime_protocol')
    if (!sawVisibleContent) return degraded('empty_response')
    return {
      status: 'verified',
      reason: 'terminal_response',
      source: 'runtime_probe',
      confidence: 'verified',
    }
  }

  private async observeExactIdentity(
    name: string,
    contextLength: number,
    signal: AbortSignal,
  ): Promise<ExactIdentityObservation | null> {
    const normalized = normalizeOllamaModelReference(name)
    if (!normalized) return null
    const [installed, runtimeVersion] = await Promise.all([
      this.dependencies.models().installedArtifacts(signal),
      this.dependencies.models().runtimeVersion(signal),
    ])
    const matches = installed.filter(
      (entry) => normalizeOllamaModelReference(entry.name) === normalized,
    )
    if (matches.length !== 1 || matches[0]!.digest.trim().length === 0) return null
    const base: CompletionProbeIdentity = {
      provider: 'ollama',
      normalizedModelReference: normalized,
      artifactDigest: matches[0]!.digest,
      runtimeVersion,
      contextLength,
    }
    const id = completionProbeKey(base)
    return {
      identity: base,
      basis: {
        state: 'exact',
        keyVersion: COMPLETION_PROBE_KEY_VERSION,
        probeDefinitionVersion: COMPLETION_PROBE_DEFINITION_VERSION,
        provider: 'ollama',
        normalizedModelReference: normalized,
        artifactDigest: matches[0]!.digest,
        runtimeVersion,
        contextLength,
        id,
      },
    }
  }

  private evidence(input: Omit<CompletionProbeEvidence, 'capability' | 'source' | 'durationMs'> & { durationMs?: number }): CompletionProbeEvidence {
    return completionProbeEvidenceSchema.parse({
      ...input,
      capability: 'completion',
      source: 'runtime_probe',
      durationMs:
        input.durationMs ?? elapsedMs(input.observedAt, new Date(input.completedAt)),
    })
  }
}

function degraded(reason: StoredDegradedReason): ProbeExecutionOutcome {
  return { status: 'degraded', reason, source: 'runtime_probe', confidence: 'degraded' }
}

function classifyProviderError(error: unknown): ProbeExecutionOutcome {
  if (error instanceof OllamaTimeoutError) {
    if (error.phase === 'connect') return degraded('connect_timeout')
    if (error.phase === 'load') return degraded('load_timeout')
    return degraded('response_timeout')
  }
  if (error instanceof OllamaProtocolError) return degraded('runtime_protocol')
  if (error instanceof OllamaUnavailableError) return degraded('provider_unavailable')
  if (error instanceof OllamaError) return degraded('provider_error')
  return degraded('provider_error')
}

function evidenceFromRecord(record: CompletionProbeRecord, historical: boolean): CompletionProbeEvidence {
  return completionProbeEvidenceSchema.parse({
    ...record.outcome,
    capability: 'completion',
    observedAt: record.observedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    basis: {
      state: 'exact',
      keyVersion: record.identity.keyVersion,
      probeDefinitionVersion: record.identity.probeDefinitionVersion,
      provider: record.identity.provider,
      normalizedModelReference: record.identity.normalizedModelReference,
      artifactDigest: record.identity.artifactDigest,
      runtimeVersion: record.identity.runtimeVersion,
      contextLength: record.identity.contextLength,
      id: record.probeKey,
    },
    historical,
  })
}

function elapsedMs(start: string, end: Date): number {
  return Math.max(0, Math.round(end.getTime() - Date.parse(start)))
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function cancellationReason(signal: AbortSignal): 'request_cancelled' | 'request_timeout' {
  return signal.reason === REQUEST_TIMEOUT ? 'request_timeout' : 'request_cancelled'
}
