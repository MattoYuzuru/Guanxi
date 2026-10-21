import { invariant, type Reserves, type Thresholds, type WindowObservation } from './types.ts'

/** The adapter must attest an upper bound INCLUDING its rendered chat template.
 * UTF-8 byte count bounds byte-level tokens; framingTokens covers template/control tokens.
 * A tokenizer adapter may provide an exact count for prompt_eval_count comparison. */
export function upperTokens(value: string, window: WindowObservation): number {
  return Buffer.byteLength(value, 'utf8') + window.framingTokens
}
export function thresholds(window: WindowObservation, r: Reserves): Thresholds {
  for (const n of [window.tokens, window.observedAt, window.framingTokens, ...Object.values(r)]) invariant(Number.isSafeInteger(n) && n >= 0, 'invalid_reserves')
  invariant(window.tokens > 0 && window.source && window.confidence === 'high', 'window_unknown')
  const H = window.tokens - r.turn - r.safety
  const hard = H - r.handoff - r.tool
  const soft = Math.floor(Math.min(.75 * window.tokens, hard - r.stepMedian, r.effective))
  invariant(r.turn > 0 && r.handoff > 0 && r.effective > 0 && soft > window.framingTokens && hard > soft && H < window.tokens, 'window_too_small')
  return { W: window.tokens, H, hard, soft, handoff: Math.floor(.15 * window.tokens) }
}
export function boundary(t: Thresholds, usage: number, itemClosed: boolean, nextEstimate: number): boolean {
  return usage >= t.hard || (itemClosed && usage >= Math.max(.5 * t.W, t.soft - nextEstimate)) || usage >= t.soft
}
export function bounded(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  if (bytes <= 0) return ''
  // Never cut a UTF-8 character, and never claim a shortened value is complete.
  let result = Buffer.from(text).subarray(0, Math.max(0, bytes - 16)).toString('utf8').replace(/\uFFFD$/u, '')
  result += '\n[use paging]'
  return result
}
export function request(prompt: string, parts: string[], window: WindowObservation, limit: number): string {
  invariant(upperTokens(prompt, window) <= limit, 'context_ceiling')
  let result = prompt
  for (const part of parts) {
    const remaining = limit - upperTokens(result, window) - 1
    if (remaining <= 16) break
    result += '\n' + bounded(part, remaining)
  }
  invariant(upperTokens(result, window) <= limit, 'context_ceiling')
  return result
}

/** Recheck the authoritative wall clock instead of treating the JS timer's maximum
 * representable delay as the delegation deadline. The returned cancel owns rearming. */
export function wallDeadline(remaining: () => number, expire: () => void,
  schedule: (fn: () => void, delay: number) => () => void = (fn, delay) => {
    const timer = setTimeout(fn, delay)
    return () => clearTimeout(timer)
  }): () => void {
  let closed = false, cancel = () => {}
  const arm = () => {
    if (closed) return
    const left = remaining()
    if (left <= 0) { closed = true; expire(); return }
    cancel = schedule(arm, Math.min(left, 2 ** 31 - 1))
  }
  arm()
  return () => { closed = true; cancel() }
}
