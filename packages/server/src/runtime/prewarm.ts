import type {
  LocalModel,
  PrewarmModelBody,
  PrewarmModelResponse,
  RuntimeSnapshot,
  Settings,
} from '@alamo/contract'
import type { ModelService } from '../models/service.ts'
import type { OllamaClient } from '../ollama/client.ts'
import type { SettingsStore } from '../store/settings.ts'
import {
  RESOURCE_GOVERNOR_CLOSE_REASON,
  ResourceGovernorError,
  operationOwner,
  type AdmissionTicket,
  type ResourceGovernor,
  type ResourceLease,
} from './resource-governor.ts'
import type { RuntimeReconciliationService } from './reconciliation.ts'
import { normalizeOllamaModelReference } from './observation-key.ts'

export const PREWARM_KEEP_ALIVE = '2m' as const
export const PREWARM_COMMAND_TIMEOUT_MS = 30_000

const REQUEST_CANCELLED = 'prewarm_request_cancelled'
const REQUEST_TIMEOUT = 'prewarm_request_timeout'
const NORMAL_PREEMPTION = 'prewarm_normal_work_started'

export interface PrewarmDependencies {
  governor: ResourceGovernor
  runtime: Pick<RuntimeReconciliationService, 'snapshot'>
  settings: Pick<SettingsStore, 'get'>
  models(): Pick<ModelService, 'listLocal'>
  ollama(): Pick<OllamaClient, 'warm'>
  now?: () => Date
  timeoutMs?: number
}

/**
 * Executes one best-effort prewarm command. The browser owns only the request;
 * the Governor owns admission and can preempt only this exact low-priority owner.
 */
