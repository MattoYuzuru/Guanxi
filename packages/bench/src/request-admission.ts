import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Budget } from './budget.ts'

const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@/-]{0,159}$/)
const evidence = z.object({
  source: z.string().min(1).max(512), observedAt: z.string().datetime(),
  validUntil: z.string().datetime(), confidence: z.literal('verified'),
}).strict()
/** Created only by a trusted, provider-specific meter/pricing adapter, never by a task agent.
 * No live adapter is shipped by the request-admission foundation. */
export const requestQuoteSchema = z.object({
  provider: key, model: key, preparedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  inputTokenBound: uint, outputTokenLimit: uint.positive(),
  meter: evidence.extend({ format: z.literal('provider-request-upper-bound') }),
  price: evidence.extend({ currency: z.literal('USD'),
    // Input rate must bound every input/cache category the provider can bill.
    inputMicrousdPerMillion: uint, outputMicrousdPerMillion: uint, requestMicrousd: uint }),
}).strict()
export type RequestQuote = z.infer<typeof requestQuoteSchema>
export interface RequestIdentity { runId: string; task: string; arm: string; seed: number; requestId: string }
export const requestUsageSchema = z.object({ tokens: uint, costMicrousd: uint,
  source: z.string().min(1).max(512), observedAt: z.string().datetime(), confidence: z.literal('verified'),
}).strict()
export type RequestUsage = z.infer<typeof requestUsageSchema>
export interface RequestReservation { requestId: string; tokens: number; costMicrousd: number }

export function checkedQuote(raw: unknown, now: Date): { quote: RequestQuote; tokens: number; costMicrousd: number } {
  const quote = requestQuoteSchema.parse(raw)
  for (const fact of [quote.meter, quote.price]) {
    if (Date.parse(fact.observedAt) > now.getTime() || Date.parse(fact.validUntil) <= now.getTime() ||
      Date.parse(fact.validUntil) <= Date.parse(fact.observedAt)) throw new Error('request_quote_not_current')
  }
  const tokens = quote.inputTokenBound + quote.outputTokenLimit
  // Round each independently billable category upwards, never down or via floats.
  const cost = (BigInt(quote.inputTokenBound) * BigInt(quote.price.inputMicrousdPerMillion) + 999_999n) / 1_000_000n +
    (BigInt(quote.outputTokenLimit) * BigInt(quote.price.outputMicrousdPerMillion) + 999_999n) / 1_000_000n + BigInt(quote.price.requestMicrousd)
  if (!Number.isSafeInteger(tokens) || cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('request_quote_overflow')
  return { quote, tokens, costMicrousd: Number(cost) }
}

/** Hash only; prepared prompts/tool results/reasoning are never persisted in the ledger. */
export function preparedRequestSha256(prepared: unknown): string {
  let serialized: string | undefined
  try { serialized = JSON.stringify(prepared) } catch { throw new Error('request_payload_invalid') }
  if (serialized === undefined) throw new Error('request_payload_invalid')
  return createHash('sha256').update(serialized).digest('hex')
}

/** Fits K3's existing ModelCall.onPrepared seam after scrubbing, before dispatch.
 * Both arm bridges must use this same admission path. Actual provider wire meters,
 * K3-owned egress and arm bridges remain separate prerequisites for paid execution. */
export function preparedRequestAdmission(
  budget: Budget, identity: RequestIdentity, outputTokenLimit: number,
  quotePrepared: (prepared: unknown, sha256: string) => RequestQuote | null,
) {
  let admitted = false
  return {
    onPrepared(prepared: unknown): void {
      if (admitted) throw new Error('request_already_admitted')
      const digest = preparedRequestSha256(prepared)
      const quote = quotePrepared(prepared, digest)
      if (!quote) throw new Error('request_quote_unknown')
      if (quote.preparedSha256 !== digest || quote.outputTokenLimit !== outputTokenLimit) throw new Error('request_quote_mismatch')
      budget.admitRequest(identity, quote)
      admitted = true
    },
    settle(usage: RequestUsage | null): void {
      if (!admitted) throw new Error('request_not_admitted')
      budget.settleRequest(identity.runId, identity.requestId, usage)
    },
  }
}
