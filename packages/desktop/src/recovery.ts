export interface Backoff {
  /** Record a failure and return how long to wait before the next recovery attempt. */
  failure(): number
  /** Delay for a failure that is not a repeat (first one, or long after the last). */
  base(): number
}

/**
 * Delay for the recovery after a lost interface: the base delay, doubling with every failure that follows the
 * previous one closely (a renderer that crashes again right after being reloaded), capped, and forgotten after a
 * quiet period. A crash loop therefore slows down instead of reloading the window every few seconds.
 */
export function createBackoff(options: { baseMs: number; maxMs: number; resetAfterMs: number; now(): number }): Backoff {
  let failures = 0
  let last = Number.NEGATIVE_INFINITY
  return {
    failure(): number {
      const now = options.now()
      failures = now - last > options.resetAfterMs ? 1 : failures + 1
      last = now
      return Math.min(options.baseMs * 2 ** (failures - 1), options.maxMs)
    },
    base: () => options.baseMs,
  }
}
