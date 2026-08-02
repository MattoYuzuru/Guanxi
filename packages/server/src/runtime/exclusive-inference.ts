/**
 * Process-local safety bridge for current Ollama inference entry points.
 *
 * This is deliberately smaller than the accepted Resource Governor: one owner,
 * FIFO waiters, no durability, priorities, admission explanation, or recovery.
 */
export interface InferencePermit {
  /** Idempotent so nested failure cleanup cannot release a later owner. */
  release(): void
}

interface Waiter {
  signal: AbortSignal | undefined
  resolve: (permit: InferencePermit) => void
  reject: (error: Error) => void
  onAbort: (() => void) | null
}

function abortedWaitError(): Error {
  const error = new Error('Inference admission was cancelled before it acquired the permit')
  error.name = 'AbortError'
  return error
}

export class ExclusiveInferenceBridge {
  private owner: symbol | null = null
  private readonly waiters: Waiter[] = []

  get active(): boolean {
    return this.owner !== null
  }

  get waiting(): number {
    return this.waiters.length
  }

  acquire(signal?: AbortSignal): Promise<InferencePermit> {
    if (signal?.aborted) return Promise.reject(abortedWaitError())
    if (this.owner === null) return Promise.resolve(this.grant())

    return new Promise<InferencePermit>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: null,
      }

      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) return
          this.waiters.splice(index, 1)
          waiter.onAbort = null
          reject(abortedWaitError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }

      this.waiters.push(waiter)
    })
  }

  private grant(): InferencePermit {
    const token = Symbol('inference-owner')
    this.owner = token
    let released = false

    return {
      release: () => {
        if (released) return
        released = true
        if (this.owner !== token) return

        this.owner = null
        this.admitNext()
      },
    }
  }

  private admitNext(): void {
    while (this.owner === null) {
      const waiter = this.waiters.shift()
      if (!waiter) return

      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
        waiter.onAbort = null
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortedWaitError())
        continue
      }

      waiter.resolve(this.grant())
    }
  }
}