export async function executePrewarm(
  dependencies: PrewarmDependencies,
  name: string,
  request: PrewarmModelBody,
  requestSignal: AbortSignal,
): Promise<PrewarmModelResponse> {
  const now = dependencies.now ?? (() => new Date())
  const controller = new AbortController()
  const abortFromRequest = () => controller.abort(REQUEST_CANCELLED)
  if (requestSignal.aborted) abortFromRequest()
  else requestSignal.addEventListener('abort', abortFromRequest, { once: true })
  const timer = setTimeout(
    () => controller.abort(REQUEST_TIMEOUT),
    dependencies.timeoutMs ?? PREWARM_COMMAND_TIMEOUT_MS,
  )
  let ticket: AdmissionTicket | undefined
  let lease: ResourceLease | undefined

  const response = (
    status: PrewarmModelResponse['status'],
    reason: PrewarmModelResponse['reason'],
    digest = request.selection.digest,
    observedAt = now().toISOString(),
  ): PrewarmModelResponse =>
    ({
      status,
      reason,
      model: { name, digest },
      operation: 'chat',
      purpose: 'model_prewarm',
      priority: 'prewarm',
      keepAlive: PREWARM_KEEP_ALIVE,
      observedAt,
    }) as PrewarmModelResponse

  try {
    if (controller.signal.aborted) return cancelledResponse(response, controller.signal.reason)
    if (!dependencies.settings.get().prewarmEnabled) return response('skipped', 'disabled')

    let installed: LocalModel
    try {
      const models = await dependencies.models().listLocal(
        request.contextLength,
        controller.signal,
      )
      const exact = models.filter((model) => model.name === name)
      if (exact.length !== 1) return response('skipped', 'model_not_installed')
      installed = exact[0]!
    } catch (error) {
      if (controller.signal.aborted) {
        return cancelledResponse(response, controller.signal.reason)
      }
      return response('skipped', 'runtime_unavailable')
    }
    if (controller.signal.aborted) {
      return cancelledResponse(response, controller.signal.reason, installed.digest)
    }

    if (
      installed.digest !== request.selection.digest ||
      installed.fit.level !== request.selection.fitLevel ||
      installed.fit.basis !== request.selection.fitBasis
    ) {
      return response('skipped', 'selection_changed', installed.digest)
    }
    if (
      installed.contextLimit.state === 'declared' &&
      request.contextLength > installed.contextLimit.value
    ) {
      return response('skipped', 'context_limit_exceeded', installed.digest)
    }
    if (installed.isCloud || installed.fit.level === 'red') {
      return response('skipped', 'fit_unavailable', installed.digest)
    }
    if (installed.fit.level === 'unknown') {
      return response('skipped', 'fit_unknown', installed.digest)
    }

    let runtime: RuntimeSnapshot
    try {
      runtime = await dependencies.runtime.snapshot({ signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        return cancelledResponse(response, controller.signal.reason, installed.digest)
      }
      return response('skipped', 'runtime_unavailable', installed.digest)
    }
    if (controller.signal.aborted) {
      return cancelledResponse(response, controller.signal.reason, installed.digest)
    }
    if (runtime.source.state !== 'available' || runtime.models === null) {
      return response('skipped', 'runtime_unavailable', installed.digest, runtime.observedAt)
    }

    const normalizedSelection = normalizeOllamaModelReference(installed.name)
    const sameReference = runtime.models.filter(
      (model) => model.normalizedName === normalizedSelection,
    )
    if (sameReference.length > 0) {
      const compatible = sameReference.filter(
        (model) =>
          model.digest === installed.digest &&
          model.contextLength === request.contextLength,
      )
      if (sameReference.length === 1 && compatible.length === 1) {
        return response(
          'reused',
          'already_resident_exact',
          installed.digest,
          runtime.observedAt,
        )
      }
      return response(
        'skipped',
        'resident_identity_ambiguous',
        installed.digest,
        runtime.observedAt,
      )
    }

    // Setting and sampled facts are advisory until this synchronous enqueue.
    // The Governor repeats the canonical normal-work check at this point.
    if (!dependencies.settings.get().prewarmEnabled) {
      return response('skipped', 'disabled', installed.digest)
    }
    try {
      ticket = dependencies.governor.enqueue({
        owner: operationOwner('model_prewarm'),
        operation: 'model_prewarm',
        model: { provider: 'ollama', name: installed.name },
        requestedContext: request.contextLength,
        priority: 'prewarm',
        enqueuedAt: now().toISOString(),
      })
      lease = await dependencies.governor.acquire(ticket, {
        signal: controller.signal,
        abortOwner: () => controller.abort(RESOURCE_GOVERNOR_CLOSE_REASON),
        preemptOwner: () => controller.abort(NORMAL_PREEMPTION),
      })
    } catch (error) {
      if (
        error instanceof ResourceGovernorError &&
        error.code === 'prewarm_normal_work_present'
      ) {
        return response('skipped', 'normal_work_present', installed.digest)
      }
      if (controller.signal.aborted || isAbort(error)) {
        return cancelledResponse(response, controller.signal.reason, installed.digest)
      }
      return response('skipped', 'runtime_unavailable', installed.digest)
    }

    if (controller.signal.aborted) {
      return cancelledResponse(response, controller.signal.reason, installed.digest)
    }
    try {
      await dependencies.ollama().warm(
        installed.name,
        request.contextLength,
        PREWARM_KEEP_ALIVE,
        controller.signal,
      )
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) {
        return cancelledResponse(response, controller.signal.reason, installed.digest)
      }
      return response('skipped', 'runtime_unavailable', installed.digest)
    }
    if (controller.signal.aborted) {
      return cancelledResponse(response, controller.signal.reason, installed.digest)
    }
    return response('warmed', 'loaded', installed.digest)
  } finally {
    clearTimeout(timer)
    requestSignal.removeEventListener('abort', abortFromRequest)
    lease?.release()
    if (!lease && ticket) dependencies.governor.cancel(ticket)
  }
}

function cancelledResponse(
  response: (
    status: PrewarmModelResponse['status'],
    reason: PrewarmModelResponse['reason'],
    digest?: string,
  ) => PrewarmModelResponse,
  reason: unknown,
  digest?: string,
): PrewarmModelResponse {
  if (reason === NORMAL_PREEMPTION) return response('cancelled', 'normal_work_started', digest)
  if (reason === REQUEST_TIMEOUT) return response('cancelled', 'request_timeout', digest)
  return response('cancelled', 'request_cancelled', digest)
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
