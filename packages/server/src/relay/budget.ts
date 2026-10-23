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
/** `exact` means the meter is a real tokenizer rather than an upper byte bound. The
 * request packer still works in bytes, so an exact measure converts a token budget to a
 * conservative byte budget and rechecks every cut. */
export type Measure = ((value: string) => number) & { readonly exact?: boolean }
export interface RequestParts { head?: readonly string[]; turns?: readonly string[] }
export interface RequestResult { text: string; dropped: number; cut: number }
export type AsyncMeasure = ((value: string) => Promise<number>) & { readonly exact?: boolean; readonly async: true }
/** One packing algorithm, two drivers. The generator yields every string it needs measured and receives the
 * measure; `request` answers synchronously (local meters) and `requestAsync` awaits (a remote meter whose exact
 * answer needs a network round trip). Both therefore make identical decisions for identical measures. */
function* pack(prompt: string, parts: RequestParts, limit: number, exact: boolean | undefined): Generator<string, RequestResult, number> {
  invariant((yield prompt) <= limit, 'context_ceiling')
  let fixed = prompt, cut = 0
  const fit = function* (value: string, remaining: number): Generator<string, string, number> {
    if (remaining <= 16) return ''
    if ((yield value) <= remaining) return value
    let bytes = exact ? remaining * 4 : remaining
    let result = bounded(value, bytes)
    while (result && (yield result) > remaining) result = bounded(value, bytes = Math.floor(bytes / 2))
    return result
  }
  for (const part of parts.head ?? []) {
    const remaining = limit - (yield fixed) - 1
    const value = yield* fit(part, remaining)
    if (value !== part) cut++
    fixed += '\n' + value
  }
  const turns = parts.turns ?? []
  const accepted: { index: number; text: string }[] = []
  let dropped = 0, packed = fixed
  // The newest turns are the most valuable next context; older ones fall off first.
  for (let index = turns.length - 1; index >= 0; index--) {
    const part = turns[index]!, candidate = packed + '\n' + part
    if ((yield candidate) <= limit) { accepted.push({ index, text: part }); packed = candidate; continue }
    if (index !== turns.length - 1) { dropped++; continue }
    const remaining = limit - (yield packed) - 1
    const value = yield* fit(part, remaining)
    if (!value) { dropped++; continue }
    accepted.push({ index, text: value }); packed += '\n' + value; cut++
  }
  accepted.sort((a, b) => a.index - b.index)
  const render = () => fixed + accepted.map(v => '\n' + v.text).join('')
  let text = render()
  // Reordering can move token boundaries; drop the oldest accepted turn if the final
  // chronological rendering no longer fits.
  while ((yield text) > limit && accepted.length) { accepted.shift(); dropped++; text = render() }
  invariant((yield text) <= limit, 'context_ceiling')
  return { text, dropped, cut }
}
export function request(prompt: string, parts: RequestParts, measure: Measure, limit: number): RequestResult {
  const run = pack(prompt, parts, limit, measure.exact)
  let step = run.next()
  while (!step.done) step = run.next(measure(step.value))
  return step.value
}
export async function requestAsync(prompt: string, parts: RequestParts, measure: AsyncMeasure, limit: number): Promise<RequestResult> {
  const run = pack(prompt, parts, limit, measure.exact)
  let step = run.next()
  while (!step.done) step = run.next(await measure(step.value))
  return step.value
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
