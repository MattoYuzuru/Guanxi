import { isExternallyOpenable } from './security.ts'

export type OpenOutcome = 'opened' | 'unsupported' | 'no_activation' | 'rate_limited'

export interface ExternalOpenerOptions {
  /** Hands the URL to the system (shell.openExternal). */
  open(url: string): void
  now(): number
  /** A request counts only this long after the last real user input. */
  activationWindowMs?: number
  /** At most `maxOpens` per `windowMs`; more are dropped. */
  maxOpens?: number
  windowMs?: number
}

/**
 * The only path from the renderer to the system browser. A link the user just clicked or typed Enter on
 * opens; a script that navigates or calls window.open on its own does not, and a page cannot flood the
 * desktop with tabs. The window never navigates away either way.
 */
export function createExternalOpener(options: ExternalOpenerOptions) {
  const activationWindowMs = options.activationWindowMs ?? 2_000
  const maxOpens = options.maxOpens ?? 3
  const windowMs = options.windowMs ?? 10_000
  let lastInput = Number.NEGATIVE_INFINITY
  let opens: number[] = []
  return {
    noteUserInput(): void {
      lastInput = options.now()
    },
    request(url: string): OpenOutcome {
      if (!isExternallyOpenable(url)) return 'unsupported'
      const now = options.now()
      if (now - lastInput > activationWindowMs) return 'no_activation'
      opens = opens.filter((time) => now - time < windowMs)
      if (opens.length >= maxOpens) return 'rate_limited'
      opens.push(now)
      // One gesture, one open: a click cannot be reused by a script a moment later.
      lastInput = Number.NEGATIVE_INFINITY
      options.open(url)
      return 'opened'
    },
  }
}

export type ExternalOpener = ReturnType<typeof createExternalOpener>
