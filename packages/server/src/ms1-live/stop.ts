/** Runs one close under a stop bound. `exit` and `forced` are injected so the policy is testable without a process: a close
 * that settles inside the bound exits 0 (or 1 on failure) with no line; one that does not exits 1 after exactly one forced
 * stop line. The flush pause lets a piped stdout deliver that line before process.exit. */
export interface BoundedStopOptions {
  boundMs: number
  /** Write the one forced-stop line. Called once, before the non-zero exit. */
  forced: () => void
  exit: (code: number) => void
  /** Time allowed for the forced line to flush. Default 250 ms. */
  flushMs?: number
}

export function runBoundedStop(close: () => Promise<void>, options: BoundedStopOptions): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let forced = false
  timer = setTimeout(() => {
    forced = true
    try { options.forced() } catch { /* the exit code still has to be non-zero */ }
    setTimeout(() => options.exit(1), options.flushMs ?? 250)
  }, options.boundMs)
  void close().then(
    () => { if (timer) clearTimeout(timer); if (!forced) options.exit(0) },
    () => { if (timer) clearTimeout(timer); if (!forced) options.exit(1) },
  )
}
