import { createHash, randomBytes } from 'node:crypto'

export type TrialToolSource = 'builtin'

/** Immutable T0 identity for one local trial. The nonce is host correlation, not auth. */
export interface TrialBinding {
  readonly experimentId: string
  readonly taskId: string
  readonly armId: string
  readonly seed: number
  readonly runId: string
  readonly attemptId: string
  readonly sessionId: string
  readonly accountId: string
  readonly connectionId: string
  readonly provider: string
  readonly model: string
  readonly modelApi: string
  readonly outputTokenLimit: number
  readonly toolSource: TrialToolSource
  readonly nonce: string
}

export interface TrialBindingInput {
  experimentId: string
  taskId: string
  armId: string
  seed: number
  runId: string
  attemptId: string
  sessionId: string
  accountId: string
  connectionId: string
  provider: string
  model: string
  modelApi: string
  outputTokenLimit: number
  toolSource: TrialToolSource
  attempt: { id: string; run_id: string }
}

export class TrialBindingError extends Error {
  readonly code: 'binding_invalid' | 'binding_attempt_mismatch'
  constructor(code: 'binding_invalid' | 'binding_attempt_mismatch') {
    super(code); this.name = 'TrialBindingError'; this.code = code
  }
}

function text(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new TrialBindingError('binding_invalid')
  }
  return value
}

/**
 * Called only by the T0 coordinator after R1 created the run/attempt and K2 session.
 * The caller's object is copied and frozen; the nonce is never caller-supplied.
 */
export function createTrialBinding(input: TrialBindingInput): TrialBinding {
  const attemptId = text(input.attemptId)
  if (attemptId !== text(input.attempt.id) || text(input.runId) !== text(input.attempt.run_id)) {
    throw new TrialBindingError('binding_attempt_mismatch')
  }
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 ||
    !Number.isSafeInteger(input.outputTokenLimit) || input.outputTokenLimit <= 0 ||
    input.outputTokenLimit > 0x7fffffff) throw new TrialBindingError('binding_invalid')
  if (input.toolSource !== 'builtin') throw new TrialBindingError('binding_invalid')
  return Object.freeze({
    experimentId: text(input.experimentId), taskId: text(input.taskId), armId: text(input.armId),
    seed: input.seed, runId: text(input.runId), attemptId, sessionId: text(input.sessionId),
    accountId: text(input.accountId), connectionId: text(input.connectionId),
    provider: text(input.provider), model: text(input.model), modelApi: text(input.modelApi),
    outputTokenLimit: input.outputTokenLimit, toolSource: input.toolSource,
    nonce: randomBytes(32).toString('base64url'),
  })
}

/** Stable hash of the non-secret binding identity; never includes the nonce. */
export function trialBindingTag(binding: TrialBinding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.experimentId, binding.taskId, binding.armId, binding.seed,
    binding.runId, binding.attemptId,
  ])).digest('hex')
}

export function nonceHash(binding: TrialBinding): string {
  return createHash('sha256').update(binding.nonce).digest('hex')
}
