import { z } from 'zod'
import type { Ledger } from './types.ts'
import { invariant } from './types.ts'

const text = z.string().trim().min(1)
const positive = z.number().int().positive().safe()
const nonnegative = z.number().int().nonnegative().safe()
const scope = z.object({ model: text, host: text, repo: text }).strict()
/** T0 observations and planner estimates. Never accept this configuration from executor JSON. */
export const etaInputSchema = z.object({
  scope,
  estimates: z.array(z.object({ item: text, remainingMs: positive }).strict()),
  history: z.array(z.object({ id: text, scope, estimatedMs: positive, actualMs: positive,
    completedAt: nonnegative, source: text, infraTainted: z.boolean() }).strict()),
  policy: z.object({ simulations: positive, seed: nonnegative.max(0xffffffff), minSamples: positive, maxAgeMs: positive }).strict(),
  throughput: z.object({ remainingTokens: nonnegative, tokensPerSecond: z.number().finite().positive(),
    observedAt: nonnegative, source: text, maxAgeMs: positive }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.estimates.map(e => e.item)).size !== input.estimates.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate ETA item' })
  const keys = input.history.map(h => JSON.stringify([h.scope.model, h.scope.host, h.scope.repo, h.id]))
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'duplicate ETA observation' })
})
export type EtaInput = z.infer<typeof etaInputSchema>
export interface EtaProjection {
  source: 'relay:empirical-ratio-monte-carlo'
  observedAt: number
  confidence: 'unknown' | 'low'
  calibration: 'unvalidated'
  scope: EtaInput['scope']
  status: 'estimated' | 'unknown' | 'complete'
  reason: 'missing_estimates' | 'insufficient_history' | null
  p50RemainingMs: number | null
  p80RemainingMs: number | null
  p50FinishAt: number | null
  p80FinishAt: number | null
  basis: {
    remainingItems: string[]
    plannedRemainingMs: number | null
    samples: number
    excludedSamples: number
    oldestSampleAt: number | null
    newestSampleAt: number | null
    sources: string[]
    policy: EtaInput['policy']
    assumption: 'serial-items-independent-ratios'
  }
  throughput: { status: 'unavailable' | 'stale' | 'consistent' | 'below_runtime_floor' | 'forecast_unknown';
    minimumRemainingMs: number | null; source: string | null; observedAt: number | null }
}

/** Empirical bootstrap of estimate/actual ratios; it is a forecast, not a calibrated P80 claim.
 * Remaining estimates are supplied by the host, so elapsed time is never guessed from run age. */
export function projectEta(ledger: Pick<Ledger, 'plan' | 'items'>, raw: EtaInput, now: number): EtaProjection {
  const input = etaInputSchema.parse(raw)
  invariant(Number.isSafeInteger(now) && now >= 0, 'eta_clock')
  const ids = new Set(ledger.plan.items.map(i => i.id))
  invariant(input.estimates.every(e => ids.has(e.item)), 'eta_item')
  const remainingItems = ledger.plan.items.filter(i => ledger.items[i.id] !== 'done').map(i => i.id)
  const estimates = new Map(input.estimates.map(e => [e.item, e.remainingMs]))
  const missing = remainingItems.some(id => !estimates.has(id))
  const plannedRemainingMs = missing ? null : remainingItems.reduce((sum, id) => sum + estimates.get(id)!, 0)
  invariant(plannedRemainingMs === null || Number.isSafeInteger(plannedRemainingMs), 'eta_overflow')
  const history = input.history.filter(h => !h.infraTainted && h.scope.model === input.scope.model
    && h.scope.host === input.scope.host && h.scope.repo === input.scope.repo
    && h.completedAt <= now && now - h.completedAt <= input.policy.maxAgeMs)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const result: EtaProjection = {
    source: 'relay:empirical-ratio-monte-carlo', observedAt: now, confidence: 'unknown', calibration: 'unvalidated',
    scope: input.scope, status: 'unknown', reason: missing ? 'missing_estimates' : 'insufficient_history',
    p50RemainingMs: null, p80RemainingMs: null, p50FinishAt: null, p80FinishAt: null,
    basis: { remainingItems, plannedRemainingMs, samples: history.length,
      excludedSamples: input.history.length - history.length,
      oldestSampleAt: history.length ? history.reduce((oldest, h) => Math.min(oldest, h.completedAt), now) : null,
      newestSampleAt: history.length ? history.reduce((newest, h) => Math.max(newest, h.completedAt), 0) : null,
      sources: [...new Set(history.map(h => h.source))].sort(), policy: input.policy,
      assumption: 'serial-items-independent-ratios' },
    throughput: { status: 'unavailable', minimumRemainingMs: null, source: null, observedAt: null },
  }
  if (!remainingItems.length) {
    result.status = 'complete'; result.reason = null
    result.p50RemainingMs = result.p80RemainingMs = 0
  } else if (!missing && history.length >= input.policy.minSamples) {
    let state = input.policy.seed
    const draws: number[] = []
    for (let trial = 0; trial < input.policy.simulations; trial++) {
      let duration = 0
      for (const item of remainingItems) {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0
        const sample = history[Math.floor(state / 0x100000000 * history.length)]!
        duration += estimates.get(item)! * sample.actualMs / sample.estimatedMs
      }
      const rounded = Math.ceil(duration)
      invariant(Number.isSafeInteger(rounded), 'eta_overflow')
      draws.push(rounded)
    }
    draws.sort((a, b) => a - b)
    result.status = 'estimated'; result.reason = null; result.confidence = 'low'
    result.p50RemainingMs = draws[Math.ceil(draws.length * 0.5) - 1]!
    result.p80RemainingMs = draws[Math.ceil(draws.length * 0.8) - 1]!
  }
  if (result.p50RemainingMs !== null && result.p80RemainingMs !== null) {
    result.p50FinishAt = now + result.p50RemainingMs; result.p80FinishAt = now + result.p80RemainingMs
    invariant(Number.isSafeInteger(result.p50FinishAt) && Number.isSafeInteger(result.p80FinishAt), 'eta_overflow')
  }
  if (input.throughput) {
    const t = input.throughput
    const fresh = t.observedAt <= now && now - t.observedAt <= t.maxAgeMs
    const minimum = Math.ceil(t.remainingTokens / t.tokensPerSecond * 1000)
    invariant(Number.isSafeInteger(minimum), 'eta_overflow')
    result.throughput = { source: t.source, observedAt: t.observedAt, minimumRemainingMs: fresh ? minimum : null,
      status: !fresh ? 'stale' : result.p80RemainingMs === null ? 'forecast_unknown'
        : result.p80RemainingMs < minimum ? 'below_runtime_floor' : 'consistent' }
  }
  return result
}
