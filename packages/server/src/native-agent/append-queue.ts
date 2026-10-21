/**
 * One FIFO for every native trace append of an active attempt (K4 input slice).
 *
 * `pi-agent-core` awaits listener promises, but the explicit tool-call
 * acknowledgment below is still required: the tool wrapper waits for the exact
 * `toolCallId` commit before any tool body effect. A failure is latched once,
 * pending acknowledgments are rejected, the turn is aborted and the caller's
 * failure handler writes at most one content-free error/terminal sequence.
 * Appends execute outside the synchronous R1 transaction; the transaction
 * itself never awaits.
 */
import type { AppendOptions, AppendResult, SessionEventInput } from '../session-log/log.ts'
import type { SessionEventType } from '@guanxi/contract'

export class NativeTraceError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'NativeTraceError'
    this.code = code
  }
}

interface Ack {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

export interface NativeAppendQueueOptions {
  append<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): AppendResult
  /**
   * Called once after the first failure while the FIFO still owns the turn.
   * It may write the single content-free error/terminal pair directly; every
   * other append goes through {@link NativeAppendQueue.append}.
   */
  onFailure(failure: { code: string; aborted: boolean }): void | Promise<void>
  abort(): void
}

function failureCode(error: unknown): string {
  if (error instanceof NativeTraceError) return error.code
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'input_artifact_storage_failed'
}

export class NativeAppendQueue {
  private readonly options: NativeAppendQueueOptions
  private tail: Promise<void> = Promise.resolve()
  private sealed = false
  private failure: NativeTraceError | null = null
  private readonly acks = new Map<string, Ack>()

  constructor(options: NativeAppendQueueOptions) {
    this.options = options
  }

  get failed(): string | null {
    return this.failure?.code ?? null
  }

  get isSealed(): boolean {
    return this.sealed
  }

  /** Enqueue one operation; later operations run only after it settles. */
  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.failure !== null) return Promise.reject(this.failure)
    if (this.sealed) return Promise.reject(new NativeTraceError('trace_sealed'))
    const run = this.tail.then(() => operation())
    // The caller sees the rejection only after the single failure handler has
    // written its terminal, so the service can distinguish a failed turn from
    // a still-running one without a microtask race.
    const settled = run.then(
      (value) => value,
      async (error: unknown) => {
        await this.fail(failureCode(error))
        throw error
      },
    )
    this.tail = settled.then(() => undefined, () => undefined)
    return settled
  }

  /** Enqueue one append. */
  append<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): Promise<AppendResult> {
    return this.enqueue(() => this.options.append(input, options))
  }

  /**
   * @internal Called only from inside an already-enqueued operation. A nested
   * `append` would wait for the same tail and deadlock.
   */
  appendNow<T extends SessionEventType>(input: SessionEventInput<T>, options?: AppendOptions): AppendResult {
    return this.options.append(input, options)
  }

  /** Register the exact toolCallId a later tool body must wait for. */
  expectToolCall(toolCallId: string): void {
    if (this.acks.has(toolCallId)) return
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    // An unconsumed rejection must not become an unhandled rejection; the tool
    // wrapper always awaits, but a sealed turn may never reach that code.
    promise.catch(() => undefined)
    this.acks.set(toolCallId, { promise, resolve, reject })
  }

  /** Resolve after the exact tool.call event committed. */
  acknowledgeToolCall(toolCallId: string): void {
    this.acks.get(toolCallId)?.resolve()
  }

  /** Wait for the exact tool.call commit; missing, sealed or failed turns reject. */
  async waitForToolCall(toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (this.failure !== null) throw this.failure
    const ack = this.acks.get(toolCallId)
    if (!ack) throw new NativeTraceError('tool_call_trace_missing')
    if (signal?.aborted) throw new NativeTraceError('aborted')
    let onAbort: (() => void) | null = null
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new NativeTraceError('aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([ack.promise, aborted])
    } finally {
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Latch the first failure, reject pending acks and abort the turn. */
  async fail(code: string): Promise<void> {
    if (this.failure !== null) return
    this.failure = new NativeTraceError(code)
    for (const ack of this.acks.values()) ack.reject(this.failure)
    this.acks.clear()
    try {
      await this.options.onFailure({ code, aborted: false })
    } catch {
      // A fenced owner cannot append its terminal; the abort still runs.
    } finally {
      this.options.abort()
    }
  }

  /** Seal the FIFO after the final terminal append has been enqueued. */
  seal(): void {
    this.sealed = true
  }

  /** Wait for every enqueued operation, including the failure handler. */
  async drain(): Promise<void> {
    await this.tail
  }
}
