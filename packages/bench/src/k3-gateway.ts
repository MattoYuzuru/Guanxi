import { randomUUID } from 'node:crypto'
import type { Connections } from '../../server/src/connections/service.ts'
import type { Budget } from './budget.ts'
import { preparedRequestAdmission, type RequestIdentity, type RequestQuote, type RequestUsage } from './request-admission.ts'

type Context = Parameters<Connections['complete']>[2]
type Completion = Awaited<ReturnType<Connections['complete']>>
type Prepared = Parameters<NonNullable<Parameters<Connections['complete']>[3]['onPrepared']>>[0]
export type TrialIdentity = Omit<RequestIdentity, 'requestId'>

/** Trusted host adapters only. Neither pi-ai's default zeros nor its catalog cost
 * metadata establish verified provider billing. No live adapter is shipped here. */
export interface BillingAdapter {
  quote(prepared: Prepared, sha256: string, outputTokenLimit: number): RequestQuote | null
  usage(result: Completion): RequestUsage | null
}
export interface TrialGatewayConfig {
  budget: Budget
  k3: Pick<Connections, 'snapshot' | 'complete'>
  accountId: string
  connectionId: string
  provider: string
  model: string
  outputTokenLimit: number
  /** Actual R1 durable run id. Old internal fixtures may omit it and use trial.runId. */
  k3RunId?: string
  /** Required by the new T0 host: synchronous R1 attempt fence before dispatch. */
  attemptFence?: { assert(): void }
  trial: TrialIdentity
  billing: BillingAdapter
}
export class BenchGatewayError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = 'BenchGatewayError' }
}
const admissionCodes = new Set(['request_quote_unknown', 'request_quote_mismatch', 'request_quote_not_current',
  'request_quote_overflow', 'request_identity_invalid', 'request_run_not_open', 'request_run_expired',
  'request_model_mismatch', 'request_trial_unknown', 'request_trial_halted', 'request_already_admitted',
  'request_in_flight_or_unreconciled', 'request_budget_exceeded'])

/** One immutable trial capability shared by either arm's trusted bridge. No generic
 * K3 service, provider key, connection selector or caller-supplied request ID is exposed.
 * This object is not a task-container endpoint and does not enable paid execution. */
export function createTrialGateway(config: TrialGatewayConfig) {
  const { budget, k3, accountId, connectionId, provider, model, outputTokenLimit } = config
  const trial = Object.freeze({ ...config.trial })
  const quote = config.billing.quote.bind(config.billing), usage = config.billing.usage.bind(config.billing)
  const k3RunId = config.k3RunId ?? trial.runId
  const attemptFence = config.attemptFence
  if (![accountId, connectionId, provider, model, trial.runId, trial.task, trial.arm, k3RunId].every(value => typeof value === 'string' && value.length > 0) ||
    !Number.isSafeInteger(trial.seed) || trial.seed < 0 || !Number.isSafeInteger(outputTokenLimit) || outputTokenLimit <= 0 ||
    (attemptFence !== undefined && (typeof attemptFence !== 'object' || attemptFence === null || typeof attemptFence.assert !== 'function')))
    throw new BenchGatewayError('gateway_config_invalid')
  const fence = () => {
    if (!attemptFence) return
    try { attemptFence.assert() } catch { throw new BenchGatewayError('gateway_attempt_fenced') }
  }
  return Object.freeze({
    async complete(context: Context, signal?: AbortSignal): Promise<{ requestId: string; result: Completion }> {
      if (signal?.aborted) throw new BenchGatewayError('gateway_cancelled')
      // K3 reads its connection synchronously when complete starts. Do not await
      // between this binding check and that call; the prepared hook repeats it.
      const assertConnection = () => {
        try {
          const connection = k3.snapshot(accountId).connections.find(item => item.id === connectionId)
          if (connection && connection.kind === 'model_api' && connection.auth === 'api_key' && connection.provider === provider) return
        } catch { /* Metadata failure carries no admission authority or exported error text. */ }
        throw new BenchGatewayError('gateway_connection_mismatch')
      }
      assertConnection()
      fence()
      const requestId = randomUUID()
      const gate = preparedRequestAdmission(budget, { ...trial, requestId }, outputTokenLimit,
        (prepared, digest) => quote(prepared as Prepared, digest, outputTokenLimit))
      let admitted = false, admissionCode: string | undefined
      const unknown = () => {
        try { gate.settle(null) } catch { throw new BenchGatewayError('gateway_accounting_failed') }
      }
      let result: Completion
      try {
        result = await k3.complete(accountId, connectionId, context, {
          model, runId: k3RunId, requestId, signal, singleAttempt: true,
          options: Object.freeze({ maxTokens: outputTokenLimit }),
          onPrepared(prepared) {
            try {
              signal?.throwIfAborted()
              assertConnection()
              fence()
              gate.onPrepared(prepared)
              admitted = true
            } catch (error) {
              admissionCode = error instanceof BenchGatewayError ? error.code
                : error instanceof Error && admissionCodes.has(error.message) ? error.message : 'gateway_quote_failed'
              throw new BenchGatewayError(admissionCode)
            }
          },
        })
      } catch {
        if (admitted) unknown()
        throw new BenchGatewayError(admissionCode ?? 'gateway_model_failed')
      }
      if (!admitted) throw new BenchGatewayError('gateway_prepared_hook_missing')
      if (signal?.aborted || result.model !== model || result.provider !== provider || ['error', 'aborted'].includes(result.stopReason)) {
        unknown(); throw new BenchGatewayError('gateway_model_failed')
      }
      let observed: RequestUsage | null
      try { observed = usage(result) } catch { unknown(); throw new BenchGatewayError('gateway_usage_invalid') }
      if (observed === null) { unknown(); throw new BenchGatewayError('gateway_usage_unknown') }
      try { gate.settle(observed) } catch (error) {
        // A committed breach already halted the trial. Other malformed observations
        // must become unknown, never leave a successfully repeatable inference.
        if (error instanceof Error && error.message === 'request_bound_violated') throw new BenchGatewayError(error.message)
        unknown(); throw new BenchGatewayError('gateway_usage_invalid')
      }
      return { requestId, result }
    },
  })
}
