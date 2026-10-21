/** Fixed-horizon, task-clustered paired inference. Never use these CIs for peeking. */
export interface Pair { task: string; control: number[]; candidate: number[] }
export function mean(xs: readonly number[]): number {
  if (!xs.length || xs.some(x => !Number.isFinite(x))) throw new Error('invalid_scores')
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
export function binary(xs: readonly number[]): void {
  if (!xs.length || xs.some(x => x !== 0 && x !== 1)) throw new Error('invalid_binary_scores')
}
export function rng(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new Error('invalid_seed')
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
function quantile(sorted: number[], p: number): number {
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  return sorted[low]! + (sorted[Math.ceil(index)]! - sorted[low]!) * (index - low)
}
export function pairedBootstrap(pairs: Pair[], seed = 25, iterations = 10_000, alpha = 0.05) {
  if (pairs.length < 2 || !Number.isSafeInteger(iterations) || iterations < 1000 || !(alpha > 0 && alpha < 1)) throw new Error('invalid_bootstrap')
  if (new Set(pairs.map(p => p.task)).size !== pairs.length) throw new Error('duplicate_task')
  const deltas = pairs.map(p => {
    binary(p.control); binary(p.candidate)
    if (p.control.length !== p.candidate.length) throw new Error('unpaired_seeds')
    return mean(p.candidate) - mean(p.control)
  })
  const random = rng(seed)
  const samples = Array.from({ length: iterations }, () => {
    let sum = 0
    for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(random() * deltas.length)]!
    return sum / deltas.length
  }).sort((a, b) => a - b)
  return { delta: mean(deltas), lower: quantile(samples, alpha / 2), upper: quantile(samples, 1 - alpha / 2),
    confidence: 1 - alpha, clusters: pairs.length, iterations, seed, horizon: 'fixed' as const }
}
/** Exact two-sided McNemar. Each entry MUST be one independent task, not a seed. */
export function mcnemar(control: number[], candidate: number[]) {
  binary(control); binary(candidate)
  if (control.length !== candidate.length) throw new Error('unpaired_tasks')
  let lost = 0; let won = 0
  for (let i = 0; i < control.length; i++) {
    if (control[i] === 1 && candidate[i] === 0) lost++
    if (control[i] === 0 && candidate[i] === 1) won++
  }
  const n = lost + won
  // Log binomial probabilities avoid underflow at large n and overflow in combinations.
  let logp = -n * Math.log(2); let tail = Math.exp(logp)
  for (let i = 1; i <= Math.min(lost, won); i++) {
    logp += Math.log(n - i + 1) - Math.log(i)
    tail += Math.exp(logp)
  }
  return { lost, won, p: Math.min(1, 2 * tail) }
}
export function holm(pvalues: number[]): number[] {
  if (pvalues.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('invalid_pvalue')
  const order = pvalues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const adjusted: number[] = []; let prior = 0
  order.forEach(({ p, i }, rank) => { prior = Math.min(1, Math.max(prior, p * (order.length - rank))); adjusted[i] = prior })
  return adjusted
}
export function conclusion(ci: { lower: number; upper: number }, change: 'addition' | 'simplification', saving: number) {
  if (!Number.isFinite(ci.lower) || !Number.isFinite(ci.upper) || ci.lower > ci.upper || !Number.isFinite(saving)) throw new Error('invalid_ci')
  const nonInferior = ci.lower > -0.05
  return { nonInferior, superior: ci.lower > 0, regression: ci.upper < 0,
    statisticalEligibility: change === 'simplification' ? nonInferior : ci.lower > 0 || nonInferior && saving >= 0.15,
    releaseDecision: 'requires_holdout_and_guardrails' as const }
}
export function noiseFloor(scores: number[][]) {
  if (scores.length < 2 || scores.some(row => row.length !== 5)) throw new Error('noise_floor_requires_five_seeds')
  scores.forEach(binary)
  const rates = Array.from({ length: 5 }, (_, i) => mean(scores.map(row => row[i]!)))
  return { seeds: 5, rates, range: Math.max(...rates) - Math.min(...rates),
    stddev: Math.sqrt(mean(rates.map(x => (x - mean(rates)) ** 2)) * 5 / 4),
    decision: 'measure_before_ab' as const }
}
